# Quickstart: Job Autofill Agent

Claude agent loop + SQLite persistence + Playwright MCP + Steel cloud browser,
with a human in the loop for anything irreversible.

---

## ⚡ Setup

**Node 22 is required.** `better-sqlite3@11` has no prebuilt binary for Node 23+
and fails to compile against it — `npm install` will die in `node-gyp`.

```bash
# 0. Check your Node version
node -v                      # must be v22.x
# macOS: brew install node@22 && brew link --overwrite --force node@22

# 1. Install dependencies
npm install

# 2. Configure credentials
cp .env.example .env
```

Set these in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...      # required
ANTHROPIC_MODEL=claude-sonnet-5   # optional, this is a sensible default
STEEL_API_KEY=ste-...             # required unless you pass --local
```

```bash
# 3. Verify
npm test                     # 66 unit + integration tests
npm run test:e2e             # optional: full-loop guard test, needs browsers
```

---

## 🚀 Run the Agent

### Recommended: Steel cloud browser with the safety guard

```bash
npm run cli -- "https://jobs.ashbyhq.com/wealthsimple/de09418a-8a12-46aa-a371-34bafaf5be26/application?utm_source=linkedinpaid"
```

Prints a live session URL you can open to watch the remote browser work. Add
`--local` to use a local browser instead (no Steel key needed, no live viewer).

### Core loop only (no Steel, no guard)

```bash
npm run agent -- "<JOB_URL>"
```

> **Note**: If prompted with `[HUMAN INPUT REQUIRED]`, type your answer — it is
> saved to SQLite (`data/context.db`) and reused on future applications. If
> prompted with `[HUMAN INTERCEPTION REQUIRED]`, a submit-like click was halted:
> answer `y` to allow it or press Enter to block. **The agent never submits an
> application on its own.**

---

## 🔌 Person 1: Steel Browser + MCP Interception + CLI HITL

Full details in [STEEL.md](STEEL.md). The short version:

```bash
# .env needs ANTHROPIC_API_KEY and STEEL_API_KEY
npm run cli -- "<JOB_URL>"
```

This creates a Steel cloud browser, prints the live session viewer URL, attaches
`@playwright/mcp` to it over CDP, and runs the agent behind a guard that halts
any submit-like click for confirmation in the terminal.

| Flag | Effect |
| --- | --- |
| `--local` | Skip Steel, drive a local browser (no live viewer) |
| `--offer-submit` | After the agent reports done, attempt the final Submit so the guard prompts you |
| `--auto-approve` | Never prompt — demo/CI only |
| `--max-turns=N` | Cap the loop (default 40) |

### Notes for the rest of the team

- The MCP package is **`@playwright/mcp`** (the bin is `mcp-server-playwright`);
  plain `playwright-mcp` is a different package. `PLAYWRIGHT_MCP_ARGS` still
  overrides the invocation if you need something else.
- Requires **Node 22** — `better-sqlite3@11` will not build on Node 23+.
- Never print a CDP URL or argv directly; run it through `redactSecrets()` from
  [src/util/redact.ts](src/util/redact.ts). Those URLs carry a session token.

### Using the pieces directly

```typescript
import { SteelSessionManager, resolveMcpLaunch, GuardedMcpClient, AgentLoop } from "./src/index.js";

const steel = new SteelSessionManager();
const session = await steel.create();
console.log("Watch:", session.liveViewUrl);

const client = new GuardedMcpClient({
  ...resolveMcpLaunch({ cdpEndpoint: session.cdpEndpoint }),
  liveViewUrl: session.liveViewUrl,
  prompt: async ({ match }) => ((await myConfirmUi(match.label)) ? "allow" : "deny"),
});

await new AgentLoop(client).run({ jobUrl, onHumanQuestion: myCliPrompt });
await steel.release();
```
