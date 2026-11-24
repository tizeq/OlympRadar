from contextlib import closing
import datetime as dt
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

import collector


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = str(Path(self.temp.name) / 'catalog.sqlite3')
        self.export = str(Path(self.temp.name) / 'catalog.json')
        self.now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        self.event = {'title': 'Web CTF', 'url': 'https://example.com/event',
                      'source': 'Test', 'description': 'A free online CTF',
                      'deadline': '2026-02-01', 'tags': ['security'], 'free': True}

    def run_catalog(self, events, **kwargs):
        return collector.run(self.db, self.export, events=events, now=self.now, **kwargs)

    def count(self, table):
        with closing(sqlite3.connect(self.db)) as db:
            return db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]

    def test_incremental_history_fields_and_search(self):
        analyzer = Mock(return_value={'score': 80})
        first = self.run_catalog([self.event], analyzer=analyzer)
        self.assertEqual(first[0]['tags'], ['ctf', 'security', 'web'])
        self.assertTrue(first[0]['free'])
        self.assertEqual(set(first[0]), set(collector.FIELDS))
        self.run_catalog([self.event], analyzer=analyzer)
        self.assertEqual(analyzer.call_count, 1)
        self.assertEqual(self.count('history'), 1)
        changed = dict(self.event, description='Updated CTF')
        latest = self.run_catalog([changed], analyzer=analyzer)
        self.assertEqual(analyzer.call_count, 2)
        self.assertEqual(self.count('history'), 2)
        self.assertEqual(first[0]['id'], latest[0]['id'])
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM events_fts WHERE events_fts MATCH 'Updated'").fetchone()[0], 1)

    def test_dedupe_and_outage_preserve_data(self):
        self.run_catalog([self.event, dict(self.event, url=self.event['url'] + '/?utm_source=x')])
        self.assertEqual(self.count('events'), 1)
        def broken():
            raise OSError('network unavailable')
            yield
        items = self.run_catalog(broken())
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['status'], 'active')

    def test_completion_without_refetch(self):
        self.run_catalog([dict(self.event, end='2026-02-01')])
        self.now = dt.datetime(2026, 2, 2, tzinfo=dt.timezone.utc)
        items = self.run_catalog([])
        self.assertEqual(items[0]['status'], 'ended')
        self.assertEqual(self.count('history'), 2)

    def test_analyzer_failure_and_atomic_export(self):
        self.run_catalog([self.event])
        original = Path(self.export).read_bytes()
        self.run_catalog([dict(self.event, description='changed')], analyzer=Mock(side_effect=ValueError('bad')))
        self.assertEqual(self.count('history'), 1)
        with patch('collector.os.replace', side_effect=OSError('disk')):
            with self.assertRaises(OSError):
                self.run_catalog([])
        self.assertEqual(Path(self.export).read_bytes(), original)

    def test_legacy_hashes_are_not_catalog(self):
        legacy = Path(self.temp.name) / 'state.json'
        legacy.write_text(json.dumps({'version': 1, 'keys': ['a' * 64]}))
        self.run_catalog([self.event], legacy_path=legacy)
        self.assertEqual(self.count('legacy_hashes'), 1)
        self.assertEqual(self.count('events'), 1)

    def test_missing_details_do_not_erase_previous(self):
        self.run_catalog([self.event])
        sparse = {k: self.event[k] for k in ('title', 'url', 'source')}
        items = self.run_catalog([sparse])
        self.assertEqual(items[0]['description'], self.event['description'])
        self.assertEqual(items[0]['deadline'], self.event['deadline'])

    def test_registration_deadline_is_not_completion(self):
        self.run_catalog([dict(self.event, prize='$500')])
        self.now = dt.datetime(2026, 2, 2, tzinfo=dt.timezone.utc)
        item = self.run_catalog([])[0]
        self.assertEqual(item['status'], 'active')
        self.assertFalse(item['registration_open'])
        self.assertEqual(item['prize_amount'], 500)
        self.assertEqual(item['prize_currency'], 'USD')

    def test_existing_version_one_migrates_and_reprocessing_is_incremental(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.executescript((Path(collector.__file__).parent / 'migrations/public/001_catalog.sql').read_text())
        first = self.run_catalog([self.event])
        second = self.run_catalog([self.event])
        self.assertEqual(first, second)
        self.assertEqual(self.count('history'), 1)
        self.assertEqual(self.count('collector_runs'), 2)
        self.assertEqual(self.count('source_runs'), 2)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 3)

    def test_source_callback_records_empty_error_and_partial(self):
        def collect(on_source):
            yield self.event
            on_source('Test', 'empty', 0)
            on_source('Unavailable', 'error', 0)
            on_source('Empty', 'empty', 0)
        with patch('collector.sources.collect', side_effect=collect):
            collector.run(self.db, self.export, now=self.now)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT status FROM collector_runs').fetchone()[0], 'partial')
            rows = {source: (count, status) for source, count, status in db.execute('SELECT source,records,status FROM source_runs')}
            self.assertEqual(rows['Test'], (1, 'observed'))
            self.assertEqual(rows['Unavailable'], (0, 'error'))
            self.assertEqual(rows['Empty'], (0, 'empty'))

    def test_analysis_cache_is_per_source_and_ignores_volatile_metadata(self):
        first = dict(self.event, start='2026-01-20')
        second = dict(first, source='Other', url='https://other.example/event', description='Other description')
        analyze = Mock(return_value={'score': 70})
        self.run_catalog([first, second], analyzer=analyze)
        self.run_catalog([dict(first, updated_at='later'), second], analyzer=analyze)
        self.assertEqual(analyze.call_count, 2)
        self.assertEqual(self.count('events'), 1)
        self.assertEqual(self.count('analysis_cache'), 2)
        self.run_catalog([dict(first, description='New substantive content')], analyzer=analyze)
        self.assertEqual(analyze.call_count, 3)

    def test_bridge_merges_existing_events_history_aliases_and_cache(self):
        first = dict(self.event)
        second = dict(self.event, url='https://other.example/event', start='2026-01-20')
        original = self.run_catalog([first, second])
        self.assertEqual(len(original), 2)
        winner = min(item['id'] for item in original)
        loser = next(item['id'] for item in original if item['id'] != winner)
        merged = self.run_catalog([dict(first, start='2026-01-20')])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]['id'], winner)
        self.assertEqual(self.count('history'), 4)
        self.assertEqual(json.loads((Path(self.export).parent / 'catalog-aliases.json').read_text()), {loser:winner})
        with closing(sqlite3.connect(self.db)) as db:
            for table in ('aliases', 'history', 'analysis_cache'):
                self.assertEqual({row[0] for row in db.execute(f'SELECT event_id FROM {table}')}, {winner})
            self.assertEqual(db.execute('SELECT count(*) FROM events_fts').fetchone()[0], 1)
        analyze = Mock(side_effect=AssertionError('cache miss'))
        self.run_catalog([first, second], analyzer=analyze)
        analyze.assert_not_called()

    def test_existing_null_category_is_normalized_once_without_analysis(self):
        data = collector._metadata(dict(self.event, source='Codeforces'), {})
        data.update(id='old', category=None, tags=[], created_at='2025-01-01', updated_at='2025-01-01')
        with closing(sqlite3.connect(self.db)) as db:
            for file in ('001_catalog.sql', '002_runs.sql'):
                db.executescript((Path(collector.__file__).parent / 'migrations/public' / file).read_text())
            db.execute('INSERT INTO events VALUES (?,?,?,?,?,?)', ('old', collector.encoded(data), 'oldhash', '2025-01-01', '2025-01-01', None))
            db.commit()
        analyze = Mock(side_effect=AssertionError('analysis forbidden'))
        items = self.run_catalog([], analyzer=analyze)
        self.assertIsNotNone(items[0]['category'])
        self.assertIn('ctf', items[0]['tags'])
        self.assertEqual(self.count('history'), 1)
        self.run_catalog([], analyzer=analyze)
        self.assertEqual(self.count('history'), 1)
        analyze.assert_not_called()


if __name__ == '__main__':
    unittest.main()
