import fs from "node:fs";
import path from "node:path";
import type { Analysis } from "../analysis/analyze.js";
import { findCallers } from "../analysis/callers.js";
import { shortSignature } from "../analysis/catalog.js";
import { exportReferenceReader } from "../analysis/export-references.js";
import { isTestFile, testsFor } from "../analysis/tests.js";

const REFERENCE_LIMIT = 16;
const TEST_LIMIT = 6;

export function renderSymbolContext(analysis: Analysis, symbol: string, file?: string): string {
  const entries = analysis.catalog.filter((entry) => entry.name === symbol && (!file || entry.file === file));
  if (entries.length === 0) return `No indexed export named "${symbol}"${file ? ` in ${file}` : ""}. Use find_api to look up the name.`;
  const files = [...new Set(entries.map((entry) => entry.file))];
  if (files.length > 1) {
    return [`"${symbol}" is exported by ${files.length} files. Specify file.`, ...files.slice(0, REFERENCE_LIMIT), ...(files.length > REFERENCE_LIMIT ? ["Use find_api to see more matches."] : [])].join("\n");
  }

  const [definition] = entries;
  const reader = exportReferenceReader({
    analysis,
    read(source) {
      try { return fs.readFileSync(path.join(analysis.root, source), "utf8"); }
      catch { return undefined; }
    },
  });
  const uses = findCallers(analysis, { symbol, file: definition.file, includeSameBlock: true });
  const references = [
    ...reader.references(definition.file, symbol).map(({ file, line, kind }) => ({ file, line, kind })),
    ...uses.sites.map(({ file, line, match }) => ({ file, line, kind: match === "certain" ? "reference" : `reference (${match})` })),
  ];
  const unique = [...new Map(references.map((reference) => [`${reference.file}:${reference.line}:${reference.kind}`, reference])).values()];
  const production = unique.filter((reference) => !isTestFile(reference.file));
  const tests = new Set(unique.filter((reference) => isTestFile(reference.file)).map(({ file, line }) => `${file}:${line}`));
  const callers = new Set(production.map((reference) => reference.file));
  for (const test of testsFor(analysis, [definition.block])) {
    if (test.covers.some((covered) => covered === definition.file || callers.has(covered)) && ![...tests].some((location) => location.startsWith(`${test.file}:`))) tests.add(test.file);
  }
  const text = [
    `# ${symbol}`,
    `Definition: ${definition.file}${definition.line ? `:${definition.line}` : ""} (block ${definition.block})`,
    ...[...new Set(entries.map((entry) => shortSignature(entry)))].slice(0, 4).map((signature) => `- ${signature}`),
    "",
    `References (${production.length} indexed locations)`,
    ...production.slice(0, REFERENCE_LIMIT).map(({ file, line, kind }) => `- ${file}:${line} (${kind})`),
    ...(production.length > REFERENCE_LIMIT ? [`- ${production.length - REFERENCE_LIMIT} more. Use callers for cross-file references.`] : []),
    "",
    `Related tests (${tests.size}; file-level links may cover other exports)`,
    ...[...tests].slice(0, TEST_LIMIT).map((test) => `- ${test}`),
    ...(tests.size > TEST_LIMIT ? [`- ${tests.size - TEST_LIMIT} more. Use block_context for the test list.`] : []),
    "",
    `Static references may be incomplete. Use block_context with block "${definition.block}" for the wider scope.`,
  ];
  return text.join("\n");
}
