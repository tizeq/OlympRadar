import { handleUpdate } from "./chat.js";
import { sendDueDigests } from "./notifications.js";
export const CATALOG_URL =
  "https://raw.githubusercontent.com/tizeq/OlympRadar/catalog-data/catalog.json";
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
export const visibleEvents = `e.status = 'active' AND (
  e.category IS NULL OR e.category <> 'olympiad'
  OR EXISTS (
    SELECT 1 FROM json_each(e.tags_json)
    WHERE value IN ('ai', 'ml', 'programming', 'informatics', 'cybersecurity', 'robotics')
  )
  OR e.id IN (
    SELECT id FROM events_fts
    WHERE events_fts MATCH 'title : (
      информатик* OR программирован* OR кибербезопасност* OR робототехник*
      OR информационн* + безопасност* OR информационн* + технологи*
      OR "computer science" OR "information security" OR "information technology"
      OR cybersecurity OR robotics OR informatics OR programming
    )'
  )
)`;
export function buildEventQuery(input = {}, userId = "") {
  const p =
    input instanceof URLSearchParams ? Object.fromEntries(input) : input;
  const where = [visibleEvents];
  const args = [];
  const add = (sql, value) => {
    where.push(sql);
    args.push(value);
  };
  if (p.category === "ai") return buildEventQuery({...p, category: "", tag: "ai"}, userId);
  if (p.q) {
    const query = String(p.q).slice(0, 200).toLowerCase()
      .replace(/искусственн[а-яё]*\s+интеллект[а-яё]*|artificial\s+intelligence/gu, "ai");
    const tokens = [];
    const types = {олимпиада:"olympiad",олимпиады:"olympiad",хакатон:"hackathon",хакатоны:"hackathon",грант:"grant",гранты:"grant"};
    for (const token of query.match(/[\p{L}\p{N}_]+/gu) || []) {
      if (["ии", "ai"].includes(token)) {
        where.push("EXISTS (SELECT 1 FROM json_each(e.tags_json) WHERE value='ai')");
      } else if (Object.hasOwn(types, token)) {
        add("e.category = ?", types[token]);
      } else if (!["по", "на", "и", "мероприятия", "мероприятие", "соревнования", "соревнование"].includes(token)) {
        tokens.push(token);
      }
    }
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
  for (const field of ["start", "end", "registration_start", "registration_end", "deadline"]) {
    const lower = p[field + "_from"], upper = p[field + "_to"];
    if (lower) add(`julianday(e.${field}) >= julianday(?)`, String(lower));
    if (upper) {
      const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(upper);
      add(dayOnly ? `julianday(e.${field}) < julianday(?, '+1 day')` : `julianday(e.${field}) <= julianday(?)`, String(upper));
    }
  }
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
const fields = [
  "id",
  "title",
  "url",
  "source",
  "description",
  "category",
  "tags_json",
  "start",
  "end",
  "registration_start",
  "registration_end",
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
export async function syncCatalog(env, readSnapshot = fetch) {
  const prior = await env.DB.prepare(
    "SELECT last_sync FROM sync_state WHERE id=1",
  ).first();
  if (prior?.last_sync && Date.now() - Date.parse(prior.last_sync) < 86400000)
    return { skipped: true };
  const response = await readSnapshot(CATALOG_URL, {
    signal: AbortSignal.timeout(20000),
    redirect: "manual",
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
  const aliasesResponse = await readSnapshot(
    CATALOG_URL.replace("catalog.json", "catalog-aliases.json"),
    { signal: AbortSignal.timeout(20000), redirect: "manual" },
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
    item.status = ["ended", "withdrawn"].includes(e.status) ? e.status : "active";
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
  await handleUpdate(update, env);
  return json({ ok: true });
}
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/telegram") return await webhook(req, env);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      const frame = e?.stack?.split("\n").find((line) => /\bat (?:telegram|handleUpdate|webhook|screen|readBody)\b/.test(line));
      console.error("Webhook processing failed", e?.name, frame?.trim() ?? "");
      return json({ error: "Processing failed" }, 502);
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
