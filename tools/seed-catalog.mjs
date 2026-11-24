// Generate a public-only D1 bootstrap script using the same importer as the Worker.
import { readFile, writeFile } from "node:fs/promises";
import { syncCatalog } from "../worker/index.js";

const target = process.argv[2];
if (!target) throw new Error("Usage: node tools/seed-catalog.mjs OUTPUT.sql");
function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return "'" + value.replaceAll("'", "''").replaceAll("\0", "") + "'";
  throw new Error("Unsupported public catalog field");
}
const db = {
  prepare(sql) {
    return {
      first: async () => null,
      bind(...params) {
        let index = 0;
        const statement = sql.replace(/\?/g, () => literal(params[index++]));
        if (index !== params.length) throw new Error("Invalid SQL parameter count");
        return statement;
      },
    };
  },
  async batch(statements) {
    if (!statements.length) throw new Error("Empty import");
    await writeFile(target, statements.join(";\n") + ";\n", { mode: 0o600 });
  },
};
const directory = process.argv[3];
const readSnapshot = directory ? async (url) => {
  const file = new URL(url).pathname.split("/").pop();
  if (!["catalog.json", "catalog-aliases.json"].includes(file)) throw new Error("Unexpected catalog path");
  return new Response(await readFile(directory + "/" + file));
} : fetch;
const result = await syncCatalog({ DB: db }, readSnapshot);
console.log("Public competitions:", result.count);
