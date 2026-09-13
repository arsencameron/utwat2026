/**
 * Locates the submit control on a filled form so the human can hand the final
 * click back to the agent.
 *
 * The agent never submits on its own. When the operator explicitly asks for it
 * (`--offer-submit`), the click is still routed through the guard, so it is the
 * usual confirmation prompt that decides whether it happens — the same code
 * path as an unrequested submit attempt, just deliberately triggered.
 */
import { DEFAULT_SUBMIT_KEYWORDS } from "../hitl/submitGuard.js";

export interface SubmitCandidate {
  /** Accessible name, e.g. `Submit application`. */
  label: string;
  /** Snapshot reference passed back as the click target, e.g. `e42`. */
  ref: string;
  role: string;
}

/** Matches a Playwright MCP snapshot line: `- button "Submit" [ref=e6]`. */
const CONTROL_LINE = /-\s*(button|link)\s+"([^"]+)"[^\n]*?\[ref=([^\]\s]+)\]/gi;

/**
 * Extracts every clickable control in an accessibility snapshot whose name
 * matches a submit phrase. Page order is preserved.
 */
export function findSubmitButtons(
  snapshot: string,
  keywords: string[] = DEFAULT_SUBMIT_KEYWORDS
): SubmitCandidate[] {
  const phrases = keywords.map((keyword) => keyword.toLowerCase());
  const found: SubmitCandidate[] = [];

  for (const match of snapshot.matchAll(CONTROL_LINE)) {
    const [, role = "", label = "", ref = ""] = match;
    if (phrases.some((phrase) => label.toLowerCase().includes(phrase))) {
      found.push({ label, ref, role: role.toLowerCase() });
    }
  }

  return found;
}

/**
 * Picks the control to click when several match. Forms put the real submit
 * last, and a button beats a link when both are present.
 */
export function chooseSubmitButton(candidates: SubmitCandidate[]): SubmitCandidate | null {
  if (candidates.length === 0) return null;
  const buttons = candidates.filter((candidate) => candidate.role === "button");
  const pool = buttons.length > 0 ? buttons : candidates;
  return pool[pool.length - 1] ?? null;
}
