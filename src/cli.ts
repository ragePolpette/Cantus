#!/usr/bin/env node
// Starts `cantus`. The hooks that run after every tool call take the short way: the whole command line
// (analysis, parsers, MCP and agent SDKs) takes ~300 ms to load, and they mostly have nothing to do.
// Check before importing parsers and agent SDKs, which may fail on older runtimes
// before the user can see Cantus's own installation instructions.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (!((nodeMajor === 20 && nodeMinor >= 19) || (nodeMajor === 22 && nodeMinor >= 12) || nodeMajor > 22)) {
  console.error(`Cantus requires Node.js 20.19+ (20.x) or 22.12+; found ${process.versions.node}. Update Node.js, then run the command again.`);
  process.exitCode = 1;
} else {
  const argv = process.argv.slice(2);
  const { LIGHT_EVENTS, runLightHook } = await import("./hooks/light-run.js");
  if (argv[0] === "hook" && LIGHT_EVENTS.includes(argv[1] ?? "")) {
    const code = await runLightHook(argv);
    // Exit only once stdout is flushed, and without cutting short the connection to the live map that is closing
    // (process.exit() there aborts libuv on Windows with Node 24).
    const { exitAfterFlush } = await import("./exit.js");
    exitAfterFlush(code);
  } else {
    await import("./main.js");
  }
}
