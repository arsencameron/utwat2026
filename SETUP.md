# Quickstart: Job Autofill Agent

Core Anthropic Claude 3.5 Sonnet agent loop + SQLite persistence + Playwright MCP.

---

## ⚡ 3-Step Setup

```bash
# 1. Install dependencies
npm install

# 2. Set your Anthropic API Key
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 3. Verify tests pass (9/9)
npm test
```

---

## 🚀 Run the Agent

### Watch Live (Headed Browser)
```bash
PLAYWRIGHT_MCP_ARGS='["playwright-mcp"]' npm run agent -- "https://jobs.ashbyhq.com/wealthsimple/de09418a-8a12-46aa-a371-34bafaf5be26/application?utm_source=linkedinpaid"
```

### Background (Headless)
```bash
npm run agent -- "https://jobs.ashbyhq.com/wealthsimple/de09418a-8a12-46aa-a371-34bafaf5be26/application?utm_source=linkedinpaid"
```

> **Note**: If prompted in the terminal with `[HUMAN INTERCEPTION REQUIRED]`, type your answer. It will be saved into SQLite (`data/context.db`) and reused automatically on future applications. Claude will never click final Submit directly.

---

## 🔌 Person 1 Integration

### Connect Steel.dev / Remote CDP
```bash
PLAYWRIGHT_MCP_ARGS='["playwright-mcp", "--cdp-endpoint", "wss://connect.steel.dev?apiKey=YOUR_KEY"]' npm run agent -- "<JOB_URL>"
```

### Or Plug Into Your CLI Script
```typescript
import { runJobAutofill } from "./src/index.js";

await runJobAutofill(jobUrl, {
  // Pass Steel.dev / remote browser
  mcpArgs: ["playwright-mcp", "--cdp-endpoint", "wss://connect.steel.dev?apiKey=..."],

  // Pass your custom CLI interception hook
  onHumanQuestion: async (question, context) => {
    return await myCliPrompt(question, context);
  },
});
```
