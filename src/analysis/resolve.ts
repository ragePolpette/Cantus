import fs from "node:fs";
import path from "node:path";
import { ResolverFactory } from "oxc-resolver";
import type { Report } from "./diagnostics.js";

export const SOURCE_EXTENSIONS: string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"];

export interface WorkspacePackage {
  name: string;
  dir: string;
}

export type Resolution =
  | { kind: "internal"; file: string }
  | { kind: "external"; packageName: string }
  /** Resolves to a real file that is not an analyzed source (JSON, assets, excluded directories). */
  | { kind: "non-source"; path: string }
  | { kind: "unresolved"; reason: string };

/**
 * Resolves specifiers to repo-relative source files. Uses tsconfig paths and package
 * `exports`; built output of workspace packages (dist/, lib/) is mapped back to sources.
 */
export function createResolver(root: string, fileSet: Set<string>, packages: WorkspacePackage[], report?: Report): (specifier: string, fromFile: string) => Resolution {
  const options = {
    extensions: [...SOURCE_EXTENSIONS, ".d.ts", ".json"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    conditionNames: ["types", "import", "require", "node", "default"],
    mainFields: ["types", "module", "main"],
    builtinModules: true,
  };
  const resolver = new ResolverFactory({ tsconfig: "auto", ...options });
  // Used when a tsconfig extends a config that is not installed (`expo/tsconfig.base` without node_modules):
  // the resolver then fails every specifier of that package, relative ones included.
  const withoutTsconfig = new ResolverFactory(options);
  const tsconfigs = new Map<string, { file: string; base: string; paths: Record<string, string[]> } | null>();
  const nearestTsconfig = (fromFile: string) => {
    for (let dir = path.dirname(path.join(root, fromFile)); dir.startsWith(root); dir = path.dirname(dir)) {
      const cached = tsconfigs.get(dir);
      if (cached !== undefined) return cached;
      const file = path.join(dir, "tsconfig.json");
      let found: { file: string; base: string; paths: Record<string, string[]> } | null | undefined;
      if (fs.existsSync(file)) {
        try {
          const text = fs.readFileSync(file, "utf8")
            .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_match, quoted) => quoted ?? "")
            .replace(/,(\s*[}\]])/g, "$1");
          const options = (JSON.parse(text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions ?? {};
          found = { file, base: path.resolve(dir, options.baseUrl ?? "."), paths: options.paths ?? {} };
        } catch {
          found = null;
        }
      }
      if (found !== undefined || dir === root) {
        tsconfigs.set(dir, found ?? null);
        return found ?? null;
      }
    }
    return null;
  };
  /** The project file a `paths` alias of the nearest tsconfig points at, without reading what that tsconfig extends. */
  const fromPaths = (specifier: string, fromFile: string): string | undefined => {
    const config = nearestTsconfig(fromFile);
    if (!config) return undefined;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const star = pattern.indexOf("*");
      const head = star < 0 ? pattern : pattern.slice(0, star);
      const tail = star < 0 ? "" : pattern.slice(star + 1);
      if (star < 0 ? specifier !== pattern : !(specifier.length >= head.length + tail.length && specifier.startsWith(head) && specifier.endsWith(tail))) continue;
      const rest = star < 0 ? "" : specifier.slice(head.length, specifier.length - tail.length);
      for (const target of targets) {
        const candidate = toPosix(path.relative(root, path.resolve(config.base, target.replace("*", rest))));
        const file = findWithExtension(candidate, fileSet) ?? findWithExtension(`${candidate}/index`, fileSet);
        if (file) return file;
      }
    }
    return undefined;
  };

  const toSource = (absolute: string): string | undefined => {
    let real = absolute;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      // keep the path as resolved; the lookups below will simply miss
    }
    const relative = toPosix(path.relative(root, real));
    if (fileSet.has(relative)) return relative;
    const fromBuild = relative.replace(/(^|\/)(dist|build|lib)\//, "$1src/").replace(/\.d\.[cm]?ts$|\.[cm]?js$/, "");
    return findWithExtension(fromBuild, fileSet);
  };

  /** The source file a workspace package's `exports` gives a subpath ("expo" → "./src/drivers/expo.ts"), for when the package is not linked in node_modules. */
  const exportedFile = (pkg: WorkspacePackage, subpath: string): string | undefined => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, pkg.dir, "package.json"), "utf8")) as { exports?: unknown };
      const entry = (manifest.exports as Record<string, unknown> | string | undefined);
      let target: unknown = typeof entry === "object" && entry !== null ? entry[subpath ? `./${subpath}` : "."] : subpath ? undefined : entry;
      for (let depth = 0; depth < 4 && typeof target === "object" && target !== null; depth++) {
        const conditions = target as Record<string, unknown>;
        target = conditions.types ?? conditions.import ?? conditions.default;
      }
      if (typeof target !== "string") return undefined;
      return findWithExtension(toPosix(path.posix.normalize(`${pkg.dir}/${target}`)), fileSet);
    } catch {
      return undefined;
    }
  };

  return (specifier: string, fromFile: string): Resolution => {
    // resolveFileSync discovers the nearest tsconfig.json for each file (per-package configs in monorepos).
    let result = resolver.resolveFileSync(path.join(root, fromFile), specifier);
    const missing = !result.path && !result.builtin ? /tsconfig not found (.+)$/i.exec(result.error ?? "") : null;
    if (missing) {
      const config = nearestTsconfig(fromFile);
      report?.({
        level: "warning",
        stage: "resolve",
        ...(config ? { file: toPosix(path.relative(root, config.file)) } : {}),
        message: `tsconfig extends "${missing[1]}", which is not installed: imports were read from the project's own files and the tsconfig's own paths only, so the map may miss dependencies. Install the dependencies and analyze again.`,
      });
      const aliased = fromPaths(specifier, fromFile);
      if (aliased) return { kind: "internal", file: aliased };
      result = withoutTsconfig.resolveFileSync(path.join(root, fromFile), specifier);
    }
    if (result.builtin) return { kind: "external", packageName: result.builtin.resolved };
    if (result.path) {
      const file = toSource(result.path);
      if (file) return { kind: "internal", file };
    }
    const outsideSources = result.path && !result.path.split(path.sep).includes("node_modules")
      ? toPosix(path.relative(root, result.path))
      : undefined;

    const pkg = packages.find((candidate) => specifier === candidate.name || specifier.startsWith(candidate.name + "/"));
    if (pkg) {
      const subpath = specifier.slice(pkg.name.length).replace(/^\//, "");
      const exported = exportedFile(pkg, subpath);
      const candidates = [
        ...(exported ? [exported] : []),
        ...(subpath
          ? [`${pkg.dir}/src/${subpath}`, `${pkg.dir}/${subpath}`, `${pkg.dir}/src/${subpath}/index`]
          : [`${pkg.dir}/src/index`, `${pkg.dir}/index`]),
      ];
      for (const candidate of candidates) {
        const file = findWithExtension(candidate, fileSet);
        if (file) return { kind: "internal", file };
      }
      return { kind: "unresolved", reason: `workspace package ${pkg.name} has no source file for "${specifier}" (tried ${candidates.join(", ")})` };
    }

    if (outsideSources !== undefined) return { kind: "non-source", path: outsideSources };
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
      return { kind: "unresolved", reason: result.error ?? "no matching file" };
    }
    return { kind: "external", packageName: packageNameOf(specifier) };
  };
}

export function findWithExtension(stem: string, fileSet: Set<string>): string | undefined {
  if (fileSet.has(stem)) return stem;
  for (const extension of SOURCE_EXTENSIONS) {
    if (fileSet.has(stem + extension)) return stem + extension;
  }
  return undefined;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
