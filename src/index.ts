import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { contextStore } from "./db/contextStore.js";
import { PlaywrightMcpClient } from "./agent/mcpClient.js";
import { AgentLoop, type HumanInterceptionHandler } from "./agent/agentLoop.js";

export { contextStore, type CandidateProfile, type QARecord } from "./db/contextStore.js";
export { PlaywrightMcpClient, type PlaywrightMcpClientOptions } from "./agent/mcpClient.js";
export { AgentLoop, type AgentRunOptions, type AgentRunResult, type HumanInterceptionHandler } from "./agent/agentLoop.js";

// Steel cloud browser + MCP interception + CLI human-in-the-loop
export {
  SteelSessionManager,
  logSessionViewer,
  buildCdpEndpoint,
  buildLiveViewUrl,
  type SteelSession,
  type SteelSessionOptions,
} from "./steel/steelSession.js";
export { redactSecrets, redactArgs, SENSITIVE_QUERY_PARAMS } from "./util/redact.js";
export { resolveMcpLaunch, type McpLaunch, type McpLaunchOptions } from "./mcp/playwrightMcp.js";
export {
  GuardedMcpClient,
  cliGuardPrompt,
  type GuardedMcpClientOptions,
  type GuardPrompt,
  type GuardVerdict,
  type InterceptionRecord,
} from "./mcp/guardedMcpClient.js";
export {
  isGuardedAction,
  describeToolCall,
  buildDenialMessage,
  DEFAULT_SUBMIT_KEYWORDS,
  type GuardMatch,
} from "./hitl/submitGuard.js";
export { createHumanQuestionHandler, NO_ANSWER_SENTINEL } from "./hitl/humanQuestion.js";

export interface RunJobAutofillOptions {
  mcpCommand?: string;
  mcpArgs?: string[];
  onHumanQuestion?: HumanInterceptionHandler;
  keepOpen?: boolean;
}

export async function runJobAutofill(
  jobUrl: string,
  options: RunJobAutofillOptions = {}
) {
  const { keepOpen = true } = options;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ Error: ANTHROPIC_API_KEY is not set.");
    console.error("Please set ANTHROPIC_API_KEY in your .env file or environment variables.");
    process.exit(1);
  }

  const mcpClient = new PlaywrightMcpClient({
    command: options.mcpCommand,
    args: options.mcpArgs,
  });

  const agent = new AgentLoop(mcpClient);

  // Setup graceful cleanup
  const cleanup = async () => {
    console.log("\n[Main] Gracefully shutting down...");
    await mcpClient.disconnect();
    contextStore.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    const result = await agent.run({
      jobUrl,
      onHumanQuestion: options.onHumanQuestion,
    });

    console.log("\n[Main] Execution finished with result:", result);

    if (keepOpen && process.stdin.isTTY) {
      console.log("\n" + "=".repeat(60));
      console.log("The application page is left open for your review and submission.");
      console.log("👉 Press [Enter] in this terminal when finished to close the browser...");
      console.log("=".repeat(60) + "\n");

      const rl = readline.createInterface({ input, output });
      try {
        await rl.question("");
      } finally {
        rl.close();
      }
    }

    return result;
  } finally {
    await mcpClient.disconnect();
    contextStore.close();
  }
}

// Direct CLI execution: npx tsx src/index.ts <jobUrl>
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("src/index.ts") || process.argv[1].endsWith("src/index.js"));

if (isDirectExecution) {
  const targetUrl = process.argv[2] || "https://boards.greenhouse.io/embed/job_app?for=test&token=12345";
  console.log(`Starting Job Autofill CLI for: ${targetUrl}`);

  runJobAutofill(targetUrl).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
