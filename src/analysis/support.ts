import path from "node:path";

/** Folders of tests, mocks and fixtures: the analysis leaves them out, and they belong to no block. */
export const TEST_DIRS: ReadonlySet<string> = new Set(["tests", "test", "__tests__", "__mocks__", "fixtures", "e2e", "testdata"]);

/** Files the analysis leaves out by default: tests, stories, configs and type declarations. */
export const EXCLUDED_FILE = /\.(test|spec|stories|config)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|^test_.*\.pyi?$|_test\.(py|go)$|^conftest\.py$|[a-z0-9](?:Test|Tests|IT)\.java$/;

/** Generated or third-party folders: never a project's own support files. */
export const GENERATED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "target", "venv", "site-packages", "__pycache__"]);

/** Test files by name, wherever they are (the analysis leaves them out too). */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|^test_.*\.pyi?$|_test\.(py|go|rs)$|^conftest\.py$|[a-z0-9](?:Test|Tests|IT)\.(java|cs)$/;

/** Documentation and changelogs: plain text a change to the code usually has to be written up in. */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"]);

/**
 * A file that supports the code without being part of any block: a test (in a test folder, or by its
 * name), or a changelog or other documentation. A task on one block may change those where no block
 * owns them, so a change is written up and tested with the code instead of stopping the task.
 * Manifests, configuration, dot-files and dot-folders (`.env`, `.github`), generated and third-party
 * folders, and source files no block owns (they say the map is behind the code) are not included.
 */
export function isSupportFile(relative: string): boolean {
  const parts = relative.split("/");
  const name = parts[parts.length - 1];
  if (parts.some((part) => part.startsWith(".")) || parts.slice(0, -1).some((part) => GENERATED_DIRS.has(part))) return false;
  if (/\.d\.[cm]?ts$/.test(name)) return false;
  if (parts.slice(0, -1).some((part) => TEST_DIRS.has(part)) || TEST_FILE.test(name)) return true;
  return DOC_EXTENSIONS.has(path.extname(name).toLowerCase());
}
