# Бесплатный запуск OlympRadar

Создайте **публичный** GitHub-репозиторий с этим кодом. Workflow намеренно пропускает private repositories: стандартные GitHub-hosted runners публичных репозиториев бесплатны; larger runners платные. Встроенный workflow использует только `ubuntu-latest`, стандартную библиотеку Python и запуск каждые два часа. [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Однократная настройка

1. Через GitHub UI создайте ветку `radar-state` от основной ветки. В этой ветке создайте файл `.radar-state.json` с содержимым `{"version":1,"keys":[]}`. Не добавляйте этот файл в основную ветку. Не удаляйте и не откатывайте журнал: это разрешит повторные уведомления. Не используйте одну ветку состояния для разных получателей.
2. Создайте Telegram-бота через [BotFather](https://t.me/BotFather), откройте его в Telegram и нажмите Start. Для канала добавьте бота с правом публиковать сообщения. Узнайте `chat_id` через официальный `getUpdates` после сообщения боту; не передавайте токен сторонним сайтам. [Telegram introduction](https://core.telegram.org/bots/tutorial), [Bot API](https://core.telegram.org/bots/api#getupdates).
3. В Settings → Secrets and variables → Actions добавьте secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Необязательный `GEMINI_API_KEY` описан в [GEMINI.md](GEMINI.md). Необязательная repository variable `MIN_SCORE` задаёт порог, по умолчанию 45.
4. Разрешите GitHub Actions и запись `contents` для `GITHUB_TOKEN`. Если branch protection блокирует запись в `radar-state`, доставка остановится. Не снимайте защиту основной ветки.
5. Откройте Actions → OlympRadar → Run workflow. Ручной запуск всегда берёт код основной ветки. Проверьте результат и Telegram. Никогда не печатайте секреты или URL Bot API с токеном в логах.

Локальный безопасный просмотр: `python -m radar`. Локальная отправка: экспортируйте `GITHUB_REPOSITORY=owner/repo`, `GITHUB_TOKEN` с правом Contents write, Telegram secrets и запустите `python -m radar --send`. Локальный и облачный запуски используют один журнал. Не запускайте другую реализацию, обходящую резервирование.

Для Gemini настройте repository variables `GEMINI_MODEL`, `GEMINI_ENABLED`, `GEMINI_ADULT_CONFIRMED`, `GEMINI_AVAILABLE_REGION_CONFIRMED`, `GEMINI_FREE_TIER_CONFIRMED` согласно [GEMINI.md](GEMINI.md). По умолчанию подтверждения равны `0` и Gemini выключен. Workflow передаёт ключ только из secret `GEMINI_API_KEY`. На свежем runner нет постоянного SQLite: workflow консервативно фиксирует `GEMINI_DAILY_LIMIT=1` и `GEMINI_QUOTA_PATH` во временном каталоге runner. Поэтому допускается **не более одной попытки модели за запуск**, до 12 при штатном расписании за сутки; ручные запуски и rerun добавляют попытки. Это не глобальный дневной лимит. Не подключайте billing; без подтверждённого бесплатного проекта оставляйте Gemini выключенным.

## Расписание и журнал

Расписание `17 */2 * * *` — каждые два часа, в 00:17, 02:17, …, 22:17 UTC (по Москве 03:17, 05:17, …, 01:17). Cron выполняется с основной ветки, допускает задержки и пропуски; в публичных репозиториях GitHub отключает расписание после 60 дней без активности. Периодически проверяйте Actions и при необходимости снова включайте workflow. Точное время доставки не гарантируется. [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Перед запросом Telegram приложение сохраняет SHA-256 всех псевдонимов события в `.radar-state.json` через GitHub Contents API. Обновление передаёт текущий SHA файла: конфликт конкурирующих записей приводит к отказу, а не к отправке. Один workflow concurrency group дополнительно предотвращает параллельные запуски; `cancel-in-progress: false` защищает текущий процесс от отмены новым запуском. [Contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents), [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

Если файл отсутствует, повреждён, недоступен, запись запрещена или результат сохранения неопределён — отправки нет. При найденном псевдониме новые псевдонимы сохраняются, повторной отправки нет. GitHub cache и artifacts не используются для дедупликации: cache может удаляться после семи дней без обращения. [Cache retention](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy).

Гарантия — **не более одной попытки отправки** для известных псевдонимов, а не гарантированное получение. Авария после резервирования и до Telegram теряет уведомление. Тайм-аут, HTTP 429/5xx или неоднозначный ответ Telegram не повторяются: резервирование остаётся. Bot API `sendMessage` не предоставляет ключ идемпотентности; автоматически безопасно повторить неопределённую отправку нельзя. Приложение отправляет обычный текст до 4000 символов без платного broadcast. [sendMessage](https://core.telegram.org/bots/api#sendmessage).

Резервирование необратимо в обычном режиме. После сбоя изучите лог и Telegram вручную; откат журнала может создать дубли. Изменённые названия/адреса без общего псевдонима могут обойти дедупликацию. Журнал публичен и содержит только хеши идентификаторов событий, но хеширование не делает предсказуемые данные секретными.

## Проверка

`python -m unittest discover -s tests` запускает локальные тесты, включая имитацию перезапуска, неизвестного результата Telegram, недоступного/повреждённого журнала, связывания псевдонимов и конкурирующего чтения. Тесты не отправляют сообщения и не обращаются в сеть.
