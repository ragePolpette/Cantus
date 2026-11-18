/**
 * The MCP server `claude -p` asks for permission (`--permission-prompt-tool`). Each call is
 * forwarded to the Cantus process that started the session, where the map or the run's policy
 * decides, and the answer goes back to Claude Code.
 *
 * Environment: CANTUS_APPROVAL_URL and CANTUS_APPROVAL_TOKEN, set by the claude-cli runner.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Names the claude-cli runner passes to --permission-prompt-tool (mcp__cantus_approvals__approve).
const APPROVAL_SERVER = "cantus_approvals";
const APPROVAL_TOOL = "approve";

const url = process.env.CANTUS_APPROVAL_URL;
const token = process.env.CANTUS_APPROVAL_TOKEN ?? "";

const server = new McpServer({ name: APPROVAL_SERVER, version: "1.0.0" });
server.registerTool(
  APPROVAL_TOOL,
  {
    description: "Asks the user, through the Cantus map, whether Claude Code may use a tool.",
    inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()).optional(), tool_use_id: z.string().optional() },
  },
  async ({ tool_name, input }) => {
    let decision: { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };
    try {
      if (!url) throw new Error("CANTUS_APPROVAL_URL is not set");
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cantus-token": token },
        body: JSON.stringify({ tool: tool_name, input: input ?? {} }),
      });
      const answer = (await response.json()) as { allow: boolean; message?: string; updatedInput?: Record<string, unknown> };
      decision = answer.allow ? { behavior: "allow", updatedInput: answer.updatedInput ?? input ?? {} } : { behavior: "deny", message: answer.message || "The user declined this step." };
    } catch (error) {
      decision = { behavior: "deny", message: `Cantus could not ask for approval: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  },
);

await server.connect(new StdioServerTransport());
