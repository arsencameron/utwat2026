import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "test";
const { server } = await import("../src/server.js");
const { contextStore } = await import("../src/db/contextStore.js");

describe("Server Q&A Memory and DB API", () => {
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test("GET /api/qa returns an array of Q&A items", async () => {
    const res = await fetch(`${baseUrl}/api/qa`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  test("POST /api/qa creates a new Q&A record", async () => {
    const res = await fetch(`${baseUrl}/api/qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Do you prefer tabs or spaces?",
        answer: "Spaces (2 spaces)",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);

    const answer = contextStore.findAnswer("Do you prefer tabs or spaces?");
    assert.equal(answer, "Spaces (2 spaces)");
  });

  test("PUT /api/qa/:id updates an existing Q&A record", async () => {
    const records = contextStore.getAllQA();
    const item = records.find((r) => r.raw_question === "Do you prefer tabs or spaces?");
    assert.ok(item, "Record should exist in store");

    const res = await fetch(`${baseUrl}/api/qa/${item.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Tabs or spaces for indentation?",
        answer: "Spaces always",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const updated = contextStore.getQAById(item.id);
    assert.equal(updated?.raw_question, "Tabs or spaces for indentation?");
    assert.equal(updated?.answer, "Spaces always");
  });

  test("DELETE /api/qa/:id deletes the Q&A record", async () => {
    const records = contextStore.getAllQA();
    const item = records.find((r) => r.answer === "Spaces always");
    assert.ok(item);

    const res = await fetch(`${baseUrl}/api/qa/${item.id}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const check = contextStore.getQAById(item.id);
    assert.equal(check, undefined);
  });

  test("GET /api/db/export returns JSON backup", async () => {
    const res = await fetch(`${baseUrl}/api/db/export`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.profile);
    assert.ok(Array.isArray(data.qaMemory));
  });

  test("POST /api/db/import imports Q&A batch", async () => {
    const res = await fetch(`${baseUrl}/api/db/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        qaMemory: [
          { question: "What is your GitHub username?", answer: "arsencameron" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.qaImportedCount >= 1);

    const found = contextStore.findAnswer("GitHub username");
    assert.equal(found, "arsencameron");
  });

  test("POST /api/status updates status to interrupt", async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "interrupt" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.status, "interrupted");

    const statusRes = await fetch(`${baseUrl}/api/status`);
    const statusData = await statusRes.json();
    assert.equal(statusData.status, "interrupted");
  });

  test("POST /api/interrupt returns 400 when no task is running", async () => {
    const res = await fetch(`${baseUrl}/api/interrupt`, {
      method: "POST",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("No agent task"));
  });
});
