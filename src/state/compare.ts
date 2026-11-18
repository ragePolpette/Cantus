import fs from "node:fs";
import path from "node:path";
import { analyze } from "../analysis/analyze.js";
import { type DeltaSide, type MapDelta, compareAnalyses } from "../analysis/delta.js";
import { check } from "../analysis/rules.js";
import { type ArchModel, loadModel } from "../model/index.js";
import { defaultBase, mergeBase, resolveRef, withCommit } from "./refs.js";

export interface CompareOptions {
  /** A branch, tag or commit to compare from. Default: origin's default branch (main, master). */
  base?: string;
  /** A branch, tag or commit to compare to. Default: the working tree, uncommitted work included. */
  head?: string;
}

function sideOf(dir: string, label: string, fallbackModel?: ArchModel): DeltaSide {
  // A map that is not committed yet on one side still describes both: blocks are then the same on each.
  const model = loadModel(dir) ?? fallbackModel;
  // Declarations are compared by the shape oxc derives from the source, so no compiler is needed.
  const analysis = analyze(dir, { model, skipGit: true, compilerFallback: "none" });
  return {
    analysis,
    findings: check(analysis, model),
    label,
    read: (file) => {
      try {
        return fs.readFileSync(path.join(dir, file), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * What the map says differs between a base (where the head branched off it) and a head, as pull
 * request reviewers want it. Each state is read from git into a temporary folder, so the working
 * tree is never switched; with no head, the project as it is now is the head.
 */
export function compareProject(root: string, options: CompareOptions = {}): MapDelta {
  const baseName = options.base ?? defaultBase(root);
  if (!baseName) throw new Error("No branch to compare with: pass one, e.g. `cantus diff main`.");
  const headCommit = options.head ? resolveRef(root, options.head) : undefined;
  const baseCommit = mergeBase(root, resolveRef(root, baseName), headCommit ?? "HEAD");
  const baseLabel = `${baseName}@${baseCommit.slice(0, 7)}`;
  const headLabel = options.head ? `${options.head}@${headCommit!.slice(0, 7)}` : "working tree";

  const compare = (headDir: string) => {
    const head = sideOf(headDir, headLabel);
    return withCommit(root, baseCommit, (baseDir) => compareAnalyses(sideOf(baseDir, baseLabel, head.analysis.blocksInferred ? undefined : loadModel(headDir)), head));
  };
  return headCommit ? withCommit(root, headCommit, compare) : compare(root);
}
