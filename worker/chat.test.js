import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { handleUpdate } from "./chat.js";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(
    new URL("./migrations", import.meta.url),
  ).sort()) {
    db.exec(
      readFileSync(new URL("./migrations/" + file, import.meta.url), "utf8"),
    );
  }
  const d1 = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            first: async () => stmt.get(...args),
            all: async () => ({ results: stmt.all(...args) }),
            run: async () => ({ meta: { changes: stmt.run(...args).changes } }),
          };
        },
      };
    },
  };
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, req) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/bottest/"));
    assert.equal(req.redirect, "manual");
    sent.push({
      method: String(url).split("/").pop(),
      ...JSON.parse(req.body),
    });
    return Response.json({ ok: true, result: true });
  });
  t.after(() => db.close());
  let serial = 0;
  async function invoke(text, action, uid = 11) {
    const from = { id: uid },
      chat = { type: "private", id: uid };
    const update = action
      ? {
          callback_query: {
            id: String(++serial),
            data: action,
            from,
            message: { message_id: 25, chat },
          },
        }
      : { message: { from, chat, text } };
    await handleUpdate(update, { DB: d1, TELEGRAM_BOT_TOKEN: "test" });
    if (action) assert.equal(sent.at(-2).method, "answerCallbackQuery");
    const message = sent.at(-1);
    assert.equal(message.chat_id, uid);
    for (const b of message.reply_markup.inline_keyboard.flat()) {
      assert.ok(!b.web_app);
      if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    }
    return message;
  }
  function events() {
    const insert = db.prepare(
      "INSERT INTO events(id,title,url,source,category,tags_json,status,free,format,score,registration_open,ai_policy,prize_amount,start,deadline) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    ["olympiad", "ctf", "hackathon", "grant"].forEach((category, index) => {
      for (let j = 0; j < (index === 1 ? 8 : 1); j++)
        insert.run(
          category + j,
          "AI " + category + " " + j,
          "https://example.org/info",
          "source",
          category,
          '["ai"]',
          "active",
          1,
          "online",
          55,
          1,
          "Разрешено",
          100,
          "2028-04-01",
          "2028-03-01",
        );
    });
  }
  return { db, d1, sent, invoke, events };
}
test("Private Telegram menu, all categories, pagination, details and search", async (t) => {
  const { db, invoke, events } = fixture(t);
  events();
  db.exec("UPDATE events SET prize='Неизвестно', restrictions=' неизвестно. '");
  const menu = await invoke("/start");
  assert.deepEqual(
    menu.reply_markup.inline_keyboard.flat().map((x) => x.text),
    [
      "🔍 Поиск мероприятий",
      "🏆 Олимпиады",
      "🚩 CTF",
      "💻 Хакатоны",
      "💰 Гранты",
      "⚙️ Фильтры",
      "🔔 Подписки",
    ],
  );
  for (const category of ["olympiad", "ctf", "hackathon", "grant"]) {
    const list = await invoke("", "category:" + category);
    const first = list.reply_markup.inline_keyboard[0][0];
    assert.match(first.text, new RegExp(category));
    const detail = await invoke("", first.callback_data);
    assert.match(detail.text, /Начало мероприятия: 2028-04-01/);
    assert.match(detail.text, /Дедлайн: 2028-03-01/);
    assert.doesNotMatch(detail.text, /неизвестно|Призы:|Ограничения:/i);
    assert.doesNotMatch(detail.text, /Регистрация до:/);
    assert.ok(
      detail.reply_markup.inline_keyboard
        .flat()
        .find((x) => x.url === "https://example.org/info"),
    );
    await invoke("", "catalog");
  }
  await invoke("", "category:ctf");
  assert.match((await invoke("", "page:1")).text, /Страница 2 из 2/);
  await invoke("", "page:0");
  await invoke("", "reset");
  await invoke("", "search");
  assert.match((await invoke("AI")).text, /Найдено: 11/);
  assert.match((await invoke("nonexistent")).text, /пока нет/);
  await invoke("", "home");
});
test("Personal controls save, load, remove, isolate chat users and select digest settings", async (t) => {
  const { db, invoke, events } = fixture(t);
  events();
  await invoke("/menu");
  await invoke("", "filters");
  for (const option of ["ai", "free", "open", "online", "cash", "allowed"]) {
    const output = await invoke("", "option:" + option);
    assert.ok(
      output.reply_markup.inline_keyboard
        .flat()
        .find((x) => x.callback_data === "option:" + option)
        .text.startsWith("✓"),
    );
  }
  for (const key of ["start_from", "deadline_to", "registration_end_to"]) {
    await invoke("", "date:" + key);
    assert.match((await invoke("2027-02-30")).text, /Проверьте дату/);
    await invoke(key === "start_from" ? "2027-01-01" : "2029-12-31");
  }
  await invoke("", "save");
  await invoke("Мои события");
  const f = db.prepare("SELECT id,query_json FROM saved_filters").get();
  assert.equal(JSON.parse(f.query_json).start_from, "2027-01-01");
  assert.match((await invoke("", "load:" + f.id, 33)).text, /недоступен/);
  await invoke("", "delete:" + f.id, 33);
  assert.equal(db.prepare("SELECT count(*) n FROM saved_filters").get().n, 1);
  await invoke("", "reset");
  await invoke("", "load:" + f.id);
  await invoke("", "subs");
  await invoke("", "daily");
  await invoke("", "clock");
  assert.match((await invoke("08:00 Imaginary/Zone")).text, /Неизвестный/);
  await invoke("08:00 Europe/Moscow");
  assert.equal(
    JSON.parse(
      db.prepare("SELECT settings_json FROM users WHERE telegram_id='11'").get()
        .settings_json,
    ).time,
    "08:00",
  );
  await invoke("", "save");
  await invoke("Другой набор");
  await invoke("", "scope:" + f.id);
  assert.equal(
    JSON.parse(
      db.prepare("SELECT settings_json FROM users WHERE telegram_id='11'").get()
        .settings_json,
    ).filter_ids.length,
    1,
  );
  await invoke("", "daily");
  await invoke("", "delete:" + f.id);
  assert.equal(db.prepare("SELECT count(*) n FROM saved_filters").get().n, 1);
});
test("Group chats and spoofed callbacks never read or change private settings", async (t) => {
  const { db, d1, sent } = fixture(t);
  for (const chat of [
    { id: 9, type: "group" },
    { id: 10, type: "private" },
  ]) {
    await handleUpdate(
      {
        callback_query: {
          id: "x",
          data: "daily",
          from: { id: 9 },
          message: { chat, message_id: 4 },
        },
      },
      { DB: d1, TELEGRAM_BOT_TOKEN: "test" },
    );
  }
  assert.equal(sent.length, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM users").get().n, 0);
});
