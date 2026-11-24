# Развёртывание OlympRadar 2

## Сбор и перенос состояния

Ежедневный workflow основной ветки запускается в 03:17 UTC и поддерживает Run workflow. Публичная ветка catalog-data содержит catalog.sqlite и catalog.json. SQLite хранит историю и служит входом следующего запуска. Файл .radar-state.json ветки radar-state содержит только прежние хеши резервирований. Заголовки и правила восстанавливаются повторным сбором, старые недоступные карточки из хешей восстановить нельзя. Никогда не копируйте в catalog-data персональную базу D1 или файл .env.

Для автономной локальной проверки выполните:

```bash
python -m unittest discover -s tests
python -m collector --db .state/dev.sqlite --export .state/catalog.json
(cd frontend && npm ci && npm run build)
(cd worker && npm ci && npm test)
(cd worker && npx wrangler d1 migrations apply DB --local)
(cd worker && npx wrangler dev --local --test-scheduled)
```

## Cloudflare Free

Потребуются существующий бесплатный аккаунт Cloudflare и Node 22 или новее. Соберите frontend и установите зависимости Worker, как показано выше. В каталоге worker выполните:

```bash
npx wrangler login
npx wrangler d1 create olympradar
cp wrangler.jsonc wrangler.live.jsonc
```

В локальной копии конфигурации укажите полученный database_id. При повторной выкладке используйте прежнюю БД. CLI может предложить обновить исходный файл автоматически; для публикации выбирайте локальную копию с реальным ID. Примените миграции и опубликуйте Worker с собранными статическими файлами:

```bash
npx wrangler d1 migrations apply DB --remote --config wrangler.live.jsonc
npx wrangler deploy --config wrangler.live.jsonc
```

Из корня проекта выполните команду ниже с фактическим HTTPS-адресом Worker. Скрипт берёт токен из локального .env, генерирует секрет webhook и передаёт секреты Wrangler через stdin. После проверки getWebhookInfo откройте чат с ботом и нажмите «Каталог». Первый Cron заполняет D1 из публичного снимка. Если каталог ещё пуст, проверьте Worker Logs и таблицу sync_state.

```bash
python tools/connect_telegram.py https://olympradar.ВАШ-ПОДДОМЕН.workers.dev
```

Пользователь открывает каталог в личном чате Telegram. Для сводки он сохраняет фильтр и выбирает время, часовой пояс и порог в настройках. До подключения боевого webhook старая поштучная доставка отключена.
