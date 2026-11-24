"""Local secret setup. No network or messages without an explicit subcommand."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

from delivery import DeliveryError, _http

FIELDS = ('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN')
ALLOWED = set(FIELDS) | {'STATE_BRANCH', 'MIN_SCORE', 'GEMINI_API_KEY', 'GEMINI_MODEL',
    'GEMINI_ENABLED', 'GEMINI_ADULT_CONFIRMED', 'GEMINI_AVAILABLE_REGION_CONFIRMED',
    'GEMINI_FREE_TIER_CONFIRMED', 'GEMINI_DAILY_LIMIT', 'GEMINI_QUOTA_PATH'}


def read_env(path):
    """Parse a deliberately small dotenv subset; never execute shell syntax."""
    path = Path(path)
    if path.is_symlink():
        raise ValueError('Refusing a symlink environment file')
    if not path.exists():
        return {}
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError('Environment file must have mode 0600; run chmod 600 .env')
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, raw = line.partition('=')
        if not sep or key not in ALLOWED:
            raise ValueError('Unknown or malformed environment entry')
        value = json.loads(raw) if raw.startswith('"') else raw
        if not isinstance(value, str) or any(c in value for c in '\r\n\x00'):
            raise ValueError('Invalid environment value')
        values[key] = value
    return values


def write_env(path, values):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('Refusing a symlink environment file')
    fd, temporary = tempfile.mkstemp(prefix='.olympradar-env-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            for key, value in sorted(values.items()):
                if key not in ALLOWED or not isinstance(value, str) or any(c in value for c in '\r\n\x00'):
                    raise ValueError('Invalid environment entry')
                output.write(f'{key}={json.dumps(value)}\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def configure(path):
    if not sys.stdin.isatty():
        raise ValueError('Configure requires a terminal for hidden input')
    values = read_env(path)
    print('Hidden input; Enter keeps an existing value. No messages will be sent.')
    for key in FIELDS:
        value = getpass.getpass(f'{key}: ').strip()
        if value:
            values[key] = value
    values.setdefault('STATE_BRANCH', 'radar-state')
    values.setdefault('MIN_SCORE', '45')
    values.setdefault('GEMINI_ENABLED', '0')
    write_env(path, values)
    print('Saved environment file with permissions 0600.')


def load_env(path):
    for key, value in read_env(path).items():
        os.environ.setdefault(key, value)


def telegram(method, payload):
    token = os.getenv('TELEGRAM_BOT_TOKEN', '')
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token):
        raise ValueError('Missing or malformed TELEGRAM_BOT_TOKEN')
    result = _http(f'https://api.telegram.org/bot{token}/{method}', method='POST', payload=payload)
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise DeliveryError('Telegram did not confirm request; no automatic retry.')
    return result.get('result')


def discover_chat(path):
    updates = telegram('getUpdates', {'timeout': 0, 'limit': 100})
    if not isinstance(updates, list):
        raise DeliveryError('Invalid Telegram update response')
    chats = {}
    for update in updates:
        if not isinstance(update, dict):
            continue
        message = update.get('message') or update.get('channel_post') or {}
        chat = message.get('chat', {}) if isinstance(message, dict) else {}
        identifier = chat.get('id')
        if type(identifier) is int:
            chats[str(identifier)] = str(chat.get('type', 'unknown'))
    if not chats:
        print('No chats found. Send /start to the bot and run discover-chat again. Existing webhook/another poller may prevent getUpdates; this tool does not remove webhooks.')
        return
    # Avoid displaying names, usernames, message text, or tokens.
    for identifier, kind in chats.items():
        print(f'{identifier} ({kind})')
    chosen = input('Chat ID to save (Enter leaves file unchanged): ').strip()
    if not chosen:
        return
    if chosen not in chats:
        raise ValueError('Choose an ID from discovered chats')
    values = read_env(path)
    values['TELEGRAM_CHAT_ID'] = chosen
    write_env(path, values)
    print('Saved TELEGRAM_CHAT_ID. No messages sent.')


def test_send():
    chat = os.getenv('TELEGRAM_CHAT_ID', '')
    if not re.fullmatch(r'-?\d+|@[A-Za-z0-9_]+', chat):
        raise ValueError('Missing or malformed TELEGRAM_CHAT_ID')
    # This explicit command sends exactly one request, outside the event journal.
    result = telegram('sendMessage', {'chat_id': chat, 'text': 'OlympRadar: тест подключения.',
                                    'link_preview_options': {'is_disabled': True}})
    if not isinstance(result, dict) or type(result.get('message_id')) is not int or result['message_id'] <= 0:
        raise DeliveryError('Telegram returned no valid message_id; outcome unknown, no retry.')
    print(f'Test delivered; message_id={result["message_id"]}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='.env')
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('configure', 'discover-chat', 'test-send'):
        sub.add_parser(command)
    run = sub.add_parser('run')
    run.add_argument('--send', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.command == 'configure':
            configure(args.env_file)
        else:
            load_env(args.env_file)
            if args.command == 'discover-chat':
                discover_chat(args.env_file)
            elif args.command == 'test-send':
                test_send()
            else:
                import radar
                return radar.run(send=args.send)
    except (OSError, ValueError, DeliveryError):
        # Parser/OS errors can include secret input or paths: keep the UI sanitized.
        print('Operation failed. Check configuration, file permissions, and service access. No automatic retry.')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
