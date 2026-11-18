import { parseSync } from "oxc-parser";
import type { Analysis } from "./analyze.js";
import { lineColumn } from "./diagnostics.js";
import { analyzeModule } from "./imports.js";
import { createResolver } from "./resolve.js";
import { isVueFile, parseName, sfcParts } from "./vue.js";

export const isJsSource = (file: string) => /\.(?:[cm]?[jt]s|[jt]sx|vue)$/i.test(file);

type SourceSide = { analysis: Analysis; read: (file: string) => string | undefined };
export type ExportReference = { file: string; line: number; kind: "local-reference" | "re-export" };

type ExportEntries = ReturnType<typeof parseSync>["module"]["staticExports"][number]["entries"];

interface ReferenceReader {
  exportsOf(file: string): ExportEntries;
  reExports(file: string, name: string): ExportReference[];
  provides(file: string, name: string): boolean;
  targetOf(from: string, specifier: string): string | undefined;
  references(file: string, name: string): ExportReference[];
  dangling(file: string, name: string, before: ReferenceReader): ExportReference[];
}

export function exportReferenceReader(side: SourceSide): ReferenceReader {
  const files = new Set(Object.keys(side.analysis.fileTokens).filter(isJsSource));
  const resolve = createResolver(side.analysis.root, files, []);
  const parsed = new Map<string, ExportEntries>();
  function exportsOf(file: string) {
    const cached = parsed.get(file);
    if (cached) return cached;
    const source = side.read(file);
    const entries = source === undefined ? [] : parseSync(parseName(file), isVueFile(file) ? sfcParts(source).script : source).module.staticExports.flatMap((entry) => entry.entries);
    parsed.set(file, entries);
    return entries;
  }
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
  function provides(file: string, name: string, seen = new Set<string>()): boolean {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return false;
    const source = side.read(file);
    if (source === undefined) return false;
    for (const entry of exportsOf(file)) {
      if (entry.exportName.name !== name) continue;
      if (!entry.moduleRequest) {
        const local = entry.localName.name;
        if (!local || !(freeReferences(file, source)[local]?.length)) return true;
      } else if (entry.importName.name) {
        const target = targetOf(file, entry.moduleRequest.value);
        if (target && provides(target, entry.importName.name, new Set([...seen, key]))) return true;
      }
    }
    return false;
  }
  function reExports(file: string, name: string): ExportReference[] {
    const result: ExportReference[] = [];
    for (const edge of side.analysis.fileImports) {
      if (edge.to !== file || !edge.symbols.includes(name) || !isJsSource(edge.from)) continue;
      for (const entry of exportsOf(edge.from)) {
        if (entry.moduleRequest && entry.importName.name === name && targetOf(edge.from, entry.moduleRequest.value) === file) {
          result.push({ file: edge.from, line: lineColumn(side.read(edge.from)!, entry.start).line, kind: "re-export" });
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
      return uniqueReferences(result);
    },
  };
}

function uniqueReferences(references: ExportReference[]): ExportReference[] {
  return [...new Map(references.map((reference) => [`${reference.file}:${reference.line}:${reference.kind}`, reference])).values()];
}
