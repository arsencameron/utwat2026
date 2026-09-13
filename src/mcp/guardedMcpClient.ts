/**
 * MCP middleware: every browser tool call the agent makes passes through here
 * on its way to the Playwright MCP server.
 *
 * Harmless calls go straight through. A call that looks like it submits the
 * application is halted, shown to the human in the CLI, and only forwarded if
 * they approve — otherwise Claude gets a denial result instead of a click.
 *
 * It subclasses PlaywrightMcpClient so it drops into AgentLoop unchanged.
 */
import { PlaywrightMcpClient, type PlaywrightMcpClientOptions, type ToolExecutionResult } from "../agent/mcpClient.js";
import {
  buildDenialMessage,
  isGuardedAction,
  lookupRefLabel,
  type GuardMatch,
} from "../hitl/submitGuard.js";
import { askChoice, isInteractive } from "../cli/prompt.js";

export type GuardVerdict = "allow" | "allow-all" | "deny";

export interface GuardPromptDetails {
  toolName: string;
  args: Record<string, unknown>;
  match: GuardMatch;
  liveViewUrl?: string | null;
}

export type GuardPrompt = (details: GuardPromptDetails) => Promise<GuardVerdict>;

export interface InterceptionRecord {
  toolName: string;
  label: string;
  reason: string;
  verdict: GuardVerdict | "auto-approved";
  at: string;
}

export interface GuardedMcpClientOptions extends PlaywrightMcpClientOptions {
  /** Shown in the confirmation banner so the human can look before deciding. */
  liveViewUrl?: string | null;
  /** Overrides the default submit phrases. */
  keywords?: string[];
  /** Guard Enter/Return key presses too (default true). */
  guardEnterKey?: boolean;
  /** Skip prompting and allow everything — demo/CI escape hatch. */
  autoApprove?: boolean;
  /** Replaces the CLI prompt; used by tests and by any non-CLI front end. */
  prompt?: GuardPrompt;
  /** Replaces the real MCP dispatch; used by tests. */
  executor?: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

const BANNER = "=".repeat(72);

/** Default CLI confirmation prompt. */
export async function cliGuardPrompt(details: GuardPromptDetails): Promise<GuardVerdict> {
  console.log("\n" + BANNER);
  console.log("🛑 [HUMAN INTERCEPTION REQUIRED] Submit-like browser action halted");
  console.log(BANNER);
  console.log(`Tool     : ${details.toolName}`);
  console.log(`Target   : ${details.match.label}`);
  console.log(`Reason   : ${details.match.reason}`);
  if (details.liveViewUrl) {
    console.log(`Live view: ${details.liveViewUrl}`);
  }
  console.log(`Arguments: ${JSON.stringify(details.args)}`);
  console.log("-".repeat(72));

  if (!isInteractive()) {
    console.log("No TTY attached — blocking the action. Re-run in an interactive terminal to approve.");
    console.log(BANNER + "\n");
    return "deny";
  }

  const choice = await askChoice(
    "👉 [y] allow once   [a] allow all for this run   [N] block (default): ",
    ["y", "a", "n"],
    "n"
  );
  console.log(BANNER + "\n");

  if (choice === "y") return "allow";
  if (choice === "a") return "allow-all";
  return "deny";
}

export class GuardedMcpClient extends PlaywrightMcpClient {
  public readonly interceptions: InterceptionRecord[] = [];

  private readonly liveViewUrl: string | null;
  private readonly keywords?: string[];
  private readonly guardEnterKey: boolean;
  private readonly autoApprove: boolean;
  private readonly prompt: GuardPrompt;
  private readonly executor?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolExecutionResult>;
  private allowAll = false;
  /** Most recent accessibility snapshot, used to resolve refs to real labels. */
  private lastSnapshot = "";

  constructor(options: GuardedMcpClientOptions = {}) {
    super(options);
    this.liveViewUrl = options.liveViewUrl ?? null;
    this.keywords = options.keywords;
    this.guardEnterKey = options.guardEnterKey ?? process.env.HITL_GUARD_ENTER !== "false";
    this.autoApprove = options.autoApprove ?? process.env.HITL_AUTO_APPROVE === "true";
    this.prompt = options.prompt ?? cliGuardPrompt;
    this.executor = options.executor;
  }

  public override async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const match = isGuardedAction(name, args, {
      keywords: this.keywords,
      guardEnterKey: this.guardEnterKey,
      resolvedLabel: this.resolveTarget(args),
    });

    if (!match.guarded) {
      return this.captureSnapshot(await this.execute(name, args));
    }

    if (this.autoApprove || this.allowAll) {
      const verdict = this.autoApprove ? "auto-approved" : "allow-all";
      console.log(`[HITL] Auto-approving guarded action (${verdict}): ${match.label}`);
      this.record(name, match, verdict);
      return this.captureSnapshot(await this.execute(name, args));
    }

    const verdict = await this.prompt({
      toolName: name,
      args,
      match,
      liveViewUrl: this.liveViewUrl,
    });
    this.record(name, match, verdict);

    if (verdict === "deny") {
      console.log(`[HITL] ❌ Blocked "${name}" on "${match.label}". Claude will be told to stop and report.`);
      return { content: buildDenialMessage(name, match.label), isError: true };
    }

    if (verdict === "allow-all") {
      this.allowAll = true;
      console.log("[HITL] ⚠️ Remaining guarded actions will be allowed for the rest of this run.");
    }

    console.log(`[HITL] ✅ Approved "${name}" on "${match.label}".`);
    return this.captureSnapshot(await this.execute(name, args));
  }

  /**
   * Remembers any tool output that carries an accessibility snapshot, so a
   * later click can be checked against what the page actually calls the target
   * rather than only the description the model supplied.
   */
  private captureSnapshot(result: ToolExecutionResult): ToolExecutionResult {
    if (!result.isError && result.content.includes("[ref=")) {
      this.lastSnapshot = result.content;
    }
    return result;
  }

  /** Resolves the ref in a tool call against the last snapshot, if possible. */
  private resolveTarget(args: Record<string, unknown>): string | null {
    const ref =
      typeof args.target === "string"
        ? args.target
        : typeof args.ref === "string"
          ? args.ref
          : null;
    if (!ref || !this.lastSnapshot) return null;
    return lookupRefLabel(this.lastSnapshot, ref);
  }

  private async execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    if (this.executor) {
      return this.executor(name, args);
    }
    return super.callTool(name, args);
  }

  private record(name: string, match: GuardMatch, verdict: InterceptionRecord["verdict"]): void {
    this.interceptions.push({
      toolName: name,
      label: match.label,
      reason: match.reason,
      verdict,
      at: new Date().toISOString(),
    });
  }
}
