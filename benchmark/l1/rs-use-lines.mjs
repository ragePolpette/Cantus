// Lines taken by `use` / `pub use` / `mod` declarations in each .rs file -> JSON {file: [lines]}
// Usage: node rs-use-lines.mjs <root> <out.json>
import fs from "node:fs"; import path from "node:path";
const [root, out] = process.argv.slice(2); const res = {};
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if ([".git", "target", "node_modules", ".cantus"].includes(e.name)) continue;
  const p = path.join(d, e.name); if (e.isDirectory()) { walk(p); continue; } if (!e.name.endsWith(".rs")) continue;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/); const set = []; let inUse = false;
  lines.forEach((t, i) => { if (!inUse && /^\s*(pub(\([^)]*\))?\s+)?use\s/.test(t)) inUse = true; if (inUse) { set.push(i + 1); if (t.includes(";")) inUse = false; } });
  res[path.relative(root, p).replaceAll("\\", "/")] = set; } })(root);
fs.writeFileSync(out, JSON.stringify(res));
