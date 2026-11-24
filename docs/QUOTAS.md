# Бесплатный контур
Проверено 24 ноября 2026 года. Workers Free допускает 100 000 запросов в сутки, 10 мс CPU на вызов, 50 подзапросов и пять Cron Triggers на аккаунт. Статические файлы и API доступны с одного origin. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

D1 Free включает 5 млн прочитанных и 100 тыс. записанных строк за сутки, 5 ГБ суммарно, до 500 МБ на базу. Индексы также расходуют записи. Использовать Workers Free, не включать биллинг Workers Paid. [Тариф D1](https://developers.cloudflare.com/d1/platform/pricing/) · [Лимиты D1](https://developers.cloudflare.com/d1/platform/limits/)

Supabase Free предлагает PostgreSQL 500 МБ, 5 ГБ исходящего трафика, 50 тыс. активных пользователей в месяц и два активных проекта. Простой в течение недели может приостановить проект. D1 выбран для доступа через binding Worker без отдельного привилегированного ключа. Локальная SQLite используется для сбора и резервной публичной копии. [Supabase pricing](https://supabase.com/pricing)

Стандартный runner публичного GitHub-репозитория выполняет одну задачу в сутки. Расписание может задерживаться. Gemini выключен по умолчанию и требует доступного Free Tier в проекте без биллинга. Квоты модели зависят от аккаунта. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
