import type { Diagnostic } from "./diagnostics.js";

/** Who can do something about a problem found while reading the project. */
export type ProblemWho = "yours" | "setup" | "cantus";

export type ProblemCode = "syntax-error" | "declarations-blocked" | "missing-package" | "unresolved-path" | "tsconfig" | "tool-failed" | "other" | "compiler-types";

/**
 * What each kind of problem is, in plain words, and what to do about it. The map page carries the same
 * texts in each of its languages (a test keeps them in step), so a change here is a change there.
 */
export const EXPLANATIONS: Record<ProblemCode, { who: ProblemWho; title: string; why: string; action: string }> = {
  "syntax-error": {
    who: "yours",
    title: "Code that cannot be parsed",
    why: "The parser stops at these places, so the imports and exports of the file are missing from the map.",
    action: "Fix the syntax at the line shown. If the code is valid, report it as a Cantus bug.",
  },
  "declarations-blocked": {
    who: "yours",
    title: "Types Cantus cannot write down",
    why: "The compiler cannot describe the type of these exports, so the contract of their block (its API as the agents see it) is partial.",
    action: "Give the export at the line shown an explicit type, naming the type it comes from (for a library type: import it with 'import type', then annotate with it).",
  },
  "missing-package": {
    who: "setup",
    title: "Packages that are not installed",
    why: "The code imports packages that cannot be found in node_modules, so their types are unknown and the compiler guesses.",
    action: "Install the project's dependencies (for example 'pnpm install'), then analyze again.",
  },
  "unresolved-path": {
    who: "yours",
    title: "Imports that lead to no file",
    why: "These imports point to a path or an alias that does not resolve to a file of the project, so they are not arrows on the map.",
    action: "Check the path: the file may have been renamed, or the alias is not in the tsconfig.json 'paths' closest to the file.",
  },
  tsconfig: {
    who: "setup",
    title: "A configuration the compiler does not accept",
    why: "Cantus reads types with the project's own TypeScript and its tsconfig.json, and the compiler rejects part of it.",
    action: "Fix the option named, or leave it: it only affects how precisely types are read.",
  },
  "tool-failed": {
    who: "setup",
    title: "A tool Cantus relies on failed",
    why: "A reader or a compiler did not run or did not finish, so part of the code is in the map by file only.",
    action: "Reinstall Cantus, or the project's TypeScript if the compiler is the one named. If it persists, report it with .cantus/analysis.log.",
  },
  other: {
    who: "setup",
    title: "Other problems",
    why: "Problems Cantus has no explanation for yet.",
    action: "Read the message; the full log is .cantus/analysis.log.",
  },
  "compiler-types": {
    who: "cantus",
    title: "Type errors the compiler reported",
    why: "These come from the compiler Cantus uses to read types. They are not Cantus's checks and the map does not depend on them.",
    action: "Your editor or 'tsc' shows them with more context. Nothing to do for the map.",
  },
};

const ORDER: ProblemCode[] = ["syntax-error", "declarations-blocked", "unresolved-path", "missing-package", "tsconfig", "tool-failed", "other", "compiler-types"];

export interface ProblemItem {
  file?: string;
  line?: number;
  column?: number;
  level: "error" | "warning";
  /** The message, without the compiler's name in front. */
  text: string;
  /** The module an unresolved import names. */
  specifier?: string;
  detail?: string;
}

export interface ProblemGroup {
  code: ProblemCode;
  who: ProblemWho;
  severity: "error" | "warning";
  items: ProblemItem[];
}

/** Compiler errors that stop a file's declarations from being written at all. */
const BLOCKING = /^(2742|2883|7056|4\d{3})$/;
const COMPILER_LABEL = /^(typescript@[\w.-]+|@typescript\/native-preview@[\w.-]+|TypeScript \d+):? /;

/** A bare package name (`react`, `@scope/pkg`), as opposed to a relative path or an alias (`./x`, `@/x`, `~/x`). */
function isPackage(specifier: string): boolean {
  return !/^(\.|\/|~|@\/|#)/.test(specifier);
}

/**
 * The problems found while reading the project, grouped by what they are, with who can act on each:
 * the code (yours), the installation or configuration (setup), or nobody (Cantus's own limits). One
 * problem found by two compilers is one item, and the compiler error that blocks a file's declarations
 * is part of the item about that file, not a second one.
 */
export function explainDiagnostics(diagnostics: Diagnostic[]): ProblemGroup[] {
  const serious = diagnostics.filter((diagnostic) => diagnostic.level !== "info");
  const blocked = new Set(serious.filter((diagnostic) => /no compiler could generate complete declarations/.test(diagnostic.message) && diagnostic.file).map((diagnostic) => diagnostic.file!));
  const blockers = new Map<string, Diagnostic>();
  const consumed = new Set<Diagnostic>();
  for (const diagnostic of serious) {
    const code = /\bTS(\d{4})\b/.exec(diagnostic.message)?.[1];
    if (!diagnostic.file || !blocked.has(diagnostic.file) || !code || !BLOCKING.test(code)) continue;
    consumed.add(diagnostic);
    if (!blockers.has(diagnostic.file)) blockers.set(diagnostic.file, diagnostic);
  }

  const groups = new Map<ProblemCode, ProblemItem[]>();
  const seen = new Set<string>();
  const add = (code: ProblemCode, diagnostic: Diagnostic, extra: Partial<ProblemItem> = {}) => {
    const item: ProblemItem = {
      ...(diagnostic.file ? { file: diagnostic.file } : {}),
      ...(diagnostic.line ? { line: diagnostic.line } : {}),
      ...(diagnostic.column ? { column: diagnostic.column } : {}),
      level: diagnostic.level === "error" ? "error" : "warning",
      text: diagnostic.message.replace(COMPILER_LABEL, ""),
      ...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
      ...extra,
    };
    const key = [code, item.file, item.line, item.column, item.text].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    groups.set(code, [...(groups.get(code) ?? []), item]);
  };

  for (const diagnostic of serious) {
    if (consumed.has(diagnostic)) continue;
    const message = diagnostic.message;
    const tsCode = /\bTS(\d{4})\b/.exec(message)?.[1];
    if (/no compiler could generate complete declarations/.test(message)) {
      const blocker = diagnostic.file ? blockers.get(diagnostic.file) : undefined;
      add("declarations-blocked", blocker ? { ...diagnostic, ...(blocker.line ? { line: blocker.line } : {}), ...(blocker.column ? { column: blocker.column } : {}), message: blocker.message } : diagnostic, { detail: diagnostic.detail });
    } else if (/reader failed|bundled TypeScript 6 failed|did not complete|printed something other than type errors/.test(message) || (!tsCode && /^cannot (read file|parse|analyze file)/.test(message))) {
      add("tool-failed", diagnostic);
    } else if (tsCode === "2307") {
      const specifier = /Cannot find module '([^']+)'/.exec(message)?.[1];
      add(specifier && !isPackage(specifier) ? "unresolved-path" : "missing-package", diagnostic, specifier ? { specifier } : {});
    } else if (diagnostic.stage === "resolve" && /^cannot resolve "/.test(message)) {
      const specifier = /^cannot resolve "([^"]+)"/.exec(message)?.[1];
      add(specifier && isPackage(specifier) ? "missing-package" : "unresolved-path", diagnostic, specifier ? { specifier } : {});
    } else if (tsCode && (/^5\d{3}$/.test(tsCode) || /tsconfig[^/]*\.json$/.test(diagnostic.file ?? "") || /cannot read tsconfig/i.test(message))) {
      add("tsconfig", diagnostic);
    } else if (tsCode) {
      add("compiler-types", diagnostic);
    } else if (diagnostic.level === "error" && diagnostic.file && diagnostic.line && (diagnostic.stage === "parse" || diagnostic.stage === "contracts")) {
      add("syntax-error", diagnostic);
    } else add("other", diagnostic);
  }

  return ORDER.filter((code) => groups.has(code)).map((code) => {
    const items = groups.get(code)!;
    return { code, who: EXPLANATIONS[code].who, severity: items.some((item) => item.level === "error") ? "error" : "warning", items };
  });
}

/** The problems somebody can act on (everything but Cantus's own limits). */
export function actionableItems(groups: ProblemGroup[]): ProblemItem[] {
  return groups.filter((group) => group.who !== "cantus").flatMap((group) => group.items);
}

const WHO_TITLE: Record<ProblemWho, string> = { yours: "To fix in your code", setup: "To check in your setup", cantus: "Cantus limits, nothing to do" };

/** The same, as text for a terminal or an agent: each group with what it means and what to do, the limits of Cantus counted only. */
export function renderProblems(groups: ProblemGroup[], options: { perGroup?: number } = {}): string {
  const perGroup = options.perGroup ?? 5;
  const lines: string[] = [];
  for (const group of groups.filter((candidate) => candidate.who !== "cantus")) {
    const explanation = EXPLANATIONS[group.code];
    lines.push(`${WHO_TITLE[group.who]}: ${explanation.title} (${group.items.length})`);
    for (const item of group.items.slice(0, perGroup)) {
      const where = item.file ? `${item.file}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ""}` : ""}` : "";
      lines.push(`  - ${where ? `${where}  ` : ""}${item.text}`);
    }
    if (group.items.length > perGroup) lines.push(`  - … ${group.items.length - perGroup} more in .cantus/analysis.log`);
    lines.push(`  What to do: ${explanation.action}`);
  }
  const limits = groups.filter((group) => group.who === "cantus").reduce((sum, group) => sum + group.items.length, 0);
  if (limits > 0) lines.push(`${limits} compiler note(s) about the code's types are not shown: ${EXPLANATIONS["compiler-types"].why}`);
  return lines.join("\n");
}
