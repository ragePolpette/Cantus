import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePath } from "../model/write-path.js";
import { type ArchModel, DEFAULT_RULES, type Layer, saveModel, toBlockId, validateModel } from "../model/index.js";

/** A project design produced by an agent: blocks with their contracts, and the dependencies between them. */
export interface Design {
  name: string;
  /** The project's own layers, top to bottom; omit for interface, application, domain, infrastructure. */
  layers?: string[];
  blocks: Array<{ name: string; layer: Layer; path: string; description: string; contract: string }>;
  dependencies: Array<{ from: string; to: string }>;
}

export const DesignSchema: z.ZodType<Design> = z.object({
  name: z.string(),
  layers: z.array(z.string()).optional().describe("Own layer names, top to bottom; omit to use interface, application, domain, infrastructure"),
  blocks: z.array(
    z.object({
      name: z.string(),
      layer: z.string().describe("One of the layers"),
      path: z.string().describe("Repo-relative directory, e.g. src/checkout"),
      description: z.string().describe("Responsibility of the block in one or two sentences"),
      contract: z.string().describe("Full TypeScript source of <path>/index.ts: the block's public API"),
    }),
  ),
  dependencies: z.array(z.object({ from: z.string().describe("path of the importing block"), to: z.string().describe("path of the imported block") })),
});

/** How to shape a design; given to the agent that produces it. */
export const DESIGN_GUIDE = `Design the module structure of a TypeScript project as a set of blocks. Each block will be implemented by a coding agent that works mainly inside that block and relies on the public APIs of the blocks it depends on, so:

- Size each block so one agent can own it: one clear responsibility, typically 3-12 blocks for a whole project.
- Place every block in its own directory under src/ (e.g. src/orders). Paths must not be nested inside each other.
- Assign layers: interface (entry points, UI, HTTP, CLI), application (use cases, orchestration), domain (business rules, no I/O), infrastructure (databases, external services). If the project calls for other layers, list them in \`layers\`, top to bottom: each layer may then use itself and the layers below it.
- Dependencies point from the importing block to the imported one and must not form cycles. Domain blocks depend only on other domain blocks; infrastructure implements interfaces declared in domain or application.
- For each block, write its contract as the complete index.ts source: exported types, interfaces, and function or class signatures with doc comments. Function bodies throw new Error("not implemented"). Import other blocks only through relative paths to their index, e.g. import type { Order } from "../orders/index.js". The contract must compile on its own together with the other contracts.`;

export interface ScaffoldResult {
  model: ArchModel;
  modelFile: string;
  created: string[];
  skipped: string[];
}

/** Manifests of projects in other languages: their blocks are not TypeScript, so no index.ts contracts. */
const OTHER_LANGUAGE_MANIFESTS = ["pyproject.toml", "setup.py", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json"];

/** Writes the model and one index.ts contract per block. Existing files are never overwritten. */
export function scaffold(root: string, design: Design): ScaffoldResult {
  design = DesignSchema.parse(design);
  // Validate the whole request before the first write, including the model destination.
  for (const block of design.blocks) writePath(root, `${normalizeDir(block.path)}/index.ts`);
  writePath(root, ".cantus/model.json");
  const other = OTHER_LANGUAGE_MANIFESTS.find((file) => fs.existsSync(path.join(root, file)));
  if (other && !fs.existsSync(path.join(root, "package.json"))) {
    throw new Error(`The project has ${other}: a design writes TypeScript contracts (index.ts). Sketch the map instead (sketch_map, or "Describe the project" on the map), then build the plan: the agents write each block in the project's language.`);
  }
  const idByPath = new Map(design.blocks.map((block) => [normalizeDir(block.path), toBlockId(normalizeDir(block.path))]));
  const model: ArchModel = {
    version: 1,
    name: design.name,
    ...(design.layers ? { layers: design.layers } : {}),
    blocks: design.blocks.map((block) => ({
      id: idByPath.get(normalizeDir(block.path))!,
      name: block.name,
      layer: block.layer,
      include: [normalizeDir(block.path)],
      description: block.description,
    })),
    dependencies: design.dependencies
      .map((dep) => ({ from: idByPath.get(normalizeDir(dep.from)), to: idByPath.get(normalizeDir(dep.to)) }))
      .filter((dep): dep is { from: string; to: string } => !!dep.from && !!dep.to && dep.from !== dep.to),
    rules: design.layers ? { allow: {} } : DEFAULT_RULES,
  };
  const problems = validateModel(model);
  if (problems.length > 0) throw new Error(`The design is not a valid map:\n  - ${problems.join("\n  - ")}`);

  const created: string[] = [];
  const skipped: string[] = [];
  for (const block of design.blocks) {
    const file = path.posix.join(normalizeDir(block.path), "index.ts");
    const absolute = writePath(root, file);
    if (fs.existsSync(absolute)) {
      skipped.push(file);
      continue;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(writePath(root, file), block.contract.trimEnd() + "\n", { flag: "wx" });
    created.push(file);
  }

  const modelFile = saveModel(root, model);
  return { model, modelFile, created, skipped };
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
