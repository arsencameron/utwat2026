/**
 * Resolves how `@playwright/mcp` is launched.
 *
 * With a Steel session it attaches to the remote Chrome over CDP; without one
 * it falls back to a local browser so the demo still runs offline.
 */

export interface McpLaunchOptions {
  /** Steel CDP websocket URL; when absent a local browser is launched. */
  cdpEndpoint?: string | null;
  /** Show the local browser window (ignored when attaching over CDP). */
  headed?: boolean;
}

export interface McpLaunch {
  command: string;
  args: string[];
}

export const DEFAULT_MCP_PACKAGE = "@playwright/mcp";

export function resolveMcpLaunch(options: McpLaunchOptions = {}): McpLaunch {
  const command = process.env.PLAYWRIGHT_MCP_COMMAND || "npx";

  // An explicit PLAYWRIGHT_MCP_ARGS always wins, so the rest of the team can
  // pin whatever server invocation they need.
  if (process.env.PLAYWRIGHT_MCP_ARGS) {
    return { command, args: JSON.parse(process.env.PLAYWRIGHT_MCP_ARGS) as string[] };
  }

  const args = ["-y", process.env.PLAYWRIGHT_MCP_PACKAGE || DEFAULT_MCP_PACKAGE];

  if (options.cdpEndpoint) {
    args.push("--cdp-endpoint", options.cdpEndpoint);
  } else if (!options.headed) {
    args.push("--headless");
  }

  return { command, args };
}
