import fs from "node:fs";
import path from "node:path";
import type { CallSite } from "./analyze.js";
import { PAGE_EXTENSIONS } from "./pages.js";

/** Most candidates a page name may have before a link is not guessed (`index.html` is everywhere). */
const MAX_CANDIDATES = 3;
const MAX_FILE_BYTES = 1024 * 1024;
const EXTENSIONS = PAGE_EXTENSIONS.map((extension) => extension.slice(1)).join("|");
const QUICK = new RegExp(`\\.(?:${EXTENSIONS})\\b`, "i");
// A page file name inside a string literal: `"…/pagina.aspx?c="`, `'ordine.html'`, `$"{host}/Ordine.aspx#x"`.
const LITERAL = new RegExp(`["'\`][^"'\`\\n]*?([\\w.~/\\\\-]*[\\w-]\\.(?:${EXTENSIONS}))(?=[?#&"'\`\\s])`, "gi");

/**
 * Where code builds a link to a page of the project: a string literal that names the page file, like
 * the `url += "pagina.aspx?c=" + …` of a method that sends a mail. Nothing in the imports shows it,
 * and the pages reached from outside (a mail, a notification, a redirect) have no other caller.
 * One call site per mention, with the page as the target.
 */
export function findPageLinks(root: string, files: Iterable<string>, pageFiles: string[], blockOf: (file: string) => string | undefined, readText: (absolute: string, stat?: fs.Stats) => string = (absolute) => fs.readFileSync(absolute, "utf8")): CallSite[] {
  const byName = new Map<string, string[]>();
  for (const page of pageFiles) {
    const name = path.posix.basename(page).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), page]);
  }
  const pages = new Set(pageFiles);
  const sites: CallSite[] = [];
  for (const file of files) {
    if (pages.has(file) || /\.min\.[cm]?js$/.test(file)) continue;
    let text: string;
    try {
      const absolute = path.join(root, file);
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_FILE_BYTES) continue;
      text = readText(absolute, stat);
    } catch {
      continue;
    }
    if (!QUICK.test(text)) continue;
    const from = blockOf(file);
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!QUICK.test(line)) continue;
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("#")) continue;
      for (const match of line.matchAll(LITERAL)) {
        const named = match[1].replace(/\\/g, "/").replace(/^(?:~\/|\.\.?\/)+/, "").replace(/^\/+/, "");
        const candidates = byName.get(path.posix.basename(named).toLowerCase());
        if (!candidates) continue;
        // A path in the literal ("Ordini/ordine.aspx") narrows the pages with that name to those that end in it.
        const narrowed = named.includes("/") ? candidates.filter((page) => page.toLowerCase().endsWith(named.toLowerCase())) : [];
        const targets = narrowed.length > 0 ? narrowed : candidates;
        if (targets.length > MAX_CANDIDATES) continue;
        const sure = targets.length === 1;
        for (const target of targets) {
          const to = blockOf(target);
          sites.push({
            symbol: path.posix.basename(target),
            targetFile: target,
            ...(to ? { targetBlock: to } : {}),
            file,
            ...(from ? { block: from } : {}),
            line: index + 1,
            column: (match.index ?? 0) + 1,
            snippet: code.length > 200 ? `${code.slice(0, 199)}…` : code,
            via: "link",
            match: sure ? "likely" : "by-name",
          });
        }
      }
    }
  }
  return sites;
}
