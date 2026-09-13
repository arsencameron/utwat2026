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

  test("prompts to extend turns when max turns reached and stops if user says no", async () => {
    const mcpClient = {
      isConnected: true,
      connect: async () => {},
      disconnect: async () => {},
      getAnthropicTools: async () => [],
      callTool: async () => "ok",
    } as unknown as PlaywrightMcpClient;

    const agent = new AgentLoop(mcpClient, { apiKey: "test-key" });

    // Mock Anthropic messages create to return a tool_use that doesn't complete
    let turnCount = 0;
    // @ts-expect-error mock private anthropic
    agent.anthropic = {
      messages: {
        create: async () => {
          turnCount++;
          return {
            id: `msg_${turnCount}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "working..." }],
            model: "mock-model",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };

    let askedQuestion = "";
    const result = await agent.run({
      jobUrl: "https://example.com/job",
      maxTurns: 1,
      onHumanQuestion: async (q) => {
        askedQuestion = q;
        return "no";
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.turns, 1);
  });

  test("extends execution turns when user specifies additional turns", async () => {
    const mcpClient = {
      isConnected: true,
      connect: async () => {},
      disconnect: async () => {},
      getAnthropicTools: async () => [
        {
          name: "dummy_action",
          description: "dummy",
          input_schema: { type: "object" },
        },
      ],
      callTool: async () => "action done",
    } as unknown as PlaywrightMcpClient;

    const agent = new AgentLoop(mcpClient, { apiKey: "test-key" });

    let callCount = 0;
    // @ts-expect-error mock private anthropic
    agent.anthropic = {
      messages: {
        create: async () => {
          callCount++;
          if (callCount === 1) {
            // Turn 1: tool use, doesn't complete
            return {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "tool_use", id: "t1", name: "dummy_action", input: {} }],
              model: "mock",
              stop_reason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
          // Turn 2 (extended): calls report_completion
          return {
            id: "msg_2",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t2",
                name: "report_completion",
                input: { summary: "All fields filled", readyForSubmission: true },
              },
            ],
            model: "mock",
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };

    let promptEncountered = false;
    const result = await agent.run({
      jobUrl: "https://example.com/job",
      maxTurns: 1, // initial limit of 1 turn
      onHumanQuestion: async (_q, context) => {
        if (context === "max_turns_prompt") {
          promptEncountered = true;
          return "1"; // grant 1 additional turn
        }
        return "answer";
      },
    });

    assert.equal(promptEncountered, true, "Should have prompted when turn limit of 1 was hit");
    assert.equal(result.success, true, "Should have succeeded on the extended turn");
    assert.equal(result.turns, 2, "Should have executed 2 turns total");
    assert.equal(result.summary, "All fields filled");
  });
});
