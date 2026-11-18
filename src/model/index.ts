import fs from "node:fs";
import path from "node:path";
import { writePath } from "./write-path.js";

/** The layers of a map without its own `layers`, top to bottom, followed by `unassigned`. */
export const LAYERS = ["interface", "application", "domain", "infrastructure", "unassigned"] as const;
/**
 * Two layers a map without its own `layers` may also use: `host` (the composition root, which wires
 * everything and sits above all) and `test`. They appear on the map only once a block is placed in
 * them; both may depend on any layer, and no other layer may depend on them.
 */
export const HOST_LAYER = "host";
export const TEST_LAYER = "test";
/** A layer name: one of the map's `layers`, or `unassigned` (never checked). */
export type Layer = string;
export const UNASSIGNED = "unassigned";

/** A unit of ownership: one sub-agent works inside one block. */
export interface Block {
  /** Stable id derived from the block's primary path, e.g. `src-checkout`. */
  id: string;
  name: string;
  layer: Layer;
  /** Repo-relative directory prefixes. A file belongs to the block with the longest matching prefix. */
  include: string[];
  description?: string;
  /** How to work in the block, beyond what the code shows: entry points, conventions, pitfalls. */
  notes?: BlockNote[];
  /** What `cantus refine` wrote here. */
  refined?: BlockRefinement;
}

/** A note on working in a block, with the block's files it rests on. */
export interface BlockNote {
  text: string;
  files: string[];
}

/** A block's notes as a short list, each with the files it rests on: for notes files and briefings. */
export function renderBlockNotes(notes: BlockNote[]): string[] {
  return ["How to work here:", ...notes.map((note) => `- ${note.text} (${note.files.map((file) => `\`${file}\``).join(", ")})`)];
}

export type RefinedField = "name" | "description" | "layer" | "notes";

/**
 * Fields `cantus refine` wrote: a later refine may rewrite them, every other field is yours and
 * stays. Take a field out of the list to keep your own edit of it.
 */
export interface BlockRefinement {
  fields: RefinedField[];
  /** The block's files and exports when it was refined: refine skips it until they change. */
  fingerprint: string;
}

export interface Group {
  /** Kebab-case id, used for the `group-<id>` subagent. */
  id: string;
  name: string;
  blocks: string[];
  description?: string;
}

/**
 * A Markdown document given to agents on top of what Cantus extracts from the code: assigned to
 * blocks or groups (specs, decisions, pitfalls), or flagged common for every agent (conventions,
 * glossary, product rules).
 */
export interface DocRef {
  /** Repo-relative path, e.g. `docs/payments.md`. */
  path: string;
  blocks?: string[];
  groups?: string[];
  common?: boolean;
  description?: string;
}

export interface DeclaredDependency {
  from: string;
  to: string;
}

export interface ArchModel {
  version: 1;
  name: string;
  blocks: Block[];
  /** Dependencies the architecture allows. Code dependencies not listed here are reported as drift. */
  dependencies: DeclaredDependency[];
  /** Saved working scopes: blocks an agent works on together (e.g. the blocks of one feature). */
  groups?: Group[];
  /** Documents for agents: assigned to blocks or groups, or common to all. See `DocRef`. */
  docs?: DocRef[];
  /**
   * The project's layers, top to bottom (e.g. ["ui", "features", "core"]). Default: interface,
   * application, domain, infrastructure. `unassigned` always exists besides these and is never checked.
   */
  layers?: string[];
  /** Treat the map as a contract in `cantus check` (see CheckOptions.strict). Default false: the map is a guide. */
  strict?: boolean;
  rules: {
    /**
     * For each layer, the layers its blocks are expected to depend on. With custom `layers`, a layer
     * not listed here may use itself and the layers below it. `unassigned` is never checked.
     */
    allow: Partial<Record<Layer, Layer[]>>;
  };
  analysis?: {
    /**
     * Analyze only these paths of the map's root: a folder prefix from the root (`webroot`, not a name
     * looked for at any depth), a single file, or a glob like `exclude`'s. Absent or empty: everything.
     * `exclude` and the defaults (`bin`, `obj`, `node_modules`) apply after it. Code that an included
     * path points to (a project reference, a relative import, a script) in a path left out here is an
     * external folder, as one outside the root is (`set_external_access`).
     */
    include?: string[];
    /** Paths to ignore on top of the defaults: a prefix (vendor), or a glob ("*.min.js", "assets/**"). */
    exclude?: string[];
    /**
     * Leave out what `.gitignore` ignores and git does not track (a generated `wwwroot`, build output):
     * default true. A block whose `include` names an ignored folder reads it anyway. `false` reads everything.
     */
    respectGitignore?: boolean;
    /**
     * Read minified, bundled and third-party files too (`.min.js`, over 1 MB, very long lines, or a
     * license banner with a version at the top: `/*! jQuery UI - v1.12.1`). Default false:
     * they stay in their block and imports or `<script src>` pointing to them are kept, but their
     * code is not analyzed (no exports, globals or call sites), which is where most of the time went.
     */
    parseMinified?: boolean;
    /** Files not to read, like minified ones (third-party code the heuristics miss): names, prefixes or globs. */
    vendor?: string[];
    /** A block past this many tokens of code is reported as too large to be one unit of work (default 40000; 0 turns it off). */
    maxBlockTokens?: number;
    /**
     * Folders outside the map's root that its code points to (`../lib/Lib`), and what the user decided:
     * `allow` reads them read-only (their exports are searchable), `deny` leaves them alone. A folder
     * not listed has not been asked about yet. Set with `set_external_access`.
     */
    externalRoots?: Record<string, "allow" | "deny">;
    /** Files to read even if they look minified or third-party (a library with project code pasted on top). */
    read?: string[];
  };
  agent?: {
    /** Claude model for tasks started from the map or with `cantus task`. Default: Claude Code's own. */
    model?: string;
    /** Model for block tasks specifically (`block`) and for the separate agent that verifies the work (`verify`); they take precedence over `model`. */
    models?: { block?: string; verify?: string };
    /** How tasks run Claude Code: `sdk` (the Agent SDK, default) or `claude-cli` (`claude -p`, the command line's own login). */
    runner?: "sdk" | "claude-cli" | "codex";
    /** Command the agent may run to verify its work, e.g. `npm test`. Chosen by you, never by the agent. */
    verifyCommand?: string;
    /** Project-relative files read by checks, including ignored local inputs. */
    gateInputs?: string[];
    /** How many more times Cantus lets the agent try again, with the check's output, when the check fails after its work (0-5, default 2). */
    retries?: number;
    /**
     * What Cantus does when a plan's task would be built and verified by the same model (or is not verified at all): `warn` (default) says so
     * in the plan and its record; `require` refuses to start such a plan until the verifier is a different model (`verifyModel`).
     */
    independence?: "warn" | "require";
    /**
     * Commands a task can be checked with, by name (e.g. `{ "unit": "npm test", "lint": "npm run lint" }`): the person who
     * starts a task, or an agent that proposes one, picks a name, never a command. Cantus runs the one chosen when the agent is done.
     */
    checks?: Record<string, string>;
    /** Documents up to this many tokens are inlined in briefings; larger ones are listed for the agent to open. Default 3000. */
    docInlineTokens?: number;
    mcp?: McpAccess;
    /** How a task started in a worktree (from the map or `cantus task --worktree`) gets its branch, folder and files. */
    worktree?: WorktreeRules;
  };
}

/**
 * The map's rules for the worktree of a task. Templates take `{id} {block} {slug} {user} {date} {project} {repo}`.
 * Without any, the worktree is `cantus/task-{id}` in `.git/cantus-worktrees`, started from the main branch.
 */
export interface WorktreeRules {
  /** Branch name. Default `cantus/task-{id}`; a taken name gets `-2`, `-3`… */
  branch?: string;
  /** Where it starts: `default` (the repository's main branch, else HEAD), `HEAD`, or any branch, tag or commit. */
  base?: string;
  /** Folder of the worktree, relative to the repository's top folder (`../{repo}-{slug}`) or absolute. Default: inside `.git` for a task Cantus runs, `.cantus/worktrees/{name}` (ignored by git and by the analysis) for a session of your own (Claude Code will not write inside `.git`). */
  path?: string;
  /** Files and folders of the project copied in, for what git ignores and the agent needs (`.env`). `.worktreeinclude` is read too. */
  copy?: string[];
  /** Files and folders linked to the project's own (junction on Windows) instead of copied: packages, big static data. Not where setup writes. */
  link?: string[];
  /** Commands run in the new worktree (`pnpm install --offline`). Each task asks for the go-ahead first, every time. */
  setup?: string[];
  /** Seconds each setup command, or the script, may take. Default 600. */
  setupTimeoutSeconds?: number;
  /** The worktree's name, handed to `script`. Default `{slug}`; one already used by a worktree gets `-2`, `-3`… */
  name?: string;
  /**
   * A script that makes the worktree itself, with all the person's own rules (a `.ps1`, `.sh`, `.cmd`, `.mjs`, or any
   * executable), instead of Cantus's. It gets the worktree's name and the branch name as its two arguments, and
   * `CANTUS_BASE`, `CANTUS_PATH` (a suggested folder), `CANTUS_TASK`, `CANTUS_BLOCKS` and `CANTUS_ROOT` in the environment; it runs
   * in the repository's top folder, and prints the worktree's folder as its last line (else it is found by branch).
   * `copy`, `link` and `setup` then do not apply: the script does that. Each task asks for the go-ahead first, every time.
   */
  script?: string;
  /**
   * The arguments `script` gets, when it does not take the name and the branch as its first two. `{name}`, `{branch}`,
   * `{base}` (the commit), `{baseRef}` (the branch or tag it was chosen as) and `{path}` (the suggested folder) are filled in:
   * `["-Branch", "{branch}", "-BaseBranch", "{baseRef}"]` for a `.ps1` with named parameters. Default `["{name}", "{branch}"]`.
   */
  scriptArgs?: string[];
  /**
   * A script that removes the worktree when the task is merged or discarded: for links your own script made, or anything
   * `git worktree remove` would not clean up. It runs in the repository's top folder; afterwards Cantus removes what is
   * left, and the task's branch. Same placeholders as `scriptArgs`, with `{path}` the worktree's real folder.
   */
  removeScript?: string;
  /** The arguments `removeScript` gets. Default `["{path}"]`. */
  removeArgs?: string[];
}

/**
 * Your own MCP servers (database, CI, repository host…) reach agents by default: the main agent and
 * every specialist. This takes some away. Entries are server names as in your Claude Code config
 * (`jenkins`), or a full tool prefix (`mcp__jenkins__delete_job`, `mcp__plugin_acme_ci`).
 */
export interface McpAccess {
  /** Refused in unattended tasks (`cantus task`), for the coordinating agent and its subagents alike. */
  deny?: string[];
  /** Refused to every generated specialist (`block-*`, `group-*`, `cantus-scope`), written into their `disallowedTools`. */
  specialists?: { deny?: string[] };
  /** Refused to the specialist of one block or group, on top of `specialists`. Keys are block or group ids. */
  blocks?: Record<string, { deny?: string[] }>;
}

/** The permission rule for an `mcp.deny` entry: `jenkins` becomes `mcp__jenkins`, which covers all of that server's tools. */
export function mcpRule(entry: string): string {
  const name = entry.trim().replace(/__$/, "");
  return /^mcp__/i.test(name) ? name : `mcp__${name}`;
}

/** Whether an MCP tool (`mcp__<server>__<tool>`) is covered by one of the `mcp.deny` entries. */
export function mcpDenied(tool: string, deny: string[] | undefined): boolean {
  return (deny ?? []).some((entry) => {
    const rule = mcpRule(entry);
    return rule !== "mcp" && rule !== "mcp__" && (tool === rule || tool.startsWith(`${rule}__`));
  });
}

export const DEFAULT_RULES: ArchModel["rules"] = {
  allow: {
    interface: ["interface", "application", "domain"],
    application: ["application", "domain", "infrastructure"],
    domain: ["domain"],
    infrastructure: ["infrastructure", "domain"],
  },
};

const BASE_LAYERS = LAYERS.filter((layer) => layer !== UNASSIGNED);

/** The map's layers, top to bottom, without `unassigned`. Without its own `layers`, `host` and `test` show once a block is in them. */
export function modelLayers(model: (Pick<ArchModel, "layers"> & { blocks?: Array<Pick<Block, "layer">> }) | undefined): string[] {
  if (model?.layers) return model.layers;
  const used = (layer: string) => !!model?.blocks?.some((block) => block.layer === layer);
  return [...(used(HOST_LAYER) ? [HOST_LAYER] : []), ...BASE_LAYERS, ...(used(TEST_LAYER) ? [TEST_LAYER] : [])];
}

/** The layers a block may be placed in: the map's, and `host` and `test` too when it has no layers of its own. */
export function selectableLayers(model: (Pick<ArchModel, "layers"> & { blocks?: Array<Pick<Block, "layer">> }) | undefined): string[] {
  return model?.layers ?? [HOST_LAYER, ...BASE_LAYERS, TEST_LAYER];
}

/**
 * The layers a layer's blocks are expected to depend on: its rule if the map has one; in a map with
 * its own `layers`, otherwise the layer itself and those below it. Undefined when not checked
 * (`unassigned`, unknown layers, and default layers without a rule, as before `layers` existed).
 */
export function allowedLayers(model: Pick<ArchModel, "layers" | "rules"> | undefined, layer: Layer): Layer[] | undefined {
  const explicit = model?.rules?.allow?.[layer];
  if (explicit) return explicit;
  if (!model?.layers) return undefined;
  const layers = model.layers;
  const index = layers.indexOf(layer);
  return index < 0 ? undefined : layers.slice(index);
}

export const MODEL_DIR = ".cantus";
export const MODEL_FILE = "model.json";

export function modelPath(root: string): string {
  return path.join(root, MODEL_DIR, MODEL_FILE);
}

/** The folder Cantus used while it was called ArchFlow. */
export const LEGACY_MODEL_DIR = ".archflow";

/**
 * Moves a project's `.archflow/` (map, cache, logs, runs) to `.cantus/`, and its `.gitignore`
 * entries with it, so a project mapped before the rename keeps its map. Does nothing when there
 * is no `.archflow/`, or when `.cantus/` already exists. Returns the moved paths, project-relative.
 */
export function migrateLegacyDir(root: string): string[] {
  const legacy = path.join(root, LEGACY_MODEL_DIR);
  const current = path.join(root, MODEL_DIR);
  if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory() || fs.existsSync(current)) return [];
  fs.renameSync(legacy, current);
  const moved = [`${LEGACY_MODEL_DIR}/ → ${MODEL_DIR}/`];
  const gitignore = path.join(root, ".gitignore");
  if (fs.existsSync(gitignore)) {
    const text = fs.readFileSync(gitignore, "utf8");
    const next = text.replace(/(^|[\s/*!])\.archflow(?=\/|\s|$)/gm, `$1${MODEL_DIR}`);
    if (next !== text) {
      fs.writeFileSync(gitignore, next);
      moved.push(".gitignore");
    }
  }
  return moved;
}

/** A Claude model: an alias such as `opus`, or a full id (`claude-sonnet-5-5`, `claude-opus-5[1m]`). It ends up on a command line, so nothing else. */
export function isModelName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/.test(value);
}

export function loadModel(root: string): ArchModel | undefined {
  const file = modelPath(root);
  if (!fs.existsSync(file)) return undefined;
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error(`Invalid ${path.relative(root, file)}: model exceeds 4 MiB.`);
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Invalid ${path.relative(root, file)}: model must be an object.`);
  const raw = parsed as unknown as ArchModel;
  const model: ArchModel = { ...raw, dependencies: raw.dependencies ?? [], rules: raw.rules ?? DEFAULT_RULES };
  const problems = validateModel(model);
  if (problems.length > 0) {
    throw new Error(`Invalid ${path.relative(root, file)}:\n  - ${problems.join("\n  - ")}`);
  }
  return model;
}

export function saveModel(root: string, model: ArchModel): string {
  const problems = validateModel(model);
  if (problems.length) throw new Error(`Invalid map: ${problems.join("; ")}`);
  const file = writePath(root, `${MODEL_DIR}/${MODEL_FILE}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(writePath(root, `${MODEL_DIR}/${MODEL_FILE}`), JSON.stringify(model, null, 2) + "\n");
  return file;
}

/** The names of `agent.checks` are what an agent or a request can choose, so they are plain words; the commands are one line. */
export const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

function checkProblems(checks: unknown): string[] {
  if (checks === undefined) return [];
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) return ["agent.checks must be an object of names and commands"];
  const problems: string[] = [];
  for (const [name, command] of Object.entries(checks)) {
    if (!CHECK_NAME.test(name) || name === "none") problems.push(`agent.checks "${name}": a name is letters, digits, dashes and underscores (up to 40), and "none" is taken`);
    else if (typeof command !== "string" || !command.trim() || command.length > 1000 || /[\r\n\0]/.test(command)) problems.push(`agent.checks "${name}": the command must be one line of text`);
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateModel(model: ArchModel): string[] {
  if (!isRecord(model)) return ["model must be an object"];
  const problems: string[] = [];
  for (const key of ["blocks", "groups", "docs", "dependencies"] as const) {
    const value = model[key];
    if (value === undefined && key !== "blocks") continue;
    if (!Array.isArray(value)) problems.push(`${key} must be an array`);
    else value.forEach((item, index) => {
      if (!isRecord(item)) problems.push(`${key}[${index}] must be an object`);
    });
  }
  for (const key of ["analysis", "agent", "rules"] as const) {
    if (model[key] !== undefined && !isRecord(model[key])) problems.push(`${key} must be an object`);
  }
  if (problems.length) return problems;
  if (model.version !== 1) problems.push(`unsupported version ${String(model.version)}`);
  if (!Array.isArray(model.blocks)) return [...problems, "blocks must be an array"];
  const layers = modelLayers(model);
  if (model.layers !== undefined) {
    if (!Array.isArray(model.layers) || model.layers.length === 0) problems.push("layers must list at least one layer");
    else {
      const seen = new Set<string>();
      for (const layer of model.layers) {
        if (typeof layer !== "string" || !layer.trim()) problems.push("layer names must not be empty");
        else if (layer === UNASSIGNED) problems.push(`"${UNASSIGNED}" is always there: do not list it in layers`);
        else if (seen.has(layer)) problems.push(`layer "${layer}" is listed twice`);
        seen.add(layer);
      }
    }
  }
  for (const [layer, allowed] of Object.entries(model.rules?.allow ?? {})) {
    if (!layers.includes(layer)) problems.push(`rules.allow names unknown layer "${layer}"`);
    if (!Array.isArray(allowed) || allowed.some(target => typeof target !== "string")) {
      problems.push(`rules.allow.${layer} must be a list of layer names`);
      continue;
    }
    for (const target of allowed) if (!layers.includes(target)) problems.push(`rules.allow.${layer} names unknown layer "${target}"`);
  }
  const include = model.analysis?.include;
  if (include !== undefined && (!Array.isArray(include) || include.some((entry) => typeof entry !== "string"))) problems.push("analysis.include must be a list of paths (strings)");
  const ids = new Set<string>();
  for (const block of model.blocks) {
    if (!block.id) problems.push("block without id");
    if (ids.has(block.id)) problems.push(`duplicate block id "${block.id}"`);
    ids.add(block.id);
    if (block.layer !== UNASSIGNED && !layers.includes(block.layer)) problems.push(`block "${block.id}" has unknown layer "${block.layer}"`);
    if (!Array.isArray(block.include) || block.include.length === 0 || block.include.some(prefix => typeof prefix !== "string")) {
      problems.push(`block "${block.id}" must include at least one path`);
    }
    if (block.notes !== undefined && (!Array.isArray(block.notes) || block.notes.some((note) => typeof note?.text !== "string" || !Array.isArray(note.files)))) {
      problems.push(`block "${block.id}": notes must be a list of { text, files }`);
    }
  }
  if (model.agent?.runner !== undefined && !["sdk", "claude-cli", "codex"].includes(model.agent.runner)) problems.push(`agent.runner must be "sdk", "claude-cli" or "codex", not "${model.agent.runner}"`);
  for (const [where, value] of [["agent.model", model.agent?.model], ["agent.models.block", model.agent?.models?.block], ["agent.models.verify", model.agent?.models?.verify]] as const) {
    if (value !== undefined && (typeof value !== "string" || !isModelName(value))) problems.push(`${where} "${String(value)}" is not a model name: use an alias such as opus, sonnet or haiku, or a full model id`);
  }
  problems.push(...checkProblems(model.agent?.checks));
  const gateInputs = model.agent?.gateInputs;
  if (gateInputs !== undefined && (!Array.isArray(gateInputs) || gateInputs.some(file =>
    typeof file !== "string" || file === "." || /[\\:\x00-\x1f]/.test(file) || file.split("/").some(part => part.toLowerCase() === ".git") || docPathProblem(file)
  ))) problems.push("agent.gateInputs must list project-relative file paths using forward slashes.");
  problems.push(...worktreeRuleProblems(model.agent?.worktree));
  const groupIds = new Set<string>();
  for (const group of model.groups ?? []) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(group.id ?? "")) problems.push(`group id "${group.id}" must be kebab-case (letters, digits, dashes)`);
    if (groupIds.has(group.id)) problems.push(`duplicate group id "${group.id}"`);
    groupIds.add(group.id);
    if (!Array.isArray(group.blocks) || group.blocks.length === 0) problems.push(`group "${group.id}" must list at least one block`);
  }
  const mcp = model.agent?.mcp;
  if (mcp !== undefined && !isRecord(mcp)) problems.push("agent.mcp must be an object");
  else if (mcp !== undefined) {
    const list = (where: string, value: unknown) => {
      if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))) problems.push(`${where} must be a list of MCP server names`);
    };
    list("agent.mcp.deny", mcp.deny);
    list("agent.mcp.specialists.deny", isRecord(mcp.specialists) ? mcp.specialists.deny : undefined);
    for (const [id, access] of Object.entries(mcp.blocks ?? {})) {
      list(`agent.mcp.blocks.${id}.deny`, isRecord(access) ? access.deny : undefined);
      if (!ids.has(id) && !groupIds.has(id)) problems.push(`agent.mcp.blocks lists "${id}", which is neither a block nor a group`);
    }
  }
  const docPaths = new Set<string>();
  for (const doc of model.docs ?? []) {
    const problem = typeof doc.path === "string" ? docPathProblem(doc.path) : "path must be a string";
    if (problem) problems.push(`document "${doc.path}": ${problem}`);
    if (docPaths.has(doc.path)) problems.push(`document "${doc.path}" is listed twice`);
    docPaths.add(doc.path);
  }
  for (const dep of model.dependencies ?? []) {
    if (!ids.has(dep.from)) problems.push(`dependency references unknown block "${dep.from}"`);
    if (!ids.has(dep.to)) problems.push(`dependency references unknown block "${dep.to}"`);
  }
  return problems;
}

function worktreeRuleProblems(rules: WorktreeRules | undefined): string[] {
  if (rules === undefined) return [];
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) return ["agent.worktree must be an object"];
  const problems: string[] = [];
  for (const key of ["branch", "base", "path", "name", "script", "removeScript"] as const) {
    const value = rules[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) problems.push(`agent.worktree.${key} must be a non-empty string`);
  }
  for (const key of ["copy", "link", "setup", "scriptArgs", "removeArgs"] as const) {
    const value = rules[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))) problems.push(`agent.worktree.${key} must be a list of strings`);
  }
  for (const key of ["copy", "link"] as const) {
    for (const entry of Array.isArray(rules[key]) ? rules[key]! : []) {
      if (typeof entry === "string" && (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes(".."))) problems.push(`agent.worktree.${key} "${entry}" must be a path inside the project`);
    }
  }
  if (rules.setupTimeoutSeconds !== undefined && !(Number.isFinite(rules.setupTimeoutSeconds) && rules.setupTimeoutSeconds > 0)) problems.push("agent.worktree.setupTimeoutSeconds must be a positive number");
  return problems;
}

export function toBlockId(relativeDir: string): string {
  return relativeDir.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
}

/** Longest-prefix match of a repo-relative file path against block include paths. */
export function blockForFile(blocks: Block[], relativeFile: string): Block | undefined {
  let best: Block | undefined;
  let bestLength = -1;
  for (const block of blocks) {
    for (const prefix of block.include) {
      const normalized = prefix.replace(/\/+$/, "");
      const matches = normalized === "" || normalized === "." || relativeFile === normalized || relativeFile.startsWith(normalized + "/");
      const length = normalized === "." ? 0 : normalized.length;
      if (matches && length > bestLength) {
        best = block;
        bestLength = length;
      }
    }
  }
  return best;
}

/**
 * `blockForFile` for many files against blocks that no longer change: the prefixes are read once and a file is looked up folder by
 * folder, longest first, instead of asking every block. Same answer, including which block wins a tie (the first).
 */
export function blockResolver(blocks: Block[]): (relativeFile: string) => Block | undefined {
  const byPrefix = new Map<string, Block>();
  let wholeProject: Block | undefined;
  for (const block of blocks) {
    for (const prefix of block.include) {
      const normalized = prefix.replace(/\/+$/, "");
      if (normalized === "" || normalized === ".") wholeProject ??= block;
      else if (!byPrefix.has(normalized)) byPrefix.set(normalized, block);
    }
  }
  return (relativeFile) => {
    for (let path = relativeFile; path !== ""; ) {
      const found = byPrefix.get(path);
      if (found) return found;
      const slash = path.lastIndexOf("/");
      path = slash === -1 ? "" : path.slice(0, slash);
    }
    return wholeProject;
  };
}

/** Adds or replaces a group. Unknown block ids are rejected: a saved group must point at real blocks. */
export function saveGroup(model: ArchModel, group: Group): ArchModel {
  const known = new Set(model.blocks.map((block) => block.id));
  const unknown = group.blocks.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown block(s) ${unknown.map((id) => `"${id}"`).join(", ")}. Known blocks: ${[...known].join(", ")}`);
  const next: ArchModel = { ...model, groups: [...(model.groups ?? []).filter((existing) => existing.id !== group.id), { ...group, blocks: [...new Set(group.blocks)] }] };
  const problems = validateModel(next);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return next;
}

export function deleteGroup(model: ArchModel, id: string): ArchModel {
  if (!(model.groups ?? []).some((group) => group.id === id)) throw new Error(`No group "${id}".`);
  const docs = model.docs?.flatMap((doc) => {
    if (!doc.groups?.includes(id)) return [doc];
    const groups = doc.groups.filter((group) => group !== id);
    const next: DocRef = { ...doc, ...(groups.length ? { groups } : {}) };
    if (!groups.length) delete next.groups;
    return next.blocks?.length || next.groups?.length || next.common ? [next] : [];
  });
  return { ...model, groups: (model.groups ?? []).filter((group) => group.id !== id), ...(docs ? { docs } : {}) };
}

/** Why a document path is not acceptable, or undefined. Paths are repo-relative and stay inside the repo. */
export function docPathProblem(docPath: string | undefined): string | undefined {
  if (!docPath) return "missing path";
  if (path.isAbsolute(docPath) || /^[a-zA-Z]:/.test(docPath)) return "use a path relative to the project root";
  const normalized = path.posix.normalize(docPath.split(path.sep).join("/"));
  if (normalized.startsWith("../") || normalized === "..") return "must stay inside the project";
  if (normalized !== docPath) return `write it as "${normalized}"`;
  return undefined;
}

export function normalizeDocPath(docPath: string): string {
  return path.posix.normalize(docPath.trim().split("\\").join("/")).replace(/^\.\//, "");
}

/**
 * Assigns a document: to more blocks or groups (added to its current ones), or as common.
 * Unknown block or group ids are rejected. `description` and `common` replace the current values when given.
 */
export function assignDoc(model: ArchModel, doc: DocRef): ArchModel {
  const docPath = normalizeDocPath(doc.path);
  const problem = docPathProblem(docPath);
  if (problem) throw new Error(`Document "${doc.path}": ${problem}.`);
  const blocks = new Set(model.blocks.map((block) => block.id));
  const groups = new Set((model.groups ?? []).map((group) => group.id));
  const unknownBlocks = (doc.blocks ?? []).filter((id) => !blocks.has(id));
  if (unknownBlocks.length) throw new Error(`Unknown block(s) ${unknownBlocks.map((id) => `"${id}"`).join(", ")}. Known blocks: ${[...blocks].join(", ")}`);
  const unknownGroups = (doc.groups ?? []).filter((id) => !groups.has(id));
  if (unknownGroups.length) throw new Error(`Unknown group(s) ${unknownGroups.map((id) => `"${id}"`).join(", ")}. Saved groups: ${[...groups].join(", ") || "none"}`);
  const current = (model.docs ?? []).find((existing) => existing.path === docPath);
  const merged: DocRef = { path: docPath };
  const mergedBlocks = [...new Set([...(current?.blocks ?? []), ...(doc.blocks ?? [])])];
  const mergedGroups = [...new Set([...(current?.groups ?? []), ...(doc.groups ?? [])])];
  if (mergedBlocks.length) merged.blocks = mergedBlocks;
  if (mergedGroups.length) merged.groups = mergedGroups;
  const common = doc.common ?? current?.common;
  if (common) merged.common = true;
  const description = doc.description ?? current?.description;
  if (description) merged.description = description;
  if (!merged.blocks && !merged.groups && !merged.common) throw new Error(`Assign "${docPath}" to at least one block or group, or mark it common.`);
  const docs = current ? (model.docs ?? []).map((existing) => (existing.path === docPath ? merged : existing)) : [...(model.docs ?? []), merged];
  return { ...model, docs };
}

/**
 * Takes a document away from blocks or groups, or clears its common flag. With no target at all
 * the document leaves the map (the file itself is not touched). A document left with no target is removed.
 */
export function unassignDoc(model: ArchModel, docPath: string, targets: { blocks?: string[]; groups?: string[]; common?: boolean } = {}): ArchModel {
  const normalized = normalizeDocPath(docPath);
  const current = (model.docs ?? []).find((existing) => existing.path === normalized);
  if (!current) throw new Error(`No document "${normalized}" in the map.`);
  const everything = !targets.blocks?.length && !targets.groups?.length && !targets.common;
  const next: DocRef = { path: normalized };
  if (!everything) {
    const blocks = (current.blocks ?? []).filter((id) => !(targets.blocks ?? []).includes(id));
    const groups = (current.groups ?? []).filter((id) => !(targets.groups ?? []).includes(id));
    if (blocks.length) next.blocks = blocks;
    if (groups.length) next.groups = groups;
    if (current.common && !targets.common) next.common = true;
    if (current.description) next.description = current.description;
  }
  const keep = !everything && (next.blocks || next.groups || next.common);
  return { ...model, docs: (model.docs ?? []).flatMap((existing) => (existing.path !== normalized ? [existing] : keep ? [next] : [])) };
}

/**
 * Documents for a working scope: the common ones, then those assigned to its blocks or to the
 * saved group it is (a document assigned to both appears once, among the common ones).
 */
export function docsForScope(model: ArchModel | undefined, scope: { id: string; blocks: string[] }): { common: DocRef[]; assigned: DocRef[] } {
  const docs = model?.docs ?? [];
  const common = docs.filter((doc) => doc.common);
  const assigned = docs.filter((doc) => !doc.common && ((doc.blocks ?? []).some((id) => scope.blocks.includes(id)) || (doc.groups ?? []).includes(scope.id)));
  return { common, assigned };
}
