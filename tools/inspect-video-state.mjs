import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(new URL("../apps/api/data/agentic-state.sqlite", import.meta.url), { readOnly: true });

const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all();
console.log(JSON.stringify({ tables }, null, 2));
for (const { name } of tables) {
  if (!/(media|draft|video|job)/i.test(name)) continue;
  const columns = db.prepare(`pragma table_info(${name})`).all();
  const rows = db.prepare(`select * from ${name} order by rowid desc limit 5`).all();
  console.log(JSON.stringify({ name, columns, rows }, null, 2));
}
