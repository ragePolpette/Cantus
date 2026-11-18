/**
 * Reads C# files with tree-sitter and prints their structure as JSON: classes and interfaces, their
 * bases and attributes, and their methods with attributes. Runs as a child process because
 * tree-sitter loads asynchronously while the analysis is synchronous.
 *
 * Input on stdin: { "root": string, "files": string[] }. Output on stdout: Record<file, CSharpFile | { error: string }>.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { CSharpAttribute, CSharpFile, CSharpType } from "./csharp.js";

const GRAMMAR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "grammars", "tree-sitter-c_sharp.wasm");

function stringValue(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node.type === "string_literal" || node.type === "verbatim_string_literal" || node.type === "raw_string_literal") {
    const content = node.namedChildren.filter((child): child is Node => !!child && child.type === "string_literal_content").map((child) => child.text).join("");
    return content || node.text.replace(/^@?"+|"+$/g, "");
  }
  return undefined;
}

function attributes(node: Node): CSharpAttribute[] {
  const result: CSharpAttribute[] = [];
  for (const list of node.namedChildren) {
    if (!list || list.type !== "attribute_list") continue;
    for (const attribute of list.namedChildren) {
      if (!attribute || attribute.type !== "attribute") continue;
      const name = (attribute.childForFieldName("name")?.text ?? "").split(".").pop()!.replace(/Attribute$/, "");
      const args: CSharpAttribute["args"] = [];
      const argumentList = attribute.namedChildren.find((child) => child?.type === "attribute_argument_list");
      for (const argument of argumentList?.namedChildren ?? []) {
        if (!argument || argument.type !== "attribute_argument") continue;
        const named = argument.namedChildren.find((child) => child?.type === "name_equals" || child?.type === "name_colon");
        let expression = argument.namedChildren.filter((child): child is Node => !!child && child.type !== "name_equals" && child.type !== "name_colon").pop() ?? null;
        let name = named ? named.namedChildren[0]?.text ?? named.text.replace(/\s*[=:]\s*$/, "") : undefined;
        // `UriTemplate = "items/{id}"` comes as the name followed by the value, or as an assignment.
        const parts = argument.namedChildren.filter((child): child is Node => !!child);
        if (!name && parts.length >= 2 && parts[0].type === "identifier") {
          name = parts[0].text;
          expression = parts[parts.length - 1];
        } else if (!name && expression?.type === "assignment_expression") {
          name = expression.childForFieldName("left")?.text;
          expression = expression.childForFieldName("right");
        }
        args.push({
          ...(name ? { name } : {}),
          ...(stringValue(expression) !== undefined ? { value: stringValue(expression) } : {}),
          text: expression?.text ?? argument.text,
        });
      }
      result.push({ name, args });
    }
  }
  return result;
}

function modifiers(node: Node): string[] {
  return node.namedChildren.filter((child): child is Node => !!child && child.type === "modifier").map((child) => child.text);
}

function readType(node: Node, namespace: string | undefined, types: CSharpType[]) {
  const name = node.childForFieldName("name")?.text;
  if (!name) return;
  const bases = node.namedChildren.find((child) => child?.type === "base_list")?.namedChildren.filter((child): child is Node => !!child).map((child) => child.text.replace(/<.*$/s, "").split(".").pop()!) ?? [];
  const methods: CSharpType["methods"] = [];
  const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => child?.type === "declaration_list") ?? null;
  for (const member of body?.namedChildren ?? []) {
    if (!member) continue;
    if (member.type === "method_declaration") {
      const methodName = member.childForFieldName("name")?.text;
      const returns = (member.childForFieldName("returns") ?? member.childForFieldName("type"))?.text;
      const parameterList = member.childForFieldName("parameters");
      if (methodName) {
        methods.push({
          name: methodName,
          line: (member.childForFieldName("name") ?? member).startPosition.row + 1,
          modifiers: modifiers(member),
          attributes: attributes(member),
          parameters: parameterList?.namedChildren.filter((child): child is Node => !!child && child.type === "parameter").map((child) => child.childForFieldName("name")?.text ?? "") ?? [],
          ...(returns ? { returns: returns.replace(/\s+/g, " ") } : {}),
          ...(parameterList ? { parameterText: parameterList.text.replace(/^\(|\)$/g, "").replace(/\s+/g, " ").trim() } : {}),
        });
      }
    } else if (member.type === "class_declaration" || member.type === "interface_declaration") {
      readType(member, namespace, types);
    }
  }
  types.push({ name, ...(namespace ? { namespace } : {}), kind: node.type === "interface_declaration" ? "interface" : "class", line: (node.childForFieldName("name") ?? node).startPosition.row + 1, bases, modifiers: modifiers(node), attributes: attributes(node), methods });
}

function readFile(root: Node): CSharpFile {
  const types: CSharpType[] = [];
  const visit = (node: Node, namespace: string | undefined) => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === "namespace_declaration" || child.type === "file_scoped_namespace_declaration") {
        const name = child.childForFieldName("name")?.text;
        const full = [namespace, name].filter(Boolean).join(".");
        if (child.type === "file_scoped_namespace_declaration") {
          namespace = full;
          continue;
        }
        const body = child.childForFieldName("body") ?? child.namedChildren.find((candidate) => candidate?.type === "declaration_list");
        if (body) visit(body, full);
      } else if (child.type === "class_declaration" || child.type === "interface_declaration") {
        readType(child, namespace, types);
      } else if (child.type === "declaration_list") {
        visit(child, namespace);
      }
    }
  };
  visit(root, undefined);
  return { types };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { root, files } = JSON.parse(input) as { root: string; files: string[] };
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(GRAMMAR));
  const output: Record<string, CSharpFile | { error: string }> = {};
  for (const file of files) {
    try {
      const tree = parser.parse(fs.readFileSync(path.join(root, file), "utf8"));
      if (!tree) throw new Error("no syntax tree");
      output[file] = readFile(tree.rootNode);
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
