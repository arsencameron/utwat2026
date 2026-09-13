/**
 * CLI argument parsing, kept free of side-effectful imports so it can be
 * unit-tested without opening the SQLite store or spawning a browser.
 */

export interface CliFlags {
  jobUrl?: string;
  local: boolean;
  headed: boolean;
  autoApprove: boolean;
  keepAlive: boolean;
  offerSubmit: boolean;
  maxTurns?: number;
  help: boolean;
}

export const USAGE = `
Usage: npm run cli -- "<job application url>" [options]

Options:
  --local           Skip Steel and drive a local Playwright browser
  --headed          Show the local browser window (only with --local)
  --auto-approve    Do not prompt on submit-like clicks (demo/CI only)
  --no-keep-alive   Release the Steel session immediately when the run ends
  --offer-submit    After the agent reports done, attempt the final Submit
                    click so the guard prompts you to approve or block it
  --max-turns=N     Cap the agent loop at N turns (default 40)
  -h, --help        Show this message

Environment:
  ANTHROPIC_API_KEY          required
  STEEL_API_KEY              required unless --local
  STEEL_API_URL              default https://api.steel.dev
  STEEL_CONNECT_URL          default wss://connect.steel.dev
  STEEL_SESSION_TIMEOUT_MS   default 900000
  PLAYWRIGHT_MCP_ARGS        JSON array overriding the MCP server invocation
  HITL_AUTO_APPROVE=true     same as --auto-approve
  HITL_GUARD_ENTER=false     do not guard Enter key presses
`;

export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    local: false,
    headed: false,
    autoApprove: false,
    keepAlive: true,
    offerSubmit: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--local") flags.local = true;
    else if (arg === "--headed") flags.headed = true;
    else if (arg === "--auto-approve") flags.autoApprove = true;
    else if (arg === "--no-keep-alive") flags.keepAlive = false;
    else if (arg === "--offer-submit") flags.offerSubmit = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("--max-turns=")) {
      const turns = Number(arg.split("=")[1]);
      if (Number.isFinite(turns) && turns > 0) flags.maxTurns = Math.floor(turns);
      else console.warn(`[CLI] Ignoring invalid --max-turns value: ${arg}`);
    } else if (!arg.startsWith("-") && !flags.jobUrl) flags.jobUrl = arg;
  }

  return flags;
}

/**
 * Auto-approval can come from the flag or the environment. The flag parser
 * always yields a boolean, so the env var has to be OR-ed in explicitly —
 * passing `false` downstream would otherwise mask `HITL_AUTO_APPROVE`.
 */
export function resolveAutoApprove(
  flags: Pick<CliFlags, "autoApprove">,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return flags.autoApprove || env.HITL_AUTO_APPROVE === "true";
}
