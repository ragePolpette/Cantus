import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadModel } from "../model/index.js";
import { CANTUS_IGNORE } from "../model/ignore.js";

export interface GateProof { version: 1; commit?: string; content: string; configuration: string; at: string; dirty: string[] }

/** Include untracked bytes as well as tracked/index changes; never use size-only hashes. */
export function gateProof(root: string, command: string, policyRoot = root): GateProof {
  const git = (...args: string[]) => execFileSync("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  const hash = createHash("sha256");
  let commit: string | undefined;
  let dirty: string[] = [];
  try {
    commit = git("rev-parse", "HEAD").trim();
    dirty = git("status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z").split("\0").filter(Boolean).filter(entry => {
      const file = entry.slice(3);
      if (!entry.startsWith("?? ")) return true;
      if (/^\.cantus\/(cache|runs|worktrees)\//.test(file) || /^\.cantus\/[^/]+\.(log|html)$/.test(file)) return false;
      return file !== ".cantus/.gitignore" || fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n") !== CANTUS_IGNORE;
    });
    hash.update(commit).update(git("diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--", "."));
    for (const file of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort()) {
      if (/^\.cantus\/(cache|runs|worktrees)\//.test(file) || /^\.cantus\/[^/]+\.(log|html)$/.test(file)) continue;
      const absolute = path.join(root, file);
      const stat = fs.lstatSync(absolute);
      const data = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
      if (file === ".cantus/.gitignore" && data.toString().replace(/\r\n/g, "\n") === CANTUS_IGNORE) continue;
      hash.update(file).update("\0").update(data).update("\0");
    }
  } catch (error) {
    // An in-place task may be outside Git. Worktree/integration callers require commit.
    if (commit) throw error;
    hash.update("not-a-git-repository");
  }
  const configuration = createHash("sha256").update(command);
  const inputs = [...new Set(loadModel(policyRoot)?.agent?.gateInputs ?? [])].sort();
  if (inputs.length) {
    configuration.update("\0").update(JSON.stringify(inputs));
    const project = fs.realpathSync(root);
    for (const file of inputs) {
      let absolute: string;
      try {
        absolute = fs.realpathSync(path.join(project, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update(JSON.stringify([file, null]));
        continue;
      }
      const relative = path.relative(project, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(absolute).isFile()) {
        throw new Error(`Gate input must be a file inside the project: ${file}`);
      }
      const digest = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
      hash.update(JSON.stringify([file, digest]));
    }
  }
  return { version: 1, ...(commit ? { commit } : {}), content: hash.digest("hex"), configuration: configuration.digest("hex"), at: new Date().toISOString(), dirty };
}

export function sameProof(a: GateProof | undefined, b: GateProof): boolean {
  return !!a && a.version === b.version && a.commit === b.commit && a.content === b.content && a.configuration === b.configuration;
}
