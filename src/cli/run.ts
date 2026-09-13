/**
 * Person 1 entrypoint: Steel cloud browser + Playwright MCP + CLI HITL.
 *
 *   npm run cli -- "<job application url>"
 *
 * Creates a Steel session, prints the live viewer URL, launches @playwright/mcp
 * attached to that session over CDP, and runs the agent loop behind a guard
 * that halts any submit-like click for CLI confirmation.
 */
import "dotenv/config";
import { contextStore } from "../db/contextStore.js";
import { AgentLoop } from "../agent/agentLoop.js";
import { GuardedMcpClient } from "../mcp/guardedMcpClient.js";
import { resolveMcpLaunch } from "../mcp/playwrightMcp.js";
import { SteelSessionManager, logSessionViewer, type SteelSession } from "../steel/steelSession.js";
import { createHumanQuestionHandler } from "../hitl/humanQuestion.js";
import { findSubmitButtons, chooseSubmitButton } from "./submitAssist.js";
import { parseArgs, resolveAutoApprove, USAGE, type CliFlags } from "./flags.js";

export { parseArgs, resolveAutoApprove, type CliFlags } from "./flags.js";
import { ask, closePrompt, isInteractive } from "./prompt.js";

const BANNER = "=".repeat(72);

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseArgs(argv);

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  const jobUrl = flags.jobUrl;
  if (!jobUrl) {
    console.error("❌ No job URL given.");
    console.error(USAGE);
    return 1;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY is not set. Add it to .env and retry.");
    return 1;
  }

  const steel = new SteelSessionManager();
  let session: SteelSession | null = null;

  if (!flags.local) {
    if (!steel.hasApiKey) {
      console.error("❌ STEEL_API_KEY is not set. Add it to .env, or pass --local to use a local browser.");
      return 1;
    }
    try {
      session = await steel.create();
      logSessionViewer(session);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Could not start a Steel session: ${message}`);
      return 1;
    }
  } else {
    console.log("[Steel] --local passed: running Playwright locally, no cloud session or live viewer.");
  }

  const launch = resolveMcpLaunch({
    cdpEndpoint: session?.cdpEndpoint,
    headed: flags.headed,
  });

  const mcpClient = new GuardedMcpClient({
    command: launch.command,
    args: launch.args,
    liveViewUrl: session?.liveViewUrl,
    autoApprove: resolveAutoApprove(flags),
  });

  let shuttingDown = false;
  const releaseAll = async (): Promise<void> => {
    closePrompt();
    await mcpClient.disconnect().catch(() => {});
    await steel.release().catch(() => {});
    try {
      contextStore.close();
    } catch {
      /* already closed */
    }
  };

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      process.exit(code);
    }
    shuttingDown = true;
    console.log("\n[CLI] Shutting down...");
    await releaseAll();
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));

  const agent = new AgentLoop(mcpClient);

  try {
    const result = await agent.run({
      jobUrl,
      maxTurns: flags.maxTurns,
      onHumanQuestion: createHumanQuestionHandler({ liveViewUrl: session?.liveViewUrl }),
    });

    if (flags.offerSubmit && result.success) {
      await attemptSubmit(mcpClient);
    }

    printRunSummary(result, mcpClient, session);

    if (session && flags.keepAlive && isInteractive()) {
      await ask("👉 Steel session is still open for your review. Press Enter to release it: ");
    }

    return result.success ? 0 : 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Run failed: ${message}`);
    return 1;
  } finally {
    if (!shuttingDown) {
      shuttingDown = true;
      await releaseAll();
    }
  }
}

/**
 * Hands the final click back to the agent at the operator's request. The click
 * still goes through the guard, so the confirmation prompt — not this function
 * — decides whether the application is actually submitted.
 */
async function attemptSubmit(mcpClient: GuardedMcpClient): Promise<void> {
  console.log("\n" + BANNER);
  console.log("📝 --offer-submit: locating the Submit control on the filled form");
  console.log(BANNER);

  const snapshot = await mcpClient.callTool("browser_snapshot", {});
  if (snapshot.isError) {
    console.log(`Could not read the page: ${snapshot.content}`);
    return;
  }

  const candidates = findSubmitButtons(snapshot.content);
  const target = chooseSubmitButton(candidates);

  if (!target) {
    console.log("No submit control found in the page snapshot — nothing to click.");
    console.log("Submit it yourself in the live view if the form looks right.\n");
    return;
  }

  console.log(`Found ${candidates.length} candidate(s); using ${target.role} "${target.label}" [ref=${target.ref}].`);

  // Routed through the guard on purpose: this is the confirmation moment.
  const clicked = await mcpClient.callTool("browser_click", {
    element: target.label,
    target: target.ref,
  });

  if (clicked.isError) {
    console.log("\n🛑 Not submitted — the click was blocked or failed.");
    console.log(`   ${clicked.content.split("\n")[0]}\n`);
    return;
  }

  console.log("\n✅ Submit click was approved and executed. Verify the result in the live view.\n");
}

function printRunSummary(
  result: { success: boolean; turns: number; summary: string; error?: string },
  mcpClient: GuardedMcpClient,
  session: SteelSession | null
): void {
  console.log("\n" + BANNER);
  console.log("📋 RUN SUMMARY");
  console.log(BANNER);
  console.log(`Completed : ${result.success ? "yes" : "no"}`);
  console.log(`Turns     : ${result.turns}`);
  console.log(`Summary   : ${result.summary}`);
  if (result.error) {
    console.log(`Error     : ${result.error}`);
  }
  console.log(`Intercepts: ${mcpClient.interceptions.length}`);
  for (const record of mcpClient.interceptions) {
    console.log(`  - ${record.verdict.toUpperCase()} ${record.toolName} → ${record.label} (${record.reason})`);
  }
  if (session) {
    console.log(`Live view : ${session.liveViewUrl}`);
  }
  console.log(BANNER + "\n");
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("cli/run.ts") || process.argv[1].endsWith("cli/run.js"));

if (isDirectExecution) {
  main()
    .then((code) => {
      closePrompt();
      process.exit(code);
    })
    .catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
}
