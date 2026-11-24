"""Connect the existing bot to a deployed OlympRadar worker."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from setup_local import load_env, telegram


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('origin', help='Deployed OlympRadar HTTPS origin')
    parser.add_argument('--config', default='wrangler.live.jsonc')
    args = parser.parse_args()
    url = urlsplit(args.origin)
    if url.scheme != 'https' or not url.hostname or url.netloc != url.hostname or url.path not in ('', '/'):
        parser.error('Expected bare HTTPS origin')
    origin = f'https://{url.hostname}'
    load_env(ROOT / '.env')
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
    if not re.fullmatch(r'\d+:[\w-]+', token):
        parser.error('Missing bot token')
    secret = secrets.token_urlsafe(36)
    subprocess.run(['npx', '--no-install', 'wrangler', 'secret', 'bulk', '--config', args.config],
                   input=json.dumps({'TELEGRAM_BOT_TOKEN': token, 'WEBHOOK_SECRET': secret}), cwd=ROOT/'worker', text=True, check=True)
    endpoint = origin + '/telegram'
    telegram('setWebhook', {'url': endpoint, 'secret_token': secret, 'max_connections': 1, 'allowed_updates': ['message', 'callback_query']})
    telegram('setMyCommands', {'commands': [{'command': 'start', 'description': 'Главное меню'}, {'command': 'search', 'description': 'Поиск мероприятий'}]})
    telegram('setChatMenuButton', {'menu_button': {'type': 'commands'}})
    state = telegram('getWebhookInfo', {})
    if state.get('url') != endpoint or 'callback_query' not in state.get('allowed_updates', []):
        raise SystemExit('Webhook verification failed')
    print('Webhook and Telegram command menu configured.')


if __name__ == '__main__':
    main()
