import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findSubmitButtons, chooseSubmitButton } from "../src/cli/submitAssist.js";

/** Shaped like a real @playwright/mcp accessibility snapshot. */
const SNAPSHOT = `### Page
- Page URL: https://jobs.example.com/apply
- Page Title: Apply
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - heading "Apply: Platform Engineer" [level=1] [ref=e2]
  - textbox "First name" [ref=e5]
  - button "Upload resume" [ref=e8]
  - link "Apply for this job" [ref=e9] [cursor=pointer]
  - button "Submit application" [ref=e12] [cursor=pointer]
\`\`\``;

describe("findSubmitButtons", () => {
  test("finds the submit control and its ref", () => {
    const found = findSubmitButtons(SNAPSHOT);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], { label: "Submit application", ref: "e12", role: "button" });
  });

  test("ignores controls that are not submit-like", () => {
    const labels = findSubmitButtons(SNAPSHOT).map((c) => c.label);
    assert.equal(labels.includes("Upload resume"), false);
    assert.equal(labels.includes("Apply for this job"), false, "the apply link is navigation, not submission");
  });

  test("returns nothing when the form has no submit control", () => {
    assert.deepEqual(findSubmitButtons("- textbox \"Email\" [ref=e3]"), []);
    assert.deepEqual(findSubmitButtons(""), []);
  });

  test("picks up links as well as buttons", () => {
    const found = findSubmitButtons('- link "Send application" [ref=e4]');
    assert.deepEqual(found[0], { label: "Send application", ref: "e4", role: "link" });
  });

  test("honours custom keywords", () => {
    const found = findSubmitButtons('- button "Bewerbung absenden" [ref=e7]', ["absenden"]);
    assert.equal(found[0]?.ref, "e7");
  });
});

describe("chooseSubmitButton", () => {
  test("returns null when there is nothing to click", () => {
    assert.equal(chooseSubmitButton([]), null);
  });

  test("prefers a button over a link", () => {
    const chosen = chooseSubmitButton([
      { label: "Submit", ref: "e1", role: "link" },
      { label: "Submit application", ref: "e2", role: "button" },
    ]);
    assert.equal(chosen?.ref, "e2");
  });

  test("takes the last button, where the real submit lives", () => {
    const chosen = chooseSubmitButton([
      { label: "Submit section 1", ref: "e1", role: "button" },
      { label: "Submit application", ref: "e9", role: "button" },
    ]);
    assert.equal(chosen?.ref, "e9");
  });

  test("falls back to a link when no button matched", () => {
    const chosen = chooseSubmitButton([{ label: "Send application", ref: "e4", role: "link" }]);
    assert.equal(chosen?.ref, "e4");
  });
});
