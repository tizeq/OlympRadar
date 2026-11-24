import { queryEvents, safeUrl } from "./index.js";

const sections = {
  olympiad: "🏆 Олимпиады",
  ctf: "🚩 CTF",
  hackathon: "💻 Хакатоны",
  grant: "💰 Гранты",
};
const btn = (text, callback_data) => ({ text, callback_data });
const home = () => [btn("🏠 Главное меню", "home")];
const panel = (text, rows) => ({
  text,
  reply_markup: { inline_keyboard: rows },
});
const categories = Object.entries(sections).map(([id, name]) =>
  btn(name, "category:" + id),
);
const mainMenu = () =>
  panel("OlympRadar · Главное меню", [
    [btn("🔍 Поиск мероприятий", "search")],
    categories.slice(0, 2),
    categories.slice(2),
    [btn("⚙️ Фильтры", "filters"), btn("🔔 Подписки", "subs")],
  ]);
const options = {
  ai: ["Искусственный интеллект", "tag", "ai"],
  online: ["Онлайн", "format", "online"],
  free: ["Бесплатно", "free", true],
  open: ["Регистрация открыта", "registration_open", true],
  cash: ["Денежные призы", "cash", true],
  allowed: ["ИИ разрешён правилами", "ai_policy", "allowed"],
};
const CATEGORY_LABELS = {
  ...sections,
  ai: "ИИ",
  ml: "Машинное обучение",
  programming: "Программирование",
};
const clean = (value, max = 200) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);

async function telegram(env, method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (
    method === "editMessageText" &&
    result.error_code === 400 &&
    result.description?.includes("message is not modified")
  )
    return;
  if (!response.ok || !result.ok) {
    const reason = String(result.description ?? "").match(
      /bot was blocked|chat not found|message thread not found|BUTTON_DATA_INVALID|bot can't initiate conversation/i,
    )?.[0];
    console.error("Telegram rejected request", method, response.status, result.error_code ?? 0, reason ?? "");
    throw new Error("Telegram " + method + " failed");
  }
  if (method === "sendMessage") {
    console.info("Telegram message sent", result.result?.message_id);
  }
}
const emptyState = () => ({ mode: "browse", query: {}, page: 0 });

function queryLabel(q) {
  return (
    [
      q.q,
      CATEGORY_LABELS[q.category] || q.category,
      ...Object.values(options)
        .filter(([, key, v]) => q[key] === v)
        .map(([label]) => label),
      q.start_from && "Начало от " + q.start_from,
      q.deadline_to && "Дедлайн до " + q.deadline_to,
      q.registration_end_to && "Регистрация до " + q.registration_end_to,
    ]
      .filter(Boolean)
      .join(" · ") || "Все мероприятия"
  );
}

async function saved(db, uid) {
  return (
    await db
      .prepare(
        "SELECT id,name,query_json FROM saved_filters WHERE user_id=? ORDER BY created_at,id LIMIT 20",
      )
      .bind(uid)
      .all()
  ).results;
}
function filterPanel(state, filters) {
  return panel("Фильтры · " + queryLabel(state.query), [
    ...Object.entries(options).map(([id, [label, key, value]]) => [
      btn((state.query[key] === value ? "✓ " : "") + label, "option:" + id),
    ]),
    [
      btn("Начало от даты", "date:start_from"),
      btn("Дедлайн до даты", "date:deadline_to"),
    ],
    [btn("Регистрация до даты", "date:registration_end_to")],
    [btn("Показать результаты", "catalog"), btn("Сбросить", "reset")],
    [btn("Сохранить набор", "save")],
    ...filters.map((f) => [
      btn(clean(f.name, 45), "load:" + f.id),
      btn("Удалить", "delete:" + f.id),
    ]),
    home(),
  ]);
}
async function results(db, uid, state) {
  const size = 5;
  const result = await queryEvents(
    db,
    { ...state.query, page: Math.floor(state.page / 8) + 1 },
    uid,
  );
  if (state.page && state.page * size >= result.total) {
    state.page = 0;
    return results(db, uid, state);
  }
  const offset = (state.page % 8) * size;
  const rows = result.items
    .slice(offset, offset + size)
    .map((e) => [btn(clean(e.title, 80), "event:" + e.id)]);
  const nav = [];
  if (state.page > 0) nav.push(btn("← Назад", "page:" + (state.page - 1)));
  if ((state.page + 1) * size < result.total)
    nav.push(btn("Далее →", "page:" + (state.page + 1)));
  if (nav.length) rows.push(nav);
  rows.push(
    [btn("⚙️ Фильтры", "filters"), btn("Сохранить поиск", "save")],
    home(),
  );
  return panel(
    queryLabel(state.query) +
      "\n" +
      (result.total
        ? `Найдено: ${result.total}. Страница ${state.page + 1} из ${Math.ceil(result.total / size)}.`
        : "Подходящих мероприятий пока нет."),
    rows,
  );
}
function detail(e) {
  const known = (value, limit) => {
    const text = clean(value, limit);
    return /^неизвестно[.!]?$/iu.test(text) ? "" : text;
  };
  const fields = [
    ["Категория", CATEGORY_LABELS[e.category] || e.category],
    ["Регистрация с", e.registration_start],
    ["Регистрация до", e.registration_end],
    ["Начало мероприятия", e.start],
    ["Конец мероприятия", e.end],
    ["Дедлайн", e.deadline],
    [
      "Участие",
      e.registration_open === 1
        ? "Регистрация открыта"
        : e.registration_open === 0
          ? "Регистрация закрыта"
          : null,
    ],
    [
      "Формат",
      { online: "Онлайн", onsite: "Очно", offline: "Очно" }[e.format] ||
        e.format,
    ],
    ["Призы", e.prize],
    ["Ограничения", e.restrictions],
    ["Правила об ИИ", e.ai_policy],
    ["Источник", e.source],
  ];
  const buttons = [];
  for (const [text, link] of [
    ["Источник", e.url],
    ["Регистрация", e.registration_url],
  ]) {
    const url = safeUrl(link);
    if (url) buttons.push({ text, url });
  }
  return panel(
    [
      clean(e.title, 220),
      known(e.description, 650),
      ...fields
        .map(([label, value]) => [label, known(value, 180)])
        .filter(([, value]) => value)
        .map(([label, value]) => label + ": " + value),
    ]
      .filter(Boolean)
      .join("\n"),
    [
      ...(buttons.length ? [buttons] : []),
      [btn("← Результаты", "catalog")],
      home(),
    ],
  );
}
function subscriptions(settings, filters) {
  const selected = settings.filter_ids || [];
  const rows = filters.map((f) => [
    btn(
      (!selected.length || selected.includes(f.id) ? "✓ " : "") +
        clean(f.name, 45),
      "scope:" + f.id,
    ),
  ]);
  return panel(
    "Ежедневная сводка: " +
      (settings.enabled ? "включена" : "выключена") +
      "\nВремя: " +
      settings.time +
      " · " +
      settings.timezone +
      "\n" +
      (filters.length
        ? "Отмечены наборы для подбора новых мероприятий."
        : "Сначала сохраните набор через «Фильтры»."),
    [
      [btn(settings.enabled ? "Выключить сводку" : "Включить сводку", "daily")],
      ...rows,
      [btn("Время и часовой пояс", "clock")],
      [btn("⚙️ Фильтры", "filters")],
      home(),
    ],
  );
}

async function screen(db, uid, state, settings, action, text) {
  const filters = () => saved(db, uid);
  const showFilters = async () => filterPanel(state, await filters());
  const showSubs = async () => subscriptions(settings, await filters());
  const updateSettings = () =>
    db
      .prepare(
        "UPDATE users SET settings_json=?,updated_at=? WHERE telegram_id=?",
      )
      .bind(
        JSON.stringify({ ...settings, urgent: false }),
        new Date().toISOString(),
        uid,
      )
      .run();
  if (
    action === "home" ||
    (text && /^\/(?:start|menu)(?:@\w+)?(?:\s|$)/i.test(text))
  ) {
    state.mode = "browse";
    return mainMenu();
  }
  if (action === "search" || text === "/search") {
    state.mode = "search";
    delete state.query.category;
    delete state.query.q;
    state.page = 0;
    return panel(
      "Напишите название или тему мероприятия, например «искусственный интеллект».",
      [home()],
    );
  }
  if (action === "filters") {
    state.mode = "browse";
    return showFilters();
  }
  if (action === "subs") {
    state.mode = "browse";
    return showSubs();
  }
  if (action === "reset") {
    Object.assign(state, emptyState());
    return showFilters();
  }
  if (action === "catalog") {
    state.mode = "browse";
    return results(db, uid, state);
  }
  if (action === "save") {
    state.mode = "name";
    return panel("Как назвать этот набор?\n" + queryLabel(state.query), [
      [btn("← Фильтры", "filters")],
    ]);
  }
  if (action === "clock") {
    state.mode = "clock";
    return panel(
      "Введите местное время и часовой пояс, например 09:30 Europe/Moscow.",
      [[btn("← Подписки", "subs")]],
    );
  }
  if (action === "daily") {
    if (!settings.enabled && !(await filters()).length)
      return panel("Для ежедневной сводки сохраните хотя бы один фильтр.", [
        [btn("⚙️ Фильтры", "filters")],
        home(),
      ]);
    settings.enabled = !settings.enabled;
    await updateSettings();
    return showSubs();
  }
  if (action) {
    const [op, arg] = action.split(":");
    state.mode = "browse";
    if (op === "category" && Object.hasOwn(sections, arg)) {
      state.query = { category: arg };
      state.page = 0;
      return results(db, uid, state);
    }
    if (op === "option" && Object.hasOwn(options, arg)) {
      const [, key, value] = options[arg];
      if (state.query[key] === value) delete state.query[key];
      else state.query[key] = value;
      state.page = 0;
      return showFilters();
    }
    if (
      op === "date" &&
      ["start_from", "deadline_to", "registration_end_to"].includes(arg)
    ) {
      state.mode = "date:" + arg;
      return panel("Введите дату в формате ГГГГ-ММ-ДД.", [
        [btn("← Фильтры", "filters")],
      ]);
    }
    if (op === "page" && /^\d{1,5}$/.test(arg)) {
      state.page = +arg;
      return results(db, uid, state);
    }
    if (op === "event" && arg) {
      const e = await db
        .prepare("SELECT * FROM events WHERE id=? AND status='active'")
        .bind(arg)
        .first();
      return e
        ? detail(e)
        : panel("Карточка больше недоступна.", [
            [btn("← Результаты", "catalog")],
            home(),
          ]);
    }
    if (["load", "delete", "scope"].includes(op)) {
      const all = await filters();
      const filter = all.find((f) => f.id === arg);
      if (!filter) return panel("Набор больше недоступен.", [home()]);
      if (op === "load") {
        state.query = JSON.parse(filter.query_json);
        state.page = 0;
        return results(db, uid, state);
      }
      if (op === "delete") {
        const selectedBefore = settings.filter_ids.length;
        await db
          .prepare("DELETE FROM saved_filters WHERE user_id=? AND id=?")
          .bind(uid, arg)
          .run();
        settings.filter_ids = settings.filter_ids.filter((id) => id !== arg);
        if (all.length === 1 || (selectedBefore && !settings.filter_ids.length))
          settings.enabled = false;
        await updateSettings();
        return showFilters();
      }
      const ids = settings.filter_ids.length
        ? [...settings.filter_ids]
        : all.map((f) => f.id);
      const selected = ids.includes(arg)
        ? ids.filter((id) => id !== arg)
        : [...ids, arg];
      if (!selected.length)
        return panel(
          "Для сводки нужен хотя бы один набор. Чтобы прекратить сообщения, выключите сводку.",
          [[btn("← Подписки", "subs")]],
        );
      settings.filter_ids = selected;
      await updateSettings();
      return showSubs();
    }
    return mainMenu();
  }
  if (!text) return mainMenu();
  if (state.mode === "name") {
    if ((await filters()).length >= 20)
      return panel(
        "Сохранено 20 наборов. Удалите один, чтобы добавить новый.",
        [[btn("Фильтры", "filters")]],
      );
    await db
      .prepare(
        "INSERT INTO saved_filters(id,user_id,name,query_json) VALUES(?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        uid,
        clean(text, 48),
        JSON.stringify(state.query),
      )
      .run();
    state.mode = "browse";
    return showFilters();
  }
  if (state.mode === "clock") {
    const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)\s+(\S+)$/);
    if (match)
      try {
        new Intl.DateTimeFormat("en", { timeZone: match[3] });
        settings.time = match[1] + ":" + match[2];
        settings.timezone = match[3];
      } catch {
        return panel(
          "Неизвестный часовой пояс. Например: 09:30 Europe/Moscow.",
          [home()],
        );
      }
    if (!match)
      return panel(
        "Нужны время и часовой пояс. Например: 09:30 Europe/Moscow.",
        [home()],
      );
    await updateSettings();
    state.mode = "browse";
    return showSubs();
  }
  if (state.mode.startsWith("date:")) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
      !Number.isFinite(Date.parse(text)) ||
      new Date(text).toISOString().slice(0, 10) !== text
    )
      return panel("Проверьте дату. Пример: 2027-02-28.", [
        [btn("← Фильтры", "filters")],
      ]);
    state.query[state.mode.slice(5)] = text;
    state.page = 0;
    state.mode = "browse";
    return showFilters();
  }
  if (text.startsWith("/")) return mainMenu();
  state.query = { ...state.query, q: clean(text, 180) };
  state.page = 0;
  state.mode = "browse";
  return results(db, uid, state);
}

export async function handleUpdate(update, env) {
  const callback = update.callback_query;
  const message = callback ? callback.message : update.message;
  const sender = callback ? callback.from : message?.from;
  if (
    message?.chat?.type !== "private" ||
    sender?.is_bot ||
    !Number.isSafeInteger(sender?.id) ||
    sender.id <= 0 ||
    sender.id !== message.chat.id
  )
    return;
  const uid = String(sender.id);
  if (callback)
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
    }).catch(() => {});
  const db = env.DB,
    now = new Date().toISOString();
  await db
    .prepare(
      "INSERT OR IGNORE INTO users(telegram_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(uid, now, now)
    .run();
  const row = await db
    .prepare(
      "SELECT u.settings_json,s.state_json FROM users u LEFT JOIN chat_sessions s ON s.user_id=u.telegram_id WHERE u.telegram_id=?",
    )
    .bind(uid)
    .first();
  const state = row.state_json ? JSON.parse(row.state_json) : emptyState();
  const output = await screen(
    db,
    uid,
    state,
    JSON.parse(row.settings_json),
    callback?.data || "",
    callback ? "" : (message.text || "").trim(),
  );
  await db
    .prepare(
      "INSERT INTO chat_sessions(user_id,state_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json",
    )
    .bind(uid, JSON.stringify(state))
    .run();
  const target = callback
    ? { chat_id: sender.id, message_id: message.message_id }
    : { chat_id: sender.id };
  await telegram(env, callback ? "editMessageText" : "sendMessage", {
    ...target,
    ...output,
    link_preview_options: { is_disabled: true },
  });
}
