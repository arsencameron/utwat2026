import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isGuardedAction,
  describeToolCall,
  collectStrings,
  buildDenialMessage,
} from "../src/hitl/submitGuard.js";

describe("isGuardedAction", () => {
  test("guards a click on a Submit button", () => {
    const match = isGuardedAction("browser_click", {
      element: "Submit application button",
      ref: "e42",
    });
    assert.equal(match.guarded, true);
    assert.match(match.reason, /submit/i);
    assert.equal(match.label, "Submit application button (ref=e42)");
  });

  test("labels the element id from `target`, as @playwright/mcp sends it", () => {
    const match = isGuardedAction("browser_click", {
      target: "e10",
      element: "Submit application button",
    });
    assert.equal(match.guarded, true);
    assert.equal(match.label, "Submit application button (ref=e10)");
  });

  test("guards submit phrasing regardless of case", () => {
    assert.equal(isGuardedAction("browser_click", { element: "SEND APPLICATION" }).guarded, true);
    assert.equal(isGuardedAction("browser_click", { element: "Apply Now" }).guarded, true);
  });

  test("lets ordinary clicks through", () => {
    assert.equal(
      isGuardedAction("browser_click", { element: "Work authorization dropdown", ref: "e7" }).guarded,
      false
    );
    assert.equal(
      isGuardedAction("browser_click", { element: "Apply for this job", ref: "e2" }).guarded,
      false
    );
  });

  test("never guards reads, navigation or fills", () => {
    assert.equal(isGuardedAction("browser_snapshot", {}).guarded, false);
    assert.equal(isGuardedAction("browser_navigate", { url: "https://jobs.example.com/submit" }).guarded, false);
    assert.equal(
      isGuardedAction("browser_fill_form", {
        fields: [{ name: "Submit your GitHub", value: "https://github.com/x" }],
      }).guarded,
      false
    );
  });

  test("guards Enter key presses by default and can be disabled", () => {
    assert.equal(isGuardedAction("browser_press_key", { key: "Enter" }).guarded, true);
    assert.equal(
      isGuardedAction("browser_press_key", { key: "Enter" }, { guardEnterKey: false }).guarded,
      false
    );
    assert.equal(isGuardedAction("browser_press_key", { key: "Tab" }).guarded, false);
  });

  test("honours custom keywords", () => {
    const match = isGuardedAction(
      "browser_click",
      { element: "Bewerbung absenden" },
      { keywords: ["absenden"] }
    );
    assert.equal(match.guarded, true);
  });
});

describe("helpers", () => {
  test("collectStrings walks nested arguments", () => {
    const strings = collectStrings({ a: "one", b: { c: ["two", 3, null] } });
    assert.deepEqual(strings, ["one", "two"]);
  });

  test("describeToolCall falls back to the tool name", () => {
    assert.equal(describeToolCall("browser_click", {}), "browser_click");
  });

  test("denial message tells Claude to stop and report", () => {
    const message = buildDenialMessage("browser_click", "Submit application");
    assert.match(message, /BLOCKED BY HUMAN OPERATOR/);
    assert.match(message, /report_completion/);
    assert.match(message, /Do NOT retry/);
  });
});
