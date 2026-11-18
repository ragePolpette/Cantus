import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A map server running for some checkout of the repository: what the other checkouts' maps need to link to it. */
export interface PeerServer {
  url: string;
  pid: number;
  /** The project folder it serves (the checkout's top folder, or a folder of the repository). */
  root: string;
  /** A Claude Code session started it (its MCP server), not `cantus serve`. */
  session: boolean;
  startedAt: string;
  /** When its session last got in touch (a hook or a tool call): the other maps read it to say whether that lead is working. */
  seenAt?: string;
  /** What it did then: `prompt`, `tool` or `stop` (the end of its turn). Absent in a record written by an older plugin. */
  seenVia?: "prompt" | "tool" | "stop" | "permission";
}

const PEERS_DIR = "cantus-servers";

/**
 * Next to the repository's own data, like the list of worktrees Cantus made: every checkout of the repository sees the
 * same servers, and the files are never committed. Holds no token: a map's token is only in its own page.
 */
export function gitCommonDir(root: string): string | undefined {
  try {
    return path.resolve(root, execFileSync("git", ["rev-parse", "--git-common-dir"], { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return undefined;
  }
}

/** One file per server: a process may serve more than one folder (the tests do), never two on one port. */
const fileName = (pid: number, url: string) => `${pid}-${new URL(url).port}.json`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not allowed to signal it: it exists.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function writePeer(root: string, peer: { url: string; pid: number; session: boolean }): void {
  const common = gitCommonDir(root);
  if (!common) return;
  const record: PeerServer = { ...peer, root: path.resolve(root), startedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.join(common, PEERS_DIR), { recursive: true });
    fs.writeFileSync(path.join(common, PEERS_DIR, fileName(peer.pid, peer.url)), JSON.stringify(record));
  } catch {
    // a read-only repository: the other maps just do not see this one
  }
}

/** The session of this server got in touch: written into its own record, for the maps of the other checkouts. */
export function touchPeer(root: string, url: string, at: string, pid = process.pid, via?: PeerServer["seenVia"]): void {
  const common = gitCommonDir(root);
  if (!common) return;
  const file = path.join(common, PEERS_DIR, fileName(pid, url));
  try {
    const { seenVia: _before, ...record } = JSON.parse(fs.readFileSync(file, "utf8")) as PeerServer;
    fs.writeFileSync(file, JSON.stringify({ ...record, seenAt: at, ...(via ? { seenVia: via } : {}) }));
  } catch {
    // a read-only repository, or the record is gone: the other maps just do not know when
  }
}

export function removePeer(root: string, url: string, pid = process.pid): void {
  const common = gitCommonDir(root);
  if (common) fs.rmSync(path.join(common, PEERS_DIR, fileName(pid, url)), { force: true });
}

/** The map servers running for the repository `root` is in, oldest first. Entries of servers that are gone are removed. */
export function readPeers(root: string): PeerServer[] {
  const common = gitCommonDir(root);
  if (!common) return [];
  const dir = path.join(common, PEERS_DIR);
  const found: PeerServer[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const peer = JSON.parse(fs.readFileSync(file, "utf8")) as PeerServer;
      if (typeof peer.url !== "string" || typeof peer.root !== "string" || !Number.isInteger(peer.pid)) throw new Error("not an entry");
      if (alive(peer.pid)) found.push(peer);
      else fs.rmSync(file, { force: true }); // its server is gone
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
  return found.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const same = (a: string, b: string) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

/** The address of the newest map running for the project folder `folder`, if one does. */
export function peerUrl(peers: PeerServer[], folder: string): string | undefined {
  return [...peers].reverse().find((peer) => same(peer.root, folder))?.url;
}

/** The map of the Claude Code session open in the project folder `folder` (its MCP server started it there): the lead of that worktree. */
export function peerSessionUrl(peers: PeerServer[], folder: string): string | undefined {
  return [...peers].reverse().find((peer) => peer.session && same(peer.root, folder))?.url;
}

/** When the session open in the project folder `folder` last got in touch, if one is open and has. */
export function peerSeenAt(peers: PeerServer[], folder: string): string | undefined {
  return [...peers].reverse().find((peer) => peer.session && same(peer.root, folder) && peer.seenAt)?.seenAt;
}

/** What the session open in the project folder `folder` did when it last got in touch (see `PeerServer.seenVia`). */
export function peerSeenVia(peers: PeerServer[], folder: string): PeerServer["seenVia"] {
  return [...peers].reverse().find((peer) => peer.session && same(peer.root, folder) && peer.seenAt)?.seenVia;
}
