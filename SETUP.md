# 🛠️ Setup & Architecture Guide: AutoApply

Autonomous job application agent with Claude, SQLite persistent memory, Mozilla pdfjs-dist text extraction, Playwright MCP, Steel cloud browsers, and Human-in-the-Loop safeguards.

---

## ⚡ Prerequisites & Installation

> **Important**: **Node 22 is required.** `better-sqlite3@11` requires Node 22 (`npm install` will fail on Node 23+).

```bash
# 0. Verify Node version (v22.x required)
node -v
# On macOS via Homebrew:
# brew install node@22 && brew link --overwrite --force node@22

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
```

### Environment Variables (`.env`)

```bash
# Anthropic API Key (Required)
ANTHROPIC_API_KEY=sk-ant-...

# Model Selection (Optional - defaults to claude-3-5-sonnet-20241022)
# Supports claude-haiku-4-5-20251001, claude-3-5-sonnet-20241022, etc.
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Steel.dev Cloud Browser Key (Optional - required for remote Steel browser mode)
STEEL_API_KEY=ste-...

# Playwright MCP Customization (Optional)
# PLAYWRIGHT_MCP_COMMAND=npx
# PLAYWRIGHT_MCP_ARGS=["-y","@playwright/mcp@latest"]
```

---

## 🧪 Verification

```bash
# Run comprehensive test suite (94 tests across 18 suites)
npm test

# Build TypeScript
npm run build
```

---

## 🚀 Running AutoApply

### Option 1: Web UI Dashboard (Recommended)

```bash
npm run ui
```

Access **[http://localhost:3000](http://localhost:3000)**:
- **Profile Management**: Stored in SQLite (`data/context.db`).
- **Resume Upload**: Upload PDF or text resume. Extracted via Mozilla's **`pdfjs-dist`** and parsed with Claude into candidate fields.
- **Learned Q&A Memory**: View, search, edit, delete, and export/import stored question-and-answer pairs.
- **Job Application Runner**: Paste any Ashby, Greenhouse, or Lever job URL.
- **Execution Modes**:
  - `Steel.dev Cloud Browser (Remote)`: Opens live session viewer on launch.
  - `Local Browser (Headed)`: Watch browser live on desktop.
  - `Local Browser (Headless)`: Runs silently in the background.
- **Control**: `⏹️ Interrupt` button to halt execution anytime; interactive turn extension dialog (`+10 Turns`, `+20 Turns`, `Stop`) when reaching turn limit.

---

### Option 2: CLI Runner

```bash
# Remote Steel.dev browser with live viewer + submit guard
npm run cli -- "<JOB_URL>"

# Local browser (no Steel API key required)
npm run cli -- --local "<JOB_URL>"

# Core agent loop only
npm run agent -- "<JOB_URL>"
```

#### CLI Flags

| Flag | Description |
| --- | --- |
| `--local` | Drive a local Playwright browser instead of Steel |
| `--offer-submit` | Prompts for human confirmation before the final submission click |
| `--max-turns=N` | Max turns before prompting user to continue (default: 40) |
| `--auto-approve` | Bypass human approval (demo/CI only) |

---

## 🏗️ Architecture Overview

```
                          ┌────────────────────────┐
                          │   AutoApply Web UI     │
                          │ (http://localhost:3000)│
                          └───────────┬────────────┘
                                      │ REST API / HITL
                                      ▼
                          ┌────────────────────────┐
                          │    Express / Node      │
                          │      (server.ts)       │
                          └─────┬────────────┬─────┘
                                │            │
      ┌─────────────────────────┴────┐   ┌───┴────────────────────────┐
      │      Context Store           │   │      Agent Loop            │
      │  (SQLite: data/context.db)   │   │  (Claude 3.5 / Haiku)      │
      │   - Candidate Profile        │   └───────────────┬────────────┘
      │   - Learned Q&A Memory       │                   │
      └──────────────────────────────┘                   │ Tools
                                                         ▼
                                         ┌────────────────────────────┐
                                         │    Guarded MCP Client      │
                                         │    (@playwright/mcp)       │
                                         └───────────────┬────────────┘
                                                         │
                                        ┌────────────────┴────────────┐
                                        │                             │
                                        ▼                             ▼
                              ┌───────────────────┐        ┌───────────────────┐
                              │  Steel.dev Cloud  │        │  Local Playwright │
                              │   Browser (CDP)   │        │ (Headed/Headless) │
                              └───────────────────┘        └───────────────────┘
```

- **`src/db/contextStore.ts`**: SQLite database with WAL mode. Stores profile, resume path, and Q&A memory with fuzzy & token-overlap matching.
- **`src/util/pdfExtractor.ts`**: Mozilla `pdfjs-dist` text extractor for PDFs.
- **`src/agent/agentLoop.ts`**: Multi-turn Claude agent loop with tool dispatch, stay-on-page protection, and interactive turn extensions.
- **`src/mcp/guardedMcpClient.ts`**: Submit safeguard ensuring the agent never submits applications without human confirmation.
- **`src/steel/steelSession.ts`**: Steel.dev remote browser provisioning and live view link generation.
- **`src/server.ts`**: REST API and Web UI server.

