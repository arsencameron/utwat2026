/**
 * Integration tests for the Steel REST calls, run against a local stand-in for
 * api.steel.dev so the real request/response handling is exercised end to end.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SteelSessionManager } from "../src/steel/steelSession.js";

interface RecordedRequest {
  method: string;
  url: string;
  apiKeyHeader: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

let server: http.Server;
let apiUrl: string;
let requests: RecordedRequest[] = [];
/** Lets a test make the fake Steel API misbehave. */
let respond: (req: RecordedRequest, res: http.ServerResponse) => void;

function defaultRespond(req: RecordedRequest, res: http.ServerResponse): void {
  if (req.method === "POST" && req.url === "/v1/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "sess-123",
        status: "live",
        websocketUrl: "wss://connect.steel.dev?sessionId=sess-123",
        debugUrl: "https://app.steel.dev/debug/sess-123",
        sessionViewerUrl: "https://app.steel.dev/v1/sessions/sess-123",
      })
    );
    return;
  }
  if (req.method === "POST" && req.url.endsWith("/release")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  res.writeHead(404);
  res.end();
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const recorded: RecordedRequest = {
        method: req.method || "",
        url: req.url || "",
        apiKeyHeader: req.headers["steel-api-key"] as string | undefined,
        contentType: req.headers["content-type"],
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(recorded);
      respond(recorded, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeManager(overrides: Record<string, unknown> = {}) {
  requests = [];
  respond = defaultRespond;
  return new SteelSessionManager({ apiKey: "ste-test-key", apiUrl, ...overrides });
}

describe("SteelSessionManager against a live HTTP endpoint", () => {
  test("creates a session and derives the CDP + viewer URLs", async () => {
    const manager = makeManager({ sessionTimeoutMs: 60_000 });
    const session = await manager.create();

    assert.equal(session.id, "sess-123");
    assert.equal(session.liveViewUrl, "https://app.steel.dev/v1/sessions/sess-123");

    const cdp = new URL(session.cdpEndpoint);
    assert.equal(cdp.protocol, "wss:");
    assert.equal(cdp.searchParams.get("sessionId"), "sess-123");
    assert.equal(cdp.searchParams.get("apiKey"), "ste-test-key");

    const [created] = requests;
    assert.equal(created?.method, "POST");
    assert.equal(created?.url, "/v1/sessions");
    assert.equal(created?.apiKeyHeader, "ste-test-key");
    assert.match(created?.contentType ?? "", /application\/json/);
    assert.deepEqual(created?.body, { sessionTimeout: 60_000, blockAds: true });
  });

  test("forwards proxy, captcha and saved-context options", async () => {
    const manager = makeManager({
      useProxy: true,
      solveCaptcha: true,
      blockAds: false,
      contextId: "ctx-42",
    });
    await manager.create();

    assert.deepEqual(requests[0]?.body, {
      sessionTimeout: 900_000,
      blockAds: false,
      useProxy: true,
      solveCaptcha: true,
      sessionContext: { id: "ctx-42" },
    });
  });

  test("reuses the session instead of creating a second one", async () => {
    const manager = makeManager();
    const first = await manager.create();
    const second = await manager.create();

    assert.equal(first.id, second.id);
    assert.equal(requests.length, 1, "create() must be idempotent");
  });

  test("releases the session and is safe to call twice", async () => {
    const manager = makeManager();
    await manager.create();
    await manager.release();
    await manager.release();

    const releases = requests.filter((r) => r.url.endsWith("/release"));
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.url, "/v1/sessions/sess-123/release");
    assert.equal(releases[0]?.apiKeyHeader, "ste-test-key");
    assert.equal(manager.session, null);
  });

  test("surfaces an API error with its status and body", async () => {
    const manager = makeManager();
    respond = (_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid api key" }));
    };

    await assert.rejects(() => manager.create(), /401/);
    await assert.rejects(() => manager.create(), /invalid api key/);
  });

  test("rejects a response with no session id", async () => {
    const manager = makeManager();
    respond = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "live" }));
    };

    await assert.rejects(() => manager.create(), /without an id/);
  });

  test("a failed release does not throw", async () => {
    const manager = makeManager();
    await manager.create();
    respond = (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    };

    await manager.release();
    assert.equal(manager.session, null);
  });
});
