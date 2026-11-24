import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { safeUrl, buildEventQuery, authenticate } from "./index.js";
globalThis.crypto ||= webcrypto;
test("URLs reject executable schemes and embedded credentials", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://u:p@example.org"), null);
  assert.equal(safeUrl("https://example.org"), "https://example.org/");
});
test("SQL uses bound input and per-user favorites", () => {
  const q = buildEventQuery(
    {
      q: '" OR 1=1 --',
      category: "x' OR 1=1",
      favorites: "true",
      sort: "DROP TABLE events",
      page: -10,
    },
    "42",
  );
  assert.ok(!q.where.includes("x'"));
  assert.ok(q.args.includes("x' OR 1=1"));
  assert.ok(q.args.includes("42"));
  assert.equal(q.page, 1);
  assert.equal(q.order, "julianday(e.created_at) DESC");
});
test("Telegram auth rejects unsigned and stale data", async () => {
  await assert.rejects(
    authenticate('user={"id":42}&auth_date=1&hash=' + "0".repeat(64), "secret"),
  );
  await assert.rejects(authenticate(null, "secret"));
});
test("Telegram valid signature and tampering", async () => {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42 }),
  });
  const sign = async (key, value) => {
    const k = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(value)),
    );
  };
  const secret = await sign(
    new TextEncoder().encode("WebAppData"),
    "test-token",
  );
  const check = [...p]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set("hash", Buffer.from(await sign(secret, check)).toString("hex"));
  assert.equal(await authenticate(p.toString(), "test-token"), "42");
  p.set("user", '{"id":43}');
  await assert.rejects(authenticate(p.toString(), "test-token"));
});
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { queryEvents, syncCatalog } from "./index.js";
function localDB() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("./migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("./migrations/0002_notifications.sql", import.meta.url),
      "utf8",
    ),
  );
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...this.values) || null;
        },
        async all() {
          return { results: db.prepare(sql).all(...this.values) };
        },
        async run() {
          const x = db.prepare(sql).run(...this.values);
          return { meta: { changes: Number(x.changes) } };
        },
        sql,
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const s of statements) await s.run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    db,
  };
}
test("SQLite migration, FTS and favorites isolation", async () => {
  const d = localDB();
  d.db
    .prepare(
      "INSERT INTO events(id,title,description,status,tags_json,score,prize_amount,prize_currency) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "one",
      "Math event",
      "Solve puzzles",
      "active",
      '["math"]',
      80,
      100,
      "RUB",
    );
  d.db
    .prepare(
      "INSERT INTO users(telegram_id,created_at,updated_at) VALUES('42','now','now')",
    )
    .run();
  d.db
    .prepare("INSERT INTO favorites(user_id,event_id) VALUES('42','one')")
    .run();
  assert.equal((await queryEvents(d, { q: "puzzles" }, "42")).total, 1);
  assert.equal((await queryEvents(d, { favorites: true }, "42")).total, 1);
  assert.equal((await queryEvents(d, { favorites: true }, "43")).total, 0);
  assert.equal((await queryEvents(d, { q: "missing" }, "42")).total, 0);
  assert.equal((await queryEvents(d, { sort: "constructor" }, "42")).total, 1);
  assert.equal((await queryEvents(d, { sort: "prize" }, "42")).total, 1);
  d.db.close();
});
test("Catalog sync sanitizes links and preserves missing catalog statuses", async () => {
  const d = localDB();
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes("catalog-aliases.json")
      ? new Response("{}")
      : new Response(
          JSON.stringify([
            {
              id: "safe",
              title: "Event",
              url: "javascript:bad",
              tags: ["math"],
              free: true,
            },
          ]),
        );
  try {
    await syncCatalog({ DB: d });
    assert.equal(
      d.db.prepare("SELECT url FROM events WHERE id='safe'").get().url,
      null,
    );
    assert.equal((await syncCatalog({ DB: d })).skipped, true);
    d.db.exec("DELETE FROM sync_state");
    globalThis.fetch = async (url) =>
      new Response(String(url).includes("catalog-aliases.json") ? "{}" : "[]");
    await syncCatalog({ DB: d });
    assert.equal(
      d.db.prepare("SELECT status FROM events WHERE id='safe'").get().status,
      "active",
    );
  } finally {
    globalThis.fetch = previous;
    d.db.close();
  }
});
import worker from "./index.js";
async function initData(id) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id }),
  });
  const sign = async (key, value) => {
    const k = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(value)),
    );
  };
  const secret = await sign(
    new TextEncoder().encode("WebAppData"),
    "test-token",
  );
  const check = [...p]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set("hash", Buffer.from(await sign(secret, check)).toString("hex"));
  return p.toString();
}
test("HTTP API authenticates, persists settings and isolates private resources", async () => {
  const DB = localDB();
  const env = { DB, TELEGRAM_BOT_TOKEN: "test-token" };
  const call = async (id, path, method = "GET", body) =>
    worker.fetch(
      new Request("https://local.test" + path, {
        method,
        headers: {
          "X-Telegram-Init-Data": await initData(id),
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  try {
    assert.equal(
      (await worker.fetch(new Request("https://local.test/api/me"), env))
        .status,
      401,
    );
    const created = await call(42, "/api/filters", "POST", {
      name: "Math",
      query: { q: "math" },
    });
    assert.equal(created.status, 201);
    const filter = await created.json();
    assert.equal(
      (await call(43, "/api/filters/" + filter.id, "DELETE")).status,
      200,
    );
    assert.equal((await (await call(42, "/api/me")).json()).filters.length, 1);
    assert.equal((await (await call(43, "/api/me")).json()).filters.length, 0);
    assert.equal(
      (
        await call(43, "/api/settings", "PUT", {
          enabled: true,
          filter_ids: [filter.id],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(42, "/api/settings", "PUT", {
          enabled: true,
          time: "10:15",
          timezone: "Europe/Moscow",
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await call(42, "/api/me")).json()).settings.enabled,
      true,
    );
  } finally {
    DB.db.close();
  }
});
import { createServer } from "node:http";
test("Local HTTP fetch exercises signed API through Worker and SQLite", async () => {
  const DB = localDB();
  const server = createServer(async (req, res) => {
    const request = new Request("http://127.0.0.1" + req.url, {
      headers: req.headers,
    });
    const response = await worker.fetch(request, {
      DB,
      TELEGRAM_BOT_TOKEN: "test-token",
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/me`,
      { headers: { "X-Telegram-Init-Data": await initData(99) } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).favorites, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    DB.db.close();
  }
});
import { execFileSync } from "node:child_process";
test("Actual collector export roundtrips public-only JSON through D1 and signed search API", async () => {
  const source = execFileSync(
    "python",
    [
      "-c",
      `import collector,tempfile,pathlib,json,datetime as dt
with tempfile.TemporaryDirectory() as tmp:
 p=pathlib.Path(tmp)
 collector.run(str(p/'public.db'),str(p/'catalog.json'),events=[{'title':'Roundtrip Quantum Contest','url':'https://example.org/contest','source':'local fixture','description':'Quantum puzzles','start':'2026-12-20T09:00:00+00:00','deadline':'2026-12-21T09:00:00+00:00','tags':['science'],'free':True}],analyzer=lambda e:{'score':81},now=dt.datetime(2026,11,24,tzinfo=dt.timezone.utc))
 print((p/'catalog.json').read_text())
`,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  const catalog = JSON.parse(source);
  assert.equal(catalog.length, 1);
  assert.ok(!source.includes("telegram_id"));
  assert.ok(!source.includes("settings_json"));
  const DB = localDB();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(String(url).includes("catalog-aliases.json") ? "{}" : source);
  try {
    await syncCatalog({ DB });
    const stored = DB.db.prepare("SELECT * FROM events").get();
    assert.equal(stored.title, catalog[0].title);
    const env = { DB, TELEGRAM_BOT_TOKEN: "test-token" };
    const request = new Request(
      "https://local.test/api/events?q=Quantum&start_from=2026-12-20T09%3A00%3A00Z&deadline_to=2026-12-21T09%3A00%3A00Z",
      { headers: { "X-Telegram-Init-Data": await initData(101) } },
    );
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, catalog[0].id);
    assert.ok(!JSON.stringify(result).includes("telegram_id"));
    assert.ok(!JSON.stringify(result).includes("settings_json"));
  } finally {
    globalThis.fetch = oldFetch;
    DB.db.close();
  }
});
test("Catalog alias migration atomically merges favorites and urgent reservations", async () => {
  const DB = localDB();
  DB.db.exec(
    "INSERT INTO users(telegram_id,created_at,updated_at) VALUES('1','now','now'); INSERT INTO events(id,title,status) VALUES('old','Old','active'); INSERT INTO favorites(user_id,event_id) VALUES('1','old'); INSERT INTO urgent_deliveries VALUES('1','old','2026-12-01','now')",
  );
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("catalog-aliases.json")
          ? { old: "winner" }
          : [{ id: "winner", title: "Winner" }],
      ),
    );
  try {
    await syncCatalog({ DB });
    assert.equal(
      DB.db.prepare("SELECT event_id FROM favorites").get().event_id,
      "winner",
    );
    assert.equal(
      DB.db.prepare("SELECT event_id FROM urgent_deliveries").get().event_id,
      "winner",
    );
    assert.equal(
      DB.db.prepare("SELECT count(*) n FROM events WHERE id='old'").get().n,
      0,
    );
  } finally {
    globalThis.fetch = oldFetch;
    DB.db.close();
  }
});
