import { parseSync, Visitor } from "oxc-parser";
import { type Report, lineColumn } from "./diagnostics.js";
import { isVueFile, parseName, sfcParts } from "./vue.js";

export interface ImportBinding {
  /** Name exported by the target module: a name, `default`, or `*` for a namespace import. */
  imported: string;
  local: string;
}

export interface ImportRef {
  specifier: string;
  /** Imported names; `*` for namespace imports, re-export-all, dynamic import and require; `default` for default imports. */
  symbols: string[];
  /** Local names introduced by a static import, used to find where the imports are used. */
  bindings: ImportBinding[];
}

/** A place in a file where an imported binding is used. */
export interface Usage {
  line: number;
  column: number;
  /** The source line, trimmed. */
  snippet: string;
  /** For namespace imports (`ns.fn()`), the accessed member. */
  member?: string;
}

export interface ModuleInfo {
  refs: ImportRef[];
  /** Usages of each imported local name (outside the import statements). */
  usages: Record<string, Usage[]>;
  /** HTTP calls to a backend (fetch, XHR open, ajax helpers) whose URL has a readable static part. */
  httpCalls: HttpCall[];
  /** HTTP calls whose URL is built entirely at run time: counted so the map's coverage is known. */
  dynamicHttpCalls: Array<{ line: number; column: number; snippet: string }>;
  /** Set when the file is a classic script (no import/export, no require/module.exports): its top level is global. */
  script?: { exportAt: number[] };
  /** Globals the file defines: top-level declarations of a script, and `window.X = …` anywhere. */
  globals: GlobalDefinition[];
  /** Top-level variables of a classic script that hold a string: `var BASE_URL = "https://host/app/"`. */
  stringGlobals: Record<string, string>;
  /** Names the file reads without declaring them in any enclosing scope: globals from other scripts, or the platform's. */
  freeRefs: Record<string, Usage[]>;
  /** References to the requested top-level local binding, when one was requested. */
  localReferences?: Usage[];
  /** Vue components registered globally here: `Vue.component("order-list", …)`, `app.component("OrderList", …)`. */
  /** `inline`: the registration defines the component right there (an object, `defineComponent(…)`), rather than registering one imported from elsewhere. */
  components: Array<{ name: string; line: number; column: number; inline: boolean }>;
  /** Template strings (`template: "<div>…</div>"`) and where their text starts, to find the component tags they use. */
  templates: Array<{ text: string; start: number }>;
  /**
   * Functions of this file that make an HTTP request with the URL (and maybe the verb) one of their
   * parameters gives: `function sendObjDati(url, type) { $.ajax({ url, type }) }`. Calls to them are
   * HTTP calls too.
   */
  httpWrappers: HttpWrapper[];
  /** Named functions passing one of their parameters on to another call: wrappers of wrappers. */
  forwards: Array<{ from: string; param: number; callee: string; arg: number; value?: string; member?: "method" }>;
  /** Calls to named functions with a path-like string argument: HTTP calls if the function is a wrapper. */
  namedCalls: Array<{ callee: string; args: Array<string | null>; methods?: Array<string | undefined>; line: number; column: number; snippet: string }>;
}

/** A function that sends an HTTP request built from its parameters. Positions count from 0. */
export interface HttpWrapper {
  name: string;
  urlArg: number;
  methodArg?: number;
  /** Position of the options object whose `method` is the verb (`request(path, init)` doing `fetch(path, { ...init })`). */
  optionsArg?: number;
  /** The URL with the parameter's place marked by WRAPPED_URL: `§`, `api/§`, `/orders/§`. */
  urlTemplate: string;
  /** The verb, when the wrapper always sends the same one (postObjDati → sendObjDati(url, "POST")); with `optionsArg`, the one used when the options name none. */
  method?: string;
}

/** Where the caller's argument goes in a wrapper's URL. */
export const WRAPPED_URL = "\u0001";

/** A name a file puts in the global scope. */
export interface GlobalDefinition {
  name: string;
  kind: "function" | "class" | "variable";
  line: number;
  column: number;
  /** Set by `window.x = …`: an assignment, which may just re-expose a value defined elsewhere. */
  assigned?: true;
}

/** An HTTP call to a backend: what a block asks of the server that imports cannot see. */
export interface HttpCall {
  /** The URL as far as it can be read without running the code: run-time parts become `{…}`, the query string is dropped. */
  url: string;
  /** Uppercase verb; `GET` when the call does not spell one out. */
  method?: string;
  line: number;
  column: number;
  /** The source line, trimmed. */
  snippet: string;
  /**
   * The global the URL starts with, when this file does not give it a value (`BASE_URL` in
   * `fetch(BASE_URL + "api/x")`, `window.API_ROOT`): another script may, and the project resolves it.
   */
  prefixName?: string;
}

const MAX_SNIPPET = 160;

/** The name a URL expression starts with: `BASE_URL + "x"`, `${BASE_URL}x`, `window.API_ROOT + "x"`. */
function leadingName(node: unknown, depth = 0): string | undefined {
  const n = asNode(node);
  if (!n || depth > 20) return undefined;
  switch (n.type) {
    case "Identifier":
      return n.name as string;
    case "MemberExpression": {
      const object = asNode(n.object);
      const property = asNode(n.property);
      return !n.computed && object?.type === "Identifier" && ["window", "self", "globalThis"].includes(object.name as string) ? (property?.name as string | undefined) : undefined;
    }
    case "BinaryExpression":
      return n.operator === "+" ? leadingName(n.left, depth + 1) : undefined;
    case "ParenthesizedExpression":
      return leadingName(n.expression, depth + 1);
    case "TemplateLiteral": {
      const quasis = (n.quasis as Array<{ value: { cooked?: string | null; raw: string } }>) ?? [];
      const expressions = (n.expressions as unknown[]) ?? [];
      return (quasis[0]?.value.cooked ?? quasis[0]?.value.raw ?? "") === "" ? leadingName(expressions[0], depth + 1) : undefined;
    }
    default:
      return undefined;
  }
}

const XHR_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** Objects whose methods are HTTP calls: jQuery, axios, and the clients Vue apps put on `this` or on Vue. */
const AJAX_HELPERS = new Set(["$", "jQuery", "axios", "$http", "http", "$axios", "$ajax"]);
const AJAX_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "del", "request", "ajax", "getJSON"]);
export const DYNAMIC = "{…}";

type Node = { type?: string; [key: string]: unknown };

const asNode = (value: unknown): Node | undefined => (value !== null && typeof value === "object" ? (value as Node) : undefined);

const literalString = (node: unknown): string | undefined => {
  const n = asNode(node);
  return n?.type === "Literal" && typeof n.value === "string" ? n.value : undefined;
};

/** A property of an object expression, e.g. `url` in `{ url: "..." }`. */
const objectProperty = (node: unknown, name: string): unknown => {
  const n = asNode(node);
  if (n?.type !== "ObjectExpression") return undefined;
  for (const property of (n.properties as unknown[] | undefined) ?? []) {
    const entry = property as { type?: string; key?: { type?: string; name?: string; value?: unknown }; value?: unknown };
    if (entry.type !== "Property") continue;
    const key = entry.key?.type === "Identifier" ? entry.key.name : typeof entry.key?.value === "string" ? entry.key.value : undefined;
    if (key === name) return entry.value;
  }
  return undefined;
};

/** Name of the object a method is called on: `$` in `$.ajax`, `$http` in `this.$http.get`. */
const calleeObjectName = (object: unknown): string | undefined => {
  const n = asNode(object);
  if (n?.type === "Identifier") return n.name as string;
  if (n?.type === "MemberExpression" && !n.computed) return asNode(n.property)?.name as string | undefined;
  return undefined;
};

/**
 * Reads a URL expression as far as possible without running the code: string literals, templates,
 * `+` concatenation, and constants of the same file holding a string. Anything else becomes `{…}`.
 */
function staticUrl(node: unknown, constants: Map<string, string | null>, depth = 0): string {
  const n = asNode(node);
  if (!n || depth > 20) return DYNAMIC;
  switch (n.type) {
    case "Literal":
      return typeof n.value === "string" ? n.value : DYNAMIC;
    case "TemplateLiteral": {
      const quasis = (n.quasis as Array<{ value: { cooked?: string | null; raw: string } }>) ?? [];
      const expressions = (n.expressions as unknown[]) ?? [];
      return quasis.map((quasi, index) => (quasi.value.cooked ?? quasi.value.raw) + (index < expressions.length ? staticUrl(expressions[index], constants, depth + 1) : "")).join("");
    }
    case "BinaryExpression":
      return n.operator === "+" ? staticUrl(n.left, constants, depth + 1) + staticUrl(n.right, constants, depth + 1) : DYNAMIC;
    case "ParenthesizedExpression":
      return staticUrl(n.expression, constants, depth + 1);
    case "Identifier": {
      const value = constants.get(n.name as string);
      return typeof value === "string" ? value : DYNAMIC;
    }
    default:
      return DYNAMIC;
  }
}

/** Drops the query string and fragment and merges adjacent run-time parts; undefined when nothing static is left. */
/**
 * A URL that names a file the page loads (`$.getScript("js/x.js")`, a stylesheet, an image, a font), not a backend route:
 * with no endpoint behind it, that is not a call the map is missing an arrow for.
 */
export function isStaticAssetUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? "";
  return /\.(?:js|mjs|css|map|html?|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot)$/i.test(path);
}

export function normalizeUrl(url: string): string | undefined {
  let normalized = url.replace(/[?#].*$/s, "");
  while (normalized.includes(DYNAMIC + DYNAMIC)) normalized = normalized.replaceAll(DYNAMIC + DYNAMIC, DYNAMIC);
  return /[A-Za-z]/.test(normalized.replaceAll(DYNAMIC, "")) ? normalized : undefined;
}

/**
 * Imports (static, re-exports, dynamic `import("...")`, `require("...")`) and where each
 * imported binding is used. Scoping is not resolved: a local variable that shadows an
 * import is counted as a use.
 */
export function analyzeModule(fileName: string, fileSource: string, report?: Report, localBinding?: string): ModuleInfo {
  // A .vue file is read through its <script> blocks, blanked in place so lines and columns still match.
  const source = isVueFile(fileName) ? sfcParts(fileSource).script : fileSource;
  const { module, program, errors } = parseSync(parseName(fileName), source);
  const refs: ImportRef[] = [];
  for (const error of errors) {
    const start = error.labels[0]?.start;
    report?.({
      level: error.severity === "Error" ? "error" : "warning",
      stage: "parse",
      file: fileName,
      ...(start !== undefined ? lineColumn(source, start) : {}),
      message: error.message,
      detail: error.codeframe ?? undefined,
    });
  }

  for (const entry of module.staticImports) {
    const bindings = entry.entries.map((item) => ({
      imported: item.importName.kind === "Default" ? "default" : item.importName.kind === "NamespaceObject" ? "*" : item.importName.name ?? "*",
      local: item.localName.value,
    }));
    refs.push({ specifier: entry.moduleRequest.value, symbols: bindings.map((binding) => binding.imported), bindings });
  }

  for (const entry of module.staticExports) {
    for (const item of entry.entries) {
      if (!item.moduleRequest) continue;
      const symbol = item.importName.kind === "Name" ? item.importName.name ?? "*" : "*";
      refs.push({ specifier: item.moduleRequest.value, symbols: [symbol], bindings: [] });
    }
  }

  const locals = new Set(refs.flatMap((ref) => ref.bindings.map((binding) => binding.local)));
  const namespaces = new Set(refs.flatMap((ref) => ref.bindings.filter((binding) => binding.imported === "*").map((binding) => binding.local)));
  // Import statements and `export ... from "..."` re-exports name other modules' bindings, not the local ones.
  const importRanges = [
    ...module.staticImports.map((entry) => [entry.start, entry.end] as const),
    ...module.staticExports.filter((entry) => entry.entries.some((item) => item.moduleRequest)).map((entry) => [entry.start, entry.end] as const),
  ];
  const notReferences = new Set<number>();
  for (const { entries } of module.staticExports) {
    for (const { exportName, localName } of entries) {
      if (exportName.start !== null && exportName.start !== localName.start) notReferences.add(exportName.start);
    }
  }
  const members = new Map<number, string>();
  const found = new Map<number, { name: string }>();
  const lines = source.split("\n");
  // URLs are read after the walk, once every string constant of the file is known.
  const httpCandidates: Array<{ url: unknown; method?: unknown; defaultMethod?: string; start: number }> = [];
  // Named functions being walked, with their simple parameter names: to find HTTP wrappers.
  type Frame = { name?: string; params: Array<string | undefined> };
  const frames: Frame[] = [];
  const functionNames = new Map<number, string>();
  const httpWrappers: HttpWrapper[] = [];
  const wrapperUrls: Array<{ wrapper: Omit<HttpWrapper, "urlTemplate">; url: unknown; param: string }> = [];
  const forwards: ModuleInfo["forwards"] = [];
  const namedCallCandidates: Array<{ callee: string; args: unknown[]; start: number }> = [];
  /**
   * Which parameter of a named function an expression comes from: the nearest function declaring the
   * name, even from inside a callback (`new Promise((resolve) => $.ajax({ url }))`).
   */
  const paramOf = (node: unknown): { name: string; index: number } | undefined => {
    const n = asNode(node);
    if (!n) return undefined;
    if (n.type === "Identifier") {
      for (let depth = frames.length - 1; depth >= 0; depth--) {
        const index = frames[depth].params.indexOf(n.name as string);
        if (index >= 0) return frames[depth].name ? { name: frames[depth].name!, index } : undefined;
      }
      return undefined;
    }
    // A URL built around the parameter (base + url, `${base}/${url}`) still comes from it.
    if (n.type === "BinaryExpression" && n.operator === "+") return paramOf(n.left) ?? paramOf(n.right);
    if (n.type === "TemplateLiteral") {
      for (const expression of (n.expressions as unknown[]) ?? []) {
        const found = paramOf(expression);
        if (found) return found;
      }
    }
    return undefined;
  };
  const constants = new Map<string, string | null>();
  // Objects written once in a variable (`const opts = { method, headers }`), for `fetch(url, opts)`.
  const objectConstants = new Map<string, unknown | null>();
  // The parameter an options object comes from: `fetch(url, init)` or `fetch(url, { ...init, headers })`.
  const optionsParamOf = (options: unknown): { name: string; index: number } | undefined => {
    const n = asNode(options);
    if (n?.type === "Identifier") return paramOf(n);
    if (n?.type !== "ObjectExpression" || objectProperty(n, "method") !== undefined) return undefined;
    for (const property of (n.properties as unknown[] | undefined) ?? []) {
      const entry = asNode(property);
      if (entry?.type === "SpreadElement") {
        const found = paramOf(entry.argument);
        if (found) return found;
      }
    }
    return undefined;
  };
  const recordHttpCall =(url: unknown, method: unknown, defaultMethod: string | undefined, start: number, options?: unknown) => {
    if (url === undefined) return;
    const fromParam = paramOf(url);
    if (fromParam && !wrapperUrls.some((entry) => entry.wrapper.name === fromParam.name)) {
      // Part of the URL comes from the caller: maybe a wrapper, whose callers make the real calls.
      // The call itself is kept too (`fetch("/orders/" + id)` is a call, `id` just a value).
      const verb = paramOf(method);
      const methodArg = verb?.name === fromParam.name ? verb.index : undefined;
      // A verb that does not come from the caller: written here, or the call's default (GET for $.ajax).
      const fixed = methodArg === undefined ? (method === undefined ? defaultMethod : literalString(method)?.toUpperCase()) : undefined;
      const fromOptions = methodArg === undefined && method === undefined ? optionsParamOf(options) : undefined;
      const optionsArg = fromOptions?.name === fromParam.name ? fromOptions.index : undefined;
      const frame = [...frames].reverse().find((candidate) => candidate.name === fromParam.name);
      wrapperUrls.push({ wrapper: { name: fromParam.name, urlArg: fromParam.index, ...(methodArg !== undefined ? { methodArg } : {}), ...(optionsArg !== undefined ? { optionsArg } : {}), ...(fixed ? { method: fixed } : {}) }, url, param: frame?.params[fromParam.index] ?? "" });
    }
    httpCandidates.push({ url, method, defaultMethod, start });
  };
  const record = (name: string, start: number) => {
    if (!locals.has(name) || notReferences.has(start) || importRanges.some(([from, to]) => start >= from && start < to)) return;
    found.set(start, { name });
  };
  const nonComputedKey = (node: { computed?: boolean; key: { start: number } }) => {
    if (!node.computed) notReferences.add(node.key.start);
  };

  // Scopes, to tell a global read from a local variable that happens to share its name.
  type Scope = { start: number; end: number; fn: boolean };
  const scopes: Scope[] = [{ start: 0, end: source.length, fn: true }];
  const declarations = new Map<string, Array<[number, number]>>();
  const reads: Array<{ name: string; start: number }> = [];
  let commonJs = false;
  const components: ModuleInfo["components"] = [];
  const templates: ModuleInfo["templates"] = [];
  const globals: GlobalDefinition[] = [];
  const exportAt: number[] = [];
  const declareIn = (scope: Scope, name: string, start: number) => {
    notReferences.add(start);
    const ranges = declarations.get(name) ?? [];
    ranges.push([scope.start, scope.end]);
    declarations.set(name, ranges);
  };
  const top = () => scopes[scopes.length - 1];
  const nearestFunction = () => [...scopes].reverse().find((scope) => scope.fn)!;
  const declarePattern = (pattern: unknown, scope: Scope) => {
    const n = asNode(pattern);
    if (!n) return;
    if (n.type === "Identifier") declareIn(scope, n.name as string, n.start as number);
    else if (n.type === "ObjectPattern") for (const property of (n.properties as unknown[]) ?? []) declarePattern(asNode(property)?.type === "RestElement" ? property : asNode(property)?.value, scope);
    else if (n.type === "ArrayPattern") for (const element of (n.elements as unknown[]) ?? []) declarePattern(element, scope);
    else if (n.type === "AssignmentPattern") declarePattern(n.left, scope);
    else if (n.type === "RestElement") declarePattern(n.argument, scope);
  };
  const enterFunction = (node: { start: number; end: number; type: string; id?: { name: string; start: number } | null; params: unknown[] }) => {
    if (node.id && node.type === "FunctionDeclaration") declareIn(top(), node.id.name, node.id.start);
    const scope = { start: node.start, end: node.end, fn: true };
    scopes.push(scope);
    if (node.id && node.type !== "FunctionDeclaration") declareIn(scope, node.id.name, node.id.start);
    for (const param of node.params) declarePattern(param, scope);
    const simpleName = (param: unknown): string | undefined => {
      const n = asNode(param);
      if (n?.type === "Identifier") return n.name as string;
      if (n?.type === "AssignmentPattern") return simpleName(n.left);
      return undefined;
    };
    frames.push({ name: node.id?.name ?? functionNames.get(node.start), params: node.params.map(simpleName) });
  };
  const leaveFunction = () => {
    leave();
    frames.pop();
  };
  // The name a function expression is known by: `var f = function`, `f: function`, `f() {}`, `window.f = …`.
  const nameFunction = (value: unknown, name: string | undefined) => {
    const n = asNode(value);
    if (name && n && (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression")) functionNames.set(n.start as number, name);
  };
  const enterBlock = (node: { start: number; end: number }) => {
    scopes.push({ start: node.start, end: node.end, fn: false });
  };
  const leave = () => {
    if (scopes.length > 1) scopes.pop();
  };
  const markLabel = (node: { label?: { start: number } | null }) => {
    if (node.label) notReferences.add(node.label.start);
  };

  new Visitor({
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        refs.push({ specifier: node.source.value, symbols: ["*"], bindings: [] });
      }
    },
    CallExpression(node) {
      const [argument] = node.arguments;
      const calleeName = node.callee.type === "Identifier" ? node.callee.name : node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.type === "Identifier" ? node.callee.property.name : undefined;
      // A plain `request(...)` or `get(...)` is the project's own function, maybe a wrapper, and so is `api.get(...)` on an object of the project; `axios.get(...)` and the like are handled below.
      if (calleeName && !(node.callee.type === "Identifier" && (calleeName === "fetch" || calleeName === "axios" || calleeName === "require")) && !(node.callee.type === "MemberExpression" && AJAX_VERBS.has(calleeName) && AJAX_HELPERS.has(calleeObjectName(node.callee.object) ?? ""))) {
        const named = [...frames].reverse().find((frame) => frame.name)?.name;
        node.arguments.forEach((arg, index) => {
          const param = paramOf(arg);
          if (param) forwards.push({ from: param.name, param: param.index, callee: calleeName, arg: index });
          // A value written here (postObjDati calling sendObjDati(url, "POST")): param -1, the value kept.
          else if (named && literalString(arg) !== undefined) forwards.push({ from: named, param: -1, callee: calleeName, arg: index, value: literalString(arg)! });
          // The verb written in an options object (`request(path, { method: "POST" })`).
          else if (named && literalString(objectProperty(arg, "method")) !== undefined) forwards.push({ from: named, param: -1, callee: calleeName, arg: index, value: literalString(objectProperty(arg, "method"))!, member: "method" });
          // Options passed on whole (`request(path, init)`), when it is a parameter: found above.
        });
        // Maybe a call to an HTTP wrapper: kept if an argument reads like a path.
        if (node.arguments.some((arg) => {
          const type = asNode(arg)?.type;
          return type === "Literal" || type === "TemplateLiteral" || type === "BinaryExpression";
        })) namedCallCandidates.push({ callee: calleeName, args: node.arguments.slice(0, 4), start: node.start });
      }
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        argument.type === "Literal" &&
        typeof argument.value === "string"
      ) {
        refs.push({ specifier: argument.value, symbols: ["*"], bindings: [] });
      }
      if (node.callee.type === "Identifier" && (node.callee.name === "fetch" || node.callee.name === "axios")) {
        const second = node.arguments[1];
        const options = asNode(argument)?.type === "ObjectExpression" ? argument : asNode(second)?.type === "Identifier" ? objectConstants.get(asNode(second)!.name as string) ?? second : second;
        const url = asNode(argument)?.type === "ObjectExpression" ? objectProperty(argument, "url") : argument;
        recordHttpCall(url, objectProperty(options, "method"), "GET", node.start, options);
        return;
      }
      if (node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.type === "Identifier") {
        const property = node.callee.property.name;
        if (property === "open") {
          const verb = literalString(node.arguments[0])?.toUpperCase();
          if (verb !== undefined && XHR_METHODS.has(verb) && node.arguments[1]) recordHttpCall(node.arguments[1], undefined, verb, node.start);
          return;
        }
        if (property === "component" && node.arguments.length >= 2) {
          const name = literalString(argument);
          const definition = asNode(node.arguments[1])?.type;
          const inline = definition === "ObjectExpression" || definition === "CallExpression" || definition === "FunctionExpression" || definition === "ArrowFunctionExpression" || definition === "ClassExpression";
          if (name) components.push({ name, ...lineColumn(source, (argument as { start: number }).start), inline });
        }
        const objectName = calleeObjectName(node.callee.object);
        if (AJAX_VERBS.has(property) && objectName !== undefined && AJAX_HELPERS.has(objectName)) {
          // $.ajax({ url, type }) / $.ajax(url, { type }) / $.get(url) / axios.post(url) / this.$http.get(url)
          const settingsFirst = asNode(argument)?.type === "ObjectExpression";
          const settings = settingsFirst ? argument : node.arguments[1];
          const url = settingsFirst ? objectProperty(argument, "url") : argument;
          const verb = property === "getJSON" ? "GET" : property === "ajax" ? "GET" : property === "request" ? undefined : property === "del" ? "DELETE" : property.toUpperCase();
          recordHttpCall(url, objectProperty(settings, "method") ?? objectProperty(settings, "type"), verb, node.start);
        }
      }
    },
    AssignmentExpression(node) {
      if (node.left.type === "Identifier") nameFunction(node.right, node.left.name);
      else if (node.left.type === "MemberExpression" && !node.left.computed && node.left.property.type === "Identifier") nameFunction(node.right, node.left.property.name);
      // window.X = … puts X in the global scope, from a script or a module alike.
      if (node.left.type === "MemberExpression" && !node.left.computed && node.left.object.type === "Identifier" && node.left.object.name === "window" && node.left.property.type === "Identifier") {
        const valueType = asNode(node.right)?.type;
        globals.push({ name: node.left.property.name, kind: valueType === "FunctionExpression" || valueType === "ArrowFunctionExpression" ? "function" : valueType === "ClassExpression" ? "class" : "variable", ...lineColumn(source, node.left.property.start), assigned: true });
      }
      if (node.left.type !== "Identifier" || !constants.has(node.left.name)) return;
      const value = node.operator === "=" ? staticUrl(node.right, constants) : DYNAMIC;
      if (constants.get(node.left.name) !== value) constants.set(node.left.name, null);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      const name = node.id.name;
      if (!node.init) return;
      nameFunction(node.init, name);
      if (asNode(node.init)?.type === "ObjectExpression") objectConstants.set(name, objectConstants.has(name) ? null : node.init);
      const value = staticUrl(node.init, constants);
      // A name given two different values, or a value read at run time, is not a constant.
      constants.set(name, constants.has(name) && constants.get(name) !== value ? null : value.includes(DYNAMIC) ? null : value);
    },
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": leaveFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": leaveFunction,
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": leaveFunction,
    BlockStatement: enterBlock,
    "BlockStatement:exit": leave,
    ForStatement: enterBlock,
    "ForStatement:exit": leave,
    ForInStatement: enterBlock,
    "ForInStatement:exit": leave,
    ForOfStatement: enterBlock,
    "ForOfStatement:exit": leave,
    SwitchStatement: enterBlock,
    "SwitchStatement:exit": leave,
    CatchClause(node) {
      enterBlock(node);
      if (node.param) declarePattern(node.param, top());
    },
    "CatchClause:exit": leave,
    ClassDeclaration(node) {
      if (node.id) declareIn(top(), node.id.name, node.id.start);
    },
    ClassExpression(node) {
      if (node.id) notReferences.add(node.id.start);
    },
    VariableDeclaration(node) {
      const scope = node.kind === "var" ? nearestFunction() : top();
      for (const declarator of node.declarations) declarePattern(declarator.id, scope);
    },
    LabeledStatement: markLabel,
    BreakStatement: markLabel,
    ContinueStatement: markLabel,
    MetaProperty(node) {
      notReferences.add(node.meta.start);
      notReferences.add(node.property.start);
    },
    MemberExpression(node) {
      if (node.object.type === "Identifier" && ((node.object.name === "module" && !node.computed && node.property.type === "Identifier" && node.property.name === "exports") || node.object.name === "exports")) commonJs = true;
      if (!node.computed) notReferences.add(node.property.start);
      if (node.object.type === "Identifier" && namespaces.has(node.object.name)) {
        const property = node.property as { type: string; name?: string; value?: unknown };
        const member = property.type === "Identifier" && !node.computed ? property.name : typeof property.value === "string" ? property.value : undefined;
        if (member) members.set(node.object.start, member);
      }
    },
    Property(node) {
      if (!node.shorthand) nonComputedKey(node);
      if (!node.computed && node.key.type === "Identifier") nameFunction(node.value, node.key.name);
      if (!node.computed && node.key.type === "Identifier" && node.key.name === "template") {
        const value = asNode(node.value);
        if (value?.type === "Literal" && typeof value.value === "string" && !value.value.startsWith("#")) templates.push({ text: value.value, start: (value.start as number) + 1 });
        if (value?.type === "TemplateLiteral") templates.push({ text: source.slice((value.start as number) + 1, (value.end as number) - 1), start: (value.start as number) + 1 });
      }
    },
    MethodDefinition(node) {
      nonComputedKey(node);
      if (!node.computed && node.key.type === "Identifier") nameFunction(node.value, node.key.name);
    },
    PropertyDefinition: nonComputedKey,
    TSPropertySignature: nonComputedKey,
    TSMethodSignature: nonComputedKey,
    JSXMemberExpression(node) {
      notReferences.add(node.property.start);
    },
    Identifier(node) {
      record(node.name, node.start);
      if (!notReferences.has(node.start) && !importRanges.some(([from, to]) => node.start >= from && node.start < to)) reads.push({ name: node.name, start: node.start });
    },
    JSXIdentifier(node) {
      record(node.name, node.start);
    },
  }).visit(program);

  // Keyed by identifiers from the code: no prototype, so `constructor` or `toString` are plain keys.
  const usages: Record<string, Usage[]> = Object.create(null) as Record<string, Usage[]>;
  for (const [start, { name }] of [...found.entries()].sort(([a], [b]) => a - b)) {
    const position = lineColumn(source, start);
    const text = (lines[position.line - 1] ?? "").trim();
    const member = members.get(start);
    (usages[name] ??= []).push({
      ...position,
      snippet: text.length > MAX_SNIPPET ? text.slice(0, MAX_SNIPPET - 1) + "…" : text,
      ...(member ? { member } : {}),
    });
  }

  const usageAt = (start: number): Usage => {
    const position = lineColumn(source, start);
    const text = (lines[position.line - 1] ?? "").trim();
    return { ...position, snippet: text.length > MAX_SNIPPET ? text.slice(0, MAX_SNIPPET - 1) + "…" : text };
  };
  const freeRefs: Record<string, Usage[]> = Object.create(null) as Record<string, Usage[]>;
  for (const read of reads) {
    if (locals.has(read.name) || (declarations.get(read.name) ?? []).some(([from, to]) => read.start >= from && read.start < to)) continue;
    (freeRefs[read.name] ??= []).push(usageAt(read.start));
  }

  const localReferences: Usage[] = [];
  if (localBinding && !locals.has(localBinding)) {
    const ranges = declarations.get(localBinding) ?? [];
    const starts = new Set<number>();
    if (ranges.some(([from, to]) => from === 0 && to === source.length)) {
      for (const read of reads) {
        if (read.name !== localBinding || notReferences.has(read.start) || starts.has(read.start)) continue;
        if (ranges.some(([from, to]) => (from !== 0 || to !== source.length) && read.start >= from && read.start < to)) continue;
        starts.add(read.start);
        localReferences.push(usageAt(read.start));
      }
    }
  }

  const isScript = !isVueFile(fileName) && !module.hasModuleSyntax && refs.length === 0 && !commonJs;
  if (isScript) {
    for (const statement of program.body as Array<{ type: string; start: number; id?: { name: string; start: number } | null; kind?: string; declarations?: Array<{ id: unknown; init?: { type?: string } | null }> }>) {
      if (statement.type === "FunctionDeclaration" && statement.id) {
        globals.push({ name: statement.id.name, kind: "function", ...lineColumn(source, statement.id.start) });
        exportAt.push(statement.start);
      } else if (statement.type === "ClassDeclaration" && statement.id) {
        globals.push({ name: statement.id.name, kind: "class", ...lineColumn(source, statement.id.start) });
        exportAt.push(statement.start);
      } else if (statement.type === "VariableDeclaration") {
        let named = false;
        for (const declarator of statement.declarations ?? []) {
          const id = asNode(declarator.id);
          if (id?.type !== "Identifier") continue;
          named = true;
          const init = declarator.init?.type;
          globals.push({ name: id.name as string, kind: init === "FunctionExpression" || init === "ArrowFunctionExpression" ? "function" : "variable", ...lineColumn(source, id.start as number) });
        }
        if (named) exportAt.push(statement.start);
      }
    }
  }

  const httpCalls: HttpCall[] = [];
  const dynamicHttpCalls: ModuleInfo["dynamicHttpCalls"] = [];
  for (const { wrapper, url, param } of wrapperUrls) {
    // The URL read with the parameter's place marked: the caller's argument fills it in.
    const marked = new Map(constants);
    marked.set(param, WRAPPED_URL);
    httpWrappers.push({ ...wrapper, urlTemplate: staticUrl(url, marked) });
  }
  for (const candidate of httpCandidates) {
    const position = lineColumn(source, candidate.start);
    const text = (lines[position.line - 1] ?? "").trim();
    const snippet = text.length > MAX_SNIPPET ? text.slice(0, MAX_SNIPPET - 1) + "…" : text;
    const url = normalizeUrl(staticUrl(candidate.url, constants));
    if (url === undefined) {
      dynamicHttpCalls.push({ ...position, snippet });
      continue;
    }
    const spelled = literalString(candidate.method) ?? (candidate.method !== undefined ? constants.get(calleeObjectName(candidate.method) ?? "") ?? undefined : undefined);
    // A verb that is there but cannot be read (`isModify ? "PUT" : "POST"`) is unknown, not the default.
    const method = candidate.method !== undefined ? spelled?.toUpperCase() : candidate.defaultMethod;
    const prefix = url.startsWith(DYNAMIC) ? leadingName(candidate.url) : undefined;
    httpCalls.push({ url, ...(method ? { method } : {}), ...position, snippet, ...(prefix && typeof constants.get(prefix) !== "string" ? { prefixName: prefix } : {}) });
  }

  const namedCalls: ModuleInfo["namedCalls"] = [];
  for (const candidate of namedCallCandidates) {
    const args = candidate.args.map((arg) => {
      const n = asNode(arg);
      if (!n || (n.type !== "Literal" && n.type !== "TemplateLiteral" && n.type !== "BinaryExpression")) return null;
      const value = staticUrl(arg, constants);
      return value === DYNAMIC ? null : value;
    });
    // Only arguments that look like a path ("orders/5", "/api/x", "/orders"): most calls with a string are not HTTP.
    if (!args.some((value) => value !== null && (/^[^\s<>()]*[A-Za-z][^\s<>()]*\/[^\s<>()]*$/.test(value) || /^\/[A-Za-z][\w.-]*$/.test(value)))) continue;
    const position = lineColumn(source, candidate.start);
    const text = (lines[position.line - 1] ?? "").trim();
    const methods = candidate.args.map((arg) => literalString(objectProperty(arg, "method"))?.toUpperCase());
    namedCalls.push({ callee: candidate.callee, args, ...(methods.some((value) => value !== undefined) ? { methods } : {}), ...position, snippet: text.length > MAX_SNIPPET ? text.slice(0, MAX_SNIPPET - 1) + "…" : text });
  }

  const stringGlobals: Record<string, string> = Object.create(null) as Record<string, string>;
  if (isScript) {
    for (const global of globals) {
      const value = global.kind === "variable" ? constants.get(global.name) : undefined;
      if (typeof value === "string" && value) stringGlobals[global.name] = value;
    }
  }
  return { refs, usages, httpCalls, dynamicHttpCalls, ...(isScript ? { script: { exportAt } } : {}), globals, stringGlobals, freeRefs, ...(localBinding ? { localReferences } : {}), components, templates, httpWrappers, forwards, namedCalls };
}

/** Import references only. */
export function collectImports(fileName: string, source: string, report?: Report): ImportRef[] {
  return analyzeModule(fileName, source, report).refs;
}

/**
 * A classic script as the module it acts as: every top-level declaration exported, so declarations,
 * the API catalog and contracts can treat its globals like exports. Line numbers are unchanged.
 */
export function scriptAsModule(source: string, exportAt: number[]): string {
  let result = source;
  for (const start of [...exportAt].sort((a, b) => b - a)) result = result.slice(0, start) + "export " + result.slice(start);
  return result;
}

/** The source to read exports from: the file itself, or for a classic script its globals as exports. */
export function exportableSource(fileName: string, source: string): string {
  if (isVueFile(fileName)) return sfcParts(source).script;
  try {
    const info = analyzeModule(fileName, source);
    return info.script ? scriptAsModule(source, info.script.exportAt) : source;
  } catch {
    return source;
  }
}
