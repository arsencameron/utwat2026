/**
 * A single shared readline interface for every human-in-the-loop prompt.
 *
 * The agent asks the human two different kinds of question (confirm a risky
 * click, answer a missing form field), and two concurrent readline interfaces
 * on the same stdin fight over keystrokes — so everything funnels through here.
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

let rl: readline.Interface | null = null;

function getInterface(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input, output });
    rl.on("close", () => {
      rl = null;
    });
    // readline swallows Ctrl+C while a question is pending; re-raise it so the
    // process-level shutdown handler still releases the Steel session.
    rl.on("SIGINT", () => {
      rl?.close();
      process.emit("SIGINT", "SIGINT");
    });
  }
  return rl;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question: string): Promise<string> {
  const answer = await getInterface().question(question);
  return answer.trim();
}

/**
 * Asks for one of a set of single-letter choices and returns the normalized
 * letter. Empty input selects `defaultChoice`.
 */
export async function askChoice(
  question: string,
  choices: string[],
  defaultChoice: string
): Promise<string> {
  const normalized = choices.map((choice) => choice.toLowerCase());

  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await ask(question)).toLowerCase();
    if (!raw) {
      return defaultChoice;
    }
    const letter = raw[0]!;
    if (normalized.includes(letter)) {
      return letter;
    }
    console.log(`Please enter one of: ${normalized.join(", ")} (or press Enter for "${defaultChoice}")`);
  }

  return defaultChoice;
}

export function closePrompt(): void {
  rl?.close();
  rl = null;
}
