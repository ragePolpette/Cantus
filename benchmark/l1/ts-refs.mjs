// Usage: node benchmark/l1/ts-refs.mjs <repo> <source-dir> <refs.json> <files.json>
import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

const [repo, sourceDir, refsOut, filesOut] = process.argv.slice(2);
if (!repo || !sourceDir || !refsOut || !filesOut) {
  throw new Error("Usage: node benchmark/l1/ts-refs.mjs <repo> <source-dir> <refs.json> <files.json>");
}
const root = fs.realpathSync(repo);
const sourceRoot = path.resolve(root, sourceDir);
const files = ts.sys.readDirectory(sourceRoot, [".ts", ".tsx"], ["**/*.d.ts"], ["**/*"]).sort();
if (!files.length) throw new Error("No TypeScript sources under " + sourceRoot);
const relative = (file) => path.relative(root, file).split(path.sep).join("/");
const included = new Set(files);
const configPath = ts.findConfigFile(root, ts.sys.fileExists);
const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : undefined;
if (config?.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = config && ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
if (parsed?.errors.length) {
  throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
}
const service = ts.createLanguageService({
  ...ts.sys,
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  getCompilationSettings: () => ({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...parsed?.options,
  }),
  getCurrentDirectory: () => root,
  getDefaultLibFileName: ts.getDefaultLibFilePath,
  getScriptFileNames: () => files,
  getScriptVersion: () => "0",
  getScriptSnapshot: (file) => {
    const source = ts.sys.readFile(file);
    return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
  },
});

function exportedNames(statement) {
  if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((decl) => decl.name).filter(ts.isIdentifier);
  }
  return statement.name && ts.isIdentifier(statement.name) ? [statement.name] : [];
}

function isCodeUse(source, position) {
  const token = ts.getTokenAtPosition(source, position);
  if (token.getStart(source) > position || token.end <= position) return false;
  for (let node = token; node; node = node.parent) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) || ts.isExportAssignment(node) || ts.isJSDocNode(node)) return false;
  }
  return true;
}

const references = new Map();
try {
  const program = service.getProgram();
  for (const file of files) {
    const source = program.getSourceFile(file);
    for (const statement of source.statements) {
      for (const name of exportedNames(statement)) {
        const key = name.text + "@" + relative(file);
        const locations = references.get(key) ?? new Map();
        references.set(key, locations);
        for (const group of service.findReferences(file, name.getStart(source)) ?? []) {
          for (const ref of group.references) {
            if (ref.fileName === file || !included.has(ref.fileName) || ref.isDefinition) continue;
            const caller = program.getSourceFile(ref.fileName);
            if (!isCodeUse(caller, ref.textSpan.start)) continue;
            const line = caller.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1;
            const callerFile = relative(ref.fileName);
            locations.set(callerFile + ":" + line, { file: callerFile, line });
          }
        }
      }
    }
  }
} finally {
  service.dispose();
}

const refs = Object.fromEntries([...references].map(([key, locations]) => [
  key, [...locations.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
]));
fs.writeFileSync(refsOut, JSON.stringify(refs, null, 2) + "\n");
fs.writeFileSync(filesOut, JSON.stringify(files.map(relative), null, 2) + "\n");
console.error(`TypeScript ${ts.version}, ${files.length} files, ${Object.keys(refs).length} exported symbols`);
