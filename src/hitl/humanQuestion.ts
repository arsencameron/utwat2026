/**
 * CLI handler for the other half of human-in-the-loop: when Claude signals
 * that required information is missing (the `ask_human_and_save` tool), the
 * question is surfaced in the terminal and the typed answer is handed straight
 * back into the agent loop — and persisted to SQLite by the loop itself.
 */
import type { HumanInterceptionHandler } from "../agent/agentLoop.js";
import { ask, isInteractive } from "../cli/prompt.js";

const BANNER = "=".repeat(72);

/** Sent back when nobody can answer, so the agent flags the field instead of inventing one. */
export const NO_ANSWER_SENTINEL =
  "UNKNOWN — no human answer available. Leave this field blank and list it in report_completion for manual review.";

export interface HumanQuestionOptions {
  liveViewUrl?: string | null;
  /** How many times to re-ask on an empty answer before giving up. */
  maxAttempts?: number;
}

export function createHumanQuestionHandler(
  options: HumanQuestionOptions = {}
): HumanInterceptionHandler {
  const { liveViewUrl = null, maxAttempts = 3 } = options;

  return async (question: string, context?: string): Promise<string> => {
    console.log("\n" + BANNER);
    console.log("❓ [HUMAN INPUT REQUIRED] Claude is missing information");
    console.log(BANNER);
    console.log(`Question : ${question}`);
    if (context) {
      console.log(`Context  : ${context}`);
    }
    if (liveViewUrl) {
      console.log(`Live view: ${liveViewUrl}`);
    }
    console.log("-".repeat(72));

    if (!isInteractive()) {
      console.log("No TTY attached — cannot collect an answer. Re-run in an interactive terminal.");
      console.log(BANNER + "\n");
      return NO_ANSWER_SENTINEL;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const answer = await ask("👉 Your answer (saved to SQLite and reused next time): ");
      if (answer) {
        console.log(BANNER + "\n");
        return answer;
      }
      if (attempt < maxAttempts) {
        console.log("An empty answer would be saved to memory — please type something.");
      }
    }

    console.log("No answer given; telling Claude to skip this field.");
    console.log(BANNER + "\n");
    return NO_ANSWER_SENTINEL;
  };
}
