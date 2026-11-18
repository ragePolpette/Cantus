import path from "node:path";
import { type BackendEndpoint, normalizeRoute } from "./csharp.js";

const FRAMEWORK = /\b(?:flask|fastapi|starlette|quart|sanic|bottle|django)\b/i;
const VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);
const ROUTER = /^[ \t]*(\w+)\s*(?::[^=\n]+)?=\s*(?:\w+\.)*(?:Flask|Blueprint|APIRouter|FastAPI|Quart|Sanic)\s*\(/gm;
const DECORATOR = /^[ \t]*@(\w+)\.(\w+)\(\s*[rf]?(["'])((?:(?!\3)[^\n])*)\3([^\n]*)\n((?:[ \t]*@[^\n]*\n|[ \t]*\n|[ \t]*#[^\n]*\n)*)[ \t]*(?:async\s+)?def\s+(\w+)/gm;
const INCLUDE = /\.(?:include_router|register_blueprint)\(\s*([\w.]+)([^\n)]*)\)/g;
const URL_ENTRY = /\b(re_path|path)\(\s*r?(["'])((?:(?!\2)[^\n])*)\2\s*,\s*([^\n]*)/g;

const prefixOf = (text: string): string => /\b(?:url_)?prefix\s*=\s*[rf]?["']([^"']*)["']/.exec(text)?.[1] ?? "";
const join = (...parts: string[]): string => parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;
/** The text of a call's arguments, from just after its `(` to the matching `)` (strings and nesting respected, capped). */
function callArguments(text: string, start: number): string {
  let depth = 1;
  let quote = "";
  for (let index = start; index < Math.min(text.length, start + 2000); index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return text.slice(start, index);
  }
  return text.slice(start, start + 2000);
}
const stem = (file: string): string => path.posix.basename(file, ".py");

/** `<int:id>` and `<id>` (Flask), `{id}` and `{path:path}` (FastAPI) → `{…}`. */
const flaskRoute = (route: string): string => route.replace(/<[^>]*>/g, "{x}");

/** Django's `re_path` regexes: `^orders/(?P<pk>\d+)/$` → `orders/{x}`. */
function regexRoute(route: string): string {
  return route.replace(/^\^/, "").replace(/\$$/, "").replace(/\(\?P<\w+>(?:[^()]|\([^()]*\))*\)/g, "{x}").replace(/\\\//g, "/").replace(/\/\?$/, "");
}

interface Definition {
  file: string;
  line: number;
}

/**
 * HTTP endpoints of Python web code, read from the source text:
 * - Flask/Quart: `@app.route("/x", methods=[…])` and `@bp.get("/x")`, with the `url_prefix` of the Blueprint;
 * - FastAPI/Starlette: `@app.get("/x")`, `@router.post("/x")`, with the `prefix` of the `APIRouter`;
 * - Django: `path()`/`re_path()` entries in `urlpatterns`, with the prefixes of the `include("app.urls")` that reach them.
 * A router included under another prefix (`app.include_router(users.router, prefix="/v1")`) is followed when the
 * module is named; a router imported by name is taken at its own prefix only.
 */
export function pythonEndpoints(sources: Iterable<[string, string]>): BackendEndpoint[] {
  const texts = new Map(sources);
  const endpoints: BackendEndpoint[] = [];
  const definitions = new Map<string, Definition[]>();
  for (const [file, text] of texts) {
    for (const match of text.matchAll(/^(?:async\s+)?(?:def|class)\s+(\w+)/gm)) {
      const list = definitions.get(match[1]) ?? [];
      list.push({ file, line: lineAt(text, match.index) });
      definitions.set(match[1], list);
    }
  }

  // Prefixes added where a router is included: "module.router" or a bare name.
  const included: Array<{ target: string; prefix: string }> = [];
  for (const [, text] of texts) for (const match of text.matchAll(INCLUDE)) included.push({ target: match[1], prefix: prefixOf(match[2]) });

  for (const [file, text] of texts) {
    if (!FRAMEWORK.test(text)) continue;
    const routers = new Map<string, string>();
    for (const match of text.matchAll(ROUTER)) routers.set(match[1], prefixOf(callArguments(text, match.index + match[0].length)));
    const outer = (receiver: string): string => {
      const names = included.filter((entry) => entry.target === receiver || entry.target === `${stem(file)}.${receiver}`);
      return names.length === 1 ? names[0].prefix : "";
    };
    // Examples inside docstrings (`@app.route("/")` in a library's own documentation) are not routes.
    const strings = [...text.matchAll(/("""|''')[\s\S]*?\1/g)].map((string) => [string.index, string.index + string[0].length]);
    for (const match of text.matchAll(DECORATOR)) {
      if (strings.some(([from, to]) => match.index > from && match.index < to)) continue;
      const [, receiver, name, , route, rest, , handler] = match;
      const isVerb = VERBS.has(name);
      if (!isVerb && name !== "route" && name !== "api_route") continue;
      if (!routers.has(receiver) && !/^(?:app|api|bp|blueprint|router|\w+_(?:app|api|bp|router|blueprint))$/.test(receiver)) continue;
      const verbs = isVerb
        ? [name.toUpperCase()]
        : [...(/\bmethods\s*=\s*[[(]([^\])]*)[\])]/.exec(rest)?.[1] ?? "").matchAll(/["'](\w+)["']/g)].map((verb) => verb[1].toUpperCase());
      const methods: Array<string | undefined> = verbs.length > 0 ? verbs : name === "route" ? ["GET"] : [undefined];
      const full = normalizeRoute(flaskRoute(join(outer(receiver), routers.get(receiver) ?? "", route)));
      const line = lineAt(text, match.index + match[0].lastIndexOf("def "));
      for (const method of methods) endpoints.push({ ...(method ? { method } : {}), route: full, file, line, handler, kind: "route" });
    }
  }

  // Django: urlpatterns, with the prefix of each include() resolved from the root files down.
  const urlFiles = [...texts].filter(([, text]) => /\burlpatterns\b/.test(text));
  const includeOf = (module: string): string | undefined => {
    const suffix = module.replace(/\./g, "/") + ".py";
    return urlFiles.map(([file]) => file).find((file) => file === suffix || file.endsWith(`/${suffix}`));
  };
  const prefixes = new Map<string, string>();
  const entriesOf = (file: string) => {
    const text = texts.get(file)!;
    return [...text.matchAll(URL_ENTRY)].map((match) => {
      const [, kind, , route, target] = match;
      const clean = kind === "re_path" ? regexRoute(route) : flaskRoute(route);
      const module = /^include\(\s*["']([\w.]+)["']/.exec(target)?.[1];
      return { clean, target, module, index: match.index, text };
    });
  };
  const visit = (file: string, prefix: string, depth: number) => {
    if (depth > 6 || prefixes.has(file)) return;
    prefixes.set(file, prefix);
    for (const entry of entriesOf(file)) {
      const child = entry.module && includeOf(entry.module);
      if (child) visit(child, join(prefix, entry.clean), depth + 1);
    }
  };
  const includedModules = new Set<string>();
  for (const [file] of urlFiles) for (const entry of entriesOf(file)) if (entry.module) {
    const child = includeOf(entry.module);
    if (child) includedModules.add(child);
  }
  for (const [file] of urlFiles) if (!includedModules.has(file)) visit(file, "", 0);
  for (const [file] of urlFiles) visit(file, "", 0);
  for (const [file, prefix] of prefixes) {
    for (const entry of entriesOf(file)) {
      if (entry.module) continue;
      const view = /^([\w.]+?)(?:\.as_view\([^\n]*?\))?\s*(?:,|\))/.exec(entry.target)?.[1]?.split(".").pop();
      const candidates = view ? definitions.get(view) ?? [] : [];
      const dir = path.posix.dirname(file);
      const definition = candidates.find((candidate) => path.posix.dirname(candidate.file) === dir) ?? candidates[0];
      endpoints.push({
        route: normalizeRoute(join(prefix, entry.clean)),
        file: definition?.file ?? file,
        line: definition?.line ?? lineAt(entry.text, entry.index),
        handler: view ?? `${stem(file)}.<view>`,
        kind: "route",
      });
    }
  }
  return endpoints;
}
