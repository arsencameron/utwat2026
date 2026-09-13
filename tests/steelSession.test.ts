import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  buildCdpEndpoint,
  buildLiveViewUrl,
  SteelSessionManager,
} from "../src/steel/steelSession.js";
import { redactSecrets, redactArgs } from "../src/util/redact.js";
import { resolveMcpLaunch } from "../src/mcp/playwrightMcp.js";

describe("buildCdpEndpoint", () => {
  test("adds sessionId and apiKey to the connect host", () => {
    const url = new URL(
      buildCdpEndpoint({
        sessionId: "abc-123",
        connectUrl: "wss://connect.steel.dev",
        apiKey: "sk-steel-test",
      })
    );

    assert.equal(url.protocol, "wss:");
    assert.equal(url.host, "connect.steel.dev");
    assert.equal(url.searchParams.get("sessionId"), "abc-123");
    assert.equal(url.searchParams.get("apiKey"), "sk-steel-test");
  });

  test("prefers the websocketUrl Steel returned and keeps its params", () => {
    const url = new URL(
      buildCdpEndpoint({
        sessionId: "abc-123",
        websocketUrl: "wss://connect.steel.dev?sessionId=from-api",
        connectUrl: "wss://connect.steel.dev",
        apiKey: "sk-steel-test",
      })
    );

    assert.equal(url.searchParams.get("sessionId"), "from-api");
    assert.equal(url.searchParams.get("apiKey"), "sk-steel-test");
  });

  test("keeps the long-lived API key out of the URL when Steel issued a token", () => {
    // The real API returns websocketUrl with a session-scoped token, which is
    // enough to connect. The URL becomes argv, so the key must not ride along.
    const url = new URL(
      buildCdpEndpoint({
        sessionId: "abc-123",
        websocketUrl: "wss://connect.steel.dev?sessionId=abc-123&token=jwt-value",
        apiKey: "ste-secret-key",
      })
    );

    assert.equal(url.searchParams.get("token"), "jwt-value");
    assert.equal(url.searchParams.has("apiKey"), false);
    assert.equal(url.toString().includes("ste-secret-key"), false);
  });

  test("omits apiKey for a self-hosted Steel with no key", () => {
    const url = new URL(
      buildCdpEndpoint({ sessionId: "local-1", connectUrl: "ws://localhost:3000" })
    );

    assert.equal(url.searchParams.has("apiKey"), false);
    assert.equal(url.searchParams.get("sessionId"), "local-1");
  });
});

describe("buildLiveViewUrl", () => {
  test("uses the session viewer URL when present", () => {
    assert.equal(
      buildLiveViewUrl("s1", { sessionViewerUrl: "https://app.steel.dev/v1/sessions/s1" }),
      "https://app.steel.dev/v1/sessions/s1"
    );
  });

  test("falls back to debugUrl, then to the dashboard path", () => {
    assert.equal(buildLiveViewUrl("s1", { debugUrl: "https://debug.example/s1" }), "https://debug.example/s1");
    assert.equal(buildLiveViewUrl("s1", {}), "https://app.steel.dev/sessions/s1");
  });
});

describe("redactSecrets", () => {
  test("masks the API key before the CDP URL is printed", () => {
    const redacted = redactSecrets("wss://connect.steel.dev/?sessionId=s1&apiKey=sk-secret");
    assert.match(redacted, /apiKey=\*\*\*/);
    assert.equal(redacted.includes("sk-secret"), false);
  });

  test("masks the Steel session token, which is also a credential", () => {
    const redacted = redactSecrets("wss://connect.steel.dev/?sessionId=s1&token=eyJhbGciOi.secret.sig");
    assert.match(redacted, /token=\*\*\*/);
    assert.equal(redacted.includes("eyJhbGciOi"), false);
    assert.equal(new URL(redacted).searchParams.get("sessionId"), "s1", "non-secret params survive");
  });

  test("masks every sensitive param at once, regardless of case", () => {
    const redacted = redactSecrets("https://h/x?apiKey=a&TOKEN=b&access_token=c&password=d&page=2");
    for (const secret of ["a", "b", "c", "d"]) {
      assert.equal(redacted.includes(`=${secret}&`), false);
      assert.equal(redacted.endsWith(`=${secret}`), false);
    }
    assert.equal(new URL(redacted).searchParams.get("page"), "2");
  });

  test("returns non-URL and secret-free input unchanged", () => {
    assert.equal(redactSecrets("not a url"), "not a url");
    assert.equal(redactSecrets("https://example.com/?page=2"), "https://example.com/?page=2");
  });

  test("redactArgs masks a CDP endpoint inside a command line", () => {
    const args = redactArgs(["-y", "@playwright/mcp", "--cdp-endpoint", "wss://h/?token=jwt-secret"]);
    assert.deepEqual(args.slice(0, 3), ["-y", "@playwright/mcp", "--cdp-endpoint"]);
    assert.equal(args[3]?.includes("jwt-secret"), false);
    assert.match(args[3] ?? "", /token=\*\*\*/);
  });
});

describe("SteelSessionManager", () => {
  test("reports whether an API key is configured", () => {
    assert.equal(new SteelSessionManager({ apiKey: "sk-steel-test" }).hasApiKey, true);
  });

  test("create() fails fast without an API key", async () => {
    // An empty string is an explicit "no key" and must not fall back to the env.
    const manager = new SteelSessionManager({ apiKey: "" });
    assert.equal(manager.hasApiKey, false);
    await assert.rejects(() => manager.create(), /STEEL_API_KEY/);
  });

  test("release() is a no-op when no session was created", async () => {
    await new SteelSessionManager({ apiKey: "sk-steel-test" }).release();
  });
});

describe("resolveMcpLaunch", () => {
  // A developer shell may already export these; the defaults must be tested clean.
  const saved = {
    args: process.env.PLAYWRIGHT_MCP_ARGS,
    command: process.env.PLAYWRIGHT_MCP_COMMAND,
    pkg: process.env.PLAYWRIGHT_MCP_PACKAGE,
  };

  beforeEach(() => {
    delete process.env.PLAYWRIGHT_MCP_ARGS;
    delete process.env.PLAYWRIGHT_MCP_COMMAND;
    delete process.env.PLAYWRIGHT_MCP_PACKAGE;
  });

  after(() => {
    if (saved.args !== undefined) process.env.PLAYWRIGHT_MCP_ARGS = saved.args;
    if (saved.command !== undefined) process.env.PLAYWRIGHT_MCP_COMMAND = saved.command;
    if (saved.pkg !== undefined) process.env.PLAYWRIGHT_MCP_PACKAGE = saved.pkg;
  });

  test("attaches to the Steel session over CDP", () => {
    const launch = resolveMcpLaunch({ cdpEndpoint: "wss://connect.steel.dev/?sessionId=s1" });

    assert.equal(launch.command, "npx");
    assert.ok(launch.args.includes("@playwright/mcp"));
    const index = launch.args.indexOf("--cdp-endpoint");
    assert.ok(index >= 0);
    assert.equal(launch.args[index + 1], "wss://connect.steel.dev/?sessionId=s1");
    assert.equal(launch.args.includes("--headless"), false);
  });

  test("runs a local headless browser when there is no CDP endpoint", () => {
    const launch = resolveMcpLaunch({});
    assert.ok(launch.args.includes("--headless"));
  });

  test("runs a local headed browser when asked", () => {
    const launch = resolveMcpLaunch({ headed: true });
    assert.equal(launch.args.includes("--headless"), false);
  });

  test("PLAYWRIGHT_MCP_ARGS overrides everything", () => {
    const previous = process.env.PLAYWRIGHT_MCP_ARGS;
    process.env.PLAYWRIGHT_MCP_ARGS = '["custom-server","--flag"]';
    try {
      const launch = resolveMcpLaunch({ cdpEndpoint: "wss://ignored" });
      assert.deepEqual(launch.args, ["custom-server", "--flag"]);
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_MCP_ARGS;
      else process.env.PLAYWRIGHT_MCP_ARGS = previous;
    }
  });
});
