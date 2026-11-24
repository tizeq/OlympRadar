# Развёртывание
Используйте публичный GitHub-репозиторий со стандартным Linux runner, Cloudflare Workers Free и D1. Ветка catalog-data хранит публичные catalog.sqlite, catalog.json и catalog-aliases.json. Ветка radar-state используется только для импорта исторических хешей v1. Расписание обновления в .github/workflows/radar.yml, есть ручной запуск.

Проверка из корня проекта:

```bash
python -m unittest discover -s tests
(cd worker && npm ci && npm test)
python -m collector --db .state/catalog.sqlite --export .state/catalog.json
```

В каталоге worker выполните wrangler login, затем создайте или выберите существующую D1 olympradar на бесплатном плане. Скопируйте wrangler.jsonc в игнорируемый wrangler.live.jsonc и укажите настоящий database_id. Примените миграции и опубликуйте webhook:

```bash
npx wrangler d1 migrations apply DB --remote -c wrangler.live.jsonc
npx wrangler deploy -c wrangler.live.jsonc
```

В корне проекта положите TELEGRAM_BOT_TOKEN в локальный файл .env с правами 0600. Подключите опубликованный HTTPS-адрес Worker:

```bash
python tools/connect_telegram.py https://olympradar.ВАШ-ПОДДОМЕН.workers.dev
```

Команда регистрирует webhook для сообщений и нажатий, настраивает список команд и проверяет конфигурацию Telegram. Первый Cron импортирует каталог; для немедленной загрузки опубликованной ветки используйте tools/seed-catalog.mjs и wrangler d1 execute, из каталога worker:

```bash
# Из корня проекта, где .state/catalog — рабочая копия ветки catalog-data
node tools/seed-catalog.mjs .state/bootstrap.sql .state/catalog
(cd worker && npx wrangler d1 execute DB --remote -c wrangler.live.jsonc --file ../.state/bootstrap.sql --yes)
```
 Не помещайте персональную D1 в публичную ветку.
