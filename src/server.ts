import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { contextStore } from "./db/contextStore.js";
import { PlaywrightMcpClient } from "./agent/mcpClient.js";
import { AgentLoop } from "./agent/agentLoop.js";
import { SteelSessionManager, type SteelSession } from "./steel/steelSession.js";
import { GuardedMcpClient } from "./mcp/guardedMcpClient.js";
import { resolveMcpLaunch } from "./mcp/playwrightMcp.js";
import { extractTextFromPdf } from "./util/pdfExtractor.js";

const PORT = Number(process.env.PORT) || 3000;
const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Global Agent State for Web UI
interface AgentState {
  status: "idle" | "running" | "waiting_for_human" | "completed" | "error" | "interrupted" | "interrupt";
  jobUrl: string | null;
  logs: string[];
  pendingQuestion: {
    question: string;
    context?: string;
    resolve: (answer: string) => void;
    reject?: (err: Error) => void;
  } | null;
  liveViewUrl: string | null;
  summary: string | null;
  error: string | null;
  abortController: AbortController | null;
}

const state: AgentState = {
  status: "idle",
  jobUrl: null,
  logs: [],
  pendingQuestion: null,
  liveViewUrl: null,
  summary: null,
  error: null,
  abortController: null,
};

let activeSteelSession: SteelSession | null = null;
let activeSteelManager: SteelSessionManager | null = null;

function addLog(msg: string) {
  const timestamp = new Date().toLocaleTimeString();
  state.logs.push(`[${timestamp}] ${msg}`);
  if (state.logs.length > 500) {
    state.logs.shift();
  }
}

// Helper to parse JSON body
async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // Prevent payload flooding (max 20MB for base64 resumes)
      if (body.length > 20 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (err) {
        reject(new Error("Invalid JSON: " + (err instanceof Error ? err.message : String(err))));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Enable CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Serve frontend HTML
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const htmlPath = path.join(process.cwd(), "public", "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("public/index.html not found");
      return;
    }
  }

  // 2. GET /api/profile
  if (req.method === "GET" && pathname === "/api/profile") {
    try {
      const profile = contextStore.getProfile();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(profile));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 3. POST /api/profile
  if (req.method === "POST" && pathname === "/api/profile") {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      contextStore.updateProfile(body);
      const updated = contextStore.getProfile();
      addLog(`Profile updated for candidate: ${updated.fullName}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, profile: updated }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 4. POST /api/upload-resume (base64 upload & AI profile parsing)
  if (req.method === "POST" && pathname === "/api/upload-resume") {
    try {
      const body = await parseJsonBody<{ filename: string; data: string }>(req);
      if (!body.filename || !body.data) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing filename or data" }));
        return;
      }

      const safeFilename = path.basename(body.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
      const targetPath = path.join(UPLOADS_DIR, safeFilename);

      // Strip data URL prefix if present (e.g. data:application/pdf;base64,...)
      const base64Content = body.data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Content, "base64");
      fs.writeFileSync(targetPath, buffer);

      // Update resume path in SQLite
      contextStore.updateProfile({ resumePath: targetPath });
      addLog(`Uploaded resume saved to: ${targetPath} (${Math.round(buffer.length / 1024)} KB)`);

      // Attempt AI parsing to auto-populate candidate profile
      let parsedProfile: Record<string, string> | null = null;
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
          addLog(`🤖 Analyzing uploaded resume with Claude (${model}) to extract profile details...`);
          const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          const isPdf = safeFilename.toLowerCase().endsWith(".pdf");

          let resumeText = "";
          if (isPdf) {
            addLog("📄 Extracting text from PDF using Mozilla pdfjs-dist...");
            try {
              resumeText = await extractTextFromPdf(buffer);
              addLog(`📄 Successfully extracted text from PDF (${resumeText.length} chars).`);
            } catch (pdfErr) {
              addLog(`⚠️ pdfjs-dist text extraction notice: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`);
            }
          } else {
            resumeText = buffer.toString("utf-8");
          }

          const prompt = `Extract candidate contact and background information from this resume text:

${(resumeText || buffer.toString("utf-8")).slice(0, 15000)}

Return a JSON object with keys:
- fullName: candidate full name (string)
- email: candidate email address (string)
- phone: candidate phone number (string)
- location: candidate location / city / state (string)
- linkedinUrl: full LinkedIn profile URL (string)
- githubUrl: GitHub profile URL (string)
- portfolioUrl: personal website or portfolio URL (string)
- workAuthorization: work authorization or citizenship status if mentioned, else empty string "" (string, never null)
- defaultCoverLetter: a concise 2-3 sentence introductory summary highlighting core skills and experience (string, never null)

Return ONLY valid JSON with no markdown tags or code fences.`;

          const response = await anthropic.messages.create({
            model,
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          });

          const textBlock = response.content.find((b) => b.type === "text");
          if (textBlock && textBlock.type === "text") {
            const raw = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
            parsedProfile = JSON.parse(raw);
            if (parsedProfile && typeof parsedProfile === "object") {
              const sanitized: Record<string, string> = {};
              for (const [key, val] of Object.entries(parsedProfile)) {
                if (val !== null && val !== undefined) {
                  sanitized[key] = String(val);
                } else {
                  sanitized[key] = "";
                }
              }
              contextStore.updateProfile({
                ...sanitized,
                resumePath: targetPath,
              });
              addLog(`✅ Resume parsed! Extracted profile for: ${parsedProfile.fullName || "Candidate"}`);
            }
          }
        } catch (parseErr: unknown) {
          addLog(`Note: Automatic resume text parsing skipped: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        }
      }

      const activeProfile = contextStore.getProfile();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          resumePath: targetPath,
          filename: safeFilename,
          sizeBytes: buffer.length,
          parsedProfile,
          profile: activeProfile,
        })
      );
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 5. GET /api/qa
  if (req.method === "GET" && pathname === "/api/qa") {
    try {
      const qaList = contextStore.getAllQA();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(qaList));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 6. POST /api/qa (Add manual Q&A entry)
  if (req.method === "POST" && pathname === "/api/qa") {
    try {
      const body = await parseJsonBody<{ question?: string; raw_question?: string; answer: string }>(req);
      const question = (body.raw_question || body.question || "").trim();
      const answer = (body.answer || "").trim();
      if (!question || !answer) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Both question and answer are required." }));
        return;
      }
      contextStore.saveAnswer(question, answer);
      addLog(`Manually added Q&A memory: "${question}" -> "${answer}"`);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Q&A memory saved." }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 7. PUT /api/qa/:id (Update existing Q&A entry)
  const qaIdMatch = pathname.match(/^\/api\/qa\/(\d+)$/);
  if (req.method === "PUT" && qaIdMatch) {
    try {
      const id = Number(qaIdMatch[1]);
      const body = await parseJsonBody<{ answer: string; question?: string; raw_question?: string }>(req);
      if (typeof body.answer !== "string" || !body.answer.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Answer cannot be empty." }));
        return;
      }
      const rawQuestion = body.raw_question || body.question;
      const success = contextStore.updateQA(id, body.answer, rawQuestion);
      if (!success) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Q&A record with ID ${id} not found.` }));
        return;
      }
      addLog(`Updated Q&A memory item #${id}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: `Q&A #${id} updated.` }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 8. DELETE /api/qa/:id (Delete single Q&A entry)
  if (req.method === "DELETE" && qaIdMatch) {
    try {
      const id = Number(qaIdMatch[1]);
      const success = contextStore.deleteQA(id);
      if (!success) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Q&A record with ID ${id} not found.` }));
        return;
      }
      addLog(`Deleted Q&A memory item #${id}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: `Q&A #${id} deleted.` }));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 9. POST /api/qa/clear (Clear all Q&A memory)
  if (req.method === "POST" && pathname === "/api/qa/clear") {
    try {
      const count = contextStore.clearAllQA();
      addLog(`Cleared all ${count} Q&A memory records.`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, cleared: count }));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 10. GET /api/db/export (Export full profile + Q&A memory)
  if (req.method === "GET" && pathname === "/api/db/export") {
    try {
      const data = contextStore.exportData();
      res.setHeader("Content-Disposition", 'attachment; filename="autoapply-db-backup.json"');
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data, null, 2));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 11. POST /api/db/import (Import profile or Q&As)
  if (req.method === "POST" && pathname === "/api/db/import") {
    try {
      const body = await parseJsonBody<{
        profile?: Record<string, unknown>;
        qaMemory?: Array<{ raw_question?: string; question?: string; answer: string }>;
      }>(req);

      let profileUpdated = false;
      let qaImportedCount = 0;

      if (body.profile && typeof body.profile === "object") {
        contextStore.updateProfile(body.profile);
        profileUpdated = true;
      }
      if (Array.isArray(body.qaMemory) && body.qaMemory.length > 0) {
        qaImportedCount = contextStore.importQA(body.qaMemory);
      }

      addLog(`DB Import completed: Profile updated: ${profileUpdated}, ${qaImportedCount} Q&As imported`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          profileUpdated,
          qaImportedCount,
        })
      );
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 6. POST /api/run (Start Job Application Autofill)
  if (req.method === "POST" && pathname === "/api/run") {
    if (state.status === "running" || state.status === "waiting_for_human") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "An agent task is already currently running." }));
      return;
    }

    try {
      const body = await parseJsonBody<{
        jobUrl: string;
        mode?: "steel" | "local";
        headed?: boolean;
        keepSessionAlive?: boolean;
        reuseSession?: boolean;
        customInstruction?: string;
      }>(req);

      if (!body.jobUrl || !body.jobUrl.startsWith("http")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Please provide a valid job application URL (http/https)." }));
        return;
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "ANTHROPIC_API_KEY is not set. Please set it in .env and restart npm run ui.",
          })
        );
        return;
      }

      state.status = "running";
      state.jobUrl = body.jobUrl;
      state.logs = [];
      state.summary = null;
      state.error = null;
      if (!body.reuseSession) {
        state.liveViewUrl = null;
      }

      addLog(`🚀 Launching Agent for: ${body.jobUrl}`);
      addLog(`Mode: ${body.mode === "steel" ? "Steel.dev Cloud Browser" : "Local Playwright"}`);
      if (body.keepSessionAlive !== false && body.mode === "steel") {
        addLog("⚙️ Keep-Alive enabled: Steel session will remain open for human review after completion.");
      }

      // Run background execution
      startAgentExecution({
        jobUrl: body.jobUrl,
        mode: body.mode || "local",
        headed: body.headed ?? true,
        keepSessionAlive: body.keepSessionAlive ?? true,
        reuseSession: body.reuseSession,
        customInstruction: body.customInstruction,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Agent launched." }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 6b. POST /api/session/continue (Continue execution on existing active session)
  if (req.method === "POST" && pathname === "/api/session/continue") {
    if (state.status === "running" || state.status === "waiting_for_human") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "An agent task is already currently running." }));
      return;
    }

    if (!activeSteelSession) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No active Steel session to continue from." }));
      return;
    }

    try {
      const body = await parseJsonBody<{
        customInstruction?: string;
      }>(req);

      const jobUrl = state.jobUrl || "active-browser-session";
      state.status = "running";
      state.summary = null;
      state.error = null;

      addLog(`♻️ Continuing execution on active Steel session (${activeSteelSession.id})...`);
      if (body.customInstruction) {
        addLog(`Instruction: "${body.customInstruction}"`);
      }

      startAgentExecution({
        jobUrl,
        mode: "steel",
        headed: false,
        reuseSession: true,
        keepSessionAlive: true,
        customInstruction: body.customInstruction,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Continuation launched." }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 6c. POST /api/session/release (Manually release active Steel session)
  if (req.method === "POST" && pathname === "/api/session/release") {
    if (activeSteelManager) {
      addLog("Manually releasing active Steel session...");
      try {
        await activeSteelManager.release();
      } finally {
        activeSteelManager = null;
        activeSteelSession = null;
        state.liveViewUrl = null;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Steel session released." }));
      return;
    }
    state.liveViewUrl = null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "No active Steel session to release." }));
    return;
  }

  // 7. GET /api/status (Poll agent status and logs)
  if (req.method === "GET" && pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: state.status,
        jobUrl: state.jobUrl,
        logs: state.logs,
        liveViewUrl: state.liveViewUrl,
        hasActiveSession: Boolean(activeSteelSession),
        activeSessionId: activeSteelSession ? activeSteelSession.id : null,
        summary: state.summary,
        error: state.error,
        model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
        pendingQuestion: state.pendingQuestion
          ? {
              question: state.pendingQuestion.question,
              context: state.pendingQuestion.context,
            }
          : null,
      })
    );
    return;
  }

  // 8. POST /api/answer (Resolve pending human question from web UI)
  if (req.method === "POST" && pathname === "/api/answer") {
    try {
      const body = await parseJsonBody<{ answer: string }>(req);
      if (!state.pendingQuestion) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No question is currently awaiting an answer." }));
        return;
      }

      const answer = (body.answer || "").trim();
      addLog(`Human answered: "${answer}"`);
      const resolver = state.pendingQuestion.resolve;
      state.pendingQuestion = null;
      state.status = "running";
      resolver(answer);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Answer submitted to agent." }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // 9. POST /api/interrupt (Interrupt running AutoApply task)
  if (req.method === "POST" && (pathname === "/api/interrupt" || pathname === "/api/stop")) {
    if (state.status !== "running" && state.status !== "waiting_for_human") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No agent task is currently running to interrupt." }));
      return;
    }

    addLog("🛑 User requested to interrupt agent execution.");
    state.status = "interrupted";
    state.summary = "AutoApply interrupted by user.";

    if (state.abortController) {
      state.abortController.abort();
    }
    if (state.pendingQuestion?.reject) {
      state.pendingQuestion.reject(new Error("Interrupted by user"));
      state.pendingQuestion = null;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, status: "interrupted", message: "Agent execution interrupted." }));
    return;
  }

  // 10. POST or PUT /api/status (Update status to interrupt or idle)
  if ((req.method === "POST" || req.method === "PUT") && pathname === "/api/status") {
    try {
      const body = await parseJsonBody<{ status: string }>(req);
      const targetStatus = (body.status || "").toLowerCase().trim();
      if (targetStatus === "interrupt" || targetStatus === "interrupted") {
        addLog("🛑 Status update: interrupting agent execution.");
        state.status = "interrupted";
        state.summary = "AutoApply interrupted by user.";

        if (state.abortController) {
          state.abortController.abort();
        }
        if (state.pendingQuestion?.reject) {
          state.pendingQuestion.reject(new Error("Interrupted by user"));
          state.pendingQuestion = null;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, status: "interrupted", message: "Status updated to interrupt." }));
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unsupported status update: ${body.status}` }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// Asynchronous agent execution runner
async function startAgentExecution(params: {
  jobUrl: string;
  mode: "steel" | "local";
  headed: boolean;
  keepSessionAlive?: boolean;
  reuseSession?: boolean;
  customInstruction?: string;
}) {
  let steelSession: SteelSession | null = null;
  let steelManager: SteelSessionManager | null = null;
  const abortController = new AbortController();
  state.abortController = abortController;
  const keepAlive = params.keepSessionAlive !== false;

  try {
    let mcpClient: PlaywrightMcpClient | GuardedMcpClient;

    if (params.mode === "steel" && process.env.STEEL_API_KEY) {
      if (params.reuseSession && activeSteelSession && activeSteelManager) {
        addLog(`♻️ Reusing existing Steel session (${activeSteelSession.id})...`);
        steelSession = activeSteelSession;
        steelManager = activeSteelManager;
      } else {
        if (activeSteelSession && activeSteelManager) {
          addLog("Cleaning up previous Steel session...");
          await activeSteelManager.release().catch(() => {});
          activeSteelSession = null;
          activeSteelManager = null;
        }
        addLog("Connecting to Steel.dev Cloud Browser...");
        steelManager = new SteelSessionManager();
        steelSession = await steelManager.create();
        activeSteelSession = steelSession;
        activeSteelManager = steelManager;
        state.liveViewUrl = steelSession.liveViewUrl;
        addLog(`Steel Session created! Live View: ${steelSession.liveViewUrl}`);
      }

      const launch = resolveMcpLaunch({
        cdpEndpoint: steelSession.cdpEndpoint,
        headed: false,
      });

      mcpClient = new GuardedMcpClient({
        command: launch.command,
        args: launch.args,
        liveViewUrl: steelSession.liveViewUrl,
        prompt: async (details) => {
          addLog(`⚠️ Submit-like action intercepted: ${details.toolName} (${details.match.reason})`);
          return "allow";
        },
      });
    } else {
      addLog(
        params.headed
          ? "Launching local Playwright browser (headed mode)..."
          : "Launching local Playwright browser (headless mode)..."
      );

      const args = params.headed ? ["playwright-mcp"] : ["playwright-mcp", "--headless"];
      mcpClient = new PlaywrightMcpClient({
        command: "npx",
        args,
      });
    }

    const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
    const agent = new AgentLoop(mcpClient as PlaywrightMcpClient, {
      defaultModel: model,
    });

    const result = await agent.run({
      jobUrl: params.jobUrl,
      model,
      customInstruction: params.customInstruction,
      navigate: !params.reuseSession,
      abortSignal: abortController.signal,
      shouldStop: () => state.status === "interrupted" || state.status === "interrupt",
      onHumanQuestion: async (question, context) => {
        if (state.status === "interrupted" || abortController.signal.aborted) {
          throw new Error("Interrupted by user");
        }
        addLog(`🚨 Human Question Encountered: "${question}"`);
        state.status = "waiting_for_human";

        return new Promise<string>((resolve, reject) => {
          state.pendingQuestion = {
            question,
            context,
            resolve: (answer) => {
              addLog(`Resuming agent loop with answer: "${answer}"`);
              resolve(answer);
            },
            reject,
          };
        });
      },
      onTurnProgress: (turn, msg) => {
        for (const block of msg.content) {
          if (block.type === "text" && block.text.trim()) {
            addLog(`🤖 Claude: ${block.text.trim().slice(0, 200)}...`);
          } else if (block.type === "tool_use") {
            addLog(`⚡ Tool Call: ${block.name}(${JSON.stringify(block.input || {})})`);
          }
        }
      },
    });

    if (state.status === "interrupted" || abortController.signal.aborted || result.error === "Interrupted by user") {
      state.status = "interrupted";
      state.summary = "AutoApply interrupted by user.";
      addLog(`🛑 AutoApply execution interrupted by user.`);
    } else if (result.success) {
      state.status = "completed";
      state.summary = result.summary || "Application AutoApply complete.";
      addLog(`✅ AutoApply finished! Summary: ${state.summary}`);
    } else {
      state.status = "error";
      state.error = result.error || "Application AutoApply stopped with an error.";
      addLog(`❌ Agent error: ${state.error}`);
    }
  } catch (err: unknown) {
    if (state.status === "interrupted" || abortController.signal.aborted || (err instanceof Error && err.message.includes("Interrupted"))) {
      state.status = "interrupted";
      state.summary = "AutoApply interrupted by user.";
      addLog("🛑 Agent execution interrupted by user.");
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      state.status = "error";
      state.error = errorMsg;
      addLog(`❌ Agent error: ${errorMsg}`);
    }
  } finally {
    state.abortController = null;
    if (steelSession && steelManager) {
      if (!keepAlive) {
        addLog("Cleaning up Steel session...");
        await steelManager.release().catch(() => {});
        if (activeSteelSession === steelSession) {
          activeSteelSession = null;
          activeSteelManager = null;
          state.liveViewUrl = null;
        }
      } else {
        addLog(`👉 Steel cloud browser kept open for your review. Live View: ${steelSession.liveViewUrl}`);
        state.liveViewUrl = steelSession.liveViewUrl;
      }
    } else if (params.mode !== "steel") {
      state.liveViewUrl = null;
    }
  }
}

export { server };

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, () => {
    console.log(`\n============================================================`);
    console.log(`🌐 AutoApply Web UI running at: http://localhost:${PORT}`);
    console.log(`🔑 Anthropic API Key: ${process.env.ANTHROPIC_API_KEY ? "Loaded from .env ✅" : "NOT SET ❌"}`);
    console.log(`🤖 Model: ${process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022"} (from ${process.env.ANTHROPIC_MODEL ? ".env" : "default"})`);
    console.log(`============================================================\n`);
  });
}
