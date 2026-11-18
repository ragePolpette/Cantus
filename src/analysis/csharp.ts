import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileStamp } from "./file-stamp.js";
import { ensureCantusIgnore } from "../model/ignore.js";
import { type Report, errorMessage } from "./diagnostics.js";
import { DYNAMIC } from "./imports.js";

/** Structure of a C# file, as the tree-sitter worker reads it. */
export interface CSharpAttribute {
  name: string;
  args: Array<{ name?: string; value?: string; text: string }>;
}

export interface CSharpType {
  name: string;
  namespace?: string;
  kind: "class" | "interface";
  line: number;
  bases: string[];
  modifiers: string[];
  attributes: CSharpAttribute[];
  methods: Array<{ name: string; line: number; modifiers: string[]; attributes: CSharpAttribute[]; parameters: string[]; /** Return type as written. */ returns?: string; /** The parameter list as written, without the parentheses. */ parameterText?: string }>;
}

export interface CSharpFile {
  types: CSharpType[];
}

/** An HTTP endpoint the backend serves, and the C# method that handles it. */
export interface BackendEndpoint {
  /** Uppercase verb; undefined when the endpoint answers any verb (ASMX, page methods). */
  method?: string;
  /** Path from the site root, with route parameters as `{…}`, e.g. `/api/orders/{…}`. */
  route: string;
  file: string;
  line: number;
  /** `Class.Method`. */
  handler: string;
  kind: "asmx" | "page-method" | "wcf" | "controller" | "handler" | "minimal" | "route";
  /** The handler's signature as written (`bool SetState(int taskId, string state)`). */
  signature?: string;
  /** WCF: the `UriTemplate` as written, with its parameter names (`Board/{studio}?sort={sort}`). */
  template?: string;
  /** WCF: `BodyStyle` (`Bare`, `Wrapped`, `WrappedRequest`, `WrappedResponse`); absent means the default, `Bare`. */
  bodyStyle?: string;
  /** WCF: the parameters that travel in the body (those the `UriTemplate` does not name). */
  bodyMembers?: string[];
  /** Where the operation is declared when that is not the handler's file: `api/ITasks.cs:12`. */
  declared?: string;
}

type Method = CSharpType["methods"][number];

/** `bool SetState(int taskId, string state)`: the method as it is written, without modifiers. */
function methodSignature(method: Method): string | undefined {
  if (method.parameterText === undefined) return undefined;
  return `${method.returns ? `${method.returns} ` : ""}${method.name}(${method.parameterText})`;
}

/** What a WCF operation says about its request: signature, `UriTemplate`, `BodyStyle`, and the body members that follow. */
function wcfDetails(operation: Method, handler: Method | undefined, web: CSharpAttribute | undefined): Pick<BackendEndpoint, "signature" | "template" | "bodyStyle" | "bodyMembers"> {
  const style = argumentText(web, "BodyStyle")?.replace(/^.*\./, "");
  const template = named(web, "UriTemplate");
  const signature = methodSignature(operation) ?? (handler ? methodSignature(handler) : undefined);
  const fromUri = new Set([...(template ?? "").matchAll(/\{(\w+)\}/g)].map((match) => match[1].toLowerCase()));
  const bodyMembers = style && /^(Wrapped|WrappedRequest)$/.test(style) ? operation.parameters.filter((name) => name && !fromUri.has(name.toLowerCase())) : undefined;
  return {
    ...(signature ? { signature } : {}),
    ...(template ? { template } : {}),
    ...(style ? { bodyStyle: style } : {}),
    ...(bodyMembers && bodyMembers.length > 0 ? { bodyMembers } : {}),
  };
}

/**
 * What to tell about an endpoint besides its route: the signature and, for WCF, the `UriTemplate` and the
 * `BodyStyle` (with `Wrapped` the body is an object with one member per parameter the template does not
 * name, and anything else sent is not read).
 */
export function endpointDetail(endpoint: BackendEndpoint): string {
  const parts: string[] = [];
  if (endpoint.signature) parts.push(`\`${endpoint.signature}\``);
  if (endpoint.template) parts.push(`UriTemplate \`${endpoint.template}\``);
  if (endpoint.bodyStyle) {
    const members = endpoint.bodyMembers?.length ? ` (body: an object with ${endpoint.bodyMembers.map((name) => `\`${name}\``).join(", ")}; other members are not read)` : "";
    parts.push(`BodyStyle ${endpoint.bodyStyle}${members}`);
  }
  if (endpoint.declared) parts.push(`declared at ${endpoint.declared}`);
  return parts.join("; ");
}

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "csharp-worker.js");
const CACHE_FILE = path.join(".cantus", "cache", "csharp.json");
const CACHE_VERSION = 5;

/**
 * C# structure of the given files. Files unchanged since the last run come from a cache
 * (`.cantus/cache/csharp.json`); the others are parsed by the tree-sitter worker.
 */
export function readCSharp(root: string, files: string[], report: Report = () => {}, useCache = true): Map<string, CSharpFile> {
  const result = new Map<string, CSharpFile>();
  if (files.length === 0) return result;
  let cache: { version: number; files: Record<string, { stamp: string; data: CSharpFile }> } = { version: CACHE_VERSION, files: {} };
  if (useCache) {
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(root, CACHE_FILE), "utf8"));
      if (stored.version === CACHE_VERSION) cache = stored;
    } catch {
      // no cache yet
    }
  }
  const stale: string[] = [];
  const stats = new Map<string, fs.Stats>();
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(root, file));
      stats.set(file, stat);
      const cached = cache.files[file];
      if (cached?.stamp === fileStamp(stat)) result.set(file, cached.data);
      else stale.push(file);
    } catch (error) {
      report({ level: "warning", stage: "csharp", file, message: `cannot read file: ${errorMessage(error)}` });
    }
  }
  if (stale.length > 0) {
    let parsed: Record<string, CSharpFile | { error: string }> = {};
    try {
      const output = execFileSync(process.execPath, [WORKER], { windowsHide: true, input: JSON.stringify({ root, files: stale }), encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
      parsed = JSON.parse(output);
    } catch (error) {
      report({ level: "error", stage: "csharp", message: `the C# reader failed: ${errorMessage(error)}`, detail: (error as { stderr?: string }).stderr || undefined });
    }
    for (const [file, data] of Object.entries(parsed)) {
      if ("error" in data) {
        report({ level: "warning", stage: "csharp", file, message: `cannot parse C#: ${data.error}` });
        continue;
      }
      result.set(file, data);
      const stat = stats.get(file);
      if (stat) cache.files[file] = { stamp: fileStamp(stat), data };
    }
  }
  if (!useCache) return result;
  try {
    for (const file of Object.keys(cache.files)) if (!stats.has(file)) delete cache.files[file];
    ensureCantusIgnore(root);
    fs.mkdirSync(path.dirname(path.join(root, CACHE_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, CACHE_FILE), JSON.stringify(cache));
  } catch {
    // a read-only checkout works without the cache
  }
  return result;
}

const VERB_ATTRIBUTES: Record<string, string> = { HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE", HttpPatch: "PATCH", HttpHead: "HEAD", HttpOptions: "OPTIONS" };
const CONTROLLER_BASES = new Set(["Controller", "ControllerBase", "ApiController", "ODataController"]);

/** `{id}`, `{id:int}`, `{*rest}`, `{id?}` → `{…}`; slashes trimmed and collapsed. */
export function normalizeRoute(route: string): string {
  return "/" + route.replace(/[?#].*$/s, "").replace(/\{[^}]*\}/g, DYNAMIC).replace(/^~?\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}

const signatureOf = (method: Method) => {
  const signature = methodSignature(method);
  return signature ? { signature } : {};
};
const attribute = (attributes: CSharpAttribute[], ...names: string[]) => attributes.find((candidate) => names.includes(candidate.name));
const positional = (attr: CSharpAttribute | undefined) => attr?.args.find((arg) => !arg.name && arg.value !== undefined)?.value;
const named = (attr: CSharpAttribute | undefined, name: string) => attr?.args.find((arg) => arg.name === name)?.value;
/** An argument's value as written: the string, or the expression (`WebMessageBodyStyle.Wrapped`). */
const argumentText = (attr: CSharpAttribute | undefined, name: string) => {
  const arg = attr?.args.find((candidate) => candidate.name === name);
  return arg ? arg.value ?? arg.text : undefined;
};

/**
 * The endpoints a C# backend serves:
 * - ASMX web services: `[WebMethod]` methods, at `<file>.asmx/<Method>`;
 * - page methods: `[WebMethod]` static methods of a page's code-behind, at `<page>.aspx/<Method>`;
 * - WCF: `[OperationContract]` methods with `[WebInvoke]`/`[WebGet]` `UriTemplate`, under the `.svc`;
 *   contracts declared on interfaces no served class is seen to implement go under the only `.svc`
 *   in their folder (or a parent), else under any path (matched by the end of the URL);
 * - generic handlers: each `.ashx` with a `WebHandler` directive, at its own path;
 * - controllers: attribute routes (`[Route]`, `[RoutePrefix]`, `[HttpGet("…")]`, `[controller]`/`[action]`
 *   tokens), else the conventional `api/<controller>` (Web API) or `<controller>/<action>` (MVC).
 * `directives` maps `.asmx`/`.svc`/`.ashx` files to their content, to find the class they serve;
 * `routes` maps WCF service classes to the prefixes a `ServiceRoute` registers them under (see serviceRoutes).
 */
export function backendEndpoints(structures: Map<string, CSharpFile>, directives: Map<string, string>, routes: Map<string, string[]> = new Map()): BackendEndpoint[] {
  const endpoints: BackendEndpoint[] = [];
  const all = [...structures.entries()].flatMap(([file, data]) => data.types.map((type) => ({ file, type })));
  const servedBy = new Map<string, string>(); // class name or full name → .asmx/.svc path
  for (const [file, text] of directives) {
    const handlerDirective = /<%@\s*WebHandler\b([^%]*)%>/i.exec(text)?.[1];
    if (handlerDirective !== undefined) {
      // Generic handler: one endpoint at the .ashx path, any verb; the class says where the code is.
      const className = /\bClass\s*=\s*"([^"]+)"/i.exec(handlerDirective)?.[1];
      const owner = className ? all.find(({ type }) => [type.namespace, type.name].filter(Boolean).join(".") === className || type.name === className) : undefined;
      const process = owner?.type.methods.find((method) => method.name === "ProcessRequest");
      endpoints.push({ route: normalizeRoute(file), file: owner?.file ?? file, line: process?.line ?? owner?.type.line ?? 1, handler: `${owner?.type.name ?? className?.split(".").pop() ?? path.posix.basename(file, ".ashx")}.ProcessRequest`, kind: "handler" });
      continue;
    }
    const directive = /<%@\s*(?:WebService|ServiceHost)\b([^%]*)%>/i.exec(text)?.[1] ?? "";
    const target = /\b(?:Class|Service)\s*=\s*"([^"]+)"/i.exec(directive)?.[1];
    const codeBehind = /\bCodeBehind\s*=\s*"([^"]+)"/i.exec(directive)?.[1];
    if (target) {
      servedBy.set(target, file);
      servedBy.set(target.split(".").pop()!, file);
    }
    if (codeBehind) servedBy.set(path.posix.join(path.posix.dirname(file), codeBehind), file);
  }

  const servedContracts = new Set<CSharpType>();
  const contractFiles = new Map<CSharpType, string>(all.map(({ file, type }) => [type, file]));
  for (const { file, type } of all) {
    if (type.kind !== "class") continue;
    const fullName = [type.namespace, type.name].filter(Boolean).join(".");
    const handler = (method: string) => `${type.name}.${method}`;

    // ASMX services and page methods: [WebMethod].
    const webMethods = type.methods.filter((method) => attribute(method.attributes, "WebMethod"));
    if (webMethods.length > 0) {
      const page = /\.(aspx|ascx|master)\.cs$/i.test(file) ? file.replace(/\.cs$/i, "") : undefined;
      const service = servedBy.get(fullName) ?? servedBy.get(file) ?? servedBy.get(type.name) ?? (/\.asmx\.cs$/i.test(file) ? file.replace(/\.cs$/i, "") : undefined);
      const base = page ?? service ?? `${DYNAMIC}/${type.name}.asmx`;
      for (const method of webMethods) {
        const scriptMethod = attribute(method.attributes, "ScriptMethod");
        const get = /UseHttpGet\s*=\s*true/i.test(scriptMethod?.args.map((arg) => `${arg.name ?? ""}=${arg.text}`).join(",") ?? "");
        // Page methods answer POST only, unless UseHttpGet; ASMX services may also allow GET.
        const verb = get ? "GET" : page ? "POST" : undefined;
        endpoints.push({ ...(verb ? { method: verb } : {}), route: normalizeRoute(`${base}/${method.name}`), file, line: method.line, handler: handler(method.name), kind: page ? "page-method" : "asmx", ...signatureOf(method) });
      }
    }

    // WCF: operations declared on a [ServiceContract] interface the class implements, or on the class itself.
    const contracts = [type, ...all.filter((candidate) => candidate.type.kind === "interface" && type.bases.includes(candidate.type.name)).map((candidate) => candidate.type)];
    const svc = servedBy.get(fullName) ?? servedBy.get(type.name);
    const routePrefixes = routes.get(fullName) ?? routes.get(type.name);
    if (svc?.toLowerCase().endsWith(".svc") || routePrefixes !== undefined || attribute(type.attributes, "ServiceContract")) {
      // A ServiceRoute is the address the site really uses; a .svc file is the other way in.
      const bases = [...(routePrefixes ?? []), ...(svc?.toLowerCase().endsWith(".svc") ? [svc] : [])];
      if (bases.length === 0) bases.push(`${DYNAMIC}/${type.name}.svc`);
      for (const contract of contracts) {
        if (contract !== type) servedContracts.add(contract);
        for (const operation of contract.methods.filter((method) => attribute(method.attributes, "OperationContract"))) {
          const invoke = attribute(operation.attributes, "WebInvoke");
          const get = attribute(operation.attributes, "WebGet");
          const template = named(invoke ?? get, "UriTemplate") ?? operation.name;
          const verb = get ? "GET" : (named(invoke, "Method") ?? "POST").toUpperCase();
          const implementation = type.methods.find((method) => method.name === operation.name);
          const declared = implementation && contract !== type ? { declared: `${contractFiles.get(contract) ?? file}:${operation.line}` } : {};
          for (const base of bases) endpoints.push({ method: verb, route: normalizeRoute(`${base}/${template}`), file, line: implementation?.line ?? operation.line, handler: handler(operation.name), kind: "wcf", ...wcfDetails(operation, implementation, invoke ?? get), ...declared });
        }
      }
    }

    // Controllers.
    const isController = type.name.endsWith("Controller") && (type.bases.some((base) => CONTROLLER_BASES.has(base)) || attribute(type.attributes, "ApiController", "Route", "RoutePrefix"));
    if (!isController || type.modifiers.includes("abstract")) continue;
    const controller = type.name.replace(/Controller$/, "");
    const webApi = type.bases.includes("ApiController") || !!attribute(type.attributes, "ApiController");
    const classRoute = positional(attribute(type.attributes, "Route")) ?? positional(attribute(type.attributes, "RoutePrefix"));
    for (const method of type.methods) {
      if (!method.modifiers.includes("public") || method.modifiers.includes("static") || attribute(method.attributes, "NonAction")) continue;
      const verbs = new Set<string>();
      let methodRoute = positional(attribute(method.attributes, "Route"));
      for (const attr of method.attributes) {
        if (VERB_ATTRIBUTES[attr.name]) {
          verbs.add(VERB_ATTRIBUTES[attr.name]);
          methodRoute ??= positional(attr);
        }
        if (attr.name === "AcceptVerbs") for (const arg of attr.args) for (const verb of (arg.value ?? arg.text).match(/GET|POST|PUT|DELETE|PATCH/gi) ?? []) verbs.add(verb.toUpperCase());
      }
      if (verbs.size === 0 && webApi) {
        const conventional = /^(Get|Post|Put|Delete|Patch)/.exec(method.name)?.[1];
        if (conventional) verbs.add(conventional.toUpperCase());
      }
      let route: string;
      if (methodRoute?.startsWith("~/") || methodRoute?.startsWith("/")) route = methodRoute;
      else if (classRoute !== undefined || methodRoute !== undefined) route = [classRoute, methodRoute].filter((part) => part !== undefined && part !== "").join("/");
      else if (webApi) route = `api/${controller}${method.parameters.includes("id") ? "/{id}" : ""}`;
      else route = `${controller}/${method.name}`;
      route = route.replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, method.name);
      for (const verb of verbs.size ? [...verbs] : [undefined]) {
        endpoints.push({ ...(verb ? { method: verb } : {}), route: normalizeRoute(route), file, line: method.line, handler: handler(method.name), kind: "controller", ...signatureOf(method) });
      }
    }
  }
  // WCF contracts on interfaces no served class was seen implementing (the service class may sit in
  // another assembly, or aggregate them through an interface the project does not contain).
  const svcFiles = [...directives.keys()].filter((file) => file.toLowerCase().endsWith(".svc"));
  for (const { file, type } of all) {
    if (type.kind !== "interface" || servedContracts.has(type)) continue;
    const operations = type.methods.filter((method) => attribute(method.attributes, "OperationContract") && attribute(method.attributes, "WebInvoke", "WebGet"));
    if (operations.length === 0) continue;
    const svc = nearestSole(file, svcFiles);
    for (const operation of operations) {
      const invoke = attribute(operation.attributes, "WebInvoke");
      const get = attribute(operation.attributes, "WebGet");
      const template = named(invoke ?? get, "UriTemplate") ?? operation.name;
      const verb = get ? "GET" : (named(invoke, "Method") ?? "POST").toUpperCase();
      endpoints.push({ method: verb, route: normalizeRoute(`${svc ?? DYNAMIC}/${template}`), file, line: operation.line, handler: `${type.name}.${operation.name}`, kind: "wcf", ...wcfDetails(operation, undefined, invoke ?? get) });
    }
  }
  return endpoints.sort((a, b) => a.route.localeCompare(b.route) || (a.method ?? "").localeCompare(b.method ?? ""));
}

const MAP_GROUP = /\b(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(\s*@?"([^"]*)"/g;
const MAP_VERB = /\b(\w+)\s*\.\s*Map(Get|Post|Put|Delete|Patch)\s*\(\s*@?"([^"]*)"\s*(?:,\s*([A-Za-z_][\w.]*)\s*[,)])?/g;

const MAP_VERB_HANDLER_FIRST = /\b(\w+)\s*\.\s*Map(Get|Post|Put|Delete|Patch)\s*\(\s*([A-Za-z_]\w*)\s*(?:,\s*@?"([^"]*)"\s*)?\)/g;

/**
 * Minimal API endpoints: `app.MapGet("/orders/{id}", Handler)`, and the same on a group
 * (`var orders = app.MapGroup("/api/orders"); orders.MapPost("/", Create)`; groups nest). The
 * handler is the method group named, or the lambda written there. Also the handler-first form of
 * the Clean Architecture template (`groupBuilder.MapGet(Handler, "{id}")` in a class that
 * implements `IEndpointGroup`, whose group is `/api/<ClassName>`, or its `RoutePrefix`).
 * Read from the source text.
 */
export function minimalEndpoints(sources: Iterable<[string, string]>, structures: Map<string, CSharpFile>): BackendEndpoint[] {
  const endpoints: BackendEndpoint[] = [];
  for (const [file, text] of sources) {
    if (!text.includes(".Map")) continue;
    const prefixes = new Map<string, string>();
    for (const match of text.matchAll(MAP_GROUP)) prefixes.set(match[1], joinRoute(prefixes.get(match[2]) ?? "", match[3]));
    const owner = structures.get(file)?.types.find((type) => type.kind === "class");
    const grouped = owner?.bases.includes("IEndpointGroup");
    if (grouped) {
      const custom = /\bRoutePrefix\s*=>\s*@?"([^"]*)"/.exec(text)?.[1];
      for (const match of text.matchAll(MAP_VERB_HANDLER_FIRST)) {
        const [, , verb, handlerName, pattern = ""] = match;
        const method = owner!.methods.find((candidate) => candidate.name === handlerName);
        if (!method) continue;
        const line = text.slice(0, match.index).split("\n").length;
        endpoints.push({ method: verb.toUpperCase(), route: normalizeRoute(joinRoute(custom ?? `api/${owner!.name}`, pattern)), file, line: method.line ?? line, handler: handlerName, kind: "minimal" });
      }
    }
    for (const match of text.matchAll(MAP_VERB)) {
      const [, receiver, verb, pattern, handlerName] = match;
      const line = text.slice(0, match.index).split("\n").length;
      const method = handlerName ? owner?.methods.find((candidate) => candidate.name === handlerName.split(".").pop()) : undefined;
      endpoints.push({
        method: verb.toUpperCase(),
        route: normalizeRoute(joinRoute(prefixes.get(receiver) ?? "", pattern)),
        file,
        line: method?.line ?? line,
        handler: handlerName ? handlerName.split(".").pop()! : `${path.posix.basename(file, ".cs")}.<lambda>`,
        kind: "minimal",
      });
    }
  }
  return endpoints;
}

function joinRoute(prefix: string, route: string): string {
  return [prefix, route].map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

const SERVICE_ROUTE = /new\s+ServiceRoute\s*\(\s*([^,]+?)\s*,[\s\S]*?typeof\s*\(\s*([\w.]+)\s*\)\s*\)/g;
const STRING_CONSTANT = /\b(?:const|readonly)\s+(?:string\s+)?(\w+)\s*=\s*@?"([^"]*)"\s*;|\bstring\s+(\w+)\s*=\s*@?"([^"]*)"\s*;/g;

/** `"a" + Prefix + "/b"` with the constants resolved; undefined when a part is neither a literal nor a known constant. */
function routeExpression(expression: string, constants: Map<string, string | null>): string | undefined {
  let result = "";
  for (const part of expression.split("+")) {
    const text = part.trim();
    const literal = /^@?"([^"]*)"$/.exec(text);
    if (literal) {
      result += literal[1];
      continue;
    }
    const value = /^[\w.]+$/.test(text) ? constants.get(text.split(".").pop()!) : undefined;
    if (value === undefined || value === null) return undefined;
    result += value;
  }
  return result;
}

/**
 * WCF services registered in code (`RouteTable.Routes.Add(new ServiceRoute("orders", new
 * WebServiceHostFactory(), typeof(Orders)))`, in Global.asax.cs or inline in Global.asax): class name → URL prefixes.
 * The prefix may be a literal, a string constant (`Routes.Orders`) or a concatenation of them; a service
 * registered under several prefixes keeps all of them.
 * Read from the source text, since the parsed structure keeps declarations, not calls.
 */
export function serviceRoutes(sources: Iterable<[string, string]>): Map<string, string[]> {
  const registrations: string[] = [];
  const constants = new Map<string, string | null>(); // null: the same name holds different values
  for (const [, text] of sources) {
    if (text.includes("ServiceRoute")) registrations.push(text);
    for (const match of text.matchAll(STRING_CONSTANT)) {
      const name = match[1] ?? match[3];
      const value = match[2] ?? match[4];
      constants.set(name, constants.has(name) && constants.get(name) !== value ? null : value);
    }
  }
  const routes = new Map<string, string[]>();
  const add = (type: string, prefix: string) => {
    const prefixes = routes.get(type) ?? [];
    if (!prefixes.includes(prefix)) routes.set(type, [...prefixes, prefix]);
  };
  for (const text of registrations) {
    for (const match of text.matchAll(SERVICE_ROUTE)) {
      const [, expression, type] = match;
      const prefix = routeExpression(expression, constants);
      if (prefix === undefined) continue;
      add(type, prefix);
      add(type.split(".").pop()!, prefix);
    }
  }
  return routes;
}

/** The only candidate in the file's folder, else in the nearest parent folder that has exactly one. */
function nearestSole(file: string, candidates: string[]): string | undefined {
  let dir = path.posix.dirname(file);
  for (;;) {
    const inside = candidates.filter((candidate) => dir === "." || candidate.startsWith(dir + "/"));
    if (inside.length === 1) return inside[0];
    if (inside.length > 1 || dir === ".") return undefined;
    dir = path.posix.dirname(dir);
  }
}

function segments(url: string): string[] {
  return url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^~/, "").split("/").filter((segment) => segment && segment !== "." && segment !== "..");
}

function segmentMatches(call: string, endpoint: string): boolean {
  if (call === DYNAMIC || endpoint === DYNAMIC) return true;
  const lower = (text: string) => text.toLowerCase();
  if (!call.includes(DYNAMIC) && !endpoint.includes(DYNAMIC)) return lower(call) === lower(endpoint);
  const pattern = (text: string) => new RegExp(`^${text.split(DYNAMIC).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return call.includes(DYNAMIC) ? pattern(call).test(endpoint) : pattern(endpoint).test(call);
}

/**
 * The endpoints an HTTP call reaches: the endpoint's path must match the end of the call's URL
 * (the site may live under a virtual directory), segment by segment, with `{…}` matching any
 * segment; the verbs must agree when both are known. The most specific matches win.
 */
export function matchEndpoints(call: { url: string; method?: string }, endpoints: BackendEndpoint[]): BackendEndpoint[] {
  const callSegments = segments(call.url);
  let best: BackendEndpoint[] = [];
  let bestScore = 0;
  for (const endpoint of endpoints) {
    if (endpoint.method && call.method && endpoint.method !== call.method) continue;
    const endpointSegments = segments(endpoint.route);
    // A leading {…} in the endpoint (an ASMX/SVC whose folder is unknown) matches any prefix.
    const anchored = endpointSegments[0] === DYNAMIC ? endpointSegments.slice(1) : endpointSegments;
    if (anchored.length === 0 || anchored.length > callSegments.length) continue;
    const tail = callSegments.slice(callSegments.length - anchored.length);
    if (!anchored.every((segment, index) => segmentMatches(tail[index], segment))) continue;
    // Only segments written out on both sides count: a run-time part of the URL matches anything,
    // so on its own it says nothing about which endpoint is called.
    const literal = anchored.filter((segment, index) => !segment.includes(DYNAMIC) && !tail[index].includes(DYNAMIC)).length;
    if (literal === 0) continue;
    const score = literal * 10 + (anchored.length === callSegments.length ? 5 : 0) + (endpoint.method && call.method ? 1 : 0);
    if (score > bestScore) {
      best = [endpoint];
      bestScore = score;
    } else if (score === bestScore) best.push(endpoint);
  }
  // Many endpoints equally likely: the URL does not say which one, and linking them all is noise.
  return best.length > MAX_TIED_ENDPOINTS ? [] : best;
}

const MAX_TIED_ENDPOINTS = 3;
