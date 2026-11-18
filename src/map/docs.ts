import fs from "node:fs";
import path from "node:path";
import { writePath } from "../model/write-path.js";
import { isExcluded } from "../analysis/analyze.js";
import { type ArchModel, type DocRef, assignDoc, docPathProblem, normalizeDocPath } from "../model/index.js";

/** Where a new document for a block, a group or everyone goes when no path is given. */
export function defaultDocPath(target: { block?: string; group?: string; common?: boolean }): string {
  if (target.block) return `docs/blocks/${target.block}.md`;
  if (target.group) return `docs/groups/${target.group}.md`;
  return "docs/common.md";
}

/**
 * Creates a document from a short template, unless the file already exists. Returns whether it was created.
 * The template only gives a shape; what goes in it is the team's knowledge, not something read from the code.
 */
export function createDoc(root: string, docPath: string, options: { title: string; forWhom: string }): boolean {
  const normalized = normalizeDocPath(docPath);
  const problem = docPathProblem(normalized);
  if (problem) throw new Error(`Document "${docPath}": ${problem}.`);
  const file = writePath(root, normalized);
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    writePath(root, normalized),
    [
      `# ${options.title}`,
      "",
      `<!-- Notes for ${options.forWhom}. Cantus puts this file in their briefing, next to what it reads from the code: write here what the code does not say. -->`,
      "",
      "## Rules and conventions",
      "",
      "## Decisions (and why)",
      "",
      "## Pitfalls",
      "",
    ].join("\n"),
  );
  return true;
}

/** One line per document: path, size, where it goes. */
export function describeDocs(root: string, model: ArchModel | undefined): string {
  const docs = model?.docs ?? [];
  if (docs.length === 0) return "No documents in the map. Assign one with `cantus doc add <path> --block <id>` (or --group, --common), or create one with `cantus doc new`.";
  return docs.map((doc) => describeDoc(root, doc)).join("\n");
}

export function describeDoc(root: string, doc: DocRef): string {
  const targets = [
    ...(doc.common ? ["common (every agent)"] : []),
    ...(doc.blocks?.length ? [`blocks: ${doc.blocks.join(", ")}`] : []),
    ...(doc.groups?.length ? [`groups: ${doc.groups.join(", ")}`] : []),
  ];
  let size: string;
  try {
    size = `~${Math.ceil(fs.statSync(path.join(root, doc.path)).size / 4)} tokens`;
  } catch {
    size = "file missing";
  }
  return `- \`${doc.path}\` (${size}) — ${targets.join("; ")}${doc.description ? ` — ${doc.description}` : ""}`;
}

export interface AddDocRequest {
  /** Repo-relative path; with `create` and no path, a default under docs/ is used. */
  path?: string;
  blocks?: string[];
  groups?: string[];
  common?: boolean;
  description?: string;
  /** Create the file from a template when it does not exist yet. */
  create?: boolean;
}

/** Assigns a document (creating it first if asked) and returns the updated model. The model is not saved. */
export function addDoc(root: string, model: ArchModel, request: AddDocRequest): { model: ArchModel; path: string; created: boolean } {
  const target = { block: request.blocks?.[0], group: request.groups?.[0], common: request.common };
  if (!request.path && !request.create) throw new Error("Give the document's path, or ask to create it.");
  const docPath = normalizeDocPath(request.path ?? defaultDocPath(target));
  const next = assignDoc(model, { path: docPath, blocks: request.blocks, groups: request.groups, common: request.common, description: request.description });
  let created = false;
  if (request.create) {
    const names = [
      ...(request.blocks ?? []).map((id) => model.blocks.find((block) => block.id === id)?.name ?? id),
      ...(request.groups ?? []).map((id) => model.groups?.find((group) => group.id === id)?.name ?? id),
    ];
    created = createDoc(root, docPath, {
      title: names.length ? `Notes: ${names.join(", ")}` : "Shared notes",
      forWhom: names.length ? `the agents working on ${names.join(", ")}` : "every agent working on this project",
    });
  } else if (!fs.existsSync(path.join(root, docPath))) {
    throw new Error(`${docPath} does not exist. Create it first, or ask to create it from the template.`);
  }
  return { model: next, path: docPath, created };
}

/** Folders of build output and installed packages (npm, NuGet, Bower, Composer, Cargo…): their READMEs and LICENSEs are not team documents. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "target", "bower_components", "bin", "obj"]);

/** A NuGet `packages/` folder (one `Name.Version/` folder with a .nupkg per package), not a monorepo's `packages/`. */
function isNugetPackages(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).slice(0, 20).some((entry) => fs.readdirSync(path.join(dir, entry.name)).some((name) => name.endsWith(".nupkg")));
  } catch {
    return false;
  }
}

/** Where the domain notes live (the lead writes them when it closes a task; a person can write them by hand). */
export const DOMAIN_NOTES_DIR = ".cantus/domain";

/** Markdown files in the project a document can be picked from: generated notes, packages and `analysis.exclude` left out. */
export function listMarkdownFiles(root: string, exclude: string[] = [], limit = 2000): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (isExcluded(path.relative(root, absolute).split(path.sep).join("/"), entry.name, exclude)) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !(entry.name === "packages" && isNugetPackages(absolute))) walk(absolute);
      } else if (entry.isFile() && /\.mdx?$/i.test(entry.name) && entry.name !== "AGENTS.md" && entry.name !== "CLAUDE.md") {
        found.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  // The one folder starting with a dot that is offered: the domain notes a person writes by hand are documents like the others.
  try {
    for (const entry of fs.readdirSync(path.join(root, DOMAIN_NOTES_DIR), { withFileTypes: true })) {
      if (entry.isFile() && /\.mdx?$/i.test(entry.name) && found.length < limit) found.push(`${DOMAIN_NOTES_DIR}/${entry.name}`);
    }
  } catch {
    // no notes yet
  }
  return found.sort();
}

/** The map's documents with their size, for listings and the live map. */
export function docSummaries(root: string, model: ArchModel | undefined): Array<DocRef & { tokens: number; exists: boolean }> {
  return (model?.docs ?? []).map((doc) => {
    try {
      return { ...doc, tokens: Math.ceil(fs.statSync(path.join(root, doc.path)).size / 4), exists: true };
    } catch {
      return { ...doc, tokens: 0, exists: false };
    }
  });
}
