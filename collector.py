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

FIELDS = ('id title url source description category tags start end registration_start registration_end deadline prize format restrictions '
          'ai_policy registration_url country age_min age_max free prize_amount prize_currency '
          'difficulty registration_open score status created_at updated_at').split()
LOG = logging.getLogger(__name__)
NORMALIZATION_VERSION = 2
DATE_FIELDS = ('start', 'end', 'registration_start', 'registration_end', 'deadline')
EVENT_TYPES = {
    'ctf': r'(?:\b|[a-z0-9])ctf\b|capture[ -]the[ -]flag',
    'hackathon': r'\bhackathons?\b|\bхакатон\w*',
    'olympiad': r'\bolympiads?\b|\bолимпиад\w*',
    'grant': r'\bgrants?\b|\bгрант(?:ы|а|ов|ом|ам|ами|ах|у)?\b',
}
TOPICS = {
    'web': r'\bweb\b|\bвеб(?:[ -]|\b)',
    'ai': (r'\b(?:ai|ии|artificial intelligence|genai|llms?|gpt)\b|'
           r'искусственн\w*\s+интеллект\w*|нейро(?:сет\w*|нн\w*\s+сет\w*)|'
           r'нейросет\w*|neural networks?|deep learning|языков\w*\s+модел\w*'),
    'ml': r'\bml\b|machine[ -]learning|машинн\w*\s+обучен\w*|глубок\w*\s+обучен\w*',
    'ai-security': r'(?:llm|ai)[ -]security|prompt injection|безопасност\w*\s+ии\b',
    'ai-agents': r'\bai[ -]agents?\b|\bии[ -]агент\w*',
    'programming': r'\bcoding\b|программирован\w*|алгоритм\w*|\bcodeforces\b',
}
# These catalogs publish a single event format. A news site's general subject
# does not establish the type of each individual announcement.
SOURCE_TYPES = {'Codeforces': 'programming', 'CTFtime': 'ctf',
                'Олимпиада.ру': 'olympiad', 'Devpost': 'hackathon'}


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
    if version < 4:
        db.executescript((schema.parent / '004_registration.sql').read_text(encoding='utf-8'))
    if version < 5:
        db.executescript((schema.parent / '005_withdrawn.sql').read_text(encoding='utf-8'))
    return db


def _date(value):
    if not isinstance(value, str):
        return None
    try:
        value = value.strip()
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            return dt.date.fromisoformat(value).isoformat()
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?', value):
            return None
        moment = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return moment.astimezone(dt.timezone.utc).isoformat() if moment.tzinfo else moment.isoformat()
    except (ValueError, OverflowError):
        return None


def _metadata(event, result):
    data = {key: event.get(key) for key in FIELDS}
    for key, value in result.items():
        if key in FIELDS and key not in DATE_FIELDS and value not in (None, '', analysis.UNKNOWN):
            data[key] = value
    for key in FIELDS:
        if data[key] == analysis.UNKNOWN:
            data[key] = None
    for key in DATE_FIELDS:
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
    title = str(event.get('title') or '').casefold()
    description = str(event.get('description') or '').casefold()
    text = ' '.join([title, description, *(value.casefold() for value in tags)])
    # A rule about using assistants does not establish the subject of the contest.
    topical_text = ' '.join([title, *(value.casefold() for value in tags), *(
        sentence for sentence in re.split(r'[.!?;\n]+', description)
        if not re.search(r'\b(?:allowed|prohibited|forbidden|permitted)\b|разрешен|разрешён|запрещен|запрещён',
                         sentence)
    )])
    explicit_type = event.get('category')
    data['category'] = explicit_type if explicit_type in {*EVENT_TYPES, 'programming'} else None
    if not data['category']:
        data['category'] = next((kind for kind, pattern in EVENT_TYPES.items()
                                 if re.search(pattern, title)), SOURCE_TYPES.get(event.get('source')))
    if not data['category']:
        kinds = [kind for kind, pattern in EVENT_TYPES.items() if re.search(pattern, text)]
        if len(kinds) == 1:
            data['category'] = kinds[0]
    if data['category']:
        tags.append(data['category'])
    for topic, pattern in TOPICS.items():
        if re.search(pattern, topical_text):
            tags.append(topic)
    if explicit_type in TOPICS:
        tags.append(explicit_type)
    if any(tag in {'ml', 'ai-security', 'ai-agents'} for tag in tags):
        tags.append('ai')
    data['tags'] = sorted(set(tags))
    if data['prize_amount'] is None and isinstance(data['prize'], str):
        match = re.fullmatch(
            r'\s*(USD|US\$|EUR|RUB|[$€₽])\s*(\d+(?:[.,]\d{1,2})?)\s*|'
            r'\s*(\d+(?:[.,]\d{1,2})?)\s*(USD|US\$|EUR|RUB|[$€₽])\s*', data['prize'], re.I)
        if match:
            symbol, amount = (match[1], match[2]) if match[1] else (match[4], match[3])
            data['prize_amount'] = float(amount.replace(',', '.'))
            data['prize_currency'] = {'US$': 'USD', 'USD': 'USD', '€': 'EUR', 'EUR': 'EUR',
                                      '₽': 'RUB', 'RUB': 'RUB'}.get(symbol.upper())
    return data


def _registration_state(data, hint, now):
    start, end = data.get('registration_start'), data.get('registration_end')
    if sources.expired(end, now):
        return False
    if start:
        opening = dt.datetime.fromisoformat(start)
        if opening.tzinfo:
            future = now < opening
        else:
            future = now.date() < opening.date()
        if future:
            return False
    if hint is not None:
        return bool(hint)
    if start and end:
        # A local time without an offset cannot establish the current instant.
        for edge in (start, end):
            moment = dt.datetime.fromisoformat(edge)
            if moment.tzinfo is None and len(edge) > 10 and moment.date() == now.date():
                return None
        return True
    return None


def _ended(data, now):
    if data.get('status') == 'ended' or sources.expired(data.get('end'), now):
        return True
    # The NLnet record represents an application round; its proposal cutoff ends that round.
    return data.get('source') == 'NLnet' and data.get('category') == 'grant' and sources.expired(data.get('deadline'), now)


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
        db.execute('UPDATE events SET registration_hint=coalesce(registration_hint,'
                   '(SELECT registration_hint FROM events WHERE id=?)) WHERE id=?', (loser, winner))
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
                # Older tags and categories mixed topics with event formats.
                # Rebuild generated tags from the evidence retained in the row.
                old['tags'] = [tag for tag in old.get('tags', []) if tag not in {*TOPICS, *EVENT_TYPES}]
                old['category'] = None
                description = old.get('description') or ''
                if ((old.get('source') == 'CTFNews' and 'Главная Что такое CTF Календарь' in description)
                        or (old.get('source') == 'Олимпиада.ру' and 'Олимпиады Новости Журнал Москва' in description)):
                    # Old HTML adapters included navigation and unrelated news.
                    # The previous version is still available in the history.
                    old['description'] = None
                    db.execute('DELETE FROM analysis_cache WHERE event_id=?', (identity,))
                if isinstance(old.get('prize'), str) and '$' in old['prize'] and 'US' not in old['prize'].upper():
                    old['prize_currency'] = None
                old['end'] = old.get('end') or completion
                if old.get('registration_open') is False and old.get('deadline') and not old.get('registration_end'):
                    old['registration_open'] = None
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
                    last_seen = db.execute(
                        'SELECT fingerprint FROM source_versions WHERE source=? AND canonical_url=?',
                        (event['source'], canonical)).fetchone()
                    if not last_seen or last_seen[0] != fingerprint:
                        result = json.loads(cached[0]) if cached else analyzer(dict(event))
                        data = _metadata(event, result)
                        # A sparse listing must not erase prior detail after a fetch failure.
                        old = json.loads(previous[0]) if previous else {}
                        for key in FIELDS:
                            if data[key] is None and old.get(key) is not None:
                                data[key] = old[key]
                        if not event.get('description') and old.get('description'):
                            data['tags'] = _metadata(data, {})['tags']
                        data.update(id=identity, created_at=old.get('created_at', stamp), updated_at=stamp)
                        completion = next((_date(event.get(k)) for k in ('end', 'finish', 'endDate') if _date(event.get(k))), None)
                        data['end'] = completion or data['end']
                        status = event.get('status') or (None if completion else old.get('status'))
                        data['status'] = 'ended' if _ended({'status': status, 'end': data['end']}, now) else 'active'
                        row = db.execute('SELECT registration_hint FROM events WHERE id=?', (identity,)).fetchone()
                        hint = event.get('registration_open')
                        if type(hint) is not bool:
                            hint = row[0] if row else None
                        data['registration_open'] = _registration_state(data, hint, now)
                        _save(db, data, fingerprint, completion)
                        db.execute('UPDATE events SET registration_hint=? WHERE id=?', (hint, identity))
                        db.execute('INSERT OR IGNORE INTO analysis_cache VALUES (?,?,?,?,?)',
                                   (event['source'], canonical, fingerprint, encoded(result), identity))
                        db.execute('INSERT INTO source_versions VALUES (?,?,?) '
                                   'ON CONFLICT(source,canonical_url) DO UPDATE SET fingerprint=excluded.fingerprint',
                                   (event['source'], canonical, fingerprint))
                    db.executemany('INSERT OR IGNORE INTO aliases VALUES (?,?)', [(key, identity) for key in keys])
            except Exception as exc:
                LOG.warning('Catalog record skipped (%s)', type(exc).__name__)
        # Absence from an unreliable feed is never evidence that an event ended.
        with db:
            for payload, fingerprint, completion, hint in db.execute('SELECT data,input_hash,completion_at,registration_hint FROM events').fetchall():
                data = json.loads(payload)
                changed = False
                if data['status'] != 'ended' and _ended(dict(data, end=data.get('end') or completion), now):
                    data['status'] = 'ended'
                    changed = True
                registration = _registration_state(data, hint, now)
                if data.get('registration_open') != registration:
                    data['registration_open'] = registration
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
