import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../src/agent/agentLoop.js";
import { PlaywrightMcpClient } from "../src/agent/mcpClient.js";

describe("AgentLoop", () => {
  test("initializes with options and mock api key", () => {
    const mcpClient = new PlaywrightMcpClient({
      command: "echo",
      args: ["test"],
    });

    const agent = new AgentLoop(mcpClient, {
      apiKey: "test-api-key",
      defaultModel: "claude-3-5-sonnet-20241022",
    });

    assert.ok(agent);
  });
});
