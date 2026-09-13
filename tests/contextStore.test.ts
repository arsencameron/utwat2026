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
    assert.equal(typeof profile.fullName, "string");
    assert.equal(typeof profile.email, "string");
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

  test("handles null or undefined fields safely in updateProfile without NOT NULL error", () => {
    // @ts-expect-error simulating LLM returning null for unknown fields
    store.updateProfile({
      fullName: "Arsen Cameron",
      workAuthorization: null,
      defaultCoverLetter: null,
    });

    const updated = store.getProfile();
    assert.equal(updated.fullName, "Arsen Cameron");
    assert.equal(typeof updated.workAuthorization, "string");
    assert.equal(typeof updated.defaultCoverLetter, "string");
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

  test("retrieves single QA record by id and updates answer", () => {
    const records = store.getAllQA();
    const target = records[0];
    assert.ok(target, "Record should exist");

    const fetched = store.getQAById(target.id);
    assert.equal(fetched?.id, target.id);

    const updated = store.updateQA(target.id, "Updated Answer Value");
    assert.equal(updated, true);

    const check = store.getQAById(target.id);
    assert.equal(check?.answer, "Updated Answer Value");
  });

  test("updates both question and answer in QA memory", () => {
    store.saveAnswer("What is your favorite language?", "TypeScript");
    const found = store.getAllQA().find((r) => r.raw_question === "What is your favorite language?");
    assert.ok(found);

    store.updateQA(found.id, "Rust and TypeScript", "What is your top programming language?");
    const updated = store.getQAById(found.id);
    assert.equal(updated?.raw_question, "What is your top programming language?");
    assert.equal(updated?.answer, "Rust and TypeScript");
    assert.equal(store.findAnswer("top programming language"), "Rust and TypeScript");
  });

  test("deletes QA record by id", () => {
    store.saveAnswer("Temporary question to delete", "Temporary answer");
    const rec = store.getAllQA().find((r) => r.raw_question === "Temporary question to delete");
    assert.ok(rec);

    const deleted = store.deleteQA(rec.id);
    assert.equal(deleted, true);
    assert.equal(store.getQAById(rec.id), undefined);
  });

  test("exports data and imports batch Q&A records", () => {
    const exported = store.exportData();
    assert.ok(exported.profile);
    assert.ok(Array.isArray(exported.qaMemory));

    const importedCount = store.importQA([
      { question: "Notice period?", answer: "2 weeks" },
      { question: "Preferred work arrangement?", answer: "Hybrid or Remote" },
    ]);
    assert.equal(importedCount, 2);
    assert.equal(store.findAnswer("notice period"), "2 weeks");
    assert.equal(store.findAnswer("work arrangement"), "Hybrid or Remote");
  });
});
