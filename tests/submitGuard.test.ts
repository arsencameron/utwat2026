import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isGuardedAction,
  describeToolCall,
  collectStrings,
  buildDenialMessage,
  lookupRefLabel,
} from "../src/hitl/submitGuard.js";

const SNAPSHOT = `- generic [ref=e1]:
  - heading "Apply" [level=1] [ref=e2]
  - textbox "Email" [ref=e5]
  - button "Submit application" [ref=e16] [cursor=pointer]`;

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

  test("guards browser_type with submit:true, which presses Enter", () => {
    const match = isGuardedAction("browser_type", {
      element: "Cover letter",
      target: "e5",
      text: "hello",
      submit: true,
    });
    assert.equal(match.guarded, true);
    assert.match(match.reason, /submit:true/);
  });

  test("lets ordinary typing through", () => {
    const match = isGuardedAction("browser_type", { element: "Cover letter", target: "e5", text: "hi" });
    assert.equal(match.guarded, false);
  });

  test("guards browser_evaluate that submits or clicks", () => {
    for (const code of [
      "() => document.forms[0].submit()",
      "() => document.querySelector('form').requestSubmit()",
      "() => document.querySelector('[type=submit]').click()",
      "async (page) => page.getByRole('button', { name: 'Submit' })",
    ]) {
      assert.equal(isGuardedAction("browser_evaluate", { function: code }).guarded, true, code);
    }
  });

  test("lets harmless browser_evaluate through", () => {
    const match = isGuardedAction("browser_evaluate", { function: "() => document.title" });
    assert.equal(match.guarded, false);
  });

  test("always guards browser_run_code_unsafe, whatever the code", () => {
    const match = isGuardedAction("browser_run_code_unsafe", { code: "async (page) => page.title()" });
    assert.equal(match.guarded, true);
    assert.match(match.reason, /arbitrary browser code/);
  });

  test("catches a submit button the model described misleadingly", () => {
    // The model calls it "final action button"; the page calls it Submit.
    const match = isGuardedAction(
      "browser_click",
      { element: "final action button", target: "e16" },
      { resolvedLabel: 'button "Submit application"' }
    );
    assert.equal(match.guarded, true);
    assert.match(match.reason, /the page calls this element/);
    assert.match(match.label, /page says button "Submit application"/);
  });

  test("a resolved label that is harmless does not trigger the guard", () => {
    const match = isGuardedAction(
      "browser_click",
      { element: "Next", target: "e4" },
      { resolvedLabel: 'button "Next"' }
    );
    assert.equal(match.guarded, false);
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

  test("lookupRefLabel resolves a ref to the page's own wording", () => {
    assert.equal(lookupRefLabel(SNAPSHOT, "e16"), 'button "Submit application"');
    assert.equal(lookupRefLabel(SNAPSHOT, "e5"), 'textbox "Email"');
  });

  test("lookupRefLabel returns null for unknown or empty input", () => {
    assert.equal(lookupRefLabel(SNAPSHOT, "e99"), null);
    assert.equal(lookupRefLabel("", "e16"), null);
    assert.equal(lookupRefLabel(SNAPSHOT, ""), null);
  });

  test("lookupRefLabel does not let a ref prefix match a longer ref", () => {
    // `e1` is a prefix of `e16`; resolving it must not return e16's button.
    assert.equal(lookupRefLabel(SNAPSHOT, "e1"), null);
  });

  test("denial message tells Claude to stop and report", () => {
    const message = buildDenialMessage("browser_click", "Submit application");
    assert.match(message, /BLOCKED BY HUMAN OPERATOR/);
    assert.match(message, /report_completion/);
    assert.match(message, /Do NOT retry/);
  });
});
