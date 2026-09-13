import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveAutoApprove } from "../src/cli/flags.js";

describe("parseArgs", () => {
  test("defaults: cloud browser, guarded, session kept alive", () => {
    const flags = parseArgs(["https://jobs.example.com/apply"]);
    assert.equal(flags.jobUrl, "https://jobs.example.com/apply");
    assert.equal(flags.local, false);
    assert.equal(flags.autoApprove, false);
    assert.equal(flags.offerSubmit, false);
    assert.equal(flags.keepAlive, true);
    assert.equal(flags.maxTurns, undefined);
  });

  test("reads every flag regardless of order", () => {
    const flags = parseArgs([
      "--offer-submit",
      "--local",
      "https://jobs.example.com/apply",
      "--headed",
      "--no-keep-alive",
      "--auto-approve",
      "--max-turns=7",
    ]);
    assert.equal(flags.jobUrl, "https://jobs.example.com/apply");
    assert.equal(flags.local, true);
    assert.equal(flags.headed, true);
    assert.equal(flags.autoApprove, true);
    assert.equal(flags.offerSubmit, true);
    assert.equal(flags.keepAlive, false);
    assert.equal(flags.maxTurns, 7);
  });

  test("takes the first positional as the URL and ignores later ones", () => {
    const flags = parseArgs(["https://first.example", "https://second.example"]);
    assert.equal(flags.jobUrl, "https://first.example");
  });

  test("ignores a nonsensical --max-turns instead of passing NaN through", () => {
    assert.equal(parseArgs(["u", "--max-turns=abc"]).maxTurns, undefined);
    assert.equal(parseArgs(["u", "--max-turns=0"]).maxTurns, undefined);
    assert.equal(parseArgs(["u", "--max-turns=-3"]).maxTurns, undefined);
    assert.equal(parseArgs(["u", "--max-turns=5.9"]).maxTurns, 5);
  });

  test("recognises both help spellings", () => {
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--help"]).help, true);
  });
});

describe("resolveAutoApprove", () => {
  test("the flag alone enables it", () => {
    assert.equal(resolveAutoApprove({ autoApprove: true }, {}), true);
  });

  test("HITL_AUTO_APPROVE=true enables it without the flag", () => {
    // Regression: the flag parser yields `false`, which used to mask the env
    // var entirely when it was passed down to the guarded client.
    assert.equal(resolveAutoApprove({ autoApprove: false }, { HITL_AUTO_APPROVE: "true" }), true);
  });

  test("stays off by default and for any other value", () => {
    assert.equal(resolveAutoApprove({ autoApprove: false }, {}), false);
    assert.equal(resolveAutoApprove({ autoApprove: false }, { HITL_AUTO_APPROVE: "1" }), false);
    assert.equal(resolveAutoApprove({ autoApprove: false }, { HITL_AUTO_APPROVE: "false" }), false);
  });
});
