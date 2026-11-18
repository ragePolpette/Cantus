/** A specialist of the open Claude Code session that is working right now, and on which blocks. */
export interface ActiveAgent {
  /** The id Claude Code gave the subagent; an agent only seen through its edits has `type:` plus its type. */
  id: string;
  /** `block-<id>` or `group-<id>`. */
  type: string;
  blocks: string[];
  startedAt: string;
  /** The file it last edited, when known. */
  file?: string;
}

interface Entry extends ActiveAgent {
  seen: number;
  /** Known only from its edits: no start event came, so no stop event can be waited for. */
  implicit: boolean;
}

/** `SubagentStop` does not come when the session is interrupted or closed: an agent not heard from for this long is gone. */
const STALE_MS = 20 * 60 * 1000;
/** An agent known only from its edits is gone this long after the last one. */
const IMPLICIT_MS = 90 * 1000;

/**
 * The specialists working in the open session, kept in memory only. They are told by the plugin's
 * hooks (a subagent starts or stops) and by the edits the hooks report; the map shows them on the
 * blocks they work on. Which blocks an agent type covers is up to the caller.
 */
export class ActiveAgents {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(agents: ActiveAgent[]) => void>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {}

  /** Called with the whole list every time it changes; returns the way to stop listening. */
  subscribe(listener: (agents: ActiveAgent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(id: string, type: string, blocks: string[]): void {
    const implicit = this.entries.get(`type:${type}`);
    this.entries.delete(`type:${type}`); // the real one replaces what the edits had guessed
    this.entries.set(id, { id, type, blocks, startedAt: implicit?.startedAt ?? new Date(this.now()).toISOString(), seen: this.now(), implicit: false, ...(implicit?.file ? { file: implicit.file } : {}) });
    this.changed();
  }

  stop(id: string, type?: string): void {
    const gone = this.entries.delete(id);
    const guessed = type ? this.entries.delete(`type:${type}`) : false;
    if (gone || guessed) this.changed();
  }

  /** An agent of this type edited `file`: it is alive, and if nobody told us it started, it is working now. */
  touch(id: string | undefined, type: string, blocks: string[], file: string): void {
    const entry = (id ? this.entries.get(id) : undefined) ?? [...this.entries.values()].find((other) => other.type === type);
    if (entry) {
      entry.seen = this.now();
      if (entry.file === file) return;
      entry.file = file;
    } else {
      this.entries.set(`type:${type}`, { id: `type:${type}`, type, blocks, startedAt: new Date(this.now()).toISOString(), seen: this.now(), implicit: true, file });
    }
    this.changed();
  }

  list(): ActiveAgent[] {
    this.sweep();
    return [...this.entries.values()].map(({ seen: _seen, implicit: _implicit, ...agent }) => agent);
  }

  /** Forgets agents nobody has heard of for too long; true when there were any. */
  sweep(): boolean {
    let removed = false;
    for (const [id, entry] of this.entries) {
      if (this.now() - entry.seen > (entry.implicit ? IMPLICIT_MS : STALE_MS)) {
        this.entries.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  /** Keeps expiring agents while someone listens; stops with the server. */
  watch(intervalMs = 15000): () => void {
    this.timer ??= setInterval(() => { if (this.sweep()) this.changed(); }, intervalMs).unref();
    return () => {
      clearInterval(this.timer);
      this.timer = undefined;
    };
  }

  private changed(): void {
    const agents = this.list();
    for (const listener of this.listeners) listener(agents);
  }
}
