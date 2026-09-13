import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ContextStore } from "../src/db/contextStore.js";

describe("SQLite ContextStore", () => {
  const testDbPath = path.join(process.cwd(), "data", "test_context.db");
  const store = new ContextStore(testDbPath);

  after(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const walPath = `${testDbPath}-wal`;
    const shmPath = `${testDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  test("seeds and retrieves candidate profile", () => {
    const profile = store.getProfile();
    assert.ok(profile, "Profile should exist");
    assert.equal(profile.fullName, "Jane Doe");
    assert.equal(profile.email, "jane.doe@example.com");
    assert.ok(profile.workAuthorization.length > 0);
  });

  test("updates candidate profile fields", () => {
    store.updateProfile({
      portfolioUrl: "https://janedoe.github.io",
      phone: "+1 (555) 999-8888",
    });

    const updated = store.getProfile();
    assert.equal(updated.portfolioUrl, "https://janedoe.github.io");
    assert.equal(updated.phone, "+1 (555) 999-8888");
  });

  test("saves and retrieves exact Q&A answers", () => {
    store.saveAnswer(
      "Are you legally authorized to work in the United States?",
      "Yes, I am a US citizen."
    );

    const answer = store.findAnswer("Are you legally authorized to work in the United States?");
    assert.equal(answer, "Yes, I am a US citizen.");
  });

  test("retrieves fuzzy and token-overlap Q&A answers", () => {
    store.saveAnswer(
      "What is your expected annual salary compensation?",
      "$175,000"
    );

    const fuzzyMatch = store.findAnswer("expected annual salary compensation");
    assert.equal(fuzzyMatch, "$175,000");

    const tokenMatch = store.findAnswer("What is your expected salary?");
    assert.equal(tokenMatch, "$175,000");
  });

  test("returns null for unseen/unrelated questions", () => {
    const answer = store.findAnswer("Do you speak fluent Esperanto?");
    assert.equal(answer, null);
  });

  test("retrieves all stored QA records", () => {
    const records = store.getAllQA();
    assert.ok(records.length >= 2);
  });
});
