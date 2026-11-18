// Runner finto LENTO: aspetta 40 secondi (o finché Cantus lo ferma) e poi scrive un file. Serve a provare l'arresto di un piano.
import fs from "node:fs";
import path from "node:path";
export default (request) => {
  async function* run() {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 40_000);
      request.abort?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (request.abort?.signal?.aborted) { yield { type: "result", ok: false, text: "stopped" }; return; }
    fs.writeFileSync(path.join(request.cwd, "slow.txt"), "done\n");
    yield { type: "result", ok: true, text: "done slowly", costUsd: 0.01 };
  }
  const it = run();
  return { [Symbol.asyncIterator]: () => it, async setPermissionMode() {} };
};
