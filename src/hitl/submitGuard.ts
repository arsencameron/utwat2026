/**
 * Detects browser tool calls that could irreversibly submit an application.
 *
 * The agent is already told never to submit, but a prompt is not a control:
 * this runs on the actual MCP tool call, so a model that ignores the system
 * prompt still gets stopped at the wire.
 */

/** Phrases that mark a click as "this probably submits the application". */
export const DEFAULT_SUBMIT_KEYWORDS = [
  "submit",
  "send application",
  "send my application",
  "complete application",
  "finish application",
  "apply now",
  "confirm and send",
];

/** Keys that submit the focused form. */
const SUBMIT_KEYS = new Set(["enter", "numpadenter", "return"]);

/**
 * Code patterns that can submit a form without ever issuing a click, used to
 * screen the arbitrary JavaScript that browser_evaluate accepts.
 */
const SUBMITTING_CODE = [
  /\.submit\s*\(/i,
  /requestSubmit/i,
  /\.click\s*\(/i,
  /type\s*=\s*["']?submit/i,
  /getByRole\s*\(\s*["']button["']/i,
];

/**
 * Tools that can drive the page arbitrarily. There is no reliable way to tell
 * from the arguments whether they submit, so they always require confirmation.
 */
const ALWAYS_GUARDED_TOOLS = new Set(["browser_run_code_unsafe"]);

/** Pulls the role and accessible name for a ref out of a snapshot. */
const REF_LINE = (ref: string) =>
  new RegExp(`-\\s*(\\w+)\\s+"([^"]+)"[^\\n]*?\\[ref=${ref.replace(/[^\w-]/g, "")}\\]`, "i");

/**
 * Resolves a snapshot reference (e.g. `e16`) to what the page actually calls
 * that element, e.g. `button "Submit application"`.
 *
 * The `element` argument on a tool call is written by the model, so it cannot
 * be trusted to describe what is really being clicked. The snapshot can.
 */
export function lookupRefLabel(snapshot: string, ref: string): string | null {
  if (!snapshot || !ref) return null;
  const match = snapshot.match(REF_LINE(ref));
  if (!match) return null;
  const [, role = "", name = ""] = match;
  return `${role.toLowerCase()} "${name}"`;
}

export interface GuardMatch {
  /** True when the call must be confirmed by a human before it runs. */
  guarded: boolean;
  /** Short human-readable description of the action, e.g. `Submit application (ref=e42)`. */
  label: string;
  /** Why the guard fired, shown in the confirmation prompt. */
  reason: string;
}

export interface GuardConfig {
  keywords?: string[];
  /** Also guard Enter/Return key presses, which submit a focused form. */
  guardEnterKey?: boolean;
  /**
   * What the page calls the targeted element, resolved from the last snapshot.
   * Checked alongside the model's own description, which can be inaccurate.
   */
  resolvedLabel?: string | null;
}

/** Collects every string in a tool-call argument object, depth-limited. */
export function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      collectStrings(item, depth + 1)
    );
  }
  return [];
}

/** Builds a compact one-line description of an MCP tool call for the prompt. */
export function describeToolCall(toolName: string, args: Record<string, unknown>): string {
  const element = typeof args.element === "string" ? args.element : undefined;
  // @playwright/mcp names this `target`; older builds and other servers use
  // `ref`. Both carry the snapshot reference the human sees as [ref=e10].
  const ref =
    typeof args.ref === "string"
      ? args.ref
      : typeof args.target === "string"
        ? args.target
        : undefined;
  const key = typeof args.key === "string" ? args.key : undefined;

  const parts = [element || key || toolName];
  if (ref) parts.push(`(ref=${ref})`);
  return parts.join(" ");
}

/**
 * Decides whether a tool call needs human confirmation.
 *
 * Only interaction tools are considered — reads (`browser_snapshot`),
 * navigation and field fills run freely, so the agent keeps its speed and the
 * human is only interrupted at the point of no return.
 */
export function isGuardedAction(
  toolName: string,
  args: Record<string, unknown> = {},
  config: GuardConfig = {}
): GuardMatch {
  const keywords = (config.keywords ?? DEFAULT_SUBMIT_KEYWORDS).map((k) => k.toLowerCase());
  const resolved = config.resolvedLabel ?? null;
  const label = resolved
    ? `${describeToolCall(toolName, args)} → page says ${resolved}`
    : describeToolCall(toolName, args);

  // Arbitrary Playwright code: unreviewable, so always confirmed.
  if (ALWAYS_GUARDED_TOOLS.has(toolName)) {
    return {
      guarded: true,
      label,
      reason: `${toolName} runs arbitrary browser code and cannot be checked automatically`,
    };
  }

  if (toolName === "browser_click") {
    // The model's own description AND what the page actually calls the element.
    const haystack = [...collectStrings(args), resolved ?? ""].join(" | ").toLowerCase();
    const hit = keywords.find((keyword) => haystack.includes(keyword));
    if (hit) {
      const viaPage = resolved?.toLowerCase().includes(hit) ?? false;
      return {
        guarded: true,
        label,
        reason: viaPage
          ? `the page calls this element ${resolved}, matching guarded phrase "${hit}"`
          : `click target matches guarded phrase "${hit}"`,
      };
    }
    return { guarded: false, label, reason: "" };
  }

  // Typing with submit:true presses Enter afterwards, submitting the form.
  if (toolName === "browser_type" && args.submit === true) {
    return {
      guarded: true,
      label,
      reason: "browser_type was called with submit:true, which presses Enter and submits the form",
    };
  }

  // Arbitrary JavaScript that clicks or calls form.submit().
  if (toolName === "browser_evaluate") {
    const code = typeof args.function === "string" ? args.function : "";
    if (SUBMITTING_CODE.some((pattern) => pattern.test(code))) {
      return {
        guarded: true,
        label,
        reason: "browser_evaluate runs page code that clicks or submits a form",
      };
    }
  }

  if (toolName === "browser_press_key" && config.guardEnterKey !== false) {
    const key = typeof args.key === "string" ? args.key.toLowerCase() : "";
    if (SUBMIT_KEYS.has(key)) {
      return {
        guarded: true,
        label,
        reason: `pressing "${args.key}" can submit the focused form`,
      };
    }
  }

  return { guarded: false, label, reason: "" };
}

/**
 * Returned to Claude in place of the tool result when a human blocks the call.
 * Worded to stop retry loops and steer the agent to `report_completion`.
 */
export function buildDenialMessage(toolName: string, label: string): string {
  return [
    `BLOCKED BY HUMAN OPERATOR: the call to "${toolName}" on "${label}" was not executed.`,
    "The human declined to submit this application automatically.",
    "Do NOT retry this action, and do NOT look for another way to submit the form.",
    "If every field is filled, call report_completion with a summary of what you filled and anything left for the human to check.",
  ].join(" ");
}
