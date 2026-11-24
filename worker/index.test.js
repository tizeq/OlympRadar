import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { safeUrl, buildEventQuery } from "./index.js";
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
  db.exec(readFileSync(new URL("./migrations/0003_dates.sql",import.meta.url),"utf8"));
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
    const result = await queryEvents(DB, {q:"Quantum", start_from:"2026-12-20", deadline_to:"2026-12-21"}, "101");
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

test("AI searches use a topic across event types and date-only upper bounds include evening", async () => {
  const d = localDB();
  try {
    const insert = d.db.prepare("INSERT INTO events(id,title,status,category,tags_json,start,registration_end,deadline) VALUES(?,?,'active',?,?,?,?,?)");
    insert.run("ml","Нейросети","olympiad",'["ai","ml"]',"2027-01-22","2027-01-10T22:30:00Z",null);
    insert.run("ctf","Чемпионат","ctf",'["ai"]',null,null,"2027-01-01");
    insert.run("misc","AI mentioned in general rules","olympiad","[]",null,null,null);
    for (const q of ["ИИ", "ai", "искусственный интеллект", "по искусственному интеллекту"])
      assert.equal((await queryEvents(d,{q},"1")).total,2);
    assert.equal((await queryEvents(d,{q:"олимпиады по ИИ"},"1")).total,1);
    assert.equal((await queryEvents(d,{registration_end_to:"2027-01-10"},"1")).items[0].id,"ml");
    assert.equal((await queryEvents(d,{deadline_to:"2027-01-10"},"1")).items[0].id,"ctf");
  } finally { d.db.close(); }
});

test("website and Mini App API retired; webhook authenticates callbacks before touching DB",async()=>{
  const env={WEBHOOK_SECRET:"test-only"};
  for(const path of ["/","/api/me","/assets/main.js"])
    assert.equal((await worker.fetch(new Request("https://local"+path),env)).status,404);
  assert.equal((await worker.fetch(new Request("https://local/telegram",{method:"POST",body:"{}"}),env)).status,401);
});

test("only olympiads with IT subjects appear in the catalog and search", async () => {
  const { db, ...catalog } = localDB();
  try {
    const insert = db.prepare(
      "INSERT INTO events(id,title,status,category,tags_json) VALUES(?,?,'active',?,?)",
    );
    insert.run("literature", "Олимпиада по литературе", "olympiad", '["olympiad"]');
    insert.run("math", "Интернет-олимпиада по математике", "olympiad", '["olympiad","web"]');
    insert.run("informatics", "Олимпиада по информатике", "olympiad", '["olympiad"]');
    insert.run("security", "Олимпиада по информационной безопасности", "olympiad", '["olympiad"]');
    insert.run("ai", "Олимпиада по нейросетям", "olympiad", '["olympiad","ai"]');
    insert.run("ctf", "CTF", "ctf", "[]");
    insert.run("other", "Открытый конкурс", null, "[]");
    const listing = await queryEvents(catalog, { category: "olympiad" });
    assert.deepEqual(listing.items.map(({ id }) => id), ["ai", "informatics", "security"]);
    assert.equal((await queryEvents(catalog, {})).total, 5);
    assert.equal((await queryEvents(catalog, { q: "литературе" })).total, 0);
    assert.equal((await queryEvents(catalog, { q: "олимпиады по ИИ" })).total, 1);
  } finally {
    db.close();
  }
});
