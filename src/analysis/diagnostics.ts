import fs from "node:fs";
import path from "node:path";
import { ensureCantusIgnore } from "../model/ignore.js";
export type DiagnosticLevel = "error" | "warning" | "info";
export type DiagnosticStage = "scan" | "packages" | "parse" | "resolve" | "contracts" | "http" | "globals" | "csharp" | "git" | "internal";

/** Something that went wrong or was skipped while reading the project. Nothing is dropped silently. */
export interface Diagnostic {
  level: DiagnosticLevel;
  stage: DiagnosticStage;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** Extra context: compiler output, resolver error, stack trace. */
  detail?: string;
}

export type Report = (diagnostic: Diagnostic) => void;

/** Collects diagnostics; the same problem reported by two stages (e.g. a syntax error) is kept once. */
export function createCollector(): { diagnostics: Diagnostic[]; report: Report } {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  return {
    diagnostics,
    report: (diagnostic) => {
      const key = [diagnostic.level, diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.message].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      diagnostics.push(diagnostic);
    },
  };
}

let lastSource: string | undefined;
let lastStarts: number[] = [0];

/** Where each line of the source starts. The last source is kept: a file asks for many offsets in a row. */
function lineStarts(source: string): number[] {
  if (source === lastSource) return lastStarts;
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  lastSource = source;
  lastStarts = starts;
  return starts;
}

/** 1-based line and column of a character offset. */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(source);
  const limit = Math.min(offset, source.length);
  // The last line that starts at or before the offset.
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= limit) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const order = { error: 0, warning: 1, info: 2 };
  return [...diagnostics].sort(
    (a, b) =>
      order[a.level] - order[b.level] ||
      a.stage.localeCompare(b.stage) ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.file ? ` ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""}` : "";
  const head = `[${diagnostic.level}] ${diagnostic.stage}${location} — ${diagnostic.message}`;
  if (!diagnostic.detail) return head;
  return `${head}\n${diagnostic.detail.trimEnd().split("\n").map((line) => `    ${line}`).join("\n")}`;
}

export interface LogSummary {
  file: string;
  counts: Record<DiagnosticLevel, number>;
}

/** Writes every diagnostic to `<root>/.cantus/analysis.log`, most severe first. */
export function writeAnalysisLog(
  root: string,
  analysis: { diagnostics: Diagnostic[]; fileTokens: Record<string, number>; blocks: unknown[]; timings?: { total: number; stages: Record<string, number>; slowestFiles: Array<{ file: string; ms: number }> } },
  logFile = ".cantus/analysis.log",
): LogSummary {
  const counts: Record<DiagnosticLevel, number> = { error: 0, warning: 0, info: 0 };
  analysis.diagnostics.forEach((diagnostic) => counts[diagnostic.level]++);
  const header = [
    `Cantus analysis log — ${new Date().toISOString()}`,
    `Project: ${root}`,
    `Files: ${Object.keys(analysis.fileTokens).length}, blocks: ${analysis.blocks.length}`,
    `Diagnostics: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`,
    ...(analysis.timings
      ? [
          `Time: ${analysis.timings.total} ms — ${Object.entries(analysis.timings.stages).map(([stage, ms]) => `${stage} ${ms}`).join(", ")}`,
          ...(analysis.timings.slowestFiles.length ? [`Slowest files to read: ${analysis.timings.slowestFiles.map((entry) => `${entry.file} ${entry.ms} ms`).join(", ")}`] : []),
        ]
      : []),
    "",
  ];
  const clean = counts.error === 0 && counts.warning === 0 ? ["No problems while reading the project."] : [];
  const file = path.join(root, logFile);
  ensureCantusIgnore(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...header, ...clean, ...analysis.diagnostics.map(formatDiagnostic), ""].join("\n"));
  return { file: logFile, counts };
}
