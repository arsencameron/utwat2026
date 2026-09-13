/**
 * End-to-end check of the human-in-the-loop safety guard.
 *
 * Runs the real AgentLoop against a real @playwright/mcp server and a real
 * browser, with a scripted stand-in for the Anthropic API playing the part of
 * a model that tries to submit the application. Proves that:
 *   - the Submit click is intercepted before it reaches the browser,
 *   - Claude receives the denial and falls back to report_completion,
 *   - the missing-information prompt round-trips an answer into the loop.
 *
 * Excluded from `npm test` (it needs Playwright browsers). Run it with:
 *   npm run test:e2e
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { buildDenialMessage } from "../../src/hitl/submitGuard.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const JOB_PAGE = `<!doctype html><html><body>
<h1>Apply: Senior Engineer</h1>
<form>
  <label>First name <input name="first" /></label>
  <label>Email <input name="email" /></label>
  <label>Salary expectations <input name="salary" /></label>
  <button type="submit">Submit application</button>
</form>
</body></html>`;

const SALARY_QUESTION = "What are your salary expectations?";
const HUMAN_ANSWER = "USD 180,000 base";

interface ScriptedMessage {
  stop_reason: string;
  content: unknown[];
}

/** The assistant turns the fake API replays, in order. */
function scriptedTurns(jobUrl: string): ScriptedMessage[] {
  const tool = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

  return [
    { stop_reason: "tool_use", content: [tool("t1", "browser_navigate", { url: jobUrl })] },
    { stop_reason: "tool_use", content: [tool("t2", "browser_snapshot", {})] },
    {
      stop_reason: "tool_use",
      content: [tool("t3", "ask_human_and_save", { question: SALARY_QUESTION, context: "Text field" })],
    },
    {
      stop_reason: "tool_use",
      content: [tool("t4", "browser_click", { element: "Submit application button", ref: "e99" })],
    },
    {
      stop_reason: "tool_use",
      content: [
        tool("t5", "report_completion", {
          summary: "Filled name and email; salary from human answer.",
          readyForSubmission: false,
        }),
      ],
    },
  ];
}

function envelope(message: ScriptedMessage) {
  return {
    id: "msg_" + Math.random().toString(36).slice(2),
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet-20241022",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...message,
  };
}

/** Finds the tool_result block for a given tool_use id across all captured requests. */
function findToolResult(bodies: string[], toolUseId: string): { content?: string; is_error?: boolean } | null {
  for (const body of bodies) {
    let parsed: { messages?: { content?: unknown }[] };
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    for (const message of parsed.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Record<string, unknown>[]) {
        if (block?.type === "tool_result" && block.tool_use_id === toolUseId) {
          return { content: String(block.content ?? ""), is_error: Boolean(block.is_error) };
        }
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const bodies: string[] = [];
  let turn = 0;
  let turns: ScriptedMessage[] = [];

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/job") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(JOB_PAGE);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString());
        const next = turns[turn++] ?? { stop_reason: "end_turn", content: [] };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(envelope(next)));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jobUrl = `${base}/job`;
  turns = scriptedTurns(jobUrl);

  // Point the Anthropic SDK at the fake API, and keep SQLite writes in a temp
  // directory so the repo's real question memory is never touched.
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "utwat-e2e-"));
  process.chdir(workdir);

  const { GuardedMcpClient } = await import(`${PROJECT_ROOT}/src/mcp/guardedMcpClient.js`);
  const { resolveMcpLaunch } = await import(`${PROJECT_ROOT}/src/mcp/playwrightMcp.js`);
  const { createHumanQuestionHandler } = await import(`${PROJECT_ROOT}/src/hitl/humanQuestion.js`);
  const { AgentLoop } = await import(`${PROJECT_ROOT}/src/agent/agentLoop.js`);
  const { contextStore } = await import(`${PROJECT_ROOT}/src/db/contextStore.js`);

  // No `prompt` override: this exercises the shipped default, which must block
  // when there is no TTY rather than hang or allow.
  const client = new GuardedMcpClient({
    ...resolveMcpLaunch({}),
    liveViewUrl: "https://app.steel.dev/sessions/fake",
  });

  // The shipped CLI handler with no TTY must refuse to invent an answer.
  const sentinel = await createHumanQuestionHandler({ liveViewUrl: null })(SALARY_QUESTION);

  const askedQuestions: string[] = [];
  const result = await new AgentLoop(client).run({
    jobUrl,
    // Stands in for the operator typing an answer at the CLI prompt.
    onHumanQuestion: async (question: string) => {
      askedQuestions.push(question);
      return HUMAN_ANSWER;
    },
  });

  const savedAnswer = contextStore.findAnswer(SALARY_QUESTION);

  await client.disconnect();
  contextStore.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workdir, { recursive: true, force: true });

  const submitResult = findToolResult(bodies, "t4");
  const navigateResult = findToolResult(bodies, "t1");
  const snapshotResult = findToolResult(bodies, "t2");
  const questionResult = findToolResult(bodies, "t3");

  const checks: [string, boolean][] = [
    ["loop reported success", result.success === true],
    ["report_completion summary returned", result.summary.includes("Filled name and email")],
    // browser_navigate reports the URL it landed on and writes the snapshot to
    // a file; browser_snapshot is the one that inlines the accessibility tree.
    [
      "browser really navigated to the job page",
      (navigateResult?.content ?? "").includes(`Page URL: ${jobUrl}`) &&
        (navigateResult?.content ?? "").includes("await page.goto"),
    ],
    ["snapshot really saw the page heading", (snapshotResult?.content ?? "").includes("Apply: Senior Engineer")],
    ["snapshot really saw the Submit button", (snapshotResult?.content ?? "").includes('button "Submit application"')],
    ["exactly one interception", client.interceptions.length === 1],
    ["the Submit click was denied", client.interceptions[0]?.verdict === "deny"],
    ["interception names the Submit button", client.interceptions[0]?.label === "Submit application button (ref=e99)"],
    ["Claude got a denial, not a click result", (submitResult?.content ?? "").includes("BLOCKED BY HUMAN OPERATOR")],
    ["denial was flagged as an error", submitResult?.is_error === true],
    // Exact match: had the click been dispatched, this would be Playwright's
    // own output (or its error), never the guard's message verbatim.
    [
      "click never reached Playwright",
      submitResult?.content === buildDenialMessage("browser_click", "Submit application button (ref=e99)"),
    ],
    ["denial pointed Claude at report_completion", (submitResult?.content ?? "").includes("report_completion")],
    ["human was asked the missing question", askedQuestions.includes(SALARY_QUESTION)],
    ["CLI handler refuses to invent an answer with no TTY", sentinel.startsWith("UNKNOWN")],
    ["the human answer reached Claude", (questionResult?.content ?? "").includes(HUMAN_ANSWER)],
    ["the human answer was persisted", savedAnswer === HUMAN_ANSWER],
  ];

  console.log("\n================ E2E RESULTS ================");
  const failures = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) {
    console.log(`${ok ? "✅" : "❌"} ${name}`);
  }
  console.log(`turns taken: ${result.turns}, model calls: ${bodies.length}`);
  console.log(`${checks.length - failures.length}/${checks.length} passed`);
  console.log("============================================");
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("e2e failed:", error);
  process.exit(1);
});
