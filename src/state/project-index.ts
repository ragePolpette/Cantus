import fs from "node:fs";
import path from "node:path";
import type { Analysis, CallSite, CoChange } from "../analysis/analyze.js";
import type { ApiKind } from "../analysis/catalog.js";
import type { ArchModel, Block, Group } from "../model/index.js";
import { ensureCantusIgnore } from "../model/ignore.js";

export const INDEX_FILE = ".cantus/cache/index.json";
/** The strongest pairs are enough for the hooks; the index stays small. */
const MAX_CO_CHANGES = 2000;

/** What hooks need, small enough to read on every edit without analyzing the project again. */
export interface ProjectIndex {
  version: 1;
  generatedAt: string;
  blocks: Block[];
  /** Blocks inferred from folders (no map saved): a block says little about who may know a file, so same-block callers count. Absent in older indexes. */
  inferred?: boolean;
  groups: Group[];
  exports: Array<{ block: string; file: string; name: string; kind: ApiKind; shape: string }>;
  /** Uses of one file's exports from another file. */
  callSites: CallSite[];
  /** Files that usually change in the same commits (absent in indexes written before it existed). */
  coChanges?: CoChange[];
}

export function writeProjectIndex(root: string, analysis: Analysis, model?: ArchModel): void {
  const index: ProjectIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    blocks: analysis.blocks.map((info) => info.block),
    ...(analysis.blocksInferred ? { inferred: true } : {}),
    groups: model?.groups ?? [],
    exports: analysis.catalog.map(({ block, file, name, kind, shape }) => ({ block, file, name, kind, shape })),
    callSites: analysis.callSites,
    coChanges: analysis.coChanges.slice(0, MAX_CO_CHANGES),
  };
  const file = path.join(root, INDEX_FILE);
  ensureCantusIgnore(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index));
}

export function readProjectIndex(root: string): ProjectIndex | undefined {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(root, INDEX_FILE), "utf8")) as ProjectIndex;
    return index.version === 1 ? index : undefined;
  } catch {
    return undefined;
  }
}
