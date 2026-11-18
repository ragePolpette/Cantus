import fs from "node:fs";
import path from "node:path";
import { gitCommonDir } from "../state/peers.js";

/** Cross-process lock shared by all linked checkouts. A dead owner's lock is recoverable.
 * Unknown owner permissions fail closed; this does not lock unrelated external Git clients. */
export async function repositoryLock<T>(root: string, name: string, work: () => Promise<T>): Promise<T> {
  const dir = gitCommonDir(root);
  if (!dir) return work();
  const file = path.join(dir, `cantus-${name}.lock`);
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw new Error(`Cantus ${name} is already running or its lock cannot be acquired.`);
      const owner = Number(fs.readFileSync(file, "utf8").split(":")[0]);
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error(`Cantus ${name} lock has an unknown owner: ${file}`);
      try { process.kill(owner, 0); throw new Error(`Cantus ${name} is already running (process ${owner}).`); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        fs.unlinkSync(file);
      }
    }
  }
  try { return await work(); }
  finally { if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file); }
}
