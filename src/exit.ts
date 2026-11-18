/**
 * Ends the process with `code` once stdout is flushed, without cutting short what is still closing.
 *
 * `process.exit()` right after a `fetch` (or a socket, a worker) has begun to close trips libuv's
 * `UV_HANDLE_CLOSING` assertion on Windows with Node 24: the process dies with 0xC0000409 instead of `code`.
 * So the code is set first and the process is left to end by itself; only if something keeps it alive (a handle that
 * never closes) it is forced out after 300 ms, when whatever was closing has closed.
 */
export function exitAfterFlush(code: number, graceMs = 300): void {
  process.stdout.write("", () => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), graceMs).unref();
  });
}
