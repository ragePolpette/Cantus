/** Variables that make Claude Code bill an API account instead of the user's own Claude Code login (subscription). */
const API_BILLING = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * The environment a session started by Cantus runs with. An API key left in the shell (for other tools)
 * wins over the user's Claude Code login and ends in "credit balance too low" although the subscription
 * is fine, so by default the key is dropped and the session uses the login. `CANTUS_USE_API_KEY=1` keeps it
 * (machines with no login, such as CI).
 */
export function agentEnv(extra: Record<string, string | undefined> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string | undefined> = { ...base, ...extra };
  if (!/^(1|true|yes)$/i.test(base.CANTUS_USE_API_KEY ?? "")) for (const name of API_BILLING) delete env[name];
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
