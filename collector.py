"""Incremental public catalog. No personal data or delivery side effects."""
import argparse
from contextlib import closing
import datetime as dt
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import tempfile

import analysis
from radar import aliases
import sources

FIELDS = ('id title url source description category tags start deadline prize format restrictions '
          'ai_policy registration_url country age_min age_max free prize_amount prize_currency '
          'difficulty registration_open score status created_at updated_at').split()
LOG = logging.getLogger(__name__)
NORMALIZATION_VERSION = 1


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def connect(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=5000')
    schema = Path(__file__).parent / 'migrations/public/001_catalog.sql'
    version = db.execute('PRAGMA user_version').fetchone()[0]
    if version < 1:
        db.executescript(schema.read_text(encoding='utf-8'))
    if version < 2:
        db.executescript((schema.parent / '002_runs.sql').read_text(encoding='utf-8'))
    if version < 3:
        db.executescript((schema.parent / '003_analysis_cache.sql').read_text(encoding='utf-8'))
    return db


def _date(value):
    if not isinstance(value, str):
        return None
    try:
        dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value
    except ValueError:
        return None


def _metadata(event, result):
    data = {key: event.get(key) for key in FIELDS}
    for key, value in result.items():
        if key in FIELDS and value not in (None, '', analysis.UNKNOWN):
            data[key] = value
    for key in FIELDS:
        if data[key] == analysis.UNKNOWN:
            data[key] = None
    for key in ('start', 'deadline'):
        data[key] = _date(data[key])
    for key in ('free', 'registration_open'):
        data[key] = data[key] if isinstance(data[key], bool) else None
    for key in ('age_min', 'age_max'):
        data[key] = data[key] if type(data[key]) is int and 0 <= data[key] <= 150 else None
    amount = data['prize_amount']
    data['prize_amount'] = amount if type(amount) in (int, float) and 0 <= amount < float('inf') else None
    score = data['score']
    data['score'] = max(0, min(100, score)) if type(score) in (int, float) else 0
    tags = data['tags'] if isinstance(data['tags'], list) else []
    tags = [x.strip()[:80] for x in tags if isinstance(x, str) and x.strip()]
    text = ' '.join(str(event.get(k) or '') for k in ('title', 'description')).casefold()
    patterns = {'web': r'\bweb\b|веб', 'ai': r'\bai\b|\bии\b|искусственн', 'ml': r'\bml\b|machine learning', 'olympiad': r'olympiad|олимпиад', 'grant': r'grant|грант', 'ctf': r'\bctf\b', 'ai-security': r'llm security|ai security|prompt injection|red team',
                'ai-agents': r'ai agents?|ии.агент', 'hackathon': r'hackathon|хакатон',
                'programming': r'coding|программ|алгоритм|codeforces'}
    tags.extend(tag for tag, pattern in patterns.items() if re.search(pattern, text))
    data['tags'] = sorted(set(tags))
    if not data['category']:
        data['category'] = next((tag for tag in patterns if tag in data['tags']), None)
    if not data['category']:
        data['category'] = {'Codeforces': 'programming', 'Олимпиада.ру': 'olympiad', 'AIcrowd': 'ml', 'Devpost': 'hackathon', 'CTFtime': 'ctf', 'CTFNews': 'ctf'}.get(event.get('source'))
    if data['prize_amount'] is None and isinstance(data['prize'], str):
        match = re.fullmatch(r'\s*([$€₽])\s*(\d+(?:[.,]\d{1,2})?)\s*|\s*(\d+(?:[.,]\d{1,2})?)\s*([$€₽])\s*', data['prize'])
        if match:
            symbol, amount = (match[1], match[2]) if match[1] else (match[4], match[3])
            data['prize_amount'] = float(amount.replace(',', '.'))
            data['prize_currency'] = {'$':'USD', '€':'EUR', '₽':'RUB'}[symbol]
    return data


def _ended(data, now):
    return data.get('status') == 'ended' or sources.expired(data.get('end'), now)


def _save(db, data, input_hash, completion_at=None):
    identity = data['id']
    payload = encoded(data)
    db.execute('INSERT INTO events(id,data,input_hash,created_at,updated_at,completion_at,normalization_version) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
               'data=excluded.data,input_hash=excluded.input_hash,updated_at=excluded.updated_at,completion_at=coalesce(excluded.completion_at,events.completion_at),normalization_version=excluded.normalization_version',
               (identity, payload, input_hash, data['created_at'], data['updated_at'], completion_at, NORMALIZATION_VERSION))
    db.execute('INSERT INTO history(event_id,changed_at,data) VALUES (?,?,?)',
               (identity, data['updated_at'], payload))
    db.execute('DELETE FROM events_fts WHERE id=?', (identity,))
    db.execute('INSERT INTO events_fts VALUES (?,?,?,?)',
               (identity, data['title'], data['description'], ' '.join(data['tags'])))



def _fingerprint(event):
    # Ignore volatile ingestion timestamps and tracking URL parameters.
    relevant = {key: event[key] for key in (*FIELDS, 'rules_text', 'rules_url', 'end', 'finish', 'endDate')
                if key in event and key not in ('id', 'url', 'created_at', 'updated_at')}
    return hashlib.sha256(encoded(relevant).encode()).hexdigest()


def _merge(db, identities, stamp):
    rows = [db.execute('SELECT id,data,input_hash,completion_at FROM events WHERE id=?', (identity,)).fetchone()
            for identity in set(identities)]
    rows.sort(key=lambda row: (json.loads(row[1])['created_at'], row[0]))
    winner, payload, fingerprint, completion = rows[0]
    data = json.loads(payload)
    for loser, other_payload, _, other_completion in rows[1:]:
        other = json.loads(other_payload)
        for key in FIELDS:
            if data.get(key) is None and other.get(key) is not None:
                data[key] = other[key]
        data['tags'] = sorted(set(data['tags']) | set(other['tags']))
        completion = completion or other_completion
        db.execute('UPDATE aliases SET event_id=? WHERE event_id=?', (winner, loser))
        db.execute('UPDATE history SET event_id=? WHERE event_id=?', (winner, loser))
        db.execute('UPDATE analysis_cache SET event_id=? WHERE event_id=?', (winner, loser))
        db.execute('UPDATE event_redirects SET event_id=? WHERE event_id=?', (winner, loser))
        db.execute('INSERT OR REPLACE INTO event_redirects VALUES (?,?)', (loser, winner))
        db.execute('DELETE FROM events_fts WHERE id=?', (loser,))
        db.execute('DELETE FROM events WHERE id=?', (loser,))
    if len(rows) > 1:
        data.update(id=winner, updated_at=stamp)
        _save(db, data, fingerprint, completion)
    return winner


def import_legacy(db, path):
    """Keep old delivery hashes as provenance, never hide public catalog records."""
    if not path or not Path(path).exists():
        return
    if Path(path).suffix.lower() == '.json':
        state = json.loads(Path(path).read_text(encoding='utf-8'))
        values = state.get('keys', []) if isinstance(state, dict) else state
        if not isinstance(values, list):
            raise ValueError('Invalid legacy hashes')
        db.executemany('INSERT OR IGNORE INTO legacy_hashes VALUES (?)',
                       [(value,) for value in values if isinstance(value, str) and re.fullmatch(r'[a-fA-F0-9]{64}', value)])
        return
    # The former delivery database contains only hashed dedupe aliases.
    with closing(sqlite3.connect(f'file:{Path(path).resolve()}?mode=ro', uri=True)) as old:
        tables = {row[0] for row in old.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        values = []
        for table in ('sent', 'deliveries', 'aliases'):
            if table not in tables:
                continue
            columns = [row[1] for row in old.execute(f'PRAGMA table_info({table})')]
            column = next((key for key in ('alias', 'hash', 'key', 'event_key') if key in columns), None)
            if column:
                values.extend(row[0] for row in old.execute(f'SELECT {column} FROM {table}'))
        db.executemany('INSERT OR IGNORE INTO legacy_hashes VALUES (?)',
                       [(value,) for value in values if isinstance(value, str) and re.fullmatch(r'[a-fA-F0-9]{64}', value)])


def _atomic_json(target, value):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent, delete=False) as stream:
            temporary = stream.name
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def export_catalog(db, path):
    items = [json.loads(row[0]) for row in db.execute('SELECT data FROM events ORDER BY id')]
    replacements = dict(db.execute('SELECT old_id,event_id FROM event_redirects ORDER BY old_id'))
    target = Path(path)
    _atomic_json(target.with_name('catalog-aliases.json'), replacements)
    _atomic_json(target, items)
    return items


def run(db_path, export_path, legacy_path=None, events=None, analyzer=None, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    stamp = now.isoformat()
    analyzer = analyzer or analysis.analyze
    with closing(connect(db_path)) as db:
        with db:
            import_legacy(db, legacy_path)
            for identity, payload, fingerprint, completion in db.execute(
                    'SELECT id,data,input_hash,completion_at FROM events WHERE normalization_version < ?',
                    (NORMALIZATION_VERSION,)).fetchall():
                old = json.loads(payload)
                normalized = _metadata(old, {})
                normalized['id'] = identity
                _save(db, normalized, fingerprint, completion)
        with db:
            run_id = db.execute("INSERT INTO collector_runs(started_at,status) VALUES (?,'running')", (stamp,)).lastrowid
        interrupted = False
        def source_done(name, status, count):
            nonlocal interrupted
            if status == 'error':
                interrupted = True
            with db:
                db.execute('INSERT INTO source_runs VALUES (?,?,?,?) ON CONFLICT(run_id,source) '
                           'DO UPDATE SET records=max(records,excluded.records),'
                           "status=CASE WHEN excluded.status='empty' AND records>0 THEN status ELSE excluded.status END",
                           (run_id, name, count, status))
        candidates = iter(sources.collect(on_source=source_done) if events is None else events)
        while True:
            try:
                event = next(candidates)
            except StopIteration:
                break
            except Exception as exc:
                interrupted = True
                LOG.warning('Collection interrupted (%s); preserving catalog', type(exc).__name__)
                break
            try:
                if not isinstance(event, dict) or not all(isinstance(event.get(k), str) and event[k].strip() for k in ('title', 'url', 'source')):
                    continue
                with db:
                    db.execute("INSERT INTO source_runs VALUES (?,?,1,'observed') ON CONFLICT(run_id,source) DO UPDATE SET records=records+1", (run_id, event['source']))
                keys = aliases(event)
                if not keys:
                    continue
                fingerprint = _fingerprint(event)
                canonical = next(key for key in keys if key.startswith('https://'))
                with db:
                    matches = [db.execute('SELECT event_id FROM aliases WHERE alias=?', (key,)).fetchone() for key in keys]
                    identities = {row[0] for row in matches if row}
                    identity = _merge(db, identities, stamp) if identities else hashlib.sha256(keys[0].encode()).hexdigest()[:24]
                    previous = db.execute('SELECT data,input_hash FROM events WHERE id=?', (identity,)).fetchone()
                    cached = db.execute('SELECT result FROM analysis_cache WHERE source=? AND canonical_url=? AND fingerprint=?',
                                        (event['source'], canonical, fingerprint)).fetchone()
                    if not cached:
                        result = analyzer(dict(event))
                        data = _metadata(event, result)
                        # A sparse listing must not erase prior detail after a fetch failure.
                        old = json.loads(previous[0]) if previous else {}
                        for key in FIELDS:
                            if data[key] is None and old.get(key) is not None:
                                data[key] = old[key]
                        data['tags'] = sorted(set(data['tags']) | set(old.get('tags', [])))
                        data.update(id=identity, created_at=old.get('created_at', stamp), updated_at=stamp)
                        completion = next((_date(event.get(k)) for k in ('end', 'finish', 'endDate') if _date(event.get(k))), None)
                        data['status'] = 'ended' if _ended({'status':event.get('status'), 'end':completion}, now) else 'active'
                        if sources.expired(data.get('deadline'), now):
                            data['registration_open'] = False
                        _save(db, data, fingerprint, completion)
                        db.execute('INSERT INTO analysis_cache VALUES (?,?,?,?,?)',
                                   (event['source'], canonical, fingerprint, encoded(result), identity))
                    db.executemany('INSERT OR IGNORE INTO aliases VALUES (?,?)', [(key, identity) for key in keys])
            except Exception as exc:
                LOG.warning('Catalog record skipped (%s)', type(exc).__name__)
        # Absence from an unreliable feed is never evidence that an event ended.
        with db:
            for payload, fingerprint, completion in db.execute('SELECT data,input_hash,completion_at FROM events').fetchall():
                data = json.loads(payload)
                changed = False
                if data['status'] != 'ended' and _ended({'end':completion}, now):
                    data['status'] = 'ended'
                    changed = True
                if data.get('registration_open') is not False and sources.expired(data.get('deadline'), now):
                    data['registration_open'] = False
                    changed = True
                if changed:
                    data['updated_at'] = stamp
                    _save(db, data, fingerprint, completion)
            db.execute('UPDATE collector_runs SET finished_at=?,status=? WHERE id=?', (dt.datetime.now(dt.timezone.utc).isoformat(), 'partial' if interrupted else 'completed', run_id))
        try:
            return export_catalog(db, export_path)
        except Exception as exc:
            with db:
                db.execute("UPDATE collector_runs SET status='export_failed',error=? WHERE id=?", (type(exc).__name__, run_id))
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--export', required=True)
    parser.add_argument('--legacy')
    args = parser.parse_args()
    run(args.db, args.export, args.legacy)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
