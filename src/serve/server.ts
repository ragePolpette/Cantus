import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildScopePack, resolveScope } from "../context/index.js";
import { readProjectMaps, removeServeInfo, writeServeInfo } from "../state/serve-info.js";
import { readPeers, removePeer, touchPeer, writePeer } from "../state/peers.js";
import { ProjectState, type ProjectSnapshot } from "../state/state.js";
import { readWorktree } from "../state/checkout.js";
import { readProjectIndex } from "../state/project-index.js";
import { editAuthor, recordEdit } from "../state/edit-ledger.js";
import { fileDiff, gitSignature, readChanges, settleEdits } from "../state/changes.js";
import { readUsage, summarizeUsage } from "../state/usage.js";
import { type ArchModel, type WorktreeRules, deleteGroup, docPathProblem, loadModel, normalizeDocPath, saveGroup, saveModel, unassignDoc, validateModel } from "../model/index.js";
import { listFolders, pickFolderNative, resolveBase } from "../run/worktree-rules.js";
import { execFileSync } from "node:child_process";
import { addDoc, docSummaries, listMarkdownFiles } from "../map/docs.js";
import { updateMap } from "../map/update.js";
import { type MapDraft, MapDraftSchema, applyDraft } from "../map/draft.js";
import { requestDraft } from "../run/draft.js";
import { addBlock, addDependency, removeBlock, removeDependency, setLayers, updateBlock } from "../model/edit.js";
import { type ViewData, buildViewData, lightView, panelDataOf, renderViewHtml } from "../outputs/view.js";
import { refreshClaudeAgents } from "../outputs/claude-agents.js";
import { claudeCodeRunner } from "../run/sdk-runner.js";
import { builtInRunner } from "../run/runners.js";
import { TaskManager, type ApprovalDecision, type Runner, type TaskRecord, type TaskSpec } from "../run/tasks.js";
import { PlanStore } from "../run/plans.js";
import { openTerminal, planTerminal, terminalApps } from "../run/terminal-launcher.js";
import { type TerminalApp, personalConfigPath, readPersonalConfig, writeTerminalApp } from "../state/personal-config.js";
import { renderReviewForSession, reviewHeadline, snapshotBase, worthSending } from "../run/verify.js";
import { worktreeVerifyContext } from "../run/worktree-report.js";
import { type RequestScope, renderRequests } from "../state/requests.js";

export interface MapServerOptions {
  /** First port to try; the next free one is used. 0 picks any free port. */
  port?: number;
  /** How often to check for code changes while a page is open, in ms. */
  pollInterval?: number;
  /** Runs the tasks started from the map. Default: the map's `agent.runner`, else Claude Code through the Agent SDK. */
  runner?: Runner;
  /**
   * A Claude Code session is attached (the server was started by its MCP server): requests written
   * on the map can go to that session. Without it, the work for a lead has nowhere to go.
   */
  session?: boolean;
  /**
   * Analyze the project right after the server is up, instead of on the first request. On a big project the first analysis
   * takes seconds to minutes and stops everything in this process; done early, the page and the tools find it ready. Default: true.
   */
  warm?: boolean;
}

export interface MapServer {
  url: string;
  port: number;
  /** Token the map's API requests must carry in `x-cantus-token`. */
  token: string;
  tasks: TaskManager;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4321;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Serves the live map on 127.0.0.1. Pages reload when the code or the map changes; requests that
 * change the map need the per-process token embedded in the page, and every request must address
 * a local host name (protection against DNS rebinding).
 */
export async function startMapServer(state: ProjectState, options: MapServerOptions = {}): Promise<MapServer> {
  const token = randomBytes(16).toString("hex");
  let ownUrl = "";
  const clients = new Set<http.ServerResponse>();
  let lastFingerprint = "";
  let timer: NodeJS.Timeout | undefined;
  // Chosen when a task starts: reading the map's setting here would analyze the project before the server is up.
  const runner: Runner = options.runner ?? ((...args) => (builtInRunner(state.get().model?.agent?.runner) ?? claudeCodeRunner)(...args));
  const tasks = new TaskManager(state, runner, {
    onUpdate: (task) => {
      const data = JSON.stringify(task);
      for (const client of clients) client.write(`event: task\ndata: ${data}\n\n`);
    },
  });

  const unsubscribe = state.requests.subscribe((request) => {
    const data = JSON.stringify(request);
    for (const client of clients) client.write(`event: request\ndata: ${data}\n\n`);
  });

  const unsubscribeSeen = state.requests.subscribeSeen((at, via) => {
    for (const client of clients) client.write(`event: seen\ndata: ${JSON.stringify({ at, ...(via ? { via } : {}) })}\n\n`);
  });

  const unsubscribeAgents = state.agents.subscribe((agents) => {
    const data = JSON.stringify(agents);
    for (const client of clients) client.write(`event: agents\ndata: ${data}\n\n`);
  });
  const stopSweeping = state.agents.watch();

  /** The blocks a `block-<id>` or `group-<id>` specialist works on; none for any other agent. */
  const agentBlocks = (type: string): string[] => {
    // Hook notifications can arrive before anyone has opened the browser or requested analysis.
    const map = loadModel(state.root) ?? readProjectIndex(state.root);
    const block = /^block-(.+)$/.exec(type)?.[1];
    if (block) return map?.blocks.some((candidate) => candidate.id === block) ? [block] : [];
    const group = /^group-(.+)$/.exec(type)?.[1];
    return group ? map?.groups?.find((candidate) => candidate.id === group)?.blocks ?? [] : [];
  };

  /** The analysis and the page's data for the code as it is now, made once the event has gone out. A failure shows again on the first request. */
  const warmSoon = () => {
    setImmediate(() => {
      try {
        currentView();
      } catch {
        // the request that needs it reports it
      }
    });
  };

  /** How long the last look at the files took: on a big project it is seconds, and it blocks everything else in this process. */
  let lastPoll = 0;
  const poll = () => {
    const started = Date.now();
    try {
      // A commit changes no source file but resets the change counts: watch git too.
      const fingerprint = `${state.fingerprint()}|${gitSignature(state.root)}`;
      if (lastFingerprint && fingerprint !== lastFingerprint) {
        for (const client of clients) client.write(`event: changed\ndata: {}\n\n`);
        // The page asks for the new analysis as soon as it reloads: done now, while it waits for the person to be at rest.
        warmSoon();
      }
      lastFingerprint = fingerprint;
    } catch {
      // a transient read error while files are being written; the next poll retries
    }
    lastPoll = Date.now() - started;
  };
  // The next look comes at least three times as long after the last one as it took, so watching never takes more than a quarter of the time.
  const schedule = () => {
    timer = setTimeout(() => {
      poll();
      if (timer) schedule();
    }, Math.max(options.pollInterval ?? 800, lastPoll * 3));
  };
  const watch = () => {
    if (timer || clients.size === 0) return;
    const started = Date.now();
    lastFingerprint = `${state.fingerprint()}|${gitSignature(state.root)}`;
    lastPoll = Date.now() - started;
    schedule();
  };
  const unwatch = () => {
    if (timer && clients.size === 0) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * The page's data. Building it takes about a second on a big project and every reload asks for it (a map edit, the
   * edit toggle, a tab): it is kept while the analysis and everything else it shows are the same.
   */
  let viewCache: { snapshot: ProjectSnapshot; key: string; data: ViewData } | undefined;
  const currentView = (): ViewData => {
    const snapshot = state.get();
    settleEdits(state.root, state.edits);
    const changes = readChanges(state.root);
    const key = JSON.stringify([changes, Object.keys(changes.files).map((file) => state.edits.agentsOf(file)), docSummaries(state.root, snapshot.model), readWorktree(state.root) ?? null]);
    if (viewCache?.snapshot !== snapshot || viewCache.key !== key) {
      viewCache = { snapshot, key, data: buildViewData(snapshot.analysis, snapshot.model, snapshot.findings, changes, (file) => state.edits.agentsOf(file)) };
    }
    return { ...viewCache.data, generatedAt: new Date().toISOString() };
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(host)) return send(res, 403, { error: "The map is served to localhost only." });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      const view = lightView(currentView());
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderViewHtml(view, { live: { token, ...(options.session ? { session: true } : {}), root: state.root } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      // The page names its icon; this is for tools that ask for the default anyway. Nothing to give, and not an error.
      res.writeHead(204, { "cache-control": "max-age=86400" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      watch();
      req.on("close", () => {
        clients.delete(res);
        unwatch();
      });
      return;
    }

    if (req.headers["x-cantus-token"] !== token) return send(res, 403, { error: "Missing or wrong token: reload the map." });

    if (req.method === "GET" && url.pathname === "/api/view") {
      return send(res, 200, currentView());
    }
    if (req.method === "GET" && url.pathname === "/api/panel") {
      const block = url.searchParams.get("block") ?? "";
      const view = currentView();
      if (!view.blocks.some((candidate) => candidate.id === block)) return send(res, 404, { error: `No block "${block}".` });
      return send(res, 200, panelDataOf(view, block));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const days = Number(url.searchParams.get("days") ?? 30);
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined;
      return send(res, 200, summarizeUsage(state.root, readUsage(state.root, since), state.get().analysis.blocks.map((info) => info.block), since));
    }
    if (req.method === "GET" && url.pathname === "/api/scope") {
      const { analysis, model, findings } = state.get();
      const blocks = (url.searchParams.get("blocks") ?? "").split(",").filter(Boolean);
      const { scope } = resolveScope(analysis, model, { blocks });
      const pack = buildScopePack(analysis, scope, model, findings);
      return send(res, 200, {
        contextTokens: pack.ownedTokens + pack.contractTokens + pack.docTokens,
        neighbors: pack.neighbors.map((neighbor) => neighbor.block.id),
        callers: pack.callers.length,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/groups") {
      const body = (await readJson(req)) as { id?: string; name?: string; blocks?: string[]; description?: string };
      const { model } = state.get();
      if (!model) return send(res, 409, { error: "No map saved yet: run `cantus analyze --write` first." });
      if (!body.id || !Array.isArray(body.blocks)) return send(res, 400, { error: "A group needs an id and blocks." });
      try {
        saveModel(state.root, saveGroup(model, { id: body.id, name: body.name || body.id, blocks: body.blocks, ...(body.description ? { description: body.description } : {}) }));
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      state.invalidate();
      return send(res, 200, { ok: true });
    }
    const groupMatch = /^\/api\/groups\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && groupMatch) {
      const { model } = state.get();
      if (!model) return send(res, 409, { error: "No map saved yet." });
      try {
        saveModel(state.root, deleteGroup(model, decodeURIComponent(groupMatch[1])));
      } catch (error) {
        return send(res, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      state.invalidate();
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/file-diff") {
      // Only files the map knows (analyzed, or changed since the last commit): no reading elsewhere.
      const file = normalizeDocPath(url.searchParams.get("path") ?? "");
      const { analysis } = state.get();
      const known = analysis.blocks.some((info) => info.files.includes(file)) || file in readChanges(state.root).files;
      if (docPathProblem(file) || !known) return send(res, 404, { error: `${file} is not a file of the map.` });
      return send(res, 200, fileDiff(state.root, file, state.edits));
    }
    if (req.method === "POST" && url.pathname === "/api/edits") {
      // From the hooks, right before and right after an agent's edit: the file is read here, now.
      const body = (await readJson(req)) as { phase?: string; path?: string; key?: string; agent?: string; agentId?: string; task?: string };
      const file = normalizeDocPath(body.path ?? "");
      if ((body.phase !== "before" && body.phase !== "after") || !body.key || docPathProblem(file) || file.startsWith(".git/")) return send(res, 400, { error: "An edit needs a phase, a key and a project file." });
      recordEdit(state.edits, state.root, body.phase, file, body.key, editAuthor(body.agent, body.task));
      const blocks = body.agent && body.phase === "after" ? agentBlocks(body.agent) : [];
      if (body.agent && blocks.length) state.agents.touch(body.agentId, body.agent, blocks, file);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/agents" && req.method === "GET") return send(res, 200, state.agents.list());
    if (url.pathname === "/api/agents" && req.method === "POST") {
      // From the hooks, when a specialist of the open session starts or stops.
      const body = (await readJson(req)) as { phase?: string; id?: string; type?: string };
      if ((body.phase !== "start" && body.phase !== "stop") || !body.id || !body.type) return send(res, 400, { error: "An agent event needs a phase, an id and a type." });
      if (body.phase === "stop") state.agents.stop(body.id, body.type);
      else {
        const blocks = agentBlocks(body.type);
        if (blocks.length) state.agents.start(body.id, body.type, blocks);
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/map/worktree-rules") return handleWorktreeRules(req, res);
    if (url.pathname === "/api/folders/pick" && req.method === "POST") {
      // The map is served on this machine: the system's own folder dialog can open here. Without a screen it answers `unavailable` and the page lists the folders itself.
      try {
        const body = (await readJson(req)) as { path?: unknown };
        const start = listFolders(state.root, typeof body.path === "string" && body.path.trim() ? body.path : undefined).path;
        const picked = await pickFolderNative(start);
        return send(res, 200, "path" in picked ? { ...picked, ...listFolders(state.root, picked.path) } : picked);
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/folders" && req.method === "GET") {
      // The browser gives a page no folder paths: the folder picker of the worktree rules asks this server, which lists folders only (never files).
      try {
        return send(res, 200, listFolders(state.root, url.searchParams.get("path") ?? undefined));
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname.startsWith("/api/map/")) return handleMapEdit(req, res, url.pathname);
    if (url.pathname.startsWith("/api/docs") || url.pathname === "/api/markdown-files") return handleDocs(req, res, url);
    // What a worktree's card opens: a terminal in its folder with the line typed, in the app this person chose (kept outside every project).
    if (url.pathname === "/api/personal/terminal" && req.method === "GET") {
      const config = readPersonalConfig();
      return send(res, 200, { app: config.terminal?.app ?? "lines", apps: terminalApps(config), settings: personalConfigPath() });
    }
    if (url.pathname === "/api/personal/terminal" && req.method === "PUT") {
      try {
        const body = (await readJson(req)) as { app?: unknown };
        writeTerminalApp(String(body.app) as TerminalApp);
        return send(res, 200, { ok: true });
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/worktrees/open" && req.method === "POST") {
      try {
        // Only a checkout of this repository, and the line is Cantus's own: the page sends a folder and nothing to type.
        const asked = String(((await readJson(req)) as { path?: unknown }).path ?? "");
        const real = (folder: string) => { try { return fs.realpathSync.native(folder); } catch { return path.resolve(folder); } };
        const checkout = tasks.trackedWorktrees().checkouts.find((candidate) => candidate.claude && real(candidate.path) === real(asked));
        if (!checkout?.claude) return send(res, 404, { error: "This is not a worktree of the repository that can be taken up." });
        const plan = planTerminal({ folder: checkout.path, command: checkout.claude });
        if (!plan.action && !plan.problem) return send(res, 409, { error: "Choose a terminal first: the lines to copy are not run by Cantus." });
        return send(res, 200, { message: await openTerminal(plan) });
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/worktrees" && req.method === "GET") return send(res, 200, tasks.trackedWorktrees());
    // Plans, to look at: the map shows how they stand and starts, approves and stops nothing (that is the command line).
    if (url.pathname === "/api/plans" && req.method === "GET") {
      try {
        const plans = new PlanStore(state.root).list().map(({ plan, state: planState }) => ({
          id: plan.id,
          goal: plan.goal,
          status: planState.status,
          approved: planState.approvedRevision === plan.revision,
          costUsd: planState.costUsd,
          ...(planState.elapsedMs ? { elapsedMs: planState.elapsedMs } : {}),
          ...(planState.blockedBy ? { blockedBy: planState.blockedBy } : {}),
          tasks: plan.tasks.map((task) => ({ id: task.id, blocks: task.blocks, status: planState.tasks[task.id]?.status ?? "pending" })),
        }));
        return send(res, 200, { plans });
      } catch {
        return send(res, 200, { plans: [] });
      }
    }
    if (url.pathname === "/api/worktrees/cleanup" && req.method === "POST") {
      try {
        return send(res, 200, await tasks.cleanupWorktrees());
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/worktrees" && req.method === "POST") {
      try {
        return send(res, 201, tasks.prepare((await readJson(req)) as TaskSpec));
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/collisions" && req.method === "POST") {
      try {
        return send(res, 200, tasks.collisions((await readJson(req)) as TaskSpec));
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/worktree-preview" && req.method === "POST") {
      try {
        return send(res, 200, tasks.previewWorktree((await readJson(req)) as TaskSpec));
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/worktree-requests" && req.method === "GET") {
      if (url.searchParams.has("local")) {
        return send(res, 200, tasks.list()
          .filter((task) => task.status === "waiting" && task.approvals.some((approval) => approval.tool === "WorktreeSetup"))
          .map((task) => ({ id: task.id, branch: task.worktree!.branch })));
      }
      const peers = readProjectMaps(state.root).filter((peer) => peer.token !== token);
      const requests = await Promise.all(peers.map(async (peer) => {
        try {
          const response = await fetch(new URL("api/worktree-requests?local", peer.url), {
            headers: { "x-cantus-token": peer.token }, redirect: "error", signal: AbortSignal.timeout(1_500),
          });
          if (!response.ok) return [];
          const list = await response.json() as Array<{ id: string; branch: string }>;
          return list.map((request) => ({ ...request, url: `${peer.url}#task=${encodeURIComponent(request.id)}` }));
        } catch {
          return []; // The other map can close between discovery and the request.
        }
      }));
      return send(res, 200, requests.flat());
    }
    // Work for the lead of another worktree: the request goes to the map of the session open there, which checks it and queues it.
    if (url.pathname === "/api/peer-requests" && req.method === "POST") return handlePeerRequest(req, res);
    if (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/")) return handleTask(req, res, url.pathname);
    if (url.pathname === "/api/verify" && req.method === "POST") return handleVerify(req, res);
    if (url.pathname === "/api/requests" || url.pathname.startsWith("/api/requests/")) return handleRequests(req, res, url.pathname);
    send(res, 404, { error: "Not found." });
  }

  /**
   * Editing the map by hand: layers, blocks and arrows. A project without a map gets one from its
   * code first (as \`cantus analyze --write\`); an empty project gets an empty one.
   */
  async function handleMapEdit(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const { analysis, model: saved } = state.get();
    const model = saved ?? updateMap(state.root, analysis).model;
    const hasCode = (id: string) => (analysis.blocks.find((info) => info.block.id === id)?.files.length ?? 0) > 0;
    const body = req.method === "POST" || req.method === "PUT" || req.method === "DELETE" ? ((await readJson(req)) as Record<string, unknown>) : {};
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
    if (req.method === "POST" && pathname === "/api/map/draft") {
      // An agent sketches the map from a description; nothing is saved until the developer keeps it.
      const description = text("description")?.trim();
      if (!description) return send(res, 400, { error: "Describe the project first." });
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableEnded) abort.abort(); });
      try {
        const agent = saved?.agent;
        const draft = await requestDraft(runner, { cwd: state.root, description, map: model, abort, ...(agent?.model ? { model: agent.model } : {}) });
        return send(res, 200, { draft, ...applyDraft(model, draft) });
      } catch (error) {
        return send(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    let next: ArchModel;
    let id: string | undefined;
    try {
      if (req.method === "POST" && pathname === "/api/map/draft/apply") {
        const parsed = MapDraftSchema.safeParse(body.draft);
        if (!parsed.success) return send(res, 400, { error: "Send the draft to keep." });
        next = applyDraft(model, parsed.data as MapDraft).model;
      } else if (req.method === "PUT" && pathname === "/api/map/layers") {
        if (!Array.isArray(body.layers)) return send(res, 400, { error: "Send the layers, top to bottom." });
        next = setLayers(model, body.layers.map(String), (body.renames ?? {}) as Record<string, string>);
      } else if (req.method === "POST" && pathname === "/api/map/blocks") {
        ({ model: next, id } = addBlock(model, { name: text("name") ?? "", layer: text("layer") ?? "", path: text("path"), description: text("description") }, analysis.blocks.flatMap((info) => info.files)));
      } else if (pathname.startsWith("/api/map/blocks/") && (req.method === "PUT" || req.method === "DELETE")) {
        const target = decodeURIComponent(pathname.slice("/api/map/blocks/".length));
        if (req.method === "DELETE") next = removeBlock(model, target, hasCode(target));
        else ({ model: next, id } = updateBlock(model, target, { name: text("name"), layer: text("layer"), path: text("path"), description: text("description") }, hasCode(target)));
      } else if (pathname === "/api/map/dependencies" && (req.method === "POST" || req.method === "DELETE")) {
        const from = text("from") ?? "";
        const to = text("to") ?? "";
        next = req.method === "POST" ? addDependency(model, from, to) : removeDependency(model, from, to);
      } else {
        return send(res, 404, { error: "Not found." });
      }
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    saveModel(state.root, next);
    state.invalidate();
    return send(res, 200, { ok: true, ...(id ? { id } : {}) });
  }

  /**
   * The map's rules for a new worktree, as the page shows and edits them: where it starts (the project's main branch,
   * named once for the project), branch and folder templates, files copied or linked. Commands (setup, script) are only
   * shown: a command to run never comes from a request.
   */
  async function handleWorktreeRules(req: http.IncomingMessage, res: http.ServerResponse) {
    const describe = () => {
      const rules = state.get().model?.agent?.worktree ?? {};
      let resolved: string | undefined;
      let problem: string | undefined;
      let automatic: string | undefined;
      try { resolved = resolveBase(state.root, rules.base).label; } catch (error) { problem = error instanceof Error ? error.message : String(error); }
      try { automatic = resolveBase(state.root, "default").label; } catch { /* no commit yet */ }
      let branches: string[] = [];
      try { branches = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: state.root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((b) => b.trim()).filter(Boolean); } catch { /* not a repository */ }
      return { rules, ...(resolved ? { resolved } : {}), ...(automatic ? { automatic } : {}), ...(problem ? { problem } : {}), branches };
    };
    try {
      if (req.method === "GET") return send(res, 200, describe());
      if (req.method !== "PUT") return send(res, 404, { error: "Not found." });
      const { model } = state.get();
      if (!model) return send(res, 409, { error: "No map saved yet: run `cantus analyze --write` first." });
      const body = (await readJson(req)) as Record<string, unknown>;
      const next: WorktreeRules = { ...(model.agent?.worktree ?? {}) };
      for (const key of ["base", "branch", "path", "name"] as const) {
        if (!(key in body)) continue;
        const value = typeof body[key] === "string" ? (body[key] as string).trim() : "";
        if (value) next[key] = value; else delete next[key];
      }
      for (const key of ["copy", "link"] as const) {
        if (!(key in body)) continue;
        const value = Array.isArray(body[key]) ? (body[key] as unknown[]).map((entry) => String(entry).trim()).filter(Boolean) : [];
        if (value.length) next[key] = value; else delete next[key];
      }
      if (next.base && next.base !== "default") {
        if (next.base.startsWith("-")) throw new Error(`"${next.base}" is not a branch, tag or commit.`);
        resolveBase(state.root, next.base);
      }
      const agent = { ...(model.agent ?? {}) };
      if (Object.keys(next).length) agent.worktree = next; else delete agent.worktree;
      const updated: ArchModel = { ...model, agent };
      if (!Object.keys(agent).length) delete updated.agent;
      const problems = validateModel(updated);
      if (problems.length) throw new Error(problems.join("; "));
      saveModel(state.root, updated);
      state.invalidate();
      return send(res, 200, describe());
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Documents for agents: assign, create, unassign, read and edit, from the map. Only Markdown files listed in the map are written. */
  async function handleDocs(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const { model } = state.get();
    try {
      if (req.method === "GET" && url.pathname === "/api/markdown-files") return send(res, 200, listMarkdownFiles(state.root, model?.analysis?.exclude ?? []));
      if (!model) return send(res, 409, { error: "No map saved yet: run `cantus analyze --write` first." });
      if (req.method === "POST" && url.pathname === "/api/docs") {
        const result = addDoc(state.root, model, (await readJson(req)) as Parameters<typeof addDoc>[2]);
        saveModel(state.root, result.model);
        state.invalidate();
        return send(res, 200, { path: result.path, created: result.created });
      }
      if (req.method === "POST" && url.pathname === "/api/docs/unassign") {
        const body = (await readJson(req)) as { path: string; blocks?: string[]; groups?: string[]; common?: boolean };
        saveModel(state.root, unassignDoc(model, body.path, body));
        state.invalidate();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/docs/content") {
        const docPath = normalizeDocPath(url.searchParams.get("path") ?? "");
        const problem = docPathProblem(docPath);
        if (problem) return send(res, 400, { error: problem });
        if (!(model.docs ?? []).some((doc) => doc.path === docPath)) return send(res, 404, { error: `${docPath} is not a document of the map.` });
        const file = path.join(state.root, docPath);
        if (req.method === "GET") return send(res, 200, { path: docPath, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", exists: fs.existsSync(file) });
        if (req.method === "PUT") {
          const body = (await readJson(req)) as { text?: string };
          if (typeof body.text !== "string") return send(res, 400, { error: "Send the document's text." });
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, body.text);
          return send(res, 200, { ok: true });
        }
      }
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    send(res, 404, { error: "Not found." });
  }

  /** Work written on the map for the open Claude Code session: queued here, taken by the session's hook or tools. */
  async function handlePeerRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const body = (await readJson(req)) as { map?: string; prompt?: string } & RequestScope;
      // Only a session's map of this repository, from the registry the servers write: never an address the page makes up.
      const peer = readPeers(state.root).find((entry) => entry.session && entry.url === body.map && entry.url !== ownUrl);
      const credentials = peer ? readProjectMaps(peer.root).find((entry) => entry.url === peer.url) : undefined;
      if (!peer || !credentials) return send(res, 409, { error: "No Claude Code session is open in that worktree any more (its map is gone)." });
      const forwarded = {
        prompt: body.prompt ?? "",
        ...(body.block ? { block: body.block } : {}),
        ...(body.group ? { group: body.group } : {}),
        ...(Array.isArray(body.blocks) && body.blocks.length ? { blocks: body.blocks.map(String) } : {}),
        ...(body.orchestrate ? { orchestrate: true } : {}),
      };
      let response: Response;
      try {
        response = await fetch(new URL("api/requests", peer.url), {
          method: "POST", headers: { "x-cantus-token": credentials.token, "content-type": "application/json" }, body: JSON.stringify(forwarded), redirect: "error", signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return send(res, 502, { error: "The map of that worktree did not answer." });
      }
      const answer = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok) return send(res, response.status === 409 ? 409 : 400, { error: answer.error ?? "That worktree's map refused the request." });
      return send(res, 201, { id: answer.id, url: peer.url });
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleRequests(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const [id, action] = pathname.split("/").slice(3).map(decodeURIComponent);
    try {
      if (!id && req.method === "GET") return send(res, 200, { session: !!options.session, seen: state.requests.seen(), seenVia: state.requests.seenVia(), requests: state.requests.list() });
      if (!id && req.method === "POST") {
        if (!options.session) return send(res, 409, { error: "No Claude Code session is attached to this map: start it from the session (the Cantus plugin does), or ask for a new worktree, which gives the lines that open one." });
        const body = (await readJson(req)) as { prompt?: string } & RequestScope;
        const scope: RequestScope = {
          ...(body.block ? { block: body.block } : {}),
          ...(body.group ? { group: body.group } : {}),
          ...(Array.isArray(body.blocks) && body.blocks.length ? { blocks: body.blocks.map(String) } : {}),
          ...(body.orchestrate ? { orchestrate: true } : {}),
        };
        {
          const { analysis, model } = state.get();
          if (!scope.orchestrate && (scope.block || scope.group || scope.blocks)) resolveScope(analysis, model, scope);
          // Blocks just planned on the map get their specialist before the session delegates to it (only in projects that use them).
          refreshClaudeAgents(analysis, model);
        }
        return send(res, 201, state.requests.add(body.prompt ?? "", scope));
      }
      // The session's prompt hook: everything nobody has taken yet, with the text to show the session.
      if (id === "take" && !action && req.method === "POST") {
        const body = (await readJson(req)) as { session?: string; via?: string };
        // A session that asks the person for a permission only says so: it takes no work, and the hook that tells it has no way to show any.
        if (body.via === "permission") {
          state.requests.touch("permission");
          return send(res, 200, { count: 0, text: "" });
        }
        const via = body.via === "tool" || body.via === "stop" ? body.via : "prompt";
        state.requests.touch(via);
        const taken = state.requests.take(typeof body.session === "string" ? body.session : undefined, via);
        // Where the project stood when the session took the work: what a review of it compares with.
        const base = taken.some((request) => !request.review && !request.base) ? snapshotBase(state.root) : undefined;
        if (base) for (const request of taken) if (!request.review && !request.base) request.base = base;
        return send(res, 200, { count: taken.length, text: taken.length ? renderRequests(taken) : "" });
      }
      if (id && action === "resend" && req.method === "POST") return send(res, 200, state.requests.resend(id));
      if (id && !action && req.method === "DELETE") {
        state.requests.withdraw(id);
        return send(res, 200, { ok: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(res, /^No (request|task)/.test(message) ? 404 : 400, { error: message });
    }
    send(res, 404, { error: "Not found." });
  }

  /**
   * A separate agent reviews the work. `request` names the session request whose work it is: the review
   * compares with where the project stood when the session took it, and gets the request as the intent.
   * When it ends with something to say, the findings go to the open session as a request of their own.
   */
  async function handleVerify(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const body = (await readJson(req)) as { task?: string; request?: string; about?: string; base?: string; model?: string; maxTurns?: number; maxBudgetUsd?: number; tests?: false; deliver?: boolean };
      let { about, base } = body;
      let claims: string | undefined;
      let dirtyBefore: string[] | undefined;
      if (body.request) {
        const request = state.requests.get(body.request);
        if (request.review) throw new Error("That request is a review, not work to verify.");
        if (!request.base) throw new Error(`Request ${request.id} was not taken by the session yet: there is no work to verify.`);
        about ??= request.prompt;
        claims = request.reply;
        base ??= request.base.commit;
        dirtyBefore = request.base.dirty;
      }
      // The work of a worktree Cantus made, with nothing said about it: its task, the lead's report and where it started.
      if (!body.request && !body.task && !about && !base) {
        const worktree = worktreeVerifyContext(state.root);
        if (worktree) {
          about = worktree.about;
          claims = worktree.claims;
          base = worktree.base;
        }
      }
      const deliver = body.deliver !== false && !!options.session;
      if (body.task) {
        // The work of a task: in its worktree or since it started, with its prompt and its report.
        const verification = tasks.verifyTask(String(body.task), { ...(body.model ? { model: String(body.model) } : {}), ...(body.tests === false ? { tests: false as const } : {}) });
        if (deliver) tasks.wait(verification.id).then((done) => deliverReview(done), () => undefined);
        return send(res, 201, { ...verification, delivery: deliver ? "session" : body.deliver === false ? "off" : "no-session" });
      }
      const task = tasks.start({
        prompt: "",
        ...(body.model ? { model: String(body.model) } : {}),
        ...(body.maxTurns ? { maxTurns: Number(body.maxTurns) } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: Number(body.maxBudgetUsd) } : {}),
        verify: { ...(about ? { about } : {}), ...(claims ? { claims } : {}), ...(base ? { base } : {}), ...(dirtyBefore ? { dirtyBefore } : {}), ...(body.tests === false ? { tests: false as const } : {}) },
      });
      if (deliver) tasks.wait(task.id).then((done) => deliverReview(done), () => undefined);
      return send(res, 201, { ...task, delivery: deliver ? "session" : body.deliver === false ? "off" : "no-session" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(res, /^No (request|task)/.test(message) ? 404 : 400, { error: message });
    }
  }

  /** The reviewer's findings, for the session that is open: nothing when it found nothing to say. */
  function deliverReview(task: TaskRecord) {
    const verification = task.verification;
    if (task.status !== "done" || !verification?.review || !worthSending(verification)) return;
    state.requests.addReview(reviewHeadline(verification.review), { task: task.id, verdict: verification.review.verdict, findings: verification.review.findings.length, text: renderReviewForSession(verification) });
  }

  async function handleTask(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const parts = pathname.split("/").slice(3).map(decodeURIComponent);
    const [id, action, approvalId] = parts;
    try {
      if (!id) {
        if (req.method === "GET") return send(res, 200, tasks.list());
        if (req.method === "POST") {
          const spec = (await readJson(req)) as TaskSpec;
          // A command to run comes from the map's settings or the command line, never from a request.
          if (spec.verify) spec.verify = { ...spec.verify, tests: spec.verify.tests === false ? false : undefined };
          spec.gate = spec.gate === false ? false : undefined;
          spec.base = undefined;
          spec.check = typeof spec.check === "string" ? spec.check : undefined; // a name from the map's agent.checks, resolved there
          spec.retries = typeof spec.retries === "number" && Number.isInteger(spec.retries) ? spec.retries : undefined;
          if (spec.build) {
            const { analysis, model } = state.get();
            refreshClaudeAgents(analysis, model);
          }
          return send(res, 201, tasks.start(spec));
        }
      } else if (!action && req.method === "GET") {
        return send(res, 200, tasks.get(id));
      } else if (action === "diff" && req.method === "GET") {
        return send(res, 200, { diff: tasks.diff(id) });
      } else if (req.method === "POST") {
        if (action === "approvals" && approvalId) return send(res, 200, tasks.decide(id, approvalId, (await readJson(req)) as ApprovalDecision));
        if (action === "accept-edits") return send(res, 200, await tasks.acceptEdits(id));
        if (action === "attach-worktree") return send(res, 200, tasks.attachPreparedWorktree(id));
        if (action === "cancel-worktree") return send(res, 200, tasks.cancelWorktreeRequest(id));
        if (action === "stop") return send(res, 200, tasks.stop(id));
        if (action === "merge") return send(res, 200, await tasks.merge(id));
        if (action === "discard") return send(res, 200, await tasks.discard(id));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(res, /^No (task|pending approval)/.test(message) ? 404 : 400, { error: message });
    }
    send(res, 404, { error: "Not found." });
  }

  const port = await listen(server, options.port ?? DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}/`;
  ownUrl = url;
  writeServeInfo(state.root, { url, pid: process.pid, token });
  writePeer(state.root, { url, pid: process.pid, session: !!options.session });
  // The session's last sign of life goes into the record the other checkouts' maps read, to tell a lead that works from one that waits.
  const unsubscribePeerSeen = options.session ? state.requests.subscribeSeen((at, via) => touchPeer(state.root, url, at, process.pid, via)) : () => undefined;
  // After the caller has the address back: it can tell the person at once. A failure shows again on the first request.
  const warming = options.warm === false ? undefined : setTimeout(() => {
    try {
      state.get();
    } catch {
      // the request that needs the analysis reports it
    }
  }, 0);

  return {
    url,
    port,
    token,
    tasks,
    close: () =>
      new Promise<void>((resolve) => {
        if (timer) clearTimeout(timer);
        if (warming) clearTimeout(warming);
        unsubscribe();
        unsubscribeSeen();
        unsubscribePeerSeen();
        unsubscribeAgents();
        stopSweeping();
        tasks.stopAll();
        for (const client of clients) client.end();
        removeServeInfo(state.root);
        removePeer(state.root, url);
        server.close(() => resolve());
      }),
  };
}

async function listen(server: http.Server, first: number): Promise<number> {
  for (let port = first, attempts = 0; attempts < 20; port++, attempts++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      return (server.address() as { port: number }).port;
    } catch (error) {
      if ((error as { code?: string }).code !== "EADDRINUSE" || first === 0) throw error;
    }
  }
  throw new Error(`No free port from ${first} to ${first + 19}.`);
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request body too large.");
  }
  return raw ? JSON.parse(raw) : {};
}
