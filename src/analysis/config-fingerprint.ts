import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/** Configurations used by TS resolution, including inherited/package configs and missing targets.
 * Hash content rather than dates: editors may preserve size and timestamps. */
export function configurationFingerprint(root: string): string {
  const files = new Map<string, string>();
  const visit = (file: string): void => {
    file = path.resolve(file);
    if (files.has(file)) return;
    files.set(file, "missing");
    let content: string;
    try { content = fs.readFileSync(file, "utf8"); } catch { return; }
    files.set(file, createHash("sha256").update(content).digest("hex"));
    if (!file.endsWith(".json")) return;
    let config: { extends?: unknown; references?: Array<{ path?: string }> };
    try {
      config = JSON.parse(content.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, quoted: string) => quoted ?? "").replace(/,(\s*[}\]])/g, "$1"));
    } catch { return; } // The analyzer reports invalid configs; their bytes still invalidate the snapshot.
    if (!config || typeof config !== "object" || Array.isArray(config)) return;
    const dir = path.dirname(file);
    for (const target of [config.extends].flat().filter((value): value is string => typeof value === "string")) {
      if (target.startsWith(".") || path.isAbsolute(target)) {
        const absolute = path.resolve(dir, target);
        visit(absolute.endsWith(".json") ? absolute : `${absolute}.json`);
      } else {
        const require = createRequire(file);
        try { visit(require.resolve(target)); }
        catch {
          try { visit(require.resolve(`${target}/tsconfig.json`)); }
          catch { files.set(`${file}:unresolved:${target}`, "missing"); }
        }
      }
    }
    if (Array.isArray(config.references)) for (const reference of config.references) {
      if (typeof reference?.path !== "string") continue;
      const target = path.resolve(dir, reference.path);
      visit(target.endsWith(".json") ? target : path.join(target, "tsconfig.json"));
    }
  };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory() && !["node_modules", ".git", ".cantus", "bin", "obj", "dist", "build", ".next"].includes(entry.name)) walk(absolute);
      else if (entry.isFile() && (/^(?:tsconfig|jsconfig)(?:\..*)?\.json$/.test(entry.name) || ["package.json", "composer.json", ".gitignore", ".gitmodules"].includes(entry.name))) visit(absolute);
    }
  };
  walk(root);
  return createHash("sha256").update(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
