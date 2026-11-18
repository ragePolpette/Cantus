import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";

const methods = {
  definition: "textDocument/definition",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
} as const;

export type RoslynQuery = keyof typeof methods;

function projectFile(root: string, file: string, extensions: string[]): string {
  const absolute = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      !extensions.includes(path.extname(absolute).toLowerCase()) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Expected a ${extensions.join("/")} file inside the project: ${file}`);
  }
  return absolute;
}

export async function queryRoslyn(root: string, executable: string, solution: string | undefined, file: string, line: number, column: number, query: RoslynQuery, timeoutMs = 60_000) {
  if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) {
    throw new Error("CANTUS_ROSLYN_PATH must point to the absolute path of the roslyn-language-server executable.");
  }
  root = fs.realpathSync(root);
  const source = projectFile(root, file, [".cs"]);
  const target = solution ? projectFile(root, solution, [".sln", ".slnx", ".csproj"]) : undefined;
  const text = fs.readFileSync(source, "utf8");
  const sourceLine = text.split(/\r\n|\n|\r/)[line - 1];
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || sourceLine === undefined || column < 1 || column > sourceLine.length + 1) {
    throw new Error("Give a valid 1-based line and UTF-16 column in the C# file.");
  }

  const child = spawn(executable, ["--stdio", ...(target ? [] : ["--autoLoadProjects"])], {
    cwd: root, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  const ready = new Promise<void>(resolve => rpc.onNotification("workspace/projectInitializationComplete", () => resolve()));
  const warnings = new Set<string>();
  rpc.onNotification("workspace/_roslyn_projectHasUnresolvedDependencies", () => warnings.add("Roslyn reported unresolved project dependencies. Results may be incomplete."));
  rpc.onRequest("workspace/configuration", (params: { items: unknown[] }) => params.items.map(() => null));
  rpc.onRequest("client/registerCapability", () => null);
  rpc.onRequest("window/workDoneProgress/create", () => null);
  let timer: NodeJS.Timeout | undefined;
  const failed = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Roslyn exited (${code ?? signal}).${stderr.trim() ? ` ${stderr.trim()}` : ""}`)));
    rpc.onError(([error]) => reject(error));
    timer = setTimeout(() => reject(new Error(`Roslyn did not complete the query within ${timeoutMs / 1000}s.`)), timeoutMs);
  });
  rpc.listen();
  const run = async () => {
    const rootUri = pathToFileURL(root).href;
    const uri = pathToFileURL(source).href;
    const initialized = await rpc.sendRequest<{ capabilities?: Record<string, unknown> }>("initialize", {
      processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: { general: { positionEncodings: ["utf-16"] }, workspace: { workspaceFolders: true, configuration: true } },
    });
    const provider = `${query === "references" ? "references" : query}Provider`;
    if (!initialized.capabilities?.[provider]) throw new Error(`Roslyn does not advertise ${query} support.`);
    await rpc.sendNotification("initialized", {});
    if (target) {
      const targetUri = pathToFileURL(target).href;
      if (path.extname(target).toLowerCase() === ".csproj") await rpc.sendNotification("project/open", { projects: [targetUri] });
      else await rpc.sendNotification("solution/open", { solution: targetUri });
    }
    await rpc.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "csharp", version: 1, text } });
    await ready;
    const result = await rpc.sendRequest<unknown>(methods[query], {
      textDocument: { uri }, position: { line: line - 1, character: column - 1 },
      ...(query === "references" ? { context: { includeDeclaration: false } } : {}),
    });
    await rpc.sendRequest("shutdown");
    await rpc.sendNotification("exit");
    return { provider: "roslyn", query, result, warnings: [...warnings] };
  };
  try {
    return await Promise.race([run(), failed]);
  } finally {
    clearTimeout(timer);
    rpc.dispose();
    child.kill();
  }
}
