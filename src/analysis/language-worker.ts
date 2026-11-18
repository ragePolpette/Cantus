/**
 * Reads source files with tree-sitter and prints their structure as JSON, one language adapter per
 * file extension. Runs as a child process because tree-sitter loads asynchronously while the
 * analysis is synchronous.
 *
 * Input on stdin: { "root": string, "files": string[], "sources"?: Record<file, string> } (a file's text, when it
 * is not the one on disk). Output on stdout: Record<file, LanguageFile | { error: string }>.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";
import { type LanguageFile, languageOf } from "./languages.js";
import { readPython } from "./python.js";
import { readCSharpCode } from "./csharp-code.js";
import { readJava } from "./java.js";
import { readRust } from "./rust.js";
import { readPhp } from "./php.js";
import { readGo } from "./go.js";

const GRAMMARS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "grammars");

const READERS: Record<string, (root: Node, source: string) => LanguageFile> = {
  python: readPython,
  csharp: readCSharpCode,
  java: readJava,
  php: readPhp,
  rust: readRust,
  go: readGo,
};

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { root, files, sources = {} } = JSON.parse(input) as { root: string; files: string[]; sources?: Record<string, string> };
  await Parser.init();
  const parsers = new Map<string, Parser>();
  const output: Record<string, LanguageFile | { error: string }> = {};
  for (const file of files) {
    try {
      const language = languageOf(file);
      const read = language && READERS[language.id];
      if (!language || !read) throw new Error("no reader for this file type");
      let parser = parsers.get(language.id);
      if (!parser) {
        parser = new Parser();
        parser.setLanguage(await Language.load(path.join(GRAMMARS, language.grammar)));
        parsers.set(language.id, parser);
      }
      const source = Object.hasOwn(sources, file) ? sources[file] : fs.readFileSync(path.join(root, file), "utf8");
      const tree = parser.parse(source);
      if (!tree) throw new Error("no syntax tree");
      output[file] = { ...read(tree.rootNode, source), ...(tree.rootNode.hasError ? { syntaxError: true as const } : {}) };
      tree.delete();
    } catch (error) {
      output[file] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  // No process.exit here: on Windows (Node 24) exiting while the pipe to the parent is closing
  // aborts in libuv, and the parent gets nothing. The process ends once the output is written.
  process.stdout.write(JSON.stringify(output));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
