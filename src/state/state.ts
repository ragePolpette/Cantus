import { createHash } from "node:crypto";
import { gitPosition } from "./changes.js";
import fs from "node:fs";
import path from "node:path";
import { fileStamp } from "../analysis/file-stamp.js";
import { configurationFingerprint } from "../analysis/config-fingerprint.js";
import { analyze, createSourceScanner, normalizeInclude, SCANNED_EXTENSIONS, type Analysis } from "../analysis/analyze.js";
import { check, type Finding } from "../analysis/rules.js";
import { SUGGESTIONS_FILE } from "../analysis/suggestions.js";
import { writeAnalysisLog } from "../analysis/diagnostics.js";
import { SOURCE_EXTENSIONS } from "../analysis/resolve.js";
import { EDIT_LEDGER_FILE, EditLedger } from "./edit-ledger.js";
import { ActiveAgents } from "./active-agents.js";
import { REQUESTS_FILE, RequestQueue } from "./requests.js";
import { writeProjectIndex } from "./project-index.js";
import { type ArchModel, loadModel, modelPath } from "../model/index.js";

export interface ProjectSnapshot {
  model?: ArchModel;
  analysis: Analysis;
  findings: Finding[];
  /** When this analysis ran (ISO time). */
  analyzedAt: string;
  fingerprint?: string;
  position?: ReturnType<typeof gitPosition>;
}

/** Non-JavaScript analysis inputs outside build output, including .NET project references. */
const OTHER_WATCHED = SCANNED_EXTENSIONS.filter(extension => !SOURCE_EXTENSIONS.includes(extension));

/**
 * The project as seen by long-running processes (MCP server, map server): analyzed once, then
 * again only when a source file or the map changes.
 */
export class ProjectState {
  private cached?: { fingerprint: string; snapshot: ProjectSnapshot };
  /** Lines agents wrote and not committed yet; kept in `.cantus/cache` for the next session. */
  readonly edits: EditLedger;
  /** What the user wrote on the map for the open session, as long as this process runs. */
  readonly requests: RequestQueue;
  /** The specialists of the open session working right now, as long as this process runs. */
  readonly agents: ActiveAgents = new ActiveAgents();

  constructor(readonly root: string) {
    this.edits = new EditLedger(path.join(root, EDIT_LEDGER_FILE));
    this.requests = new RequestQueue(path.join(root, REQUESTS_FILE));
  }

  get(): ProjectSnapshot {
    const position = gitPosition(this.root);
    const fingerprint = this.fingerprint(position?.commit);
    if (this.cached?.fingerprint === fingerprint) return this.cached.snapshot;
    const model = loadModel(this.root);
    const analysis = analyze(this.root, { model });
    if (this.fingerprint(gitPosition(this.root)?.commit) !== fingerprint) throw new Error("Project changed during analysis; retry to obtain a consistent snapshot.");
    writeAnalysisLog(this.root, analysis);
    writeProjectIndex(this.root, analysis, model);
    const snapshot = { model, analysis, findings: check(analysis, model), analyzedAt: new Date().toISOString(), fingerprint, position };
    this.cached = { fingerprint, snapshot };
    return snapshot;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** Changes whenever a source file (any language, pages) or the map changes. Cheap enough to poll. */
  fingerprint(commit?: string): string {
    const model = loadModelQuietly(this.root);
    const exclude = model?.analysis?.exclude ?? [];
    const include = normalizeInclude(model?.analysis?.include);
    const scan = createSourceScanner(this.root, exclude, () => {}, include);
    const files = [...scan(SOURCE_EXTENSIONS), ...scan(OTHER_WATCHED, ["bin", "obj"])];
    const parts = files.map((file) => `${file}:${stampAt(path.join(this.root, file))}`);
    // Folders outside the map the user allowed reading change the analysis too.
    for (const [folder, access] of Object.entries(model?.analysis?.externalRoots ?? {})) {
      if (access !== "allow") continue;
      const absolute = path.resolve(this.root, folder);
      const externalScan = createSourceScanner(absolute, []);
      const externalFiles = [...externalScan(SOURCE_EXTENSIONS), ...externalScan(OTHER_WATCHED, ["bin", "obj"])];
      for (const file of externalFiles) parts.push(`ext:${folder}/${file}:${stampAt(path.join(absolute, file))}`);
    }
    parts.push(`model:${stampAt(modelPath(this.root))}`, `suggestions:${stampAt(path.join(this.root, SUGGESTIONS_FILE))}`);
    if (commit) parts.push(`head:${commit}`);
    parts.push(`configuration:${configurationFingerprint(this.root)}`);
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }
}

function stampAt(file: string): string {
  try {
    return fileStamp(fs.statSync(file));
  } catch {
    return "missing";
  }
}

function loadModelQuietly(root: string): ArchModel | undefined {
  try {
    return loadModel(root);
  } catch {
    return undefined;
  }
}
