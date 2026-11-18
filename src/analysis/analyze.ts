import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { type ArchModel, type Block, type Layer, blockForFile, blockResolver, toBlockId } from "../model/index.js";
import { readSourceText } from "./text-cache.js";
import { AnalysisCache, fingerprint } from "./cache.js";
import { type ApiEntry, buildCatalog } from "./catalog.js";
import { type CompilerFallback, type ContractIssue, generateContracts } from "./contracts.js";
import { type Diagnostic, type Report, createCollector, errorMessage, sortDiagnostics } from "./diagnostics.js";
import { DYNAMIC, isStaticAssetUrl, type GlobalDefinition, type HttpWrapper, type ModuleInfo, type Usage, WRAPPED_URL, analyzeModule, normalizeUrl, scriptAsModule, type HttpCall as SourceHttpCall } from "./imports.js";
import { PAGE_EXTENSIONS, dynamicLoads, readPage, resolveScriptSrc } from "./pages.js";
import { findPageLinks } from "./links.js";
import { componentTags, isVueFile, kebabCase, sfcComponentName, sfcParts } from "./vue.js";
import { pythonEndpoints } from "./python-endpoints.js";
import { type BackendEndpoint, backendEndpoints, endpointDetail, minimalEndpoints, serviceRoutes, matchEndpoints, readCSharp } from "./csharp.js";
import { lineColumn } from "./diagnostics.js";
import { SOURCE_EXTENSIONS, type WorkspacePackage, createResolver, toPosix } from "./resolve.js";
import type { LanguageFile, LanguageImport } from "./languages.js";
import { COUNTED_EXTENSIONS, LANGUAGES, LANGUAGE_EXTENSIONS, type LanguageResolver, type ResolvedImport, languageContract, languageOf, readLanguageFiles } from "./languages.js";
import { normalizeShape } from "./catalog.js";
import { gitIgnored } from "./gitignore.js";
import { type StoredSuggestion, readSuggestions } from "./suggestions.js";
import { isRebuiltCantusFile } from "../model/ignore.js";
import { type Uncovered, trackedFiles, uncoveredFiles, untrackedBlocks } from "./coverage.js";
import { EXTERNAL_CATALOG_LIMIT, type ExternalAnalysis, type ExternalRef, type ExternalVia, externalUses, groupExternal, outsideRoot } from "./external.js";
import { EXCLUDED_FILE, TEST_DIRS } from "./support.js";

export type { CompilerFallback, ContractIssue } from "./contracts.js";
export type { Diagnostic } from "./diagnostics.js";
export type { ApiEntry } from "./catalog.js";
export type { Usage } from "./imports.js";
const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".git", ".next", ".turbo", ".cantus",
  "vendor", ...TEST_DIRS,
  "__pycache__", "venv", "site-packages", "target",
]);
const DEFAULT_EXCLUDED_FILE = EXCLUDED_FILE;
const SPLIT_THRESHOLD = 25;
/** A block owning more files than this is one agent's scope too many: it is split along its subdirectories. */
const BIG_BLOCK = 40;
/** A block this small is not worth an agent of its own when it has small siblings. */
const SMALL_BLOCK = 4;
const MIN_SMALL_SIBLINGS = 8;
/** The most files a group of merged small blocks may hold. */
const MERGE_MAX = 12;

/** Folder names that mark tests or the composition root; a test folder anywhere in a path decides it. */
const TEST_HINTS = ["test", "tests", "__tests__", "spec", "specs", "e2e", "testing"];
const HOST_HINTS = ["host", "bootstrap", "startup", "composition"];

const LAYER_HINTS: Array<[Layer, string[]]> = [
  ["host", HOST_HINTS],
  ["interface", ["api", "app", "apps", "cli", "components", "controllers", "handlers", "pages", "routes", "ui", "views", "web", "http"]],
  ["application", ["application", "features", "service", "services", "use-cases", "usecases", "workflows", "commands"]],
  ["domain", ["core", "domain", "entities", "model", "models"]],
  ["infrastructure", ["adapters", "clients", "data", "db", "database", "infra", "infrastructure", "persistence", "repositories", "repository", "storage", "integrations"]],
];

export interface CodeDependency {
  from: string;
  to: string;
  /** Imported names; `*` for namespace or re-export-all, `default` for default imports. */
  symbols: string[];
  /** Files of the target block that `from` imports, plus the sibling files they reference. Their declarations are the contract `from` relies on. */
  files: string[];
  imports: Array<{ file: string; target: string; specifier: string }>;
}

/** A literal-URL HTTP call in a file, with the block that makes it. */
export interface HttpCall extends SourceHttpCall {
  file: string;
  block?: string;
  /** The backend methods that serve this call, when the C# code shows them. */
  handlers?: Array<{ file: string; line: number; handler: string }>;
  /** Set when the request goes through one of the project's wrapper functions: its name. */
  via?: string;
}

export type { BackendEndpoint } from "./csharp.js";

/** A use of another file's export: who calls what, where. */
export interface CallSite {
  /** Exported name used (for namespace imports, the accessed member, or `*`). */
  symbol: string;
  targetFile: string;
  targetBlock?: string;
  file: string;
  block?: string;
  line: number;
  column: number;
  snippet: string;
  /** How the call was found: an import, a global read, a component tag, an HTTP call to an endpoint. */
  via: "import" | "global" | "component" | "http" | "type" | "link" | "external";
  /**
   * `link`: a string in the code that names a page file ("pagina.aspx?c=…"), the link built to reach it.
   * `type`: a type name a C# file uses, linked to the type of that name in a namespace the file sees.
   * How sure the link is: `certain` (a resolved import), `likely` (one candidate, or the one loaded
   * by the same page, or a route matched in full), `by-name` (only the name, or a wildcard, matched).
   */
  match: "certain" | "likely" | "by-name";
}

const MATCH_ORDER = { certain: 0, likely: 1, "by-name": 2 } as const;

/** What to say next to a call site that is not a resolved import, so readers weigh it. */
export function matchNote(site: { match?: CallSite["match"] }): string {
  return site.match === "by-name" ? " (by name only)" : site.match === "likely" ? " (likely)" : "";
}

/** Call sites with the surest first. Sites from an older index (no `match`) count as certain. */
export function bySureness<T extends { match?: CallSite["match"] }>(sites: T[]): T[] {
  return [...sites].sort((a, b) => MATCH_ORDER[a.match ?? "certain"] - MATCH_ORDER[b.match ?? "certain"]);
}

export interface BlockInfo {
  block: Block;
  files: string[];
  tokens: number;
  /** Commits touching the block in the last 90 days, when git is available. */
  churn: number;
  /** Files other blocks import, plus the block's index file. */
  publicFiles: string[];
  externalPackages: string[];
  /** HTTP calls the block makes (`GET /api/orders/{…}`), so the backend boundary is visible. */
  httpEndpoints: string[];
  /** HTTP calls whose URL is built entirely at run time: not in httpEndpoints. */
  dynamicHttpCalls: number;
  /** Pages that load the block's files with `<script src>`. */
  loadedBy: string[];
  /** The block's classic scripts: files whose top-level declarations are globals. */
  scriptFiles: string[];
  /** Endpoints the block's C# code serves: `POST /api/orders → OrdersController.Create`. */
  endpoints: string[];
}

export interface Analysis {
  root: string;
  name: string;
  blocksInferred: boolean;
  blocks: BlockInfo[];
  unassignedFiles: string[];
  dependencies: CodeDependency[];
  /** Declaration (.d.ts) text of every public file, keyed by repo-relative source path. */
  contracts: Record<string, string>;
  /** Public files whose declarations needed a compiler fallback, or could not be completed. */
  contractIssues: ContractIssue[];
  /** Every exported symbol of every block: what an agent could reuse instead of rewriting. */
  catalog: ApiEntry[];
  /** File-level imports between analyzed files (within and across blocks), with the names imported. */
  fileImports: Array<{ from: string; to: string; symbols: string[] }>;
  /** Every use of an internal import across files, so owners know who calls their code. */
  callSites: CallSite[];
  unresolvedImports: Array<{ file: string; specifier: string; reason: string }>;
  /**
   * Folders outside the map's root that its files point to (a project reference, a relative import, a
   * script): the code is not analyzed, so the map only says that the blocks point to an external.
   */
  externalRefs: ExternalRef[];
  /** Tracked files in no block that Cantus does not read (git projects only); undefined when git is not used. */
  uncovered?: Uncovered;
  /** Blocks all of whose files git does not track (local scripts, or work not committed yet); said only of a repository that tracks something. */
  untrackedBlocks?: string[];
  /** Files in `.cantus/` that Cantus rebuilds (cache, logs, task records) and git tracks: they clash when branches merge. */
  trackedRebuilt?: string[];
  /** Changes to the map that `refine` suggested and nobody has applied or declined yet (kept in .cantus/cache, out of git). */
  refineSuggestions?: StoredSuggestion[];
  /** Every HTTP call with a readable URL: the backend boundary imports cannot show. */
  httpCalls: HttpCall[];
  /** Pages (.html, .aspx, .cshtml, …), the scripts they load with `<script src>` in order, and the pages they are built from (master page, user controls, includes). */
  pages: Array<{ file: string; block?: string; scripts: string[]; missing: string[]; includes?: string[] }>;
  /** Classic scripts (no import/export): their top-level declarations are globals other files call. */
  scriptFiles: string[];
  /** HTTP endpoints the C# backend serves (ASMX, page methods, WCF, controllers). */
  endpoints: BackendEndpoint[];
  /** Everything that failed or was skipped while reading the project, most severe first. */
  diagnostics: Diagnostic[];
  fileTokens: Record<string, number>;
  /** Minified or bundled files kept in their blocks but not analyzed (see AnalyzeOptions.parseMinified). */
  minifiedFiles: string[];
  /**
   * Files that usually change in the same commits (last 1000 commits): coupling imports may not
   * show, like a page, its script and its code-behind. Strongest first.
   */
  coChanges: CoChange[];
  /** Where the time went, in milliseconds: each stage, and the files that took longest to read. */
  timings: AnalysisTimings;
}

export interface CoChange {
  files: [string, string];
  /** Commits that changed both. */
  commits: number;
  /** `commits` over the commits of the less changed of the two: 1 means it never changed alone. */
  share: number;
}

export interface AnalysisTimings {
  total: number;
  stages: Record<string, number>;
  slowestFiles: Array<{ file: string; ms: number }>;
}

export interface AnalyzeOptions {
  model?: ArchModel;
  /** Skip git history lookups (used by tests and non-git directories). */
  skipGit?: boolean;
  /** Engines allowed to complete declarations oxc cannot derive alone. Default `auto`. */
  compilerFallback?: CompilerFallback;
  /** Analyze minified and bundled files too; default: the map's `analysis.parseMinified`, else false. */
  parseMinified?: boolean;
  /** Reuse what earlier analyses stored in `.cantus/cache/` for files that did not change. Default true. */
  cache?: boolean;
}

/** A module read back from the cache: maps keyed by names from the code get their null prototype back. */
function reviveModule(info: ModuleInfo): ModuleInfo {
  return {
    ...info,
    usages: Object.assign(Object.create(null) as Record<string, Usage[]>, info.usages),
    freeRefs: Object.assign(Object.create(null) as Record<string, Usage[]>, info.freeRefs),
  };
}

/**
 * Among definitions of the same name with no page to tell them apart, the one in the closest
 * folder to the caller (`Fhff/x.js` calling a name defined in `Fhff/js/main.js` and `js/main.js`),
 * when one is closer than all the others; otherwise all of them.
 */
function nearest<T extends { file: string }>(caller: string, candidates: T[]): T[] {
  if (candidates.length < 2) return candidates;
  const folders = caller.split("/").slice(0, -1);
  const shared = (file: string) => {
    const other = file.split("/").slice(0, -1);
    let count = 0;
    while (count < folders.length && count < other.length && folders[count] === other[count]) count++;
    return count;
  };
  const scored = candidates.map((candidate) => ({ candidate, score: shared(candidate.file) }));
  const best = Math.max(...scored.map((entry) => entry.score));
  let closest = scored.filter((entry) => entry.score === best);
  if (closest.length > 1) {
    // No folder in common from the root: the one that shares a folder name (`site/orders/x.js` and `assets/orders/main.js`).
    const names = new Set(folders.map((folder) => folder.toLowerCase()));
    const named = closest.map((entry) => ({ ...entry, score: new Set(entry.candidate.file.split("/").slice(0, -1).map((folder) => folder.toLowerCase()).filter((folder) => names.has(folder))).size }));
    const most = Math.max(...named.map((entry) => entry.score));
    if (most > 0) closest = named.filter((entry) => entry.score === most);
  }
  return closest.length === 1 ? [closest[0].candidate] : candidates;
}

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

const MINIFIED_NAME = /\.(min|bundle)\.[cm]?js$/i;
const LARGE_FILE = 1024 * 1024;

/**
 * Whether a file looks minified or bundled: by name (`.min.js`, `.bundle.js`), by size, or by shape
 * (few, very long lines). Such files are third-party or generated: reading them costs most of the
 * analysis and adds nothing an agent should edit.
 */
export function looksMinified(file: string, source: string): boolean {
  return looksPacked(file, source) || looksLikeLibrary(source);
}

/**
 * A third-party library kept readable: the comment at the very top carries a license marker
 * (`@license`, `@licstart`, `@preserve`), or a copyright or license line together with a version
 * (`/*! jQuery UI - v1.12.1 … Copyright`). A company header without a version does not count.
 */
export function looksLikeLibrary(source: string): boolean {
  const header = /^\s*(?:(["'])use strict\1;?\s*)?\/\*([\s\S]{0,2000}?)\*\//.exec(source)?.[2];
  if (!header) return false;
  if (/@license|@licstart|@preserve/i.test(header)) return true;
  return /copyright|\(c\)|©|licen[cs]e/i.test(header) && /\bv?\d+\.\d+(\.\d+)?\b/.test(header);
}

function looksPacked(file: string, source: string): boolean {
  if (MINIFIED_NAME.test(file) || source.length > LARGE_FILE) return true;
  if (source.length < 20_000) return false;
  let lines = 1;
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) lines++;
  return source.length / lines > 300;
}

export function analyze(rootPath: string, options: AnalyzeOptions = {}): Analysis {
  const root = path.resolve(rootPath);
  const model = options.model;
  const { diagnostics, report } = createCollector();
  const started = performance.now();
  const stages: Record<string, number> = {};
  let lastLap = started;
  const lap = (stage: string) => {
    const now = performance.now();
    stages[stage] = Math.round((stages[stage] ?? 0) + now - lastLap);
    lastLap = now;
  };
  const fileTimes: Array<{ file: string; ms: number }> = [];
  const cache = new AnalysisCache(root, options.cache ?? true);
  // A file read for the previous analysis of this process and not touched since is not read again (off with the cache: tests rewrite files in the same instant).
  const readText = (absolute: string, stat?: fs.Stats): string => ((options.cache ?? true) ? readSourceText(absolute, stat) : fs.readFileSync(absolute, "utf8"));
  // What .gitignore leaves out is left out here too (`analysis.respectGitignore: false` reads it all), unless a block names it.
  const ignored = model?.analysis?.respectGitignore === false ? { patterns: [], entries: [] } : gitIgnored(root, (model?.blocks ?? []).flatMap((block) => block.include));
  const exclude = [...(model?.analysis?.exclude ?? []), ...ignored.patterns];
  if (ignored.entries.length > 0) {
    const shown = ignored.entries.slice(0, 6).join(", ");
    report({ level: "info", stage: "scan", message: `${ignored.entries.length} path(s) ignored by git left out of the analysis: ${shown}${ignored.entries.length > 6 ? ", …" : ""}. A block that includes one reads it anyway; \`analysis.respectGitignore: false\` reads them all.` });
  }
  const include = normalizeInclude(model?.analysis?.include, report);
  // A relative path that lands in the root but outside `analysis.include` points to code the map does not hold.
  const outsideInclude = (relative: string) => leavesInclude(relative, exclude, include);
  const scan = createSourceScanner(root, exclude, report, include);
  const files = scan(SOURCE_EXTENSIONS);
  const packages = findWorkspacePackages(root, exclude, report, include);
  // The C# backend: its files belong to blocks (size, ownership, briefings) but stay out of the JavaScript pipeline.
  const csFiles = scan([".cs"], ["bin", "obj"]);
  // Python and the other languages read with tree-sitter; then the languages only counted, not read yet.
  const languageFileList = scan(LANGUAGE_EXTENSIONS, [...new Set(LANGUAGES.flatMap((language) => language.excludedDirs ?? []))]);
  const countedFiles = scan(COUNTED_EXTENSIONS, ["bin", "obj"]);
  const blockFiles = [...new Set([...files, ...csFiles, ...languageFileList, ...countedFiles])];
  const blocks = model?.blocks ?? inferBlocks(root, blockFiles, packages);
  // The blocks are final from here: one lookup per file, not a pass over every block.
  const ownerOf = blockResolver(blocks);
  const name = model?.name ?? readPackageName(root, report) ?? folderName(root);
  lap("scan");
  if (blockFiles.length === 0) report({ level: "warning", stage: "scan", message: `no source files found (${[...SOURCE_EXTENSIONS, ".cs", ...LANGUAGE_EXTENSIONS].join(", ")})` });
  if (countedFiles.length > 0) {
    const extensions = [...new Set(countedFiles.map((file) => path.extname(file).toLowerCase()))].sort();
    report({ level: "info", stage: "scan", message: `${countedFiles.length} source file(s) in languages Cantus does not read yet (${extensions.join(", ")}): they belong to their blocks, without imports or call sites` });
  }

  const fileBlock = new Map<string, string>();
  const unassignedFiles: string[] = [];
  for (const file of blockFiles) {
    const block = ownerOf(file);
    if (block) fileBlock.set(file, block.id);
    else unassignedFiles.push(file);
  }

  const fileSet = new Set(files);
  const resolver = createResolver(root, fileSet, packages, report);

  const fileTokens: Record<string, number> = {};
  const externalByBlock = new Map<string, Set<string>>();
  const unresolvedImports: Analysis["unresolvedImports"] = [];
  const resolvedImports = new Set<string>();
  // Where files of the map point outside its root: project references, relative imports, scripts.
  const outsidePointers: Array<{ file: string; target: string; via: ExternalVia; block?: string }> = [];
  const depsByKey = new Map<string, CodeDependency>();
  const sameBlockImports = new Map<string, Set<string>>();
  const sources: Array<{ file: string; block: string; source: string }> = [];
  const callSites: CallSite[] = [];
  const httpCalls: HttpCall[] = [];
  // Strings that scripts put in global variables (`var BASE_URL = "…"`): the start of URLs other files write as `BASE_URL + "api/x"`. A name given in several files has several values.
  const stringGlobals = new Map<string, Set<string>>();
  const dynamicHttpByFile = new Map<string, number>();
  const scriptViews = new Map<string, string>();
  const fileImportsByKey = new Map<string, { from: string; to: string; symbols: string[] }>();
  const vueScripts = new Map<string, string>();
  // Vue: components defined (globally registered, or one per .vue file) and the tags that use them.
  const componentDefinitions = new Map<string, Array<{ file: string; line: number; inline: boolean }>>();
  const componentUses: Array<{ file: string; raw: string; name: string; line: number; column: number; snippet: string }> = [];
  const defineComponent = (name: string, file: string, line: number, inline = true) => {
    const list = componentDefinitions.get(name) ?? [];
    const existing = list.find((entry) => entry.file === file);
    if (!existing) list.push({ file, line, inline });
    else if (inline && !existing.inline) Object.assign(existing, { line, inline });
    componentDefinitions.set(name, list);
  };
  const collectTags = (file: string, text: string, tags: Array<{ name: string; raw: string; offset: number }>) => {
    const lines = text.split("\n");
    for (const tag of tags) {
      const position = lineColumn(text, tag.offset);
      componentUses.push({ file, raw: tag.raw, name: tag.name, ...position, snippet: (lines[position.line - 1] ?? "").trim().slice(0, 160) });
    }
  };
  const globalsByFile = new Map<string, { globals: GlobalDefinition[]; freeRefs: ModuleInfo["freeRefs"] }>();
  // Scripts and page fragments a file names in a load call (`$.getScript("x.js")`, `.load("part.html")`), as written.
  const loadsByFile = new Map<string, ReturnType<typeof dynamicLoads>>();
  const addDependency = (fromBlock: string, toBlock: string, symbols: string[], target: string, entry: { file: string; target: string; specifier: string }) => {
    const key = `${fromBlock}->${toBlock}`;
    const dep = depsByKey.get(key) ?? { from: fromBlock, to: toBlock, symbols: [], files: [], imports: [] };
    addUnique(dep.symbols, ...symbols);
    addUnique(dep.files, target);
    dep.imports.push(entry);
    depsByKey.set(key, dep);
  };

  const parseMinified = options.parseMinified ?? model?.analysis?.parseMinified ?? false;
  const wrapperDefinitions: HttpWrapper[] = [];
  const wrapperForwards: ModuleInfo["forwards"] = [];
  const namedCallsByFile = new Map<string, ModuleInfo["namedCalls"]>();
  const minifiedFiles: string[] = [];
  const fileStats = new Map<string, fs.Stats>();
  // Files read again this time (changed, or new to the cache): files importing them get new contracts.
  const changedFiles = new Set<string>();
  for (const file of files) {
    let source: string;
    let moduleInfo: ReturnType<typeof analyzeModule>;
    const fileStarted = performance.now();
    try {
      const absolute = path.join(root, file);
      const stat = fs.statSync(absolute);
      fileStats.set(file, stat);
      source = readText(absolute, stat);
      const name = path.posix.basename(file);
      const forced = isExcluded(file, name, model?.analysis?.read ?? []);
      if (!forced && (isExcluded(file, name, model?.analysis?.vendor ?? []) || (!parseMinified && looksMinified(file, source)))) {
        // Still a file of its block, and still the target of imports and <script src>; its code is not read.
        fileTokens[file] = estimateTokens(source);
        minifiedFiles.push(file);
        continue;
      }
      const cached = cache.get<ModuleInfo>(`module:${file}`, stat);
      if (cached) {
        moduleInfo = reviveModule(cached.value);
        for (const diagnostic of cached.diagnostics) report(diagnostic);
      } else {
        const produced: Diagnostic[] = [];
        moduleInfo = analyzeModule(file, source, (diagnostic) => {
          produced.push(diagnostic);
          report(diagnostic);
        });
        cache.set(`module:${file}`, stat, moduleInfo, produced);
        changedFiles.add(file);
      }
      fileTimes.push({ file, ms: Math.round(performance.now() - fileStarted) });
    } catch (error) {
      report({ level: "error", stage: "parse", file, message: `cannot analyze file: ${errorMessage(error)}`, detail: error instanceof Error ? error.stack : undefined });
      continue;
    }
    fileTokens[file] = estimateTokens(source);
    const fromBlock = fileBlock.get(file);
    const loads = dynamicLoads(source);
    if (loads.scripts.length > 0 || loads.fragments.length > 0) loadsByFile.set(file, loads);
    if (moduleInfo.script) scriptViews.set(file, scriptAsModule(source, moduleInfo.script.exportAt));
    globalsByFile.set(file, { globals: moduleInfo.globals, freeRefs: moduleInfo.freeRefs });
    for (const [name, value] of Object.entries(moduleInfo.stringGlobals ?? {})) stringGlobals.set(name, new Set([...(stringGlobals.get(name) ?? []), value]));
    for (const component of moduleInfo.components) defineComponent(kebabCase(component.name), file, component.line, component.inline);
    if (isVueFile(file)) {
      const parts = sfcParts(source);
      vueScripts.set(file, parts.script);
      defineComponent(sfcComponentName(file), file, 1);
      if (parts.template) collectTags(file, source, componentTags(parts.template.text, parts.template.offset));
    }
    for (const template of moduleInfo.templates) collectTags(file, source, componentTags(template.text, template.start));
    if (fromBlock) sources.push({ file, block: fromBlock, source: scriptViews.get(file) ?? vueScripts.get(file) ?? source });
    if (moduleInfo.dynamicHttpCalls.length > 0) {
      dynamicHttpByFile.set(file, moduleInfo.dynamicHttpCalls.length);
      const first = moduleInfo.dynamicHttpCalls[0];
      report({ level: "info", stage: "http", file, line: first.line, column: first.column, message: `${moduleInfo.dynamicHttpCalls.length} HTTP call(s) with a URL built entirely at run time: not on the map`, detail: moduleInfo.dynamicHttpCalls.slice(0, 5).map((call) => `${call.line}: ${call.snippet}`).join("\n") });
    }
    for (const call of moduleInfo.httpCalls) {
      httpCalls.push({ file, ...(fromBlock ? { block: fromBlock } : {}), url: call.url, ...(call.method ? { method: call.method } : {}), line: call.line, column: call.column, snippet: call.snippet, ...(call.prefixName ? { prefixName: call.prefixName } : {}) });
    }
    wrapperDefinitions.push(...(moduleInfo.httpWrappers ?? []));
    wrapperForwards.push(...(moduleInfo.forwards ?? []));
    if (moduleInfo.namedCalls?.length) namedCallsByFile.set(file, moduleInfo.namedCalls);

    for (const ref of moduleInfo.refs) {
      let resolved: ReturnType<typeof resolver>;
      try {
        resolved = resolver(ref.specifier, file);
      } catch (error) {
        report({ level: "error", stage: "resolve", file, message: `resolver failed on "${ref.specifier}": ${errorMessage(error)}` });
        continue;
      }
      if (resolved.kind === "non-source") {
        const outside = outsideRoot(file, ref.specifier, outsideInclude);
        if (outside) outsidePointers.push({ file, target: outside, via: "import", ...(fromBlock ? { block: fromBlock } : {}) });
        report({ level: "info", stage: "resolve", file, message: `"${ref.specifier}" resolves to ${resolved.path}, which is not an analyzed source file` });
        continue;
      }
      if (resolved.kind === "external") {
        if (fromBlock) {
          const set = externalByBlock.get(fromBlock) ?? new Set<string>();
          set.add(resolved.packageName);
          externalByBlock.set(fromBlock, set);
        }
        continue;
      }
      if (resolved.kind === "unresolved") {
        unresolvedImports.push({ file, specifier: ref.specifier, reason: resolved.reason });
        report({ level: "warning", stage: "resolve", file, message: `cannot resolve "${ref.specifier}": ${resolved.reason}` });
        continue;
      }
      resolvedImports.add(`${file}\u0000${ref.specifier}`);
      const toBlock = fileBlock.get(resolved.file);
      const edgeKey = `${file}\u0000${resolved.file}`;
      const fileEdge = fileImportsByKey.get(edgeKey) ?? { from: file, to: resolved.file, symbols: [] };
      addUnique(fileEdge.symbols, ...ref.symbols);
      fileImportsByKey.set(edgeKey, fileEdge);
      for (const binding of ref.bindings) {
        for (const usage of Object.hasOwn(moduleInfo.usages, binding.local) ? moduleInfo.usages[binding.local] : []) {
          callSites.push({
            symbol: binding.imported === "*" ? usage.member ?? "*" : binding.imported,
            targetFile: resolved.file,
            ...(toBlock ? { targetBlock: toBlock } : {}),
            file,
            ...(fromBlock ? { block: fromBlock } : {}),
            line: usage.line,
            column: usage.column,
            snippet: usage.snippet,
            via: "import",
            match: "certain",
          });
        }
      }
      if (fromBlock && fromBlock === toBlock) {
        const set = sameBlockImports.get(file) ?? new Set<string>();
        set.add(resolved.file);
        sameBlockImports.set(file, set);
      }
      if (!fromBlock || !toBlock || fromBlock === toBlock) continue;
      addDependency(fromBlock, toBlock, ref.symbols, resolved.file, { file, target: resolved.file, specifier: ref.specifier });
    }
  }

  // HTTP wrappers: functions that send a request with the URL their caller passes (sendObjDati(url, type)),
  // and the functions that pass their own parameter on to one of them. Their calls are HTTP calls.
  const wrappers = new Map<string, HttpWrapper>();
  for (const wrapper of wrapperDefinitions) if (!wrappers.has(wrapper.name)) wrappers.set(wrapper.name, wrapper);
  for (let round = 0, grew = true; grew && round < 5; round++) {
    grew = false;
    for (const forward of wrapperForwards) {
      const target = wrappers.get(forward.callee);
      if (!target || forward.param < 0 || target.urlArg !== forward.arg || wrappers.has(forward.from)) continue;
      // The verb: passed on from the caller, written here, or fixed further down.
      const verb = target.methodArg !== undefined ? wrapperForwards.find((other) => other.from === forward.from && other.callee === forward.callee && other.arg === target.methodArg) : undefined;
      // Or in an options object: written there (`{ method: "POST" }`) or the caller's own options, passed on.
      const options = target.optionsArg !== undefined ? wrapperForwards.find((other) => other.from === forward.from && other.callee === forward.callee && other.arg === target.optionsArg) : undefined;
      const fixed = verb?.value?.toUpperCase() ?? (options?.member === "method" ? options.value?.toUpperCase() : undefined) ?? target.method;
      const optionsFromCaller = options && options.member === undefined && options.param >= 0 && options.value === undefined && !verb;
      wrappers.set(forward.from, {
        name: forward.from,
        urlArg: forward.param,
        urlTemplate: target.urlTemplate,
        ...(verb && verb.param >= 0 ? { methodArg: verb.param } : {}),
        ...(optionsFromCaller ? { optionsArg: options.param } : {}),
        ...(fixed && HTTP_VERBS.has(fixed) ? { method: fixed } : {}),
      });
      grew = true;
    }
  }
  if (wrappers.size > 0) {
    let found = 0;
    for (const [file, calls] of namedCallsByFile) {
      const fromBlock = fileBlock.get(file);
      for (const call of calls) {
        const wrapper = wrappers.get(call.callee);
        const raw = wrapper ? call.args[wrapper.urlArg] : null;
        const url = raw && wrapper ? normalizeUrl(wrapper.urlTemplate.split(WRAPPED_URL).join(raw)) : undefined;
        if (!wrapper || !url) continue;
        const verb = wrapper.methodArg !== undefined ? call.args[wrapper.methodArg]?.toUpperCase() : (wrapper.optionsArg !== undefined ? call.methods?.[wrapper.optionsArg] : undefined) ?? wrapper.method;
        const method = verb && HTTP_VERBS.has(verb) ? verb : undefined;
        httpCalls.push({ file, ...(fromBlock ? { block: fromBlock } : {}), url, ...(method ? { method } : {}), line: call.line, column: call.column, snippet: call.snippet, via: call.callee });
        found++;
      }
    }
    const names = [...new Set(httpCalls.flatMap((call) => (call.via ? [call.via] : [])))];
    if (found > 0) report({ level: "info", stage: "http", message: `${names.length} function(s) send HTTP requests for their callers (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}): ${found} call(s) to them read as HTTP calls` });
  }

  if (minifiedFiles.length > 0) {
    const shown = minifiedFiles.slice(0, 8).join(", ") + (minifiedFiles.length > 8 ? `, … (${minifiedFiles.length})` : "");
    report({ level: "info", stage: "scan", message: `${minifiedFiles.length} minified, bundled or third-party file(s) kept in their blocks but not analyzed: ${shown}. To read some of them, list them in "analysis": { "read": […] } in the map; "parseMinified": true reads them all.` });
  }
  lap("parse and imports");

  // Python and the other tree-sitter languages: the same imports, call sites and dependencies.
  const languageFiles = readLanguageFiles(root, languageFileList, cache, report, fileStats);
  for (const file of countedFiles) {
    try {
      fileTokens[file] = Math.ceil(fs.statSync(path.join(root, file)).size / 4);
    } catch {
      // gone since the scan
    }
  }
  {
    const resolvers = new Map<string, LanguageResolver>();
    const resolverFor = (file: string): LanguageResolver => {
      const language = languageOf(file)!;
      let resolver = resolvers.get(language.id);
      if (!resolver) {
        resolver = language.createResolver(root, new Set(languageFileList.filter((candidate) => languageOf(candidate)?.id === language.id)), languageFiles);
        resolvers.set(language.id, resolver);
      }
      return resolver;
    };
    const resolved = new Map<string, Array<{ specifier: string; targets: ResolvedImport[] }>>();
    // Names a file imports from another file of the project: a package's __init__.py re-exporting them.
    const reexports = new Map<string, Map<string, { file: string; imported: string }>>();
    for (const [file, data] of languageFiles) {
      fileTokens[file] = Math.ceil((fileStats.get(file)?.size ?? 0) / 4);
      const list: Array<{ specifier: string; targets: ResolvedImport[] }> = [];
      for (const spec of data.imports) {
        let targets: ResolvedImport[];
        try {
          targets = resolverFor(file)(spec, file);
        } catch (error) {
          report({ level: "error", stage: "resolve", file, message: `resolver failed on "${spec.specifier}": ${errorMessage(error)}` });
          continue;
        }
        list.push({ specifier: spec.specifier, targets });
        for (const target of targets) {
          if (target.resolution.kind !== "internal") continue;
          const names = reexports.get(file) ?? new Map<string, { file: string; imported: string }>();
          for (const binding of target.bindings) if (binding.imported !== "*") names.set(binding.local, { file: target.resolution.file, imported: binding.imported });
          reexports.set(file, names);
        }
      }
      resolved.set(file, list);
    }
    const declared = (file: string, name: string) => languageFiles.get(file)?.declarations.some((declaration) => declaration.name === name) ?? false;
    /** Where a name imported from `file` is declared: through the files that only re-export it. */
    const definition = (file: string, name: string): string => {
      for (let hops = 0; hops < 5 && !declared(file, name); hops++) {
        const next = reexports.get(file)?.get(name);
        if (!next) break;
        file = next.file;
        name = next.imported;
      }
      return file;
    };
    for (const [file, list] of resolved) {
      const data = languageFiles.get(file)!;
      const fromBlock = fileBlock.get(file);
      for (const { specifier, targets } of list) {
        for (const target of targets) {
          const resolution = target.resolution;
          if (resolution.kind === "external") {
            if (fromBlock) externalByBlock.set(fromBlock, new Set([...(externalByBlock.get(fromBlock) ?? []), resolution.packageName]));
            continue;
          }
          if (resolution.kind === "unresolved") {
            unresolvedImports.push({ file, specifier, reason: resolution.reason });
            report({ level: "warning", stage: "resolve", file, message: `cannot resolve "${specifier}": ${resolution.reason}` });
            continue;
          }
          if (resolution.kind !== "internal") continue;
          // What the import reaches, file by file: one file for most languages; for a package of several
          // files (Go) the file that declares each name used, else the package's first file.
          const reached = new Map<string, string[]>(target.files ? [] : [[resolution.file, target.symbols]]);
          for (const binding of target.bindings) {
            for (const usage of Object.hasOwn(data.usages, binding.local) ? data.usages[binding.local] : []) {
              const symbol = binding.imported === "*" ? usage.member ?? "*" : binding.imported;
              const targetFile = target.files ? target.files.find((candidate) => declared(candidate, symbol)) ?? resolution.file : symbol === "*" ? resolution.file : definition(resolution.file, symbol);
              if (target.files) reached.set(targetFile, [...new Set([...(reached.get(targetFile) ?? []), symbol])]);
              const targetBlock = fileBlock.get(targetFile);
              callSites.push({ symbol, targetFile, ...(targetBlock ? { targetBlock } : {}), file, ...(fromBlock ? { block: fromBlock } : {}), line: usage.line, column: usage.column, snippet: usage.snippet, via: "import", match: "certain" });
            }
          }
          // A glob import (`use super::*`): the names it brings in that the file uses, each linked to the file that declares it.
          for (const entry of target.glob ?? []) {
            const uses = Object.hasOwn(data.references ?? {}, entry.name) ? data.references![entry.name] : [];
            if (uses.length === 0) continue;
            const targetBlock = fileBlock.get(entry.file);
            for (const usage of uses) callSites.push({ symbol: entry.imported, targetFile: entry.file, ...(targetBlock ? { targetBlock } : {}), file, ...(fromBlock ? { block: fromBlock } : {}), line: usage.line, column: usage.column, snippet: usage.snippet, via: "import", match: "certain" });
            reached.set(entry.file, [...new Set([...(reached.get(entry.file) ?? []), entry.imported])]);
          }
          if (target.files && reached.size === 0) reached.set(resolution.file, target.symbols);
          for (const [targetFile, symbols] of reached) {
            const edgeKey = `${file}\u0000${targetFile}`;
            const fileEdge = fileImportsByKey.get(edgeKey) ?? { from: file, to: targetFile, symbols: [] };
            addUnique(fileEdge.symbols, ...symbols);
            fileImportsByKey.set(edgeKey, fileEdge);
            const toBlock = fileBlock.get(targetFile);
            if (fromBlock && fromBlock === toBlock) sameBlockImports.set(file, new Set([...(sameBlockImports.get(file) ?? []), targetFile]));
            if (!fromBlock || !toBlock || fromBlock === toBlock) continue;
            addDependency(fromBlock, toBlock, symbols, targetFile, { file, target: targetFile, specifier });
          }
        }
      }
    }
  }
  const projects = dotnetProjects(root, exclude, include, scan);
  linkByNamespace(languageFiles, fileBlock, projects, { callSites, fileImportsByKey, sameBlockImports, externalByBlock, addDependency });
  linkBySamePackage(languageFiles, fileBlock, { callSites, fileImportsByKey, sameBlockImports, addDependency });
  lap("other languages");

  // Pages: which scripts load together (to pick the right definition of a global), the page's own
  // inline code, and the dependency of the page's block on the blocks of the scripts it loads.
  const pageFiles = scan(PAGE_EXTENSIONS);
  if (include) {
    for (const entry of include) {
      if (![...blockFiles, ...pageFiles].some((file) => isIncluded(file, [entry]))) {
        report({ level: "warning", stage: "scan", message: `analysis.include entry "${entry}" matches no source file (paths are relative to the map's root, and case counts)` });
      }
    }
  }
  const pages: Analysis["pages"] = [];
  const pageSet = new Set(pageFiles);
  for (const pageFile of pageFiles) {
    let html: string;
    try {
      html = readText(path.join(root, pageFile));
    } catch (error) {
      report({ level: "warning", stage: "scan", file: pageFile, message: `cannot read page: ${errorMessage(error)}` });
      continue;
    }
    const page = readPage(pageFile, html, fileSet, report, pageSet);
    const pageBlock = ownerOf(pageFile)?.id;
    for (const src of page.missing) {
      const target = outsideRoot(pageFile, src, outsideInclude);
      if (target) outsidePointers.push({ file: pageFile, target, via: "script", ...(pageBlock ? { block: pageBlock } : {}) });
    }
    collectTags(pageFile, html, componentTags(html));
    if (page.scripts.length === 0 && !page.inline && !page.includes && !componentUses.some((use) => use.file === pageFile && componentDefinitions.has(use.name))) continue;
    pages.push({ file: pageFile, ...(pageBlock ? { block: pageBlock } : {}), scripts: page.scripts, missing: page.missing, ...(page.includes ? { includes: page.includes } : {}) });
    if (page.inline) loadsByFile.set(pageFile, dynamicLoads(page.inline));
    for (const script of page.scripts) {
      const toBlock = fileBlock.get(script);
      if (pageBlock && toBlock && pageBlock !== toBlock) addDependency(pageBlock, toBlock, ["<script>"], script, { file: pageFile, target: script, specifier: script });
    }
    if (!page.inline) continue;
    try {
      // Inline code is often mixed with server code: what cannot be parsed is noted, not an error.
      const inlineReport: Report = (diagnostic) => report({ ...diagnostic, file: pageFile, level: "info", message: `inline script: ${diagnostic.message}` });
      const info = analyzeModule(pageFile.replace(/\.[^./]+$/, ".inline.js"), page.inline, inlineReport);
      globalsByFile.set(pageFile, { globals: info.globals, freeRefs: info.freeRefs });
      for (const call of info.httpCalls) httpCalls.push({ file: pageFile, ...(pageBlock ? { block: pageBlock } : {}), url: call.url, ...(call.method ? { method: call.method } : {}), line: call.line, column: call.column, snippet: call.snippet, ...(call.prefixName ? { prefixName: call.prefixName } : {}) });
    } catch (error) {
      report({ level: "info", stage: "parse", file: pageFile, message: `inline script not readable: ${errorMessage(error)}` });
    }
  }

  // What runs together: for each page, the scripts it loads, what it is built from (master page, user
  // controls, includes) and what its code loads at run time. A file loaded by no page is absent.
  const pagesLoading = new Map<string, Set<string>>();
  const runtimeLoads = new Map<string, string[]>();
  for (const [file, loads] of loadsByFile) {
    const targets = [...loads.scripts.map((name) => resolveScriptSrc(file, name, fileSet)), ...loads.fragments.map((name) => resolveScriptSrc(file, name, pageSet))].filter((target): target is string => typeof target === "string" && target !== file);
    if (targets.length > 0) runtimeLoads.set(file, targets);
  }
  const pageByFile = new Map(pages.map((page) => [page.file, page]));
  for (const page of pages) {
    const seen = new Set<string>();
    const queue = [page.file];
    for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
      if (seen.has(node)) continue;
      seen.add(node);
      const own = pageByFile.get(node);
      queue.push(...(own?.scripts ?? []), ...(own?.includes ?? []), ...(runtimeLoads.get(node) ?? []));
    }
    for (const node of seen) pagesLoading.set(node, new Set([...(pagesLoading.get(node) ?? []), page.file]));
  }

  // Globals: a name a script declares at top level (or sets on window) and another file reads.
  const definitions = new Map<string, Array<{ file: string; definition: GlobalDefinition }>>();
  for (const [file, info] of globalsByFile) {
    for (const definition of info.globals) {
      if (PLATFORM_NAMES.has(definition.name)) continue;
      const list = definitions.get(definition.name) ?? [];
      const existing = list.find((entry) => entry.file === file);
      if (!existing) list.push({ file, definition });
      else if (existing.definition.assigned && !definition.assigned) existing.definition = definition; // the declaration, not the re-export
      definitions.set(definition.name, list);
    }
  }
  for (const [name, list] of definitions) {
    if (list.length < 2) continue;
    report({ level: "info", stage: "globals", file: list[0].file, line: list[0].definition.line, message: `global \`${name}\` is defined in ${list.length} files: ${list.map((entry) => entry.file).join(", ")}. Calls are linked to the definition the same page loads; failing that, to the closest one.` });
  }
  const sharePage = (a: string, b: string) => [...(pagesLoading.get(a) ?? [])].some((page) => pagesLoading.get(b)?.has(page));
  for (const [file, info] of globalsByFile) {
    const fromBlock = fileBlock.get(file) ?? ownerOf(file)?.id;
    for (const [name, usages] of Object.entries(info.freeRefs)) {
      const all = definitions.get(name) ?? [];
      // Defined in the same file: the read is local, whatever other files define.
      if (all.some((entry) => entry.file === file)) continue;
      let candidates = all;
      // `window.x = y` often re-exposes something declared elsewhere: a declaration is the better answer.
      if (candidates.some((entry) => !entry.definition.assigned)) candidates = candidates.filter((entry) => !entry.definition.assigned);
      if (candidates.length === 0) continue;
      const together = candidates.filter((entry) => sharePage(file, entry.file));
      let targets = together;
      if (targets.length === 0) {
        // The caller runs in known pages and none of them loads a definition: one that other pages load is not
        // there at run time. What no page loads may be loaded by code, and is the only answer left to guess.
        const callerRunsInPages = candidates.length > 1 && pagesLoading.has(file);
        const reachable = callerRunsInPages ? candidates.filter((entry) => !pagesLoading.has(entry.file)) : candidates;
        targets = nearest(file, reachable);
        if (callerRunsInPages && reachable.length < candidates.length) {
          report({ level: "info", stage: "globals", file, line: usages[0].line, message: `\`${name}\` is defined only in ${candidates.filter((entry) => pagesLoading.has(entry.file)).map((entry) => entry.file).join(", ")}, and no page that loads this file loads them: not linked to ${reachable.length === 0 ? "any definition" : "those"}.` });
        }
      }
      if (targets.length === 0) continue;
      // One definition, or the one a page loads next to the caller: likely. Several to choose from: by name.
      const match = targets.length === 1 && (together.length === 1 || candidates.length === 1) ? "likely" : "by-name";
      for (const { file: target } of targets) {
        const toBlock = fileBlock.get(target) ?? ownerOf(target)?.id;
        for (const usage of usages) {
          callSites.push({ symbol: name, targetFile: target, ...(toBlock ? { targetBlock: toBlock } : {}), file, ...(fromBlock ? { block: fromBlock } : {}), line: usage.line, column: usage.column, snippet: usage.snippet, via: "global", match });
        }
        if (fromBlock && toBlock && fromBlock !== toBlock && fileSet.has(target)) addDependency(fromBlock, toBlock, [name], target, { file, target, specifier: `global ${name}` });
      }
    }
  }

  // Component tags: <order-list> (or <OrderList>) in a template or a page uses the component defined with that name.
  // A one-word name only counts written in PascalCase (<Modal>), so <table> or <button> never match a component.
  for (const use of componentUses) {
    const all = componentDefinitions.get(use.name) ?? [];
    // Defined in the same file (not just registered there from an import): that is the component the tag means.
    if (all.some((entry) => entry.file === use.file && entry.inline)) continue;
    const candidates = all.filter((entry) => entry.file !== use.file);
    if (candidates.length === 0 || (!use.name.includes("-") && !/^[A-Z]/.test(use.raw))) continue;
    const fromBlock = fileBlock.get(use.file) ?? ownerOf(use.file)?.id;
    const together = candidates.filter((entry) => sharePage(use.file, entry.file));
    const targets = together.length ? together : nearest(use.file, candidates);
    const match = targets.length === 1 && (together.length === 1 || candidates.length === 1) ? "likely" : "by-name";
    for (const { file: target } of targets) {
      const toBlock = fileBlock.get(target) ?? ownerOf(target)?.id;
      callSites.push({ symbol: `<${use.name}>`, targetFile: target, ...(toBlock ? { targetBlock: toBlock } : {}), file: use.file, ...(fromBlock ? { block: fromBlock } : {}), line: use.line, column: use.column, snippet: use.snippet, via: "component", match });
      if (fromBlock && toBlock && fromBlock !== toBlock) addDependency(fromBlock, toBlock, [`<${use.name}>`], target, { file: use.file, target, specifier: `component <${use.name}>` });
    }
  }

  lap("pages, globals and components");

  // The backend: endpoints of the C# code, and the HTTP calls of the front end that reach them.
  const endpoints: BackendEndpoint[] = [];
  if (csFiles.length > 0) {
    for (const file of csFiles) {
      try {
        fileTokens[file] = Math.ceil(fs.statSync(path.join(root, file)).size / 4);
      } catch {
        // reported by the C# reader
      }
    }
    const directives = new Map<string, string>();
    for (const file of scan([".asmx", ".svc", ".ashx"], ["bin", "obj"])) {
      try {
        directives.set(file, readText(path.join(root, file)).slice(0, 2000));
      } catch {
        // an unreadable directive only loses that service's path
      }
    }
    // Route registrations live in code (Global.asax.cs, or inline in Global.asax): read the text of the files that mention them.
    const asaxFiles = scan([".asax"], ["bin", "obj"]);
    const routeSources = function* (): Generator<[string, string]> {
      for (const file of [...csFiles, ...asaxFiles]) {
        try {
          yield [file, readText(path.join(root, file))];
        } catch {
          // unreadable: reported by the C# reader
        }
      }
    };
    const structures = readCSharp(root, csFiles, report, options.cache);
    endpoints.push(...backendEndpoints(structures, directives, serviceRoutes(routeSources())), ...minimalEndpoints(routeSources(), structures));
  }
  const pythonSources = function* (): Generator<[string, string]> {
    for (const file of languageFileList) {
      if (languageOf(file)?.id !== "python") continue;
      try {
        yield [file, readText(path.join(root, file))];
      } catch {
        // unreadable: reported by the language reader
      }
    }
  };
  endpoints.push(...pythonEndpoints(pythonSources()));
  endpoints.sort((a, b) => a.route.localeCompare(b.route) || (a.method ?? "").localeCompare(b.method ?? ""));
  {
    const unmatched = new Map<string, number>();
    for (const call of httpCalls) {
      let handlers = matchEndpoints(call, endpoints);
      // A URL that starts with a global another script defines (dev and prod can differ): try each value.
      let prefixKnown = false;
      if (call.prefixName && call.url.startsWith(DYNAMIC)) {
        const found = new Map<string, (typeof endpoints)[number]>();
        for (const value of [...(stringGlobals.get(call.prefixName) ?? [])].slice(0, 4)) {
          for (const endpoint of matchEndpoints({ ...call, url: value + call.url.slice(DYNAMIC.length) }, endpoints)) found.set(`${endpoint.file}:${endpoint.line}:${endpoint.handler}`, endpoint);
        }
        if (found.size > 0) {
          handlers = [...found.values()];
          prefixKnown = true;
        }
      }
      if (handlers.length === 0) {
        if (isStaticAssetUrl(call.url)) continue;
        unmatched.set(call.file, (unmatched.get(call.file) ?? 0) + 1);
        continue;
      }
      call.handlers = handlers.map((endpoint) => ({ file: endpoint.file, line: endpoint.line, handler: endpoint.handler }));
      for (const endpoint of handlers) {
        const toBlock = fileBlock.get(endpoint.file);
        // A route matched from its first segment is likely; an unknown base (the endpoint's or the URL's) or a choice of several, by name.
        const wildStart = endpoint.route.startsWith(`/${DYNAMIC}`) || (!prefixKnown && call.url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^[./~]+/, "").startsWith(DYNAMIC));
        const match = handlers.length === 1 && !wildStart ? "likely" : "by-name";
        callSites.push({ symbol: endpoint.handler, targetFile: endpoint.file, ...(toBlock ? { targetBlock: toBlock } : {}), file: call.file, ...(call.block ? { block: call.block } : {}), line: call.line, column: call.column, snippet: call.snippet, via: "http", match });
        if (call.block && toBlock && call.block !== toBlock) addDependency(call.block, toBlock, [endpoint.handler], endpoint.file, { file: call.file, target: endpoint.file, specifier: `${call.method ?? "GET"} ${call.url}` });
      }
    }
    if (endpoints.length > 0) {
      for (const [file, count] of unmatched) report({ level: "info", stage: "http", file, message: `${count} HTTP call(s) match no endpoint found in the C# code` });
    }
  }

  lap("C# backend");

  callSites.push(...findPageLinks(root, fileBlock.keys(), pageFiles, (file) => fileBlock.get(file), readText));
  lap("links to pages");

  // A contract file that re-exports or references sibling files needs their declarations too.
  const withSiblings = (entries: Iterable<string>): string[] => {
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...(sameBlockImports.get(file) ?? []));
    }
    return [...seen].sort();
  };

  const dependencies = [...depsByKey.values()]
    .map((dep) => ({ ...dep, symbols: dep.symbols.sort(), files: withSiblings(dep.files) }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const publicFiles = new Map<string, Set<string>>();
  for (const dep of dependencies) {
    const set = publicFiles.get(dep.to) ?? new Set<string>();
    dep.files.forEach((file) => set.add(file));
    publicFiles.set(dep.to, set);
  }
  for (const block of blocks) {
    for (const prefix of block.include) {
      for (const candidate of ["index.ts", "index.tsx", "index.js", "index.mts", "__init__.py"]) {
        const file = path.posix.join(prefix === "." ? "" : prefix, candidate);
        if (fileBlock.get(file) === block.id) {
          const set = publicFiles.get(block.id) ?? new Set<string>();
          set.add(file);
          publicFiles.set(block.id, set);
        }
      }
    }
  }

  for (const [blockId, set] of publicFiles) publicFiles.set(blockId, new Set(withSiblings(set)));
  const notRead = new Set(minifiedFiles);
  const allPublic = [...publicFiles.values()].flatMap((set) => [...set]).filter((file) => !file.endsWith(".cs") && !languageFiles.has(file) && !notRead.has(file));
  // Contracts, file by file: reused while the file and the files it imports are unchanged (a
  // compiler may infer its types from them). The others are generated again, together.
  const fallbackName = options.compilerFallback ?? "auto";
  const importsOf = new Map<string, string[]>();
  for (const edge of fileImportsByKey.values()) importsOf.set(edge.from, [...(importsOf.get(edge.from) ?? []), edge.to]);
  type CachedContract = { contract?: string; issue?: ContractIssue };
  const contracts: Record<string, string> = {};
  const contractIssues: ContractIssue[] = [];
  const toGenerate: string[] = [];
  for (const file of allPublic) {
    const stat = fileStats.get(file);
    const touchedImport = (importsOf.get(file) ?? []).some((dependency) => changedFiles.has(dependency));
    const hit = stat && !touchedImport ? cache.get<CachedContract>(`contract:${file}`, stat, fallbackName) : undefined;
    if (!hit) {
      toGenerate.push(file);
      continue;
    }
    if (hit.value.contract !== undefined) contracts[file] = hit.value.contract;
    if (hit.value.issue) contractIssues.push(hit.value.issue);
    for (const diagnostic of hit.diagnostics) report(diagnostic);
  }
  if (toGenerate.length > 0) {
    const produced: Diagnostic[] = [];
    const record: Report = (diagnostic) => {
      produced.push(diagnostic);
      report(diagnostic);
    };
    const generated = generateContracts(root, toGenerate, options.compilerFallback, record, new Map([...scriptViews, ...vueScripts]), (file, specifier) => resolvedImports.has(`${file}\u0000${specifier}`));
    Object.assign(contracts, generated.contracts);
    contractIssues.push(...generated.issues);
    // Notes about the whole run (which compiler) go with every file: reported once, as the collector drops repeats.
    for (const file of toGenerate) {
      const stat = fileStats.get(file);
      if (!stat) continue;
      const issue = generated.issues.find((candidate) => candidate.file === file);
      cache.set(`contract:${file}`, stat, { ...(generated.contracts[file] !== undefined ? { contract: generated.contracts[file] } : {}), ...(issue ? { issue } : {}) }, produced.filter((diagnostic) => diagnostic.file === file || !diagnostic.file), fallbackName);
    }
  }
  for (const file of [...publicFiles.values()].flatMap((set) => [...set])) {
    const data = languageFiles.get(file);
    if (data) contracts[file] = languageContract(data, languageOf(file)!);
  }
  contractIssues.sort((a, b) => a.file.localeCompare(b.file));
  lap("contracts");

  // Catalog entries, file by file: they depend on the source, the contract and the block.
  const incomplete = new Set(contractIssues.filter((issue) => issue.engine === "incomplete").map((issue) => issue.file));
  const catalog: ApiEntry[] = [];
  for (const entry of sources) {
    const stat = fileStats.get(entry.file);
    const extra = fingerprint([entry.block, contracts[entry.file] ?? null, incomplete.has(entry.file)]);
    const hit = stat ? cache.get<ApiEntry[]>(`catalog:${entry.file}`, stat, extra) : undefined;
    if (hit) {
      catalog.push(...hit.value);
      continue;
    }
    const own = buildCatalog([entry], contracts[entry.file] !== undefined ? { [entry.file]: contracts[entry.file] } : {}, incomplete);
    catalog.push(...own);
    if (stat) cache.set(`catalog:${entry.file}`, stat, own, [], extra);
  }
  for (const [file, data] of languageFiles) {
    const block = fileBlock.get(file);
    if (!block) continue;
    for (const declaration of data.declarations) {
      if (!declaration.exported) continue;
      catalog.push({ block, file, name: declaration.name, kind: declaration.kind, signature: declaration.signature, ...(declaration.doc ? { doc: declaration.doc } : {}), line: declaration.line, complete: true, shape: normalizeShape(declaration.signature), ...(declaration.bodyHash ? { bodyHash: declaration.bodyHash } : {}) });
    }
  }
  catalog.sort((a, b) => a.block.localeCompare(b.block) || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  // A C# file's contract, for the blocks that call it: its types, and the endpoints it serves.
  for (const file of new Set(endpoints.map((endpoint) => endpoint.file))) {
    const served = endpoints.filter((endpoint) => endpoint.file === file).map((endpoint) => `// ${endpoint.method ?? "ANY"} ${endpoint.route} → ${endpoint.handler} (line ${endpoint.line})${endpointDetail(endpoint) ? `: ${endpointDetail(endpoint)}` : ""}`).join("\n");
    contracts[file] = contracts[file] && !/^\/\/ no exported declarations$/.test(contracts[file]) ? `${served}\n\n${contracts[file]}` : served;
  }
  lap("catalog");
  cache.save();
  const history = options.skipGit ? { churn: new Map<string, number>(), coChanges: [] } : gitHistory(root, new Set([...blockFiles, ...pageFiles]), report);
  const churn = history.churn;
  lap("git history");

  const blockInfos: BlockInfo[] = blocks.map((block) => {
    const ownFiles = blockFiles.filter((file) => fileBlock.get(file) === block.id).sort();
    return {
      block,
      files: ownFiles,
      tokens: ownFiles.reduce((sum, file) => sum + (fileTokens[file] ?? 0), 0),
      churn: ownFiles.reduce((sum, file) => sum + (churn.get(file) ?? 0), 0),
      publicFiles: [...(publicFiles.get(block.id) ?? [])].sort(),
      externalPackages: [...(externalByBlock.get(block.id) ?? [])].sort(),
      httpEndpoints: [...new Set(httpCalls.filter((call) => call.block === block.id).map((call) => `${call.method ?? "?"} ${call.url}${call.via ? ` (via ${call.via})` : ""}${call.handlers ? ` → ${call.handlers.map((handler) => `${handler.handler} (${handler.file}:${handler.line})`).join(", ")}` : ""}`))].sort(),
      dynamicHttpCalls: ownFiles.reduce((sum, file) => sum + (dynamicHttpByFile.get(file) ?? 0), 0),
      loadedBy: pages.filter((page) => page.scripts.some((script) => fileBlock.get(script) === block.id)).map((page) => page.file),
      scriptFiles: ownFiles.filter((file) => scriptViews.has(file)),
      endpoints: endpoints.filter((endpoint) => fileBlock.get(endpoint.file) === block.id).map((endpoint) => `${endpoint.method ?? "ANY"} ${endpoint.route} → ${endpoint.handler}`),
    };
  });

  for (const entry of projects.outside) outsidePointers.push({ ...entry, via: "project reference", ...(ownerOf(entry.file)?.id ? { block: ownerOf(entry.file)!.id } : {}) });
  for (const entry of unresolvedImports) {
    const target = outsideRoot(entry.file, entry.specifier, outsideInclude);
    const block = fileBlock.get(entry.file);
    if (target) outsidePointers.push({ file: entry.file, target, via: "import", ...(block ? { block } : {}) });
  }
  const pagesWithCode = new Set(pages.map((page) => page.file));
  const trackedList = options.skipGit ? undefined : trackedFiles(root);
  const uncovered = trackedList && uncoveredFiles(root, (file) => file in fileTokens || pagesWithCode.has(file) || !!ownerOf(file), exclude, trackedList, include);
  // A suggestion about a block that is gone is stale.
  const suggestions = readSuggestions(root).filter((entry) => !entry.block || blockInfos.some((info) => info.block.id === entry.block));
  const untracked = untrackedBlocks(trackedList, blockInfos.map((info) => ({ id: info.block.id, files: info.files })));
  const trackedRebuilt = (trackedList ?? []).filter(isRebuiltCantusFile);
  const externalRefs = groupExternal(outsidePointers, (folder) => model?.analysis?.externalRoots?.[folder] ?? "ask");
  let readExternalFolders = false;
  for (const ref of externalRefs) {
    if (ref.access !== "allow") continue;
    ref.analyzed = readExternal(root, ref.folder, report);
    readExternalFolders = true;
  }
  if (readExternalFolders) {
    // What the blocks that point to an allowed folder use of it: found by name, since the folder is no block.
    for (const ref of externalRefs) {
      if (!ref.analyzed) continue;
      const users = blockInfos.filter((info) => ref.blocks.includes(info.block.id)).flatMap((info) => info.files.map((file) => ({ file, block: info.block.id })));
      callSites.push(...externalUses(root, ref, users));
    }
    lap("external folders");
  }
  return {
    root,
    name,
    blocksInferred: !model,
    blocks: blockInfos,
    unassignedFiles,
    dependencies,
    contracts,
    contractIssues,
    catalog,
    fileImports: [...fileImportsByKey.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    callSites,
    unresolvedImports,
    externalRefs,
    ...(uncovered ? { uncovered } : {}),
    ...(untracked.length ? { untrackedBlocks: untracked } : {}),
    ...(trackedRebuilt.length ? { trackedRebuilt } : {}),
    ...(suggestions.length ? { refineSuggestions: suggestions } : {}),
    httpCalls,
    pages,
    coChanges: history.coChanges,
    scriptFiles: [...scriptViews.keys()].sort(),
    endpoints,
    diagnostics: sortDiagnostics(diagnostics),
    fileTokens,
    minifiedFiles,
    timings: { total: Math.round(performance.now() - started), stages, slowestFiles: fileTimes.sort((a, b) => b.ms - a.ms).slice(0, 5) },
  };
}

/**
 * An external folder the user allowed, analyzed by itself with its own inferred blocks: read-only
 * (no cache, no git, nothing written there), its exports kept for `find_api`. Folders it points to
 * in turn are not followed.
 */
function readExternal(root: string, folder: string, report: Report): ExternalAnalysis | undefined {
  const absolute = path.resolve(root, folder);
  try {
    if (!fs.statSync(absolute).isDirectory()) throw new Error("not a folder");
  } catch (error) {
    report({ level: "warning", stage: "scan", file: folder, message: `external folder allowed by the map but unreadable: ${errorMessage(error)}` });
    return undefined;
  }
  const inner = analyze(absolute, { skipGit: true, cache: false, compilerFallback: "none" });
  const prefix = (file: string) => path.posix.normalize(path.posix.join(folder, file));
  return {
    files: Object.keys(inner.fileTokens).length,
    tokens: Object.values(inner.fileTokens).reduce((sum, tokens) => sum + tokens, 0),
    exports: inner.catalog.length,
    catalog: inner.catalog.slice(0, EXTERNAL_CATALOG_LIMIT).map((entry) => ({ ...entry, block: folder, file: prefix(entry.file) })),
  };
}

const MAX_TYPE_CANDIDATES = 3;

interface DotnetProjects {
  /** Whether code in `from` can use code in `to`: the same project, or one it references (directly or not). */
  sees(from: string, to: string): boolean;
  /** Project references that leave the map's root: the project file and the project it names. */
  outside: Array<{ file: string; target: string }>;
}

/**
 * The .NET projects of the repository (`*.csproj`, `*.fsproj`, `*.vbproj`) and their
 * `<ProjectReference>`s. A file belongs to the project of the nearest folder above it that holds one;
 * with no project files at all, everything sees everything.
 */
function dotnetProjects(root: string, exclude: string[], include: string[] | undefined, scan: SourceScanner): DotnetProjects {
  const files = scan([".csproj", ".fsproj", ".vbproj"], ["bin", "obj"]);
  const references = new Map<string, Set<string>>();
  const outside: DotnetProjects["outside"] = [];
  for (const file of files) {
    const refs = new Set<string>();
    try {
      for (const match of fs.readFileSync(path.join(root, file), "utf8").matchAll(/<ProjectReference\s[^>]*?Include\s*=\s*"([^"]+)"/gi)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1].replace(/\\/g, "/")));
        refs.add(target);
        if (target === ".." || target.startsWith("../") || leavesInclude(target, exclude, include)) outside.push({ file, target });
      }
    } catch {
      // an unreadable project file loses its references only
    }
    references.set(file, refs);
  }
  const folders = new Map(files.map((file) => [path.posix.dirname(file) === "." ? "" : path.posix.dirname(file), file]));
  const projectOf = (file: string): string | undefined => {
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      const key = dir === "." ? "" : dir;
      const project = folders.get(key);
      if (project) return project;
      if (key === "") return undefined;
    }
  };
  const reach = new Map<string, Set<string>>();
  const reachable = (project: string): Set<string> => {
    let set = reach.get(project);
    if (set) return set;
    set = new Set([project]);
    reach.set(project, set);
    for (const next of references.get(project) ?? []) for (const found of reachable(next)) set.add(found);
    return set;
  };
  return {
    outside,
    sees(from, to) {
      if (files.length === 0) return true;
      const a = projectOf(from);
      const b = projectOf(to);
      return !a || !b || a === b || reachable(a).has(b);
    },
  };
}

/**
 * C# files name namespaces, not files: a type name a file uses is linked to the types of that name
 * declared in a namespace the file sees (its own namespace and the enclosing ones, its `using`
 * directives, the project's `global using`s). One candidate is likely; a few are by name; more
 * than three are left unlinked. A `using` of a namespace the project does not declare is an
 * external package, named by its first segment.
 */
function linkByNamespace(
  languageFiles: Map<string, LanguageFile>,
  fileBlock: Map<string, string>,
  projects: DotnetProjects,
  out: {
    callSites: CallSite[];
    fileImportsByKey: Map<string, { from: string; to: string; symbols: string[] }>;
    sameBlockImports: Map<string, Set<string>>;
    externalByBlock: Map<string, Set<string>>;
    addDependency: (fromBlock: string, toBlock: string, symbols: string[], target: string, entry: { file: string; target: string; specifier: string }) => void;
  },
): void {
  const linked = [...languageFiles].filter(([file]) => languageOf(file)?.linkByNamespace);
  if (linked.length === 0) return;
  const types = new Map<string, Array<{ file: string; namespace: string }>>();
  const declaredNamespaces = new Set<string>();
  const globalUsings = new Set<string>();
  for (const [file, data] of linked) {
    for (const declaration of data.declarations) types.set(declaration.name, [...(types.get(declaration.name) ?? []), { file, namespace: declaration.namespace ?? "" }]);
    for (const namespace of data.namespaces ?? []) for (const prefix of prefixes(namespace)) declaredNamespaces.add(prefix);
    for (const spec of data.imports) if (spec.global) globalUsings.add(spec.specifier);
  }
  // C# looks a `using` name up in the namespace that holds the directive, then in each enclosing one, then at the root:
  // `namespace A.B; using Results;` opens `A.B.Results` when that namespace exists. Where none does, the name is as written.
  const resolveUsing = (spec: LanguageImport): string => {
    if (!spec.scope) return spec.specifier;
    const enclosing = prefixes(spec.scope).reverse();
    for (const base of [...enclosing, ""]) {
      const full = base ? `${base}.${spec.specifier}` : spec.specifier;
      if (declaredNamespaces.has(full)) return full;
    }
    return spec.specifier;
  };
  for (const [file, data] of linked) {
    const fromBlock = fileBlock.get(file);
    const visible = new Set<string>(["", ...globalUsings]);
    for (const namespace of data.namespaces ?? []) for (const prefix of languageOf(file)?.flatNamespaces ? [namespace] : prefixes(namespace)) visible.add(prefix);
    for (const spec of data.imports) {
      const opened = resolveUsing(spec);
      visible.add(opened);
      if (!declaredNamespaces.has(opened) && fromBlock) out.externalByBlock.set(fromBlock, new Set([...(out.externalByBlock.get(fromBlock) ?? []), opened.split(".")[0]]));
    }
    const own = new Set(data.declarations.map((declaration) => declaration.name));
    for (const [name, usages] of Object.entries(data.references ?? {})) {
      if (own.has(name)) continue;
      const candidates = (types.get(name) ?? []).filter((candidate) => candidate.file !== file && visible.has(candidate.namespace) && projects.sees(file, candidate.file));
      const targets = [...new Set(candidates.map((candidate) => candidate.file))];
      if (targets.length === 0 || targets.length > MAX_TYPE_CANDIDATES) continue;
      const match = targets.length === 1 ? "likely" : "by-name";
      for (const target of targets) {
        const toBlock = fileBlock.get(target);
        for (const usage of usages) {
          out.callSites.push({ symbol: name, targetFile: target, ...(toBlock ? { targetBlock: toBlock } : {}), file, ...(fromBlock ? { block: fromBlock } : {}), line: usage.line, column: usage.column, snippet: usage.snippet, via: "type", match });
        }
        const key = `${file}\u0000${target}`;
        const edge = out.fileImportsByKey.get(key) ?? { from: file, to: target, symbols: [] };
        addUnique(edge.symbols, name);
        out.fileImportsByKey.set(key, edge);
        if (fromBlock && fromBlock === toBlock) out.sameBlockImports.set(file, new Set([...(out.sameBlockImports.get(file) ?? []), target]));
        else if (fromBlock && toBlock) out.addDependency(fromBlock, toBlock, [name], target, { file, target, specifier: `type ${name}` });
      }
    }
  }
}

/** A Go file whose name limits it to some systems or architectures: `x_windows.go`, `x_linux_arm64.go`. */
const GO_SYSTEM_FILE = /_(?:aix|android|darwin|dragonfly|freebsd|hurd|illumos|ios|js|linux|nacl|netbsd|openbsd|plan9|solaris|wasip1|windows|zos|386|amd64|arm|arm64|loong64|mips|mipsle|mips64|mips64le|ppc64|ppc64le|riscv64|s390x|sparc64|wasm)(?:_(?:386|amd64|arm|arm64|loong64|mips|mipsle|mips64|mips64le|ppc64|ppc64le|riscv64|s390x|sparc64|wasm))?\.go$/;

/**
 * The files of one Go package (the files of a folder that name the same package) see each other's
 * top-level names without an import. An exported name a file uses without a qualifier, and declares
 * itself nowhere, is linked to the file of its package that declares it: `certain`, the language's own
 * rule. Where files compiled for different systems or tags declare the same name, the unconstrained
 * file wins; if every candidate is constrained, one is `likely` and several are `by-name`.
 */
function linkBySamePackage(
  languageFiles: Map<string, LanguageFile>,
  fileBlock: Map<string, string>,
  out: {
    callSites: CallSite[];
    fileImportsByKey: Map<string, { from: string; to: string; symbols: string[] }>;
    sameBlockImports: Map<string, Set<string>>;
    addDependency: (fromBlock: string, toBlock: string, symbols: string[], target: string, entry: { file: string; target: string; specifier: string }) => void;
  },
): void {
  const linked = [...languageFiles].filter(([file]) => languageOf(file)?.linkBySamePackage);
  if (linked.length === 0) return;
  const packageOf = (file: string, data: LanguageFile) => `${path.posix.dirname(file)}\u0000${data.packageName ?? ""}`;
  const constrained = (file: string, data: LanguageFile) => !!data.conditional || GO_SYSTEM_FILE.test(file);
  const declaredIn = new Map<string, Map<string, Array<{ file: string; constrained: boolean }>>>();
  for (const [file, data] of linked) {
    const key = packageOf(file, data);
    const names = declaredIn.get(key) ?? new Map<string, Array<{ file: string; constrained: boolean }>>();
    declaredIn.set(key, names);
    for (const declaration of data.declarations) {
      if (!declaration.exported) continue;
      const list = names.get(declaration.name) ?? [];
      if (!list.some((entry) => entry.file === file)) list.push({ file, constrained: constrained(file, data) });
      names.set(declaration.name, list);
    }
  }
  for (const [file, data] of linked) {
    const names = declaredIn.get(packageOf(file, data));
    if (!names) continue;
    const fromBlock = fileBlock.get(file);
    for (const [name, usages] of Object.entries(data.references ?? {})) {
      const all = (names.get(name) ?? []).filter((candidate) => candidate.file !== file);
      if (all.length === 0) continue;
      const open = all.filter((candidate) => !candidate.constrained);
      const targets = (open.length > 0 ? open : all).map((candidate) => candidate.file);
      if (targets.length > MAX_TYPE_CANDIDATES) continue;
      const match = open.length > 0 ? "certain" : targets.length === 1 ? "likely" : "by-name";
      for (const target of targets) {
        const toBlock = fileBlock.get(target);
        for (const usage of usages) {
          out.callSites.push({ symbol: name, targetFile: target, ...(toBlock ? { targetBlock: toBlock } : {}), file, ...(fromBlock ? { block: fromBlock } : {}), line: usage.line, column: usage.column, snippet: usage.snippet, via: "type", match });
        }
        const key = `${file}\u0000${target}`;
        const edge = out.fileImportsByKey.get(key) ?? { from: file, to: target, symbols: [] };
        addUnique(edge.symbols, name);
        out.fileImportsByKey.set(key, edge);
        if (fromBlock && fromBlock === toBlock) out.sameBlockImports.set(file, new Set([...(out.sameBlockImports.get(file) ?? []), target]));
        else if (fromBlock && toBlock) out.addDependency(fromBlock, toBlock, [name], target, { file, target, specifier: `package ${name}` });
      }
    }
  }
}

/** `A.B.C` → `A`, `A.B`, `A.B.C`. */
function prefixes(namespace: string): string[] {
  const parts = namespace.split(".").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("."));
}

/** Names scripts often reuse from the browser: a declaration of one is not taken as a project global. */
const PLATFORM_NAMES = new Set(["name", "status", "length", "top", "parent", "self", "event", "open", "close", "print", "history", "location", "document", "window", "console", "alert", "confirm", "navigator", "screen", "frames", "opener", "origin", "$", "jQuery"]);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function scanSourceFiles(root: string, extraExclude: string[] = [], report: Report = () => {}, extensions: string[] = SOURCE_EXTENSIONS, include?: string[]): string[] {
  const result: string[] = [];
  const wanted = new Set(extensions);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      report({ level: "error", stage: "scan", file: toPosix(path.relative(root, dir)) || ".", message: `cannot read directory: ${errorMessage(error)}` });
      return;
    }
    for (const entry of entries) {
      // A plain file of another kind (images, binaries: most of a big tree) is not looked at any further.
      if (entry.isFile() && !wanted.has(path.extname(entry.name).toLowerCase())) continue;
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (isExcluded(relative, entry.name, extraExclude)) continue;
      if (entry.isSymbolicLink()) {
        report({ level: "info", stage: "scan", file: relative, message: "symbolic link skipped (not followed, to avoid loops and duplicates)" });
        continue;
      }
      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (!mayHoldIncluded(relative, include)) continue;
        walk(absolute);
      } else if (entry.isFile() && !DEFAULT_EXCLUDED_FILE.test(entry.name) && isIncluded(relative, include)) {
        result.push(relative);
      }
    }
  };
  walk(root);
  return result.sort();
}

/** Every extension any scan of the project asks for: one walk lists them all, each question picks its own. */
export const SCANNED_EXTENSIONS: string[] = [...new Set([...SOURCE_EXTENSIONS, ".cs", ...LANGUAGE_EXTENSIONS, ...COUNTED_EXTENSIONS, ...PAGE_EXTENSIONS, ".asmx", ".svc", ".ashx", ".asax", ".csproj", ".fsproj", ".vbproj"])];

/** Source files of some kinds, outside what `analysis.exclude` and the defaults leave out and, besides, outside `extraExclude`. */
export type SourceScanner = (extensions: string[], extraExclude?: string[]) => string[];

/**
 * The same answers as `scanSourceFiles`, but the tree is walked once: a big project is walked in seconds, and the analysis asks
 * a dozen times (JavaScript, C#, pages, other languages…). The first question walks, with `exclude` only (and reports what the
 * walk meets); the others pick from that list the files of their kinds that `extraExclude` does not leave out (`bin`, `obj`…),
 * as the folders they would not have entered are named.
 */
export function createSourceScanner(root: string, exclude: string[], report: Report = () => {}, include?: string[]): SourceScanner {
  let listed: Array<{ file: string; extension: string }> | undefined;
  return (extensions, extraExclude = []) => {
    listed ??= scanSourceFiles(root, exclude, report, SCANNED_EXTENSIONS, include).map((file) => ({ file, extension: path.extname(file).toLowerCase() }));
    const wanted = new Set(extensions);
    const folderOk = new Map<string, boolean>();
    // A folder is left out when its own path matches, or one above it does.
    const allowed = (folder: string): boolean => {
      if (folder === "") return true;
      let known = folderOk.get(folder);
      if (known === undefined) {
        const slash = folder.lastIndexOf("/");
        known = allowed(slash === -1 ? "" : folder.slice(0, slash)) && !isExcluded(folder, folder.slice(slash + 1), extraExclude);
        folderOk.set(folder, known);
      }
      return known;
    };
    const result: string[] = [];
    for (const { file, extension } of listed) {
      if (!wanted.has(extension)) continue;
      if (extraExclude.length > 0) {
        const slash = file.lastIndexOf("/");
        if (!allowed(slash === -1 ? "" : file.slice(0, slash)) || isExcluded(file, file.slice(slash + 1), extraExclude)) continue;
      }
      result.push(file);
    }
    return result;
  };
}

/**
 * `analysis.include` as the scan uses it: entries cleaned up (`./a/`, `a\\b` and `a/b` are the same
 * entry), `undefined` when the whole root is meant (no entry, an empty list, or `"."`). An entry that
 * leaves the root (`..`, an absolute path) is ignored with a warning; if none is left, nothing is included.
 */
export function normalizeInclude(include: string[] | undefined, report: Report = () => {}): string[] | undefined {
  if (!Array.isArray(include) || include.length === 0) return undefined;
  const kept: string[] = [];
  for (const raw of include) {
    const entry = String(raw).trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (entry === "" || entry === ".") return undefined;
    if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.split("/").includes("..")) {
      report({ level: "warning", stage: "scan", message: `analysis.include entry "${raw}" leaves the map's root and is ignored (a folder outside the root is an external one: set_external_access)` });
      continue;
    }
    if (!kept.includes(entry)) kept.push(entry);
  }
  return kept;
}

/** The part of a glob before its first wildcard segment: where files it matches can start. */
function literalPrefix(pattern: string): string {
  const literal: string[] = [];
  for (const segment of pattern.split("/")) {
    if (segment.includes("*")) break;
    literal.push(segment);
  }
  return literal.length === pattern.split("/").length ? pattern : literal.join("/");
}

/** Whether a file path is inside `analysis.include` (undefined: everything is). A glob may match the file or a folder above it. */
export function isIncluded(relative: string, include: string[] | undefined): boolean {
  if (!include) return true;
  return include.some((pattern) => {
    if (!pattern.includes("*")) return relative === pattern || relative.startsWith(pattern + "/");
    const parts = relative.split("/");
    return parts.some((_part, index) => matchesGlob(parts.slice(0, index + 1).join("/"), pattern));
  });
}

/** Whether a folder is worth walking: it is inside an included path, or above one. */
export function mayHoldIncluded(folder: string, include: string[] | undefined): boolean {
  if (!include) return true;
  return include.some((pattern) => {
    const literal = pattern.includes("*") ? literalPrefix(pattern) : pattern;
    return literal === "" || folder === literal || folder.startsWith(literal + "/") || literal.startsWith(folder + "/");
  });
}

/**
 * Whether a path in the root is left out by `analysis.include` and nothing else: what the code points
 * to without the map holding it. A path `exclude` or the defaults leave out is not that.
 */
export function leavesInclude(relative: string, exclude: string[], include: string[] | undefined): boolean {
  if (!include || relative === "" || isIncluded(relative, include)) return false;
  const segments = relative.split("/");
  if (segments.some((segment, index) => (index < segments.length - 1 || !path.posix.extname(segment)) && (DEFAULT_EXCLUDED_DIRS.has(segment) || segment.startsWith(".")))) return false;
  return !isExcluded(relative, segments[segments.length - 1], exclude);
}

/** Whether a path matches one of `analysis.exclude`: a name, a prefix, or a glob. */
export function isExcluded(relative: string, name: string, extraExclude: string[]): boolean {
  let segments: string[] | undefined;
  return extraExclude.some((pattern) => {
    if (pattern.includes("*")) return globFor(pattern)((segments ??= relative.split("/")));
    return pattern === name || relative === pattern || relative.startsWith(pattern.replace(/\/+$/, "") + "/");
  });
}

/**
 * Glob match for `analysis.exclude` patterns: `*` stays inside a path segment, `**` crosses
 * segments, and a pattern without `/` matches a file name in any directory (like .gitignore).
 */
export function matchesGlob(relative: string, pattern: string): boolean {
  return globFor(pattern)(relative.split("/"));
}

/** Each pattern is read once: a scan asks about every entry of the tree, many times over. */
const compiledGlobs = new Map<string, (segments: string[]) => boolean>();

function globFor(pattern: string): (segments: string[]) => boolean {
  let matcher = compiledGlobs.get(pattern);
  if (!matcher) {
    matcher = compileGlob(pattern);
    compiledGlobs.set(pattern, matcher);
  }
  return matcher;
}

function compileGlob(pattern: string): (segments: string[]) => boolean {
  const parts = pattern.split("/");
  const wholePath = pattern.includes("/");
  // A segment with no `*` is compared as it is; the others become one pattern each.
  const tests = parts.map((part): string | RegExp | null => (part === "**" ? null : part.includes("*") ? new RegExp(`^${part.split("*").map((piece) => piece.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join(".*")}$`) : part));
  const matches = (target: string[], partAt: number, targetAt: number): boolean => {
    if (partAt === parts.length) return targetAt === target.length;
    const test = tests[partAt];
    if (test === null) {
      for (let skip = targetAt; skip <= target.length; skip++) if (matches(target, partAt + 1, skip)) return true;
      return false;
    }
    if (targetAt >= target.length) return false;
    const segment = target[targetAt];
    return (typeof test === "string" ? test === segment : test.test(segment)) && matches(target, partAt + 1, targetAt + 1);
  };
  return (segments) => matches(wholePath ? segments : [segments[segments.length - 1]], 0, 0);
}

function findWorkspacePackages(root: string, extraExclude: string[], report: Report, include?: string[]): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  // Each folder is listed once, and the listing says which manifests it holds: no attempt to open a file that is not there.
  const walk = (dir: string, relativeDir: string | undefined) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // already reported by scanSourceFiles
    }
    if (relativeDir !== undefined) {
      const names = new Set(entries.map((entry) => entry.name));
      const name = readPackageName(dir, report, root, names);
      if (name && !isIncluded(relativeDir, include)) {
        // above an included folder, walked only to reach it: not a package of the map
      } else if (name) packages.push({ name, dir: relativeDir });
      else if (names.has("package.json") && hasValidPackageJson(dir)) {
        report({ level: "info", stage: "packages", file: `${relativeDir}/package.json`, message: "package.json has no name; its directory is not treated as a workspace package" });
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || DEFAULT_EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (isExcluded(relative, entry.name, extraExclude) || !mayHoldIncluded(relative, include)) continue;
      walk(absolute, relative);
    }
  };
  walk(root, undefined);
  return packages;
}

function hasValidPackageJson(dir: string): boolean {
  try {
    JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * What to call a project that names itself nowhere: its folder, except when the folder is a git
 * checkout of a repository with a remote (a worktree is called `<repo>-<branch>`): then the
 * repository's name, so the same project has the same names in every checkout.
 */
export function folderName(root: string): string {
  const folder = path.basename(root);
  try {
    const git = (...args: string[]) => execFileSync("git", args, { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (fs.realpathSync.native(git("rev-parse", "--show-toplevel")) !== fs.realpathSync.native(root)) return folder; // a subfolder: the folder was chosen
    const remote = git("config", "--get", "remote.origin.url").replace(/[\\/]+$/, "").replace(/\.git$/, "");
    const name = remote.split(/[\\/:]/).pop();
    return name || folder;
  } catch {
    return folder;
  }
}

function readPackageName(dir: string, report?: Report, root: string = dir, names?: Set<string>): string | undefined {
  const file = path.join(dir, "package.json");
  if (names ? !names.has("package.json") : !fs.existsSync(file)) return readManifestName(dir, names);
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string }).name;
  } catch (error) {
    report?.({ level: "warning", stage: "packages", file: toPosix(path.relative(root, file)), message: `invalid package.json: ${errorMessage(error)}` });
    return undefined;
  }
}

/**
 * The name in a Python (`pyproject.toml`, `[project]`) or Rust (`Cargo.toml`, `[package]`) manifest, a Go module's last element,
 * or of the folder's only .NET project (`Orders.Api.csproj` → `Orders.Api`).
 */
function readManifestName(dir: string, names?: Set<string>): string | undefined {
  // With the folder's listing at hand, a manifest that is not in it is not read (no failing open per folder).
  if (!names || names.has("go.mod")) {
    try {
      const goModule = /^\s*module\s+"?([^\s"]+)/m.exec(fs.readFileSync(path.join(dir, "go.mod"), "utf8"))?.[1];
      if (goModule) return goModule.split("/").filter((part) => !/^v\d+$/.test(part)).pop();
    } catch {
      // not a Go module
    }
  }
  try {
    const projects = [...(names ?? fs.readdirSync(dir))].filter((name) => /\.(cs|fs|vb)proj$/i.test(name));
    if (projects.length === 1) return projects[0].replace(/\.[^.]+$/, "");
  } catch {
    return undefined;
  }
  for (const [manifest, table] of [["pyproject.toml", "project"], ["Cargo.toml", "package"]]) {
    if (names && !names.has(manifest)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, manifest), "utf8");
    } catch {
      continue;
    }
    const section = new RegExp(`^\\[${table}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text)?.[1];
    const name = section && /^\s*name\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
    if (name) return name;
  }
  return undefined;
}

/**
 * Proposes blocks from directory structure: one block per workspace package, split into
 * first-level `src/` subdirectories when the package is too large to be one agent's scope.
 */
export function inferBlocks(root: string, files: string[], packages: WorkspacePackage[] = []): Block[] {
  const containers = new Map<string, string[]>();
  const packageDirs = packages.map((pkg) => pkg.dir).sort((a, b) => b.length - a.length);
  for (const file of files) {
    const container = packageDirs.find((dir) => file.startsWith(dir + "/")) ?? ".";
    containers.set(container, [...(containers.get(container) ?? []), file]);
  }

  const isMonorepo = packages.length > 0;
  const repoName = readPackageName(root) ?? folderName(root);
  const blocks: Block[] = [];

  for (const [container, containerFiles] of [...containers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const pkg = packages.find((candidate) => candidate.dir === container);
    const containerName = pkg ? stripScope(pkg.name) : container === "." ? repoName : path.posix.basename(container);
    const prefix = container === "." ? "" : container + "/";
    let base = containerFiles.some((file) => file.startsWith(prefix + "src/")) ? prefix + "src" : container;
    // A folder holding a single Python package (`src/mypackage/__init__.py`, the usual layout) says nothing: split the package.
    for (;;) {
      const basePrefix = base === "." ? "" : base + "/";
      const inside = containerFiles.filter((file) => file.startsWith(basePrefix)).map((file) => file.slice(basePrefix.length).split("/"));
      const only = inside[0]?.length > 1 ? inside[0][0] : undefined;
      if (!only || !inside.every((parts) => parts.length > 1 && parts[0] === only) || !(containerFiles.includes(`${basePrefix}${only}/__init__.py`) || inside.every((parts) => parts[parts.length - 1].endsWith(".java")))) break;
      base = basePrefix + only;
    }
    const containerLayer = guessLayer([...container.split("/"), containerName]) ?? "unassigned";

    const subdirs = new Map<string, number>();
    // A single-package project is split by directory; workspace packages only when too large for one agent.
    if (container === "." || containerFiles.length > SPLIT_THRESHOLD) {
      const basePrefix = base === "." ? "" : base + "/";
      for (const file of containerFiles) {
        if (!file.startsWith(basePrefix)) continue;
        const rest = file.slice(basePrefix.length).split("/");
        if (rest.length > 1) subdirs.set(rest[0], (subdirs.get(rest[0]) ?? 0) + 1);
      }
    }

    const covered = new Set<string>();
    // The main project splits even with one subdirectory; a workspace package needs two to be worth splitting.
    if (subdirs.size > (container === "." ? 0 : 1)) {
      for (const sub of [...subdirs.keys()].sort()) {
        const include = base === "." ? sub : `${base}/${sub}`;
        const subFiles = containerFiles.filter((file) => file.startsWith(include + "/"));
        subFiles.forEach((file) => covered.add(file));
        const name = isMonorepo ? `${titleCase(containerName)} · ${titleCase(sub)}` : titleCase(sub);
        const layer = guessLayer([sub]) ?? containerLayer;
        // A large Python package at the top (`fastapi/`, not under src/) splits into its subpackages, like src/ does.
        const children = new Set(subFiles.map((file) => file.slice(include.length + 1).split("/")).filter((parts) => parts.length > 1).map((parts) => parts[0]));
        if (subFiles.length > SPLIT_THRESHOLD && subFiles.includes(`${include}/__init__.py`) && children.size > 1) {
          for (const child of [...children].sort()) {
            blocks.push({ id: toBlockId(`${include}/${child}`), name: `${name} · ${titleCase(child)}`, layer: guessLayer([child]) ?? layer, include: [`${include}/${child}`] });
          }
          if (subFiles.some((file) => !file.slice(include.length + 1).includes("/"))) {
            blocks.push({ id: toBlockId(include), name, layer, include: [include] });
          }
          continue;
        }
        blocks.push({ id: toBlockId(include), name, layer, include: [include] });
      }
    }

    if (containerFiles.some((file) => !covered.has(file))) {
      blocks.push({
        id: container === "." ? toBlockId(repoName) : toBlockId(container),
        name: titleCase(containerName),
        layer: containerLayer,
        include: [container],
      });
    }
  }

  return withoutAssemblyInfoBlocks(balanceBlocks(blocks, files), files).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A .NET `Properties/` folder that holds only `AssemblyInfo.cs` is not a unit of work: its file stays with the block around it.
 * (Only when there is one: a block of that folder alone would leave the file with no owner.)
 */
export function isAssemblyInfoFolder(folder: string, files: string[]): boolean {
  if (path.posix.basename(folder).toLowerCase() !== "properties") return false;
  const inside = files.filter((file) => file.startsWith(`${folder}/`));
  return inside.length > 0 && inside.every((file) => /^assemblyinfo\.[a-z]+$/i.test(path.posix.basename(file)));
}

function withoutAssemblyInfoBlocks(blocks: Block[], files: string[]): Block[] {
  const stays = (block: Block) => {
    const folder = block.include.length === 1 ? block.include[0].replace(/\/+$/, "") : undefined;
    if (!folder || !isAssemblyInfoFolder(folder, files)) return true;
    return !blocks.some((other) => other !== block && other.include.some((prefix) => prefix === "." || folder.startsWith(`${prefix.replace(/\/+$/, "")}/`)));
  };
  return blocks.filter(stays);
}

/** Longest-prefix owner of each file, the same rule the analysis applies. */
function ownedFiles(blocks: Block[], files: string[]): Map<Block, string[]> {
  const owned = new Map<Block, string[]>(blocks.map((block) => [block, []]));
  for (const file of files) {
    const owner = blockForFile(blocks, file);
    if (owner) owned.get(owner)?.push(file);
  }
  return owned;
}

/**
 * Evens out block sizes after the directory layout proposed them: a block owning far too many files is split
 * along its subdirectories (knex: `lib` alone held 147 of 193 files), and a run of tiny sibling blocks is merged
 * (nodemailer: 20 blocks of 1-4 files). Pure file counts, so it works for every language.
 */
function balanceBlocks(initial: Block[], files: string[]): Block[] {
  const blocks = [...initial];
  const dirOf = (block: Block): string | undefined => (block.include.length === 1 && block.include[0] !== "." ? block.include[0] : undefined);
  const splittable = (block: Block): string | undefined => (block.include.length === 1 ? block.include[0] : undefined);

  for (let round = 0; round < 6; round++) {
    const owned = ownedFiles(blocks, files);
    let changed = false;
    for (const block of [...blocks]) {
      const dir = splittable(block);
      const mine = owned.get(block) ?? [];
      if (dir === undefined || mine.length <= BIG_BLOCK) continue;
      const base = dir === "." ? "" : dir + "/";
      // A chain of single folders (`src/main/java/com/acme`) says nothing: split where it forks.
      let prefix = base;
      let children = new Set<string>();
      for (;;) {
        children = new Set(mine.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split("/")).filter((parts) => parts.length > 1).map((parts) => parts[0]));
        const only = children.size === 1 ? [...children][0] : undefined;
        if (!only || mine.filter((file) => file.startsWith(`${prefix}${only}/`)).length < mine.length * 0.9 || !mine.every((file) => file.endsWith(".java"))) break;
        prefix = `${prefix}${only}/`;
      }
      if (children.size < 2) continue;
      for (const child of [...children].sort()) {
        const include = prefix + child;
        const id = toBlockId(include);
        if (blocks.some((other) => other.id === id)) continue;
        blocks.push({ id, name: `${block.name} · ${titleCase(child)}`, layer: guessLayer([child]) ?? block.layer, include: [include] });
        changed = true;
      }
      // What the children took no longer belongs to the parent; a parent left with nothing goes away.
      if (mine.every((file) => file.startsWith(prefix) && children.has(file.slice(prefix.length).split("/")[0]) && file.slice(prefix.length).includes("/"))) blocks.splice(blocks.indexOf(block), 1);
    }
    if (!changed) break;
  }

  const owned = ownedFiles(blocks, files);
  const parentOf = (block: Block): string | undefined => {
    const dir = dirOf(block);
    return dir ? path.posix.dirname(dir) : undefined;
  };
  const isLeaf = (block: Block): boolean => {
    const dir = dirOf(block);
    return !!dir && !blocks.some((other) => other !== block && other.include.some((include) => include.startsWith(dir + "/")));
  };
  const siblings = new Map<string, Block[]>();
  for (const block of blocks) {
    const parent = parentOf(block);
    if (parent === undefined || !isLeaf(block) || (owned.get(block)?.length ?? 0) > SMALL_BLOCK) continue;
    siblings.set(parent, [...(siblings.get(parent) ?? []), block]);
  }
  for (const [parent, small] of [...siblings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (small.length < MIN_SMALL_SIBLINGS) continue;
    const groups: Block[][] = [[]];
    let size = 0;
    for (const block of small.sort((a, b) => a.id.localeCompare(b.id))) {
      const count = owned.get(block)?.length ?? 0;
      if (size + count > MERGE_MAX && groups[groups.length - 1].length > 0) {
        groups.push([]);
        size = 0;
      }
      groups[groups.length - 1].push(block);
      size += count;
    }
    const usable = groups.filter((group) => group.length > 1);
    usable.forEach((group, index) => {
      const layers = new Set(group.map((block) => block.layer));
      const suffix = usable.length > 1 ? ` ${index + 1}` : "";
      const merged: Block = {
        id: toBlockId(`${parent}-small${suffix}`),
        name: `${titleCase(path.posix.basename(parent))} · Small modules${suffix}`,
        layer: layers.size === 1 ? [...layers][0] : "unassigned",
        include: group.flatMap((block) => block.include).sort(),
      };
      if (blocks.some((other) => other.id === merged.id && !group.includes(other))) return;
      for (const block of group) blocks.splice(blocks.indexOf(block), 1);
      blocks.push(merged);
    });
  }
  return blocks;
}

function guessLayer(segments: string[]): Layer | undefined {
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.some((segment) => segment.split(/[^a-z0-9_]+/).some((word) => TEST_HINTS.includes(word)))) return "test";
  for (const segment of lower) {
    const words = segment.split(/[^a-z0-9]+/);
    for (const [layer, hints] of LAYER_HINTS) {
      if (hints.includes(segment) || words.some((word) => hints.includes(word))) return layer;
    }
  }
  return undefined;
}

const HISTORY_COMMITS = 1000;
const CHURN_DAYS = 90;
/** A commit touching more analyzed files than this is a sweep (rename, reformat): it says nothing about coupling. */
const SWEEP_FILES = 20;
const MIN_SHARED_COMMITS = 3;
const MIN_SHARE = 0.5;

/**
 * From the git history: how often each file changed in the last 90 days (hotspots), and which
 * analyzed files keep changing in the same commits (co-change), over the last 1000 commits.
 */
export function gitHistory(root: string, known: Set<string>, report: Report): { churn: Map<string, number>; coChanges: CoChange[] } {
  const churn = new Map<string, number>();
  const coChanges: CoChange[] = [];
  let log: string;
  let prefix: string;
  try {
    prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    log = execFileSync("git", ["log", `--max-count=${HISTORY_COMMITS}`, "--name-only", "--pretty=format:%x00%ct %P", "--", "."], {
      windowsHide: true,
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const failed = error as { stderr?: string; code?: string };
    report({
      level: "info",
      stage: "git",
      message: failed.code === "ENOENT" ? "git is not installed; change hotspots are unavailable" : "not a git repository (or git failed); change hotspots are unavailable",
      detail: failed.stderr?.toString().trim() || undefined,
    });
    return { churn, coChanges };
  }
  const since = Date.now() / 1000 - CHURN_DAYS * 24 * 3600;
  const changes = new Map<string, number>();
  const together = new Map<string, number>();
  for (const commit of log.split("\0").filter(Boolean)) {
    const [header, ...lines] = commit.split("\n");
    const [time, ...parents] = header.trim().split(" ");
    const touched = [...new Set(lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length)))];
    if (Number(time) >= since) for (const file of touched) churn.set(file, (churn.get(file) ?? 0) + 1);
    const analyzed = touched.filter((file) => known.has(file)).sort();
    // The first commit adds the project at once, and a sweep touches everything: neither says what belongs together.
    if (parents.length === 0 || analyzed.length > SWEEP_FILES) continue;
    for (const file of analyzed) changes.set(file, (changes.get(file) ?? 0) + 1);
    for (let i = 0; i < analyzed.length; i++) {
      for (let j = i + 1; j < analyzed.length; j++) {
        const key = `${analyzed[i]}\0${analyzed[j]}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, commits] of together) {
    if (commits < MIN_SHARED_COMMITS) continue;
    const [a, b] = key.split("\0");
    const share = commits / Math.min(changes.get(a)!, changes.get(b)!);
    if (share >= MIN_SHARE) coChanges.push({ files: [a, b], commits, share: Math.round(share * 100) / 100 });
  }
  coChanges.sort((x, y) => y.commits - x.commits || y.share - x.share || x.files[0].localeCompare(y.files[0]));
  return { churn, coChanges };
}

function addUnique(target: string[], ...values: string[]) {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function stripScope(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

/** A folder name as a block name: `order-history` → `Order History`. */
export function titleCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

