import { sendDueDigests } from "./notifications.js";
export const CATALOG_URL =
  "https://raw.githubusercontent.com/tizeq/OlympRadar/catalog-data/catalog.json";
const defaults = {
  enabled: false,
  time: "09:00",
  timezone: "Europe/Moscow",
  min_score: 0,
  filter_ids: [],
  urgent: false,
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
export function safeUrl(value) {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
const enc = new TextEncoder();
async function hmac(key, value) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(value)));
}
export async function authenticate(raw, token, now = Date.now()) {
  if (!raw || raw.length > 8192 || !token) throw new Error("Unauthorized");
  const p = new URLSearchParams(raw);
  if ([...p.keys()].some((k, i, a) => a.indexOf(k) !== i))
    throw new Error("Unauthorized");
  const hash = p.get("hash");
  p.delete("hash");
  const date = Number(p.get("auth_date"));
  if (
    !hash ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    !date ||
    now / 1000 - date > 86400 ||
    date - now / 1000 > 60
  )
    throw new Error("Unauthorized");
  const check = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const expected = await hmac(await hmac("WebAppData", token), check);
  let mismatch = 0;
  for (let i = 0; i < 32; i++)
    mismatch |= expected[i] ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16);
  if (mismatch) throw new Error("Unauthorized");
  const user = JSON.parse(p.get("user") || "null");
  if (!Number.isSafeInteger(user?.id) || user.id <= 0)
    throw new Error("Unauthorized");
  return String(user.id);
}
export function buildEventQuery(input = {}, userId = "") {
  const p =
    input instanceof URLSearchParams ? Object.fromEntries(input) : input;
  const where = ["e.status = 'active'"];
  const args = [];
  const add = (sql, value) => {
    where.push(sql);
    args.push(value);
  };
  if (p.q) {
    const tokens =
      String(p.q)
        .slice(0, 200)
        .match(/[\p{L}\p{N}_]+/gu) || [];
    if (tokens.length)
      add(
        "e.id IN (SELECT id FROM events_fts WHERE events_fts MATCH ?)",
        tokens.map((x) => '"' + x + '"').join(" AND "),
      );
  }
  for (const key of ["category", "format", "country", "difficulty"])
    if (p[key]) add(`e.${key} = ?`, String(p[key]).slice(0, 100));
  if (p.ai_policy === "allowed") where.push("e.ai_policy LIKE 'Разрешено%'");
  else if (p.ai_policy === "prohibited")
    where.push("e.ai_policy LIKE 'Запрещено%'");
  else if (p.ai_policy === "unknown")
    where.push("(e.ai_policy IS NULL OR e.ai_policy = '')");
  else if (p.ai_policy)
    add("e.ai_policy = ?", String(p.ai_policy).slice(0, 100));
  if (p.tag)
    add(
      "EXISTS (SELECT 1 FROM json_each(e.tags_json) WHERE value = ?)",
      String(p.tag).slice(0, 100),
    );
  for (const key of ["free", "registration_open"])
    if (p[key] === true || p[key] === "true" || p[key] === "1")
      add(`e.${key} = ?`, 1);
    else if (p[key] === false || p[key] === "false" || p[key] === "0")
      add(`e.${key} = ?`, 0);
  if (p.cash === true || p.cash === "true" || p.cash === "1")
    where.push("e.prize_amount > 0");
  if (p.sort === "prize" && !p.currency) p.currency = "RUB";
  if (p.currency)
    add("e.prize_currency = ?", String(p.currency).slice(0, 10).toUpperCase());
  if (p.start_from)
    add(
      "julianday(e.start) >= julianday(?)",
      String(p.start_from).slice(0, 40),
    );
  if (p.deadline_from)
    add(
      "julianday(e.deadline) >= julianday(?)",
      String(p.deadline_from).slice(0, 40),
    );
  if (p.deadline_to)
    add(
      "julianday(e.deadline) <= julianday(?)",
      String(p.deadline_to).slice(0, 40),
    );
  if (p.age !== undefined && Number.isFinite(Number(p.age))) {
    add("(e.age_min IS NULL OR e.age_min <= ?)", Number(p.age));
    add("(e.age_max IS NULL OR e.age_max >= ?)", Number(p.age));
  }
  if (p.min_score !== undefined && Number.isFinite(Number(p.min_score)))
    add("e.score >= ?", Number(p.min_score));
  if (p.favorites === true || p.favorites === "true" || p.favorites === "1")
    add(
      "EXISTS (SELECT 1 FROM favorites f WHERE f.event_id=e.id AND f.user_id=?)",
      userId,
    );
  const orders = {
    new: "julianday(e.created_at) DESC",
    deadline: "e.deadline IS NULL,julianday(e.deadline) ASC",
    score: "e.score DESC",
    prize: "e.prize_amount DESC",
  };
  const order = Object.hasOwn(orders, p.sort) ? orders[p.sort] : orders.new;
  const page = Math.min(10000, Math.max(1, Math.floor(Number(p.page) || 1)));
  return { where: where.join(" AND "), args, order, page };
}
export async function queryEvents(db, input, userId) {
  const q = buildEventQuery(input, userId);
  const total = await db
    .prepare(`SELECT count(*) AS n FROM events e WHERE ${q.where}`)
    .bind(...q.args)
    .first();
  const rows = await db
    .prepare(
      `SELECT e.* FROM events e WHERE ${q.where} ORDER BY ${q.order},e.id LIMIT 40 OFFSET ?`,
    )
    .bind(...q.args, (q.page - 1) * 40)
    .all();
  return {
    items: rows.results.map(({ tags_json, ...e }) => ({
      ...e,
      tags: JSON.parse(tags_json),
      free: e.free === null ? null : !!e.free,
      registration_open:
        e.registration_open === null ? null : !!e.registration_open,
    })),
    total: total.n,
  };
}
async function readBody(req) {
  if (Number(req.headers.get("content-length")) > 16384)
    throw new Error("Body too large");
  const raw = await req.text();
  if (raw.length > 16384) throw new Error("Body too large");
  return JSON.parse(raw);
}
function validateSettings(s) {
  if (!s || typeof s !== "object" || Array.isArray(s))
    throw new Error("Invalid settings");
  const out = { ...defaults, ...s };
  if (
    typeof out.enabled !== "boolean" ||
    typeof out.urgent !== "boolean" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.time) ||
    !Number.isFinite(out.min_score) ||
    out.min_score < 0 ||
    out.min_score > 100 ||
    !Array.isArray(out.filter_ids) ||
    out.filter_ids.length > 20 ||
    !out.filter_ids.every((x) => typeof x === "string")
  )
    throw new Error("Invalid settings");
  try {
    new Intl.DateTimeFormat("en", { timeZone: out.timezone });
  } catch {
    throw new Error("Invalid timezone");
  }
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, out[k]]));
}
async function api(req, env, path) {
  let uid;
  try {
    uid = await authenticate(
      req.headers.get("X-Telegram-Init-Data"),
      env.TELEGRAM_BOT_TOKEN,
    );
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }
  const minute = Math.floor(Date.now() / 60000);
  const quota = await env.DB.prepare(
    "INSERT INTO request_limits(user_id,bucket,n) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET bucket=excluded.bucket,n=CASE WHEN request_limits.bucket=excluded.bucket THEN request_limits.n+1 ELSE 1 END RETURNING n",
  )
    .bind(uid, minute)
    .first();
  if (quota.n > 120) return json({ error: "Rate limit" }, 429);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users(telegram_id,created_at,updated_at) VALUES(?,?,?)",
  )
    .bind(uid, now, now)
    .run();
  const method = req.method;
  if (path === "/api/events" && method === "GET")
    return json(await queryEvents(env.DB, new URL(req.url).searchParams, uid));
  if (path === "/api/me" && method === "GET") {
    const [u, f, s] = await Promise.all([
      env.DB.prepare("SELECT settings_json FROM users WHERE telegram_id=?")
        .bind(uid)
        .first(),
      env.DB.prepare("SELECT event_id FROM favorites WHERE user_id=?")
        .bind(uid)
        .all(),
      env.DB.prepare(
        "SELECT id,name,query_json FROM saved_filters WHERE user_id=?",
      )
        .bind(uid)
        .all(),
    ]);
    return json({
      favorites: f.results.map((x) => x.event_id),
      filters: s.results.map((x) => ({
        id: x.id,
        name: x.name,
        query: JSON.parse(x.query_json),
      })),
      settings: { ...defaults, ...JSON.parse(u.settings_json) },
    });
  }
  const favorite = path.match(/^\/api\/favorites\/([^/]+)$/);
  if (favorite && ["PUT", "DELETE"].includes(method)) {
    const id = decodeURIComponent(favorite[1]);
    if (id.length > 200) return json({ error: "Invalid id" }, 400);
    if (method === "PUT") {
      const event = await env.DB.prepare("SELECT id FROM events WHERE id=?")
        .bind(id)
        .first();
      if (!event) return json({ error: "Not found" }, 404);
      const n = await env.DB.prepare(
        "SELECT count(*) n FROM favorites WHERE user_id=?",
      )
        .bind(uid)
        .first();
      if (n.n >= 1000) return json({ error: "Favorite limit" }, 409);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO favorites(user_id,event_id) VALUES(?,?)",
      )
        .bind(uid, id)
        .run();
    } else
      await env.DB.prepare(
        "DELETE FROM favorites WHERE user_id=? AND event_id=?",
      )
        .bind(uid, id)
        .run();
    return json({ ok: true });
  }
  if (path === "/api/filters" && method === "POST") {
    const b = await readBody(req);
    if (
      typeof b.name !== "string" ||
      !b.name.trim() ||
      b.name.length > 100 ||
      !b.query ||
      typeof b.query !== "object" ||
      Array.isArray(b.query)
    )
      return json({ error: "Invalid filter" }, 400);
    const n = await env.DB.prepare(
      "SELECT count(*) n FROM saved_filters WHERE user_id=?",
    )
      .bind(uid)
      .first();
    if (n.n >= 20) return json({ error: "Filter limit" }, 409);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO saved_filters(id,user_id,name,query_json) VALUES(?,?,?,?)",
    )
      .bind(id, uid, b.name.trim(), JSON.stringify(b.query))
      .run();
    return json({ id, name: b.name.trim(), query: b.query }, 201);
  }
  const filter = path.match(/^\/api\/filters\/([^/]+)$/);
  if (filter && method === "DELETE") {
    await env.DB.prepare("DELETE FROM saved_filters WHERE user_id=? AND id=?")
      .bind(uid, decodeURIComponent(filter[1]))
      .run();
    return json({ ok: true });
  }
  if (path === "/api/settings" && method === "PUT") {
    const b = await readBody(req);
    const settings = validateSettings(b.settings || b);
    if (settings.filter_ids.length) {
      const rows = await env.DB.prepare(
        "SELECT id FROM saved_filters WHERE user_id=?",
      )
        .bind(uid)
        .all();
      if (
        settings.filter_ids.some((id) => !rows.results.some((x) => x.id === id))
      )
        return json({ error: "Unknown filter" }, 400);
    }
    await env.DB.prepare(
      "UPDATE users SET settings_json=?,updated_at=? WHERE telegram_id=?",
    )
      .bind(JSON.stringify(settings), now, uid)
      .run();
    return json({ settings });
  }
  return json({ error: "Not found" }, 404);
}
const fields = [
  "id",
  "title",
  "url",
  "source",
  "description",
  "category",
  "tags_json",
  "start",
  "deadline",
  "prize",
  "format",
  "restrictions",
  "ai_policy",
  "registration_url",
  "country",
  "age_min",
  "age_max",
  "free",
  "prize_amount",
  "prize_currency",
  "difficulty",
  "registration_open",
  "score",
  "status",
  "created_at",
  "updated_at",
];
export async function syncCatalog(env) {
  const prior = await env.DB.prepare(
    "SELECT last_sync FROM sync_state WHERE id=1",
  ).first();
  if (prior?.last_sync && Date.now() - Date.parse(prior.last_sync) < 86400000)
    return { skipped: true };
  const response = await fetch(CATALOG_URL, {
    signal: AbortSignal.timeout(20000),
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Catalog fetch failed");
  if (Number(response.headers.get("content-length")) > 10_000_000)
    throw new Error("Catalog too large");
  const raw = await response.text();
  if (raw.length > 10_000_000) throw new Error("Catalog too large");
  const catalog = JSON.parse(raw);
  if (!Array.isArray(catalog) || catalog.length > 20000)
    throw new Error("Invalid catalog");
  const aliasesResponse = await fetch(
    CATALOG_URL.replace("catalog.json", "catalog-aliases.json"),
    { signal: AbortSignal.timeout(20000), redirect: "error" },
  );
  let aliases = {};
  if (aliasesResponse.status === 404 && !prior?.last_sync) {
    /* First migration only. */
  } else {
    if (!aliasesResponse.ok) throw new Error("Alias fetch failed");
    const aliasText = await aliasesResponse.text();
    if (aliasText.length > 2000000) throw new Error("Aliases too large");
    aliases = JSON.parse(aliasText);
    if (
      !aliases ||
      typeof aliases !== "object" ||
      Array.isArray(aliases) ||
      Object.keys(aliases).length > 20000
    )
      throw new Error("Invalid aliases");
  }
  const ids = new Set();
  const statements = [];
  const now = new Date().toISOString();
  for (const e of catalog) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !e.id ||
      e.id.length > 200 ||
      typeof e.title !== "string" ||
      !e.title.trim() ||
      ids.has(e.id)
    )
      throw new Error("Invalid catalog entry");
    ids.add(e.id);
    const item = {};
    for (const key of fields) item[key] = null;
    for (const key of fields) {
      const v = e[key];
      if (v === null || v === undefined) continue;
      if (typeof v === "string")
        item[key] = v.slice(0, key === "description" ? 12000 : 2000);
      else if (typeof v === "number" && Number.isFinite(v)) item[key] = v;
    }
    item.url = safeUrl(e.url);
    item.registration_url = safeUrl(e.registration_url);
    item.tags_json = JSON.stringify(
      Array.isArray(e.tags)
        ? e.tags
            .filter((x) => typeof x === "string")
            .slice(0, 100)
            .map((x) => x.slice(0, 100))
        : [],
    );
    item.status = e.status === "ended" ? "ended" : "active";
    item.free = typeof e.free === "boolean" ? Number(e.free) : null;
    item.registration_open =
      typeof e.registration_open === "boolean"
        ? Number(e.registration_open)
        : null;
    item.created_at = item.created_at || now;
    item.updated_at = item.updated_at || now;
    statements.push(
      env.DB.prepare(
        `INSERT INTO events(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${fields
          .filter((k) => k !== "id")
          .map((k) => `${k}=excluded.${k}`)
          .join(",")} WHERE ${fields
          .filter((k) => k !== "id")
          .map((k) => `events.${k} IS NOT excluded.${k}`)
          .join(" OR ")}`,
      ).bind(...fields.map((k) => item[k])),
    );
  }
  for (const [oldId, rawWinner] of Object.entries(aliases)) {
    let winner = rawWinner;
    const seen = new Set([oldId]);
    while (Object.hasOwn(aliases, winner)) {
      if (seen.has(winner)) throw new Error("Alias cycle");
      seen.add(winner);
      winner = aliases[winner];
    }
    if (
      typeof winner !== "string" ||
      !winner ||
      oldId.length > 200 ||
      winner.length > 200 ||
      !ids.has(winner)
    )
      throw new Error("Invalid alias target");
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO favorites(user_id,event_id) SELECT user_id,? FROM favorites WHERE event_id=?",
      ).bind(winner, oldId),
    );
    statements.push(
      env.DB.prepare("DELETE FROM favorites WHERE event_id=?").bind(oldId),
    );
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO urgent_deliveries(user_id,event_id,deadline,reserved_at) SELECT user_id,?,deadline,reserved_at FROM urgent_deliveries WHERE event_id=?",
      ).bind(winner, oldId),
    );
    statements.push(
      env.DB.prepare("DELETE FROM urgent_deliveries WHERE event_id=?").bind(
        oldId,
      ),
    );
    statements.push(
      env.DB.prepare("DELETE FROM events WHERE id=?").bind(oldId),
    );
  }
  // Preserve catalog statuses; absence does not imply an ended event.

  statements.push(
    env.DB.prepare(
      "INSERT INTO sync_state(id,last_sync,last_error) VALUES(1,?,NULL) ON CONFLICT(id) DO UPDATE SET last_sync=excluded.last_sync,last_error=NULL",
    ).bind(now),
  );
  // D1 batch is transactional; never expose a partly imported snapshot.
  await env.DB.batch(statements);
  return { count: catalog.length };
}
async function webhook(req, env) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (
    !env.WEBHOOK_SECRET ||
    req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
  )
    return json({ error: "Unauthorized" }, 401);
  const update = await readBody(req);
  if (!Number.isSafeInteger(update.update_id))
    return json({ error: "Invalid update" }, 400);
  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_updates(id,created_at) VALUES(?,?)",
  )
    .bind(update.update_id, Date.now())
    .run();
  if (!claimed.meta.changes) return json({ ok: true });
  await env.DB.prepare("DELETE FROM webhook_updates WHERE created_at < ?")
    .bind(Date.now() - 7 * 86400000)
    .run();
  const m = update.message;
  if (
    m?.chat?.type === "private" &&
    m?.from?.id === m?.chat?.id &&
    /^\/start(?:@\w+)?(?:\s|$)/.test(m.text || "")
  ) {
    const url = safeUrl(env.APP_URL);
    if (!url || !url.startsWith("https:")) return json({ ok: true });
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: m.chat.id,
          text: "OlympRadar — персональный каталог соревнований. Откройте приложение и включите ежедневную сводку в настройках.",
          reply_markup: {
            inline_keyboard: [
              ...[
                ["Каталог", "catalog"],
                ["Поиск", "search"],
                ["Для вас", "recommendations"],
                ["Избранное", "favorites"],
                ["Настройки", "settings"],
              ].map(([text, view]) => {
                const target = new URL(url);
                target.searchParams.set("view", view);
                return [{ text, web_app: { url: target.href } }];
              }),
            ],
          },
        }),
      },
    );
  }
  return json({ ok: true });
}
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    try {
      if (path.startsWith("/api/")) return await api(req, env, path);
      if (path === "/telegram") return await webhook(req, env);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error("Request failed", e?.name);
      return json({ error: "Invalid request" }, 400);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await syncCatalog(env);
        } catch (e) {
          console.error("Catalog sync failed", e?.name);
        }
        await sendDueDigests(env, new Date(event.scheduledTime));
      })(),
    );
  },
};
