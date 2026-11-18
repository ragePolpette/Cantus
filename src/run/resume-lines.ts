/** A Claude Code session id: what `claude --resume` takes, and nothing a shell could read as more. */
export const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Two lines, not "&&": Windows PowerShell 5.1 has no "&&", and every shell takes two lines pasted together. */
export function resumeLines(folder: string, sessionId: string): string {
  return `cd "${folder}"\nclaude --resume ${sessionId}`;
}
