import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PlaywrightMcpClient } from "../src/agent/mcpClient.js";

describe("PlaywrightMcpClient", () => {
  test("initializes with default options and environment overrides", () => {
    const client = new PlaywrightMcpClient();
    assert.equal(client.isConnected, false);
  });

  test("accepts custom command, args, and environment", () => {
    const client = new PlaywrightMcpClient({
      command: "node",
      args: ["./customMcpServer.js"],
      env: { CUSTOM_VAR: "1" },
      clientName: "test-client",
      clientVersion: "2.0.0",
    });

    assert.equal(client.isConnected, false);
  });
});
