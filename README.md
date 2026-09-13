# 🚀 AutoApply

Autonomous job application agent powered by **Claude**, **Playwright MCP**, **Mozilla pdfjs-dist**, **SQLite**, and **Steel.dev** cloud browsers — with strict Human-in-the-Loop (HITL) safeguards.

---

## ⚡ Quickstart

> **Prerequisite**: Node 22 (`better-sqlite3` requires Node 22).

```bash
# 1. Install & configure
npm install
cp .env.example .env

# Set credentials in .env:
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-haiku-4-5-20251001   # or claude-3-5-sonnet-20241022
# STEEL_API_KEY=ste-...                       # optional for remote cloud browser

# 2. Run test suite (94 tests)
npm test

# 3. Launch Web UI Dashboard
npm run ui
```

Open [http://localhost:3000](http://localhost:3000).

---

## 🌟 Core Features

- **📄 Smart Resume Parsing**: Upload PDF or text resume. Extracted via Mozilla's **`pdfjs-dist`** and parsed with Claude into candidate profile fields.
- **🧠 Persistent Q&A Memory**: Stored in SQLite (`data/context.db`). Add, search, edit, delete, and export/import learned answers so the agent never asks the same question twice.
- **🛡️ Guarded Execution & Submission Safeguard**: The agent fills forms autonomously but **never submits on its own**. Submission-like buttons require human approval.
- **⏹️ One-Click Interruption**: Instantly stop active runs at any turn via the `⏹️ Interrupt` button or `POST /api/interrupt`.
- **⏱️ Interactive Turn Extension**: When turn limit is reached, AutoApply prompts you to continue (`+10 Turns`, `+20 Turns`, or `Stop`).
- **🌐 Flexible Execution Modes**:
  - **Steel.dev Cloud Browser**: Remote browser with interactive live viewer, session keep-alive for manual review, follow-up prompt continuation, and explicit session release.
  - **Local Headed**: Live desktop browser window.
  - **Local Headless**: Fast background execution.

---

## 💻 CLI Usage

```bash
# Steel cloud browser + safety guard
npm run cli -- "<JOB_URL>"

# Local browser (no Steel key needed)
npm run cli -- --local "<JOB_URL>"

# Core agent loop only
npm run agent -- "<JOB_URL>"
```

---

## 📜 Available Scripts

| Command | Description |
| --- | --- |
| `npm run ui` | Launch full Web UI dashboard on `http://localhost:3000` |
| `npm run cli -- "<url>"` | Run CLI agent with Steel cloud browser & submit guard |
| `npm run agent -- "<url>"` | Run core agent loop directly |
| `npm test` | Run 94 unit & integration tests across 18 suites |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run test:e2e` | End-to-end submit guard test |

---

## 📚 Documentation

- [SETUP.md](SETUP.md) — Detailed setup, environment variables, and architecture
- [STEEL.md](STEEL.md) — Steel.dev cloud browser and CDP connection guide
