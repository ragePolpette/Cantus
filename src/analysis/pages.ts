import path from "node:path";
import { type Report } from "./diagnostics.js";

/** Server and static pages that load scripts with `<script src>` tags. */
export const PAGE_EXTENSIONS: string[] = [".html", ".htm", ".aspx", ".ascx", ".master", ".cshtml", ".vbhtml", ".php", ".jsp"];

/** A page and the scripts it loads, in order. */
export interface Page {
  file: string;
  /** Analyzed source files loaded by `<script src>`, in page order. */
  scripts: string[];
  /** `src` values that point to no analyzed file (CDN and other hosts are left out). */
  missing: string[];
  /** Inline `<script>` code, blanked outside the tags so line numbers match the page. */
  inline?: string;
  /** Pages this one is built from: master page, user controls, server-side includes and partials. */
  includes?: string[];
}

const SCRIPT_TAG = /<script\b((?:<%[\s\S]*?%>|[^>])*)>([\s\S]*?)<\/script\s*>/gi;
const SERVER_CODE = /<%[\s\S]*?%>|@\{[\s\S]*?\}|<\?(?:php)?[\s\S]*?\?>/g;

/**
 * Reads a page's script tags: where each `src` points (relative to the page, to the site root for
 * `/x.js`, `~/x.js` and `ResolveUrl("~/x.js")`), and the inline code. Query strings (`?v=3`) are
 * ignored. A path that matches no file exactly falls back to the one analyzed file ending with it.
 */
export function readPage(file: string, html: string, sourceFiles: Set<string>, report: Report = () => {}, pageFiles: Set<string> = new Set()): Page {
  const scripts: string[] = [];
  const missing: string[] = [];
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  let inline = "";
  let cursor = 0;
  let hasInline = false;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attributes = match[1];
    // The value may hold server code with its own quotes: src="<%= ResolveUrl("~/a.js") %>".
    const src = /\bsrc\s*=\s*(["'])((?:<%[\s\S]*?%>|@\([^)]*\)|(?!\1)[\s\S])*?)\1/i.exec(attributes)?.[2];
    const type = /\btype\s*=\s*(["'])([^"']*)\1/i.exec(attributes)?.[2]?.toLowerCase();
    if (src !== undefined) {
      const target = resolveScriptSrc(file, src, sourceFiles);
      if (target === null) continue; // another host
      if (target) {
        if (!scripts.includes(target)) scripts.push(target);
      } else {
        missing.push(src);
        report({ level: "info", stage: "resolve", file, message: `<script src="${src}"> points to no analyzed file` });
      }
      continue;
    }
    if (type && !/javascript|ecmascript|module|babel/.test(type)) continue; // templates and data blocks
    const bodyStart = (match.index ?? 0) + match[0].indexOf(">") + 1;
    const body = match[2];
    // Server code inside a script stands for a value: a 0 keeps `var id = <%= Id %>;` parseable.
    inline += blank(html.slice(cursor, bodyStart)) + body.replace(SERVER_CODE, (code) => "0" + blank(code.slice(1)));
    cursor = bodyStart + body.length;
    if (body.trim()) hasInline = true;
  }
  const includes = pageIncludes(file, html, pageFiles);
  return { file, scripts, missing, ...(hasInline ? { inline } : {}), ...(includes.length > 0 ? { includes } : {}) };
}

// What a page is built from on the server: its master page, user controls, includes and partial views.
const INCLUDE_PATTERNS: RegExp[] = [
  /\bMasterPageFile\s*=\s*["']([^"']+)["']/gi,
  /<%@\s*Register\b[^%]*?\bSrc\s*=\s*["']([^"']+)["']/gi,
  /<!--\s*#include\s+(?:file|virtual)\s*=\s*["']([^"']+)["']/gi,
  /<%@\s*include\s+file\s*=\s*["']([^"']+)["']/gi,
  /<jsp:include\s+page\s*=\s*["']([^"']+)["']/gi,
  /\bLayout\s*=\s*["']([^"']+)["']/g,
  /\bHtml\.(?:Render)?Partial(?:Async)?\(\s*["']([^"']+)["']/g,
  /<partial\s+name\s*=\s*["']([^"']+)["']/gi,
  /\b(?:include|require)(?:_once)?\s*\(?\s*["']([^"']+\.(?:php|inc|html?))["']/g,
];

/** The pages a page includes: master page, user controls, `#include`, partial views. A name with no extension is a Razor view: `_Name.cshtml` or `Name.cshtml`. */
export function pageIncludes(file: string, html: string, pageFiles: Set<string>): string[] {
  if (pageFiles.size === 0) return [];
  const found: string[] = [];
  for (const pattern of INCLUDE_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const name = match[1].trim();
      const named = /\.\w+$/.test(name) ? [name] : PAGE_EXTENSIONS.flatMap((extension) => [`${name}${extension}`, name.replace(/([^/]+)$/, "_$1") + extension]);
      for (const candidate of named) {
        const target = resolveScriptSrc(file, candidate, pageFiles);
        if (target && target !== file) {
          if (!found.includes(target)) found.push(target);
          break;
        }
      }
    }
  }
  return found;
}

// Scripts and page fragments the code loads at run time: `$.getScript("x.js")`, `$("#a").load("part.html")`, `script.src = "x.js"`.
const LOAD_CALL = /(?:\bgetScript|\bloadScript|\bimportScripts|\bimport|\.load|\.get|\.post|\.ajax|\bfetch)\s*\(\s*(?:\{[^}]*?\burl\s*:\s*)?(["'`])([^"'`\n]+)\1/g;
const SRC_ASSIGN = /\.src\s*=\s*(["'`])([^"'`\n]+)\1/g;
const SCRIPT_NAME = /\.(?:[cm]?js)$/i;
const PAGE_NAME = new RegExp(`\\.(?:${PAGE_EXTENSIONS.map((extension) => extension.slice(1)).join("|")})$`, "i");

/** The scripts and page fragments a piece of code names in a load call, as written (query strings left out). */
export function dynamicLoads(source: string): { scripts: string[]; fragments: string[] } {
  const scripts: string[] = [];
  const fragments: string[] = [];
  if (!/\bgetScript|\bloadScript|\bimportScripts|\bimport|\.load|\.get|\.post|\.ajax|\bfetch|\.src\b/.test(source)) return { scripts, fragments };
  for (const line of source.split(/\r?\n/)) {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    for (const match of [...line.matchAll(LOAD_CALL), ...line.matchAll(SRC_ASSIGN)]) {
      const name = match[2].replace(/[?#].*$/, "");
      if (SCRIPT_NAME.test(name)) scripts.push(match[2]);
      else if (PAGE_NAME.test(name)) fragments.push(match[2]);
    }
  }
  return { scripts, fragments };
}

/** The analyzed file a `src` points to; null for another host; undefined when nothing matches. */
export function resolveScriptSrc(page: string, rawSrc: string, sourceFiles: Set<string>): string | null | undefined {
  let src = rawSrc.trim();
  const resolveUrl = /ResolveUrl\(\s*["']([^"']+)["']\s*\)|Url\.Content\(\s*["']([^"']+)["']\s*\)/.exec(src);
  if (resolveUrl) src = resolveUrl[1] ?? resolveUrl[2];
  src = src.replace(/<%[\s\S]*?%>|@\S+/g, "").replace(/[?#].*$/, "");
  if (/^([a-z]+:)?\/\//i.test(src)) return null;
  if (!src) return undefined;
  const rooted = src.startsWith("~/") ? src.slice(2) : src.startsWith("/") ? src.slice(1) : undefined;
  const candidate = path.posix.normalize(rooted ?? path.posix.join(path.posix.dirname(page), src)).replace(/^\.\//, "");
  if (sourceFiles.has(candidate)) return candidate;
  // Sites mounted under a virtual directory, or paths rewritten by the server: match the end of the path.
  const tail = "/" + (rooted ?? src).replace(/^(\.\.?\/)+/, "");
  const matches = [...sourceFiles].filter((file) => ("/" + file).endsWith(tail));
  return matches.length === 1 ? matches[0] : undefined;
}
