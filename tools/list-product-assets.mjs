import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(new URL("../apps/api/data/agentic-state.sqlite", import.meta.url), { readOnly: true });
const rows = db.prepare("select payload from media_assets order by created_at desc").all()
  .map(row => JSON.parse(row.payload))
  .filter(asset => asset.kind === "PRIMARY_PRODUCT")
  .slice(0, 30);
console.log(JSON.stringify(rows, null, 2));
