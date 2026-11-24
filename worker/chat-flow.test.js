// Exercise the deployed webhook, including the import and update reservation boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import worker, { syncCatalog } from "./index.js";

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const migrations = new URL("./migrations/", import.meta.url);
  for (const migration of readdirSync(migrations).sort())
    sqlite.exec(readFileSync(new URL(migration, migrations), "utf8"));
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        first() {
          return statement.get(...this.values) || null;
        },
        all() {
          return { results: statement.all(...this.values) };
        },
        run() {
          return { meta: { changes: statement.run(...this.values).changes } };
        },
      };
    },
    batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const stmt of statements) stmt.run();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function fixtureCatalog() {
  return Array.from({ length: 48 }, (_, i) => ({
    id: "event-" + String(i).padStart(2, "0"),
    title: "Олимпиада " + i,
    category: "olympiad",
    source: "Fixture",
    url: "https://example.org/" + i,
    status: "active",
    tags: ["ai"],
    created_at: "2026-11-12T13:00:00Z",
    updated_at: "2026-11-12T13:00:00Z",
  }));
}
async function checkFlow(t, catalog) {
  const DB = database(t),
    env = { DB, WEBHOOK_SECRET: "for-test", TELEGRAM_BOT_TOKEN: "local" };
  await syncCatalog(env, async (url) =>
    Response.json(String(url).includes("-aliases") ? {} : catalog),
  );
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, req) => {
    assert.match(
      String(url),
      /^https:\/\/api\.telegram\.org\/botlocal\/(sendMessage|editMessageText|answerCallbackQuery)$/,
    );
    calls.push({
      method: String(url).split("/").at(-1),
      ...JSON.parse(req.body),
    });
    return Response.json({ ok: true, result: true });
  });
  let id = 0;
  const chat = { type: "private", id: 77 };
  function update(value, callback = false) {
    return {
      update_id: ++id,
      ...(callback
        ? {
            callback_query: {
              id: String(id),
              from: { id: 77 },
              message: { chat, message_id: 1 },
              data: value,
            },
          }
        : { message: { chat, from: { id: 77 }, text: value } }),
    };
  }
  async function send(payload, secret = env.WEBHOOK_SECRET) {
    return worker.fetch(
      new Request("https://example.org/telegram", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": secret,
        },
        body: JSON.stringify(payload),
      }),
      env,
    );
  }
  async function step(value, callback = false) {
    const resp = await send(update(value, callback));
    assert.equal(resp.status, 200);
    return calls.at(-1);
  }
  const start = update("/start");
  assert.equal((await send(start, "wrong")).status, 401);
  assert.equal(calls.length, 0);
  await send(start);
  const main = calls.at(-1);
  await send(start);
  assert.equal(calls.length, 1);
  const button = (m, predicate) =>
    m.reply_markup.inline_keyboard.flat().find(predicate);
  const key = (m, label) => button(m, (b) => b.text === label)?.callback_data;
  assert.equal(key(main, "🏆 Олимпиады"), "category:olympiad");
  const list = await step(key(main, "🏆 Олимпиады"), true);
  const first = button(list, (b) => b.callback_data.startsWith("event:"));
  const card = await step(first.callback_data, true);
  assert.ok(card.text.includes(first.text));
  assert.ok(button(card, (b) => b.url?.startsWith("https://")));
  await step(key(card, "← Результаты"), true);
  let page = list;
  const visited = new Set();
  for (let i = 0; i < 9; i++) {
    for (const entry of page.reply_markup.inline_keyboard
      .flat()
      .filter((b) => b.callback_data.startsWith("event:"))) {
      assert.ok(!visited.has(entry.callback_data));
      visited.add(entry.callback_data);
    }
    if (i === 8) break;
    const next = key(page, "Далее →");
    if (!next) break;
    page = await step(next, true);
  }
  const available = DB.sqlite
    .prepare(
      "SELECT count(*) n FROM events WHERE category='olympiad' AND status='active'",
    )
    .get().n;
  assert.equal(visited.size, Math.min(available, 45));
  const empty = await step("daily", true);
  assert.match(empty.text, /хотя бы один фильтр/);
  await step("filters", true);
  await step("save", true);
  await step("Олимпиады");
  const enabled = await step("daily", true);
  assert.match(enabled.text, /Ежедневная сводка: включена/);
  assert.equal(
    JSON.parse(
      DB.sqlite
        .prepare("SELECT settings_json FROM users WHERE telegram_id='77'")
        .get().settings_json,
    ).enabled,
    true,
  );
  const stop = await step("daily", true);
  assert.match(stop.text, /выключена/);
}
test("Webhook and SQLite: replay, category page nine, detail, saved filter and digest opt-in", async (t) =>
  checkFlow(t, fixtureCatalog()));
const actual = new URL("../.state/catalog/catalog.json", import.meta.url);
test(
  "Local collection snapshot: navigate real olympiad cards through Telegram webhook",
  { skip: !existsSync(actual) },
  async (t) => checkFlow(t, JSON.parse(readFileSync(actual, "utf8"))),
);
