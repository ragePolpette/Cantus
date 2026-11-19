import { parseSync } from "oxc-parser";
import type { Analysis } from "./analyze.js";
import { lineColumn } from "./diagnostics.js";
import { analyzeModule } from "./imports.js";
import { createResolver } from "./resolve.js";
import { isVueFile, parseName, sfcParts } from "./vue.js";

export const isJsSource = (file: string) => /\.(?:[cm]?[jt]s|[jt]sx|vue)$/i.test(file);

type SourceSide = { analysis: Analysis; read: (file: string) => string | undefined };
export type ExportReference = { file: string; line: number; kind: "local-reference" | "re-export" | "import" };

type ParsedModule = ReturnType<typeof parseSync>["module"];
type ExportEntries = ParsedModule["staticExports"][number]["entries"];

interface ReferenceReader {
  exportsOf(file: string): ExportEntries;
  reExports(file: string, name: string): ExportReference[];
  provides(file: string, name: string): boolean;
  targetOf(from: string, specifier: string): string | undefined;
  importers(file: string): string[];
  starBarrels(file: string, name: string): string[];
  references(file: string, name: string): ExportReference[];
  dangling(file: string, name: string, before: ReferenceReader): ExportReference[];
}

export function exportReferenceReader(side: SourceSide): ReferenceReader {
  const files = new Set(Object.keys(side.analysis.fileTokens).filter(isJsSource));
  const resolve = createResolver(side.analysis.root, files, []);
  const parsed = new Map<string, ParsedModule | undefined>();
  const importedBy = new Map<string, Set<string>>();
  for (const { from, to } of side.analysis.fileImports) {
    if (!isJsSource(from)) continue;
    const callers = importedBy.get(to) ?? new Set<string>();
    callers.add(from);
    importedBy.set(to, callers);
  }
  const importers = (file: string) => [...(importedBy.get(file) ?? [])];
  function moduleOf(file: string) {
    if (!parsed.has(file)) {
      const source = side.read(file);
      parsed.set(file, source === undefined ? undefined : parseSync(parseName(file), isVueFile(file) ? sfcParts(source).script : source).module);
    }
    return parsed.get(file);
  }
  const exportsOf = (file: string) => moduleOf(file)?.staticExports.flatMap((entry) => entry.entries) ?? [];
  const targetOf = (from: string, specifier: string) => {
    const target = resolve(specifier, from);
    return target.kind === "internal" ? target.file : undefined;
  };

  const moduleInfo = new Map<string, ReturnType<typeof analyzeModule>>();
  const freeReferences = (file: string, source: string) => {
    const info = moduleInfo.get(file) ?? analyzeModule(file, source);
    moduleInfo.set(file, info);
    return info.freeRefs;
  };
  /** Resolve a name through local exports, explicit forwarders, and star barrels. */
  function exportSources(file: string, name: string, seen = new Set<string>()): Set<string> {
    const key = `${file}\0${name}`;
    const source = side.read(file);
    if (seen.has(key) || source === undefined) return new Set();
    const nextSeen = new Set([...seen, key]);
    const entries = exportsOf(file);
    const explicit = entries.filter((entry) => entry.exportName.name === name);
    const sources = new Set<string>();
    for (const entry of explicit.length || name === "default" ? explicit : entries) {
      const specifier = entry.moduleRequest?.value;
      if (!specifier) {
        if (entry.exportName.name !== name) continue;
        const local = entry.localName.name;
        if (!local || !freeReferences(file, source)[local]?.length) sources.add(key);
        continue;
      }
      const star = entry.importName.kind === "AllButDefault";
      if (!star && entry.exportName.name !== name) continue;
      const target = resolve(specifier, file);
      const forwarded = star ? name : entry.importName.name;
      if (target.kind === "internal" && forwarded) {
        for (const origin of exportSources(target.file, forwarded, nextSeen)) sources.add(origin);
      } else if (target.kind === "internal" && entry.importName.kind === "All") {
        sources.add(target.file + "\0*");
      } else if (target.kind === "external" || target.kind === "non-source") {
        // Unknown outside the analyzed tree: do not claim a downstream import was broken.
        sources.add(`${file}\0${specifier}\0${forwarded ?? "*"}`);
      }
    }
    return sources;
  }

  function starBarrels(file: string, name: string): string[] {
    const origin = `${file}\0${name}`;
    const seen = new Set([file]);
    const queue = [file];
    for (const target of queue) {
      for (const barrel of importers(target)) {
        if (seen.has(barrel)) continue;
        const forwards = exportsOf(barrel).some((entry) => entry.importName.kind === "AllButDefault" &&
          entry.moduleRequest && targetOf(barrel, entry.moduleRequest.value) === target);
        if (!forwards) continue;
        const origins = exportSources(barrel, name);
        if (origins.size !== 1 || !origins.has(origin)) continue;
        seen.add(barrel);
        queue.push(barrel);
      }
    }
    return queue.slice(1);
  }

  const provides = (file: string, name: string) => exportSources(file, name).size > 0;
  function reExports(file: string, name: string): ExportReference[] {
    const result: ExportReference[] = [];
    for (const importer of importers(file)) {
      for (const entry of exportsOf(importer)) {
        if (entry.moduleRequest && entry.importName.name === name && targetOf(importer, entry.moduleRequest.value) === file) {
          result.push({ file: importer, line: lineColumn(side.read(importer)!, entry.start).line, kind: "re-export" });
        }
      }
    }
    return result;
  }

  return {
    exportsOf,
    targetOf,
    provides,
    reExports,
    importers,
    starBarrels,
    references(file: string, name: string): ExportReference[] {
      if (!isJsSource(file)) return [];
      const source = side.read(file);
      const local = exportsOf(file).find((entry) => !entry.moduleRequest && entry.exportName.name === name)?.localName.name;
      const localReferences = source !== undefined && local ? analyzeModule(file, source, undefined, local).localReferences ?? [] : [];
      return [
        ...localReferences.map(({ line }): ExportReference => ({ file, line, kind: "local-reference" })),
        ...reExports(file, name),
      ];
    },
    dangling(file: string, name: string, before: ReferenceReader): ExportReference[] {
      const source = side.read(file);
      const result: ExportReference[] = [];
      const local = before.exportsOf(file).find((entry) => !entry.moduleRequest && entry.exportName.name === name)?.localName.name;
      if (source !== undefined && local) {
        for (const { line } of freeReferences(file, source)[local] ?? []) result.push({ file, line, kind: "local-reference" });
      }
      // A compatibility alias or forwarding export keeps the old public name available.
      if (provides(file, name)) return uniqueReferences(result);
      for (const barrelFile of new Set(before.reExports(file, name).map((reference) => reference.file))) {
        const barrel = side.read(barrelFile);
        if (barrel === undefined) continue;
        for (const entry of exportsOf(barrelFile)) {
          if (!entry.moduleRequest || entry.importName.name !== name) continue;
          const specifier = entry.moduleRequest.value;
          const target = targetOf(barrelFile, specifier);
          if (target !== file && !(target === undefined && source === undefined && before.targetOf(barrelFile, specifier) === file)) continue;
          result.push({ file: barrelFile, line: lineColumn(barrel, entry.start).line, kind: "re-export" });
        }
      }
      for (const barrel of before.starBarrels(file, name)) {
        if (provides(barrel, name)) continue;
        for (const importer of new Set([...importers(barrel), ...before.importers(barrel)])) {
          const text = side.read(importer);
          if (text === undefined) continue;
          const stillTargetsBarrel = (specifier: string) => {
            const target = targetOf(importer, specifier);
            return target === barrel || (target === undefined && side.read(barrel) === undefined && before.targetOf(importer, specifier) === barrel);
          };
          for (const statement of moduleOf(importer)?.staticImports ?? []) {
            if (!stillTargetsBarrel(statement.moduleRequest.value)) continue;
            for (const entry of statement.entries) {
              if (entry.importName.name === name) {
                result.push({ file: importer, line: lineColumn(text, entry.importName.start ?? statement.start).line, kind: "import" });
              }
            }
          }
        }
        result.push(...reExports(barrel, name));
      }
      return uniqueReferences(result);
    },
  };
}

function uniqueReferences(references: ExportReference[]): ExportReference[] {
  return [...new Map(references.map((reference) => [`${reference.file}:${reference.line}:${reference.kind}`, reference])).values()];
}
