import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GuardedMcpClient, type GuardVerdict } from "../src/mcp/guardedMcpClient.js";

interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** Builds a client whose MCP dispatch and human prompt are both faked. */
function makeClient(verdicts: GuardVerdict[]) {
  const executed: Call[] = [];
  const prompted: Call[] = [];
  const queue = [...verdicts];

  const client = new GuardedMcpClient({
    executor: async (name, args) => {
      executed.push({ name, args });
      return { content: `ran ${name}`, isError: false };
    },
    prompt: async ({ toolName, args }) => {
      prompted.push({ name: toolName, args });
      return queue.shift() ?? "deny";
    },
  });

  return { client, executed, prompted };
}

describe("GuardedMcpClient", () => {
  test("passes ordinary tool calls straight through without prompting", async () => {
    const { client, executed, prompted } = makeClient([]);

    const result = await client.callTool("browser_snapshot", {});

    assert.equal(result.isError, false);
    assert.equal(result.content, "ran browser_snapshot");
    assert.equal(executed.length, 1);
    assert.equal(prompted.length, 0);
    assert.equal(client.interceptions.length, 0);
  });

  test("blocks a denied Submit click and tells Claude to report instead", async () => {
    const { client, executed, prompted } = makeClient(["deny"]);

    const result = await client.callTool("browser_click", {
      element: "Submit application",
      ref: "e42",
    });

    assert.equal(prompted.length, 1);
    assert.equal(executed.length, 0, "the click must never reach the MCP server");
    assert.equal(result.isError, true);
    assert.match(result.content, /BLOCKED BY HUMAN OPERATOR/);
    assert.match(result.content, /report_completion/);
    assert.deepEqual(
      client.interceptions.map((i) => i.verdict),
      ["deny"]
    );
  });

  test("forwards a Submit click the human approves", async () => {
    const { client, executed } = makeClient(["allow"]);

    const result = await client.callTool("browser_click", { element: "Submit", ref: "e9" });

    assert.equal(result.isError, false);
    assert.equal(executed.length, 1);
    assert.equal(executed[0]?.name, "browser_click");
  });

  test("'allow all' approves later guarded calls without re-prompting", async () => {
    const { client, executed, prompted } = makeClient(["allow-all"]);

    await client.callTool("browser_click", { element: "Submit application", ref: "e1" });
    await client.callTool("browser_click", { element: "Submit application", ref: "e2" });

    assert.equal(prompted.length, 1, "only the first guarded call prompts");
    assert.equal(executed.length, 2);
    assert.deepEqual(
      client.interceptions.map((i) => i.verdict),
      ["allow-all", "allow-all"]
    );
  });

  test("autoApprove skips the prompt entirely", async () => {
    const executed: Call[] = [];
    const client = new GuardedMcpClient({
      autoApprove: true,
      executor: async (name, args) => {
        executed.push({ name, args });
        return { content: "ok", isError: false };
      },
      prompt: async () => {
        throw new Error("prompt must not be called when autoApprove is set");
      },
    });

    const result = await client.callTool("browser_click", { element: "Submit", ref: "e3" });

    assert.equal(result.isError, false);
    assert.equal(executed.length, 1);
    assert.equal(client.interceptions[0]?.verdict, "auto-approved");
  });
});
