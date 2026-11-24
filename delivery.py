"""Durable at-most-once reservations; Telegram requests are never retried."""
import base64
import hashlib
import json
import os
import re
from urllib import error, parse, request


class DeliveryError(RuntimeError):
    """Sanitized error: never include credentials or a Telegram request URL."""


def _http(url, method='GET', payload=None, headers=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = request.Request(url, data=body, method=method,
                          headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with request.urlopen(req, timeout=25) as response:
            return json.load(response)
    except (OSError, ValueError) as exc:
        code = getattr(exc, 'code', None)
        raise DeliveryError(f'Remote request failed (HTTP {code or "unknown"}); no retry.') from None


def _hashes(keys):
    values = list(keys)
    if not values or any(not isinstance(key, str) or not key.strip() for key in values):
        raise DeliveryError('Reservation requires nonempty string keys.')
    return {hashlib.sha256(key.encode()).hexdigest() for key in values}


class GitHubJournal:
    def __init__(self):
        self.repo = os.environ.get('GITHUB_REPOSITORY', '')
        self.token = os.environ.get('GITHUB_TOKEN', '')
        self.branch = os.environ.get('STATE_BRANCH', 'radar-state')
        self.keys = None
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', self.repo) or not self.token:
            raise DeliveryError('GITHUB_REPOSITORY and GITHUB_TOKEN are required.')
        self.url = f'https://api.github.com/repos/{self.repo}/contents/.radar-state.json'
        self.headers = {'Authorization': f'Bearer {self.token}',
                        'Accept': 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28'}

    def _read(self):
        data = _http(self.url + '?ref=' + parse.quote(self.branch, safe=''), headers=self.headers)
        try:
            state = json.loads(base64.b64decode(data['content'], validate=False))
            keys = state['keys']
            if state['version'] != 1 or not isinstance(keys, list) or any(
                    not isinstance(k, str) or not re.fullmatch(r'[0-9a-f]{64}', k) for k in keys):
                raise ValueError()
            sha = data['sha']
            if not isinstance(sha, str) or not sha:
                raise ValueError()
            return set(keys), sha
        except (KeyError, ValueError, TypeError):
            raise DeliveryError('Invalid reservation journal; delivery blocked.') from None

    def known(self, keys):
        hashes = _hashes(keys)
        if self.keys is None:
            self.keys, _ = self._read()
        return bool(hashes & self.keys)

    def reserve(self, keys):
        hashes = _hashes(keys)
        # This optimization is safe: a reservation is never intentionally removed.
        if self.keys is not None and hashes <= self.keys:
            return False
        current, sha = self._read()
        duplicate = bool(hashes & current)
        if not hashes <= current:
            merged = current | hashes
            content = json.dumps({'version': 1, 'keys': sorted(merged)}, separators=(',', ':')) + '\n'
            result = _http(self.url, method='PUT', headers=self.headers, payload={
                'message': 'Reserve OlympRadar notification aliases', 'branch': self.branch,
                'sha': sha, 'content': base64.b64encode(content.encode()).decode()})
            if not isinstance(result, dict) or not result.get('commit', {}).get('sha'):
                raise DeliveryError('Unconfirmed journal update; delivery blocked.')
            current = merged
        self.keys = current
        return not duplicate


_journal = None


def _get_journal():
    global _journal
    if _journal is None:
        _journal = GitHubJournal()
    return _journal


def known(keys):
    return _get_journal().known(keys)


def reserve(keys):
    return _get_journal().reserve(keys)


def send(event, assessment):
    """Call only after reserve(keys) returned True. Never retry this operation."""
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
    chat = os.environ.get('TELEGRAM_CHAT_ID', '')
    if not token or not chat:
        raise DeliveryError('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.')
    lines = [str(event.get('title', 'Олимпиада'))[:500],
             f'Оценка: {assessment.get("score", "?")}/100']
    for label, field in [('ИИ', 'ai_policy'), ('Дедлайн', 'deadline'), ('Приз', 'prize'),
                         ('Формат', 'format'), ('Ограничения', 'restrictions')]:
        lines.append(f'{label}: {assessment.get(field) or "неизвестно"}'[:450])
    for field in ('url', 'registration_url', 'rules_url'):
        url = event.get(field)
        if isinstance(url, str) and url.startswith(('https://', 'http://')):
            lines.append(url[:400])
    # Plain text avoids injection through Markdown/HTML from remote sources.
    text = '\n'.join(lines)[:4000]
    result = _http(f'https://api.telegram.org/bot{token}/sendMessage', method='POST', payload={
        'chat_id': chat, 'text': text, 'link_preview_options': {'is_disabled': True}})
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise DeliveryError('Telegram did not confirm delivery; reservation retained, no retry.')
    return True
