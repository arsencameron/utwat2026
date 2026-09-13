import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { contextStore, type CandidateProfile, type QARecord } from "../db/contextStore.js";
import type { PlaywrightMcpClient } from "./mcpClient.js";

export type HumanInterceptionHandler = (
  question: string,
  context?: string
) => Promise<string>;

export interface AgentRunOptions {
  jobUrl: string;
  maxTurns?: number;
  model?: string;
  onHumanQuestion?: HumanInterceptionHandler;
  onTurnProgress?: (turn: number, assistantMessage: Anthropic.Message) => void;
  onMaxTurnsReached?: (currentTurns: number) => Promise<number>;
  abortSignal?: AbortSignal;
  shouldStop?: () => boolean;
}

export interface AgentRunResult {
  success: boolean;
  turns: number;
  summary: string;
  error?: string;
}

/**
 * Fallback CLI prompt for Human-in-the-Loop input when Person 1's hook isn't passed
 */
async function defaultCliHumanHandler(question: string, context?: string): Promise<string> {
  console.log("\n" + "=".repeat(60));
  console.log("🚨 [HUMAN INTERCEPTION REQUIRED] Novel Job Question Encountered");
  console.log("=".repeat(60));
  console.log(`Question: ${question}`);
  if (context) {
    console.log(`Context / Options: ${context}`);
  }
  console.log("-".repeat(60));

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("👉 Your Answer (will be saved to SQLite memory): ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Local custom tools schemas for Anthropic Claude
 */
const LOCAL_TOOLS: Anthropic.Tool[] = [
  {
    name: "ask_human_and_save",
    description:
      "Asks the human user an unanswered or novel application question (e.g. salary expectations, relocation, custom essays, specific years of experience), saves their answer to persistent SQLite memory, and returns the response.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The exact question text found on the job application form.",
        },
        context: {
          type: "string",
          description: "Any additional context, field options (e.g. dropdown choices), or hints from the form.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "report_completion",
    description:
      "Signals that all application form fields have been filled out and inspected. Pauses the automated loop and requests final human review before submission. NEVER click the final Submit button directly.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Summary of fields completed and any fields requiring manual human attention.",
        },
        readyForSubmission: {
          type: "boolean",
          description: "Whether all required fields appear to be filled and ready for review.",
        },
      },
      required: ["summary", "readyForSubmission"],
    },
  },
];

/**
 * Builds the system prompt injecting candidate profile and learned Q&A memory
 */
function buildSystemPrompt(profile: CandidateProfile, qaMemory: QARecord[]): string {
  const qaSection =
    qaMemory.length > 0
      ? qaMemory
          .map((qa) => `Q: ${qa.raw_question}\nA: ${qa.answer}`)
          .join("\n\n")
      : "No prior Q&A records stored yet.";

  return `You are an expert autonomous Job Autofill Agent equipped with browser automation and persistent memory.
Your mission is to accurately, efficiently, and safely fill out job application forms (e.g., Ashby, Greenhouse, Lever, Workday) for the candidate.

### Candidate Profile:
- Full Name: ${profile.fullName}
- Email: ${profile.email}
- Phone: ${profile.phone}
- Location: ${profile.location}
- LinkedIn: ${profile.linkedinUrl}
- GitHub: ${profile.githubUrl}
- Portfolio: ${profile.portfolioUrl || "N/A"}
- Work Authorization: ${profile.workAuthorization}
- Default Cover Letter:
${profile.defaultCoverLetter}
- Resume Path: ${profile.resumePath || "N/A"}

### Known Q&A Memory (Answers previously provided by candidate):
${qaSection}

### Playwright MCP Mechanics:
- **Accessibility Snapshots**: Use 'browser_snapshot' to inspect page structure. It returns the accessibility tree with element roles, labels, and reference IDs (e.g., textbox 'First Name' [ref=e5], checkbox 'Agree' [ref=e10]).
- **Targeting Elements**: Use the exact reference string (e.g., target: 'e5') as the target argument in browser tools.
- **Filling Fields**:
  - Prefer 'browser_fill_form' to fill multiple fields efficiently in a single turn.
  - Or use 'browser_type' with target: 'e...' and text: '...' for individual textboxes.
  - Use 'browser_select_option' with target: 'e...' and values: ['...'] for dropdowns / comboboxes.
  - Use 'browser_click' with target: 'e...' for checkboxes, radio buttons, or tabs.
  - Use 'browser_file_upload' if a resume or file attachment path is provided.

### Operational Instructions:
1. **Navigate to Job URL**: Call 'browser_navigate' to open the job application URL.
2. **Inspect Form Structure**: Call 'browser_snapshot' to capture the accessibility tree and discover all input element 'ref' IDs.
3. **Autofill Standard Fields**: Fill in first name, last name, email, phone, LinkedIn, GitHub, website, location, work auth, etc., matching fields to Candidate Profile.
4. **Handle Custom & Diversity Questions**:
   - Check if an answer exists in 'Known Q&A Memory' above. If a clear match exists, use that answer.
   - If the question is novel, unclear, or asks for specific candidate input not present in profile/memory, CALL the local tool 'ask_human_and_save'.
   - The human's answer will be saved into SQLite so you will remember it in all future runs.
5. **CRITICAL HUMAN-IN-THE-LOOP SAFETY GUARD**:
   - **DO NOT CLICK THE FINAL SUBMIT BUTTON UNDER ANY CIRCUMSTANCES.**
   - **DO NOT CLOSE THE BROWSER WINDOW.** Leave the page open on the completed application so the candidate can review.
   - Once all form fields have been filled out and validated, call the local tool 'report_completion'.
   - Summarize what was completed and ask the human to review and submit.`;
}

export class AgentLoop {
  private anthropic: Anthropic;
  private mcpClient: PlaywrightMcpClient;
  private defaultModel: string;

  constructor(
    mcpClient: PlaywrightMcpClient,
    options: { apiKey?: string; defaultModel?: string } = {}
  ) {
    this.mcpClient = mcpClient;
    this.anthropic = new Anthropic({
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY,
    });
    this.defaultModel =
      options.defaultModel ||
      process.env.ANTHROPIC_MODEL ||
      "claude-3-5-sonnet-20241022";
  }

  /**
   * Run the multi-turn agent execution loop
   */
  public async run(options: AgentRunOptions): Promise<AgentRunResult> {
    let currentMaxTurns = options.maxTurns ?? 40;
    const {
      jobUrl,
      model = this.defaultModel,
      onHumanQuestion = defaultCliHumanHandler,
      onTurnProgress,
    } = options;

    console.log(`\n🚀 Starting AutoApply Agent Loop`);
    console.log(`🎯 Target Job URL: ${jobUrl}`);
    console.log(`🤖 Model: ${model}`);

    // 1. Ensure MCP client is connected and gather all tools
    if (!this.mcpClient.isConnected) {
      await this.mcpClient.connect();
    }
    const rawMcpTools = await this.mcpClient.getAnthropicTools();
    // Exclude browser_close so the browser remains open after autofill
    const mcpTools = rawMcpTools.filter((t) => t.name !== "browser_close");
    const allTools: Anthropic.Tool[] = [...mcpTools, ...LOCAL_TOOLS];

    console.log(`🛠️ Active Tools: ${allTools.length} total (${mcpTools.length} browser tools + ${LOCAL_TOOLS.length} local HITL tools)`);

    // 2. Fetch context from SQLite
    const profile = contextStore.getProfile();
    const qaMemory = contextStore.getAllQA();
    const systemPrompt = buildSystemPrompt(profile, qaMemory);

    // 3. Initialize message history
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Please navigate to the job application at ${jobUrl}, inspect the form, autofill all fields using my profile and memory, and ask me if you encounter any unknown questions. When done, call report_completion. Do not submit the application.`,
      },
    ];

    let turns = 0;
    let finalSummary = "";
    let completed = false;

    while (!completed) {
      if (options.abortSignal?.aborted || options.shouldStop?.()) {
        console.log("🛑 Agent run interrupted by user.");
        return {
          success: false,
          turns,
          summary: finalSummary || "AutoApply interrupted by user.",
          error: "Interrupted by user",
        };
      }

      // Check if turn limit reached before proceeding with next turn
      if (turns >= currentMaxTurns) {
        console.log(`\n⚠️ [Turn Limit] Reached ${currentMaxTurns} turns without completion.`);
        let addTurns = 0;

        if (options.onMaxTurnsReached) {
          addTurns = await options.onMaxTurnsReached(turns);
        } else if (onHumanQuestion) {
          const question = `Agent reached turn limit (${currentMaxTurns} turns) without finishing. Would you like to continue for more turns? (Enter number of turns, e.g. 10, 20, or 'no' to stop)`;
          const answer = await onHumanQuestion(question, "max_turns_prompt");

          if (options.abortSignal?.aborted || options.shouldStop?.()) {
            return {
              success: false,
              turns,
              summary: finalSummary || "AutoApply interrupted by user.",
              error: "Interrupted by user",
            };
          }

          const trimmed = (answer || "").trim().toLowerCase();
          if (trimmed === "no" || trimmed === "n" || trimmed === "stop" || trimmed === "cancel") {
            addTurns = 0;
          } else {
            const numMatch = trimmed.match(/\d+/);
            if (numMatch) {
              addTurns = parseInt(numMatch[0], 10);
            } else if (trimmed === "yes" || trimmed === "y" || trimmed === "continue") {
              addTurns = 15;
            }
          }
        }

        if (addTurns > 0) {
          currentMaxTurns += addTurns;
          console.log(`🔄 Continuing agent execution for another ${addTurns} turns (new limit: ${currentMaxTurns}).`);
          messages.push({
            role: "user",
            content: `Turn limit extended by ${addTurns} more turns. Please continue inspecting and autofilling the remaining form fields. When finished, call report_completion.`,
          });
          continue;
        } else {
          console.log(`🛑 Stopping agent: reached maximum limit of ${currentMaxTurns} turns.`);
          finalSummary = finalSummary || `AutoApply stopped: reached maximum limit of ${currentMaxTurns} turns.`;
          break;
        }
      }

      turns++;
      console.log(`\n--- [Turn ${turns} / ${currentMaxTurns}] Invoking Claude ---`);

      let response: Anthropic.Message;
      try {
        response = await this.anthropic.messages.create(
          {
            model,
            system: systemPrompt,
            messages,
            tools: allTools,
            max_tokens: 4096,
          },
          { signal: options.abortSignal }
        );
      } catch (err: unknown) {
        if (options.abortSignal?.aborted || (err instanceof Error && err.name === "APIUserAbortError")) {
          console.log("[Agent] Run interrupted by user.");
          return {
            success: false,
            turns,
            summary: finalSummary || "Autofill interrupted by user.",
            error: "Interrupted by user",
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Agent] Anthropic API error:`, message);
        return {
          success: false,
          turns,
          summary: finalSummary,
          error: `Anthropic API error: ${message}`,
        };
      }

      if (onTurnProgress) {
        onTurnProgress(turns, response);
      }

      // Print any assistant text responses
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(`\n[Claude]:\n${block.text}\n`);
        }
      }

      // Add assistant response to history
      messages.push({
        role: "assistant",
        content: response.content,
      });

      // Handle tool use
      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          if (options.abortSignal?.aborted || options.shouldStop?.()) {
            console.log("🛑 Agent run interrupted by user.");
            return {
              success: false,
              turns,
              summary: finalSummary || "Autofill interrupted by user.",
              error: "Interrupted by user",
            };
          }

          const toolName = toolUse.name;
          const toolInput = (toolUse.input || {}) as Record<string, unknown>;

          console.log(`⚡ Dispatching tool: ${toolName}`);

          // A. Handle local tool: ask_human_and_save
          if (toolName === "ask_human_and_save") {
            const question = String(toolInput.question || "");
            const context = toolInput.context ? String(toolInput.context) : undefined;

            // Check if SQLite already knows answer (in case learned during current run)
            const cached = contextStore.findAnswer(question);
            let humanAnswer: string;

            if (cached) {
              console.log(`[HITL] Answer found in SQLite memory: "${cached}"`);
              humanAnswer = cached;
            } else {
              humanAnswer = await onHumanQuestion(question, context);
              contextStore.saveAnswer(question, humanAnswer);
              console.log(`[HITL] Answer saved to SQLite: "${humanAnswer}"`);
            }

            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                status: "success",
                question,
                answer: humanAnswer,
              }),
            });
          }
          // B. Handle local tool: report_completion
          else if (toolName === "report_completion") {
            const summary = String(toolInput.summary || "Application form autofill completed.");
            const ready = Boolean(toolInput.readyForSubmission);

            console.log("\n" + "=".repeat(60));
            console.log("✅ [AUTOAPPLY COMPLETED] Ready for Human Review");
            console.log("=".repeat(60));
            console.log(`Summary: ${summary}`);
            console.log(`Ready for Submission: ${ready}`);
            console.log("=".repeat(60) + "\n");

            finalSummary = summary;
            completed = true;

            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                status: "acknowledged",
                message: "Autofill paused. Awaiting human user to review and submit.",
              }),
            });
          }
          // C. Handle remote MCP browser tools
          else {
            const result = await this.mcpClient.callTool(toolName, toolInput);
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: result.content,
              is_error: result.isError,
            });
          }
        }

        // Push tool results back to conversation history
        messages.push({
          role: "user",
          content: toolResultBlocks,
        });
      } else if (response.stop_reason === "end_turn") {
        if (!completed) {
          console.log("[Agent] Claude reached end of turn without calling report_completion.");
          finalSummary = "Agent ended turn without calling report_completion.";
        }
        break;
      } else {
        console.log(`[Agent] Stopped with reason: ${response.stop_reason}`);
        break;
      }
    }

    return {
      success: completed,
      turns,
      summary: finalSummary || "Autofill process ended.",
    };
  }
}
