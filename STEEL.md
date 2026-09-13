# Steel Browser + MCP Interception + CLI HITL (Person 1)

The agent drives a **remote Chrome running on Steel**, not a browser on your laptop.
Every browser action goes through an MCP middleware layer that halts submit-like
clicks and asks you in the terminal before letting them through.

```
  CLI (src/cli/run.ts)
        │  creates session, prints live viewer URL
        ▼
  Steel cloud Chrome ──── wss CDP ────┐
                                      │
  AgentLoop ── tool call ── GuardedMcpClient ── npx @playwright/mcp --cdp-endpoint …
                              │
                              └── submit-like? → CLI prompt → allow / block
```

## Setup

```bash
npm install
cp .env.example .env
```

Add to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
STEEL_API_KEY=ste-...
```

## Run

```bash
npm run cli -- "https://jobs.ashbyhq.com/wealthsimple/de09418a-8a12-46aa-a371-34bafaf5be26/application"
```

On start the CLI prints the live session viewer — open it to watch the remote
browser fill the form in real time:

```
========================================================================
🖥️  STEEL LIVE SESSION VIEWER — watch the remote browser in real time
========================================================================
Session ID : 0f2c...
Live view  : https://app.steel.dev/sessions/0f2c...
CDP        : wss://connect.steel.dev/?sessionId=0f2c...&token=***
========================================================================
```

### Credentials

Steel returns a short-lived, session-scoped `token` in the CDP URL, and that
token alone is enough to attach — so the long-lived `STEEL_API_KEY` is
deliberately **not** appended to the endpoint. That URL becomes an argument to
the `npx @playwright/mcp` subprocess, which is visible in `ps` to every user on
the machine and in anything that echoes a command line.

Both the token and any API key are masked with `***` before being printed
([`src/util/redact.ts`](src/util/redact.ts)), so a live demo can be screen-shared
safely. If you add logging that prints a CDP URL or argv, run it through
`redactSecrets()` first.

### Options

| Flag | Effect |
| --- | --- |
| `--local` | Skip Steel, drive a local Playwright browser (no live viewer) |
| `--headed` | Show the local browser window (with `--local`) |
| `--auto-approve` | Do not prompt on submit-like clicks — demo/CI only |
| `--no-keep-alive` | Release the Steel session as soon as the run ends |
| `--offer-submit` | After the agent reports done, attempt the final Submit click so the guard prompts you |
| `--max-turns=N` | Cap the agent loop (default 40) |

### Showing the guard actually working

The agent will not try to submit on its own — Claude follows the instruction not
to, so a normal run ends with `Intercepts: 0` and the guard never visibly fires.
To demonstrate it, use `--offer-submit`: once the agent reports it is done, the
CLI locates the Submit control in the page snapshot and attempts the click
itself. That click goes through the guard like any other, so you get the
confirmation prompt and can show either outcome:

```bash
npm run cli -- --offer-submit "<JOB_URL>"
```

Answer `n` and the application is not submitted; answer `y` and the click is
executed against the remote browser, visible in the live viewer.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `STEEL_API_KEY` | — | Required unless `--local` |
| `STEEL_API_URL` | `https://api.steel.dev` | Point at a self-hosted Steel |
| `STEEL_CONNECT_URL` | `wss://connect.steel.dev` | CDP connect host |
| `STEEL_SESSION_TIMEOUT_MS` | `900000` | Session lifetime |
| `STEEL_USE_PROXY` / `STEEL_SOLVE_CAPTCHA` | `false` | Steel session features |
| `STEEL_CONTEXT_ID` | — | Reuse a saved browser context (cookies/logins) |
| `PLAYWRIGHT_MCP_ARGS` | — | JSON array overriding the MCP server invocation |
| `HITL_AUTO_APPROVE` | `false` | Same as `--auto-approve` |
| `HITL_GUARD_ENTER` | `true` | Set `false` to stop guarding Enter presses |

## The two human-in-the-loop paths

**1. Submit interception** — [`src/mcp/guardedMcpClient.ts`](src/mcp/guardedMcpClient.ts)
wraps the MCP client, so it inspects the real tool call rather than trusting the
system prompt. Guarded routes ([`src/hitl/submitGuard.ts`](src/hitl/submitGuard.ts)):

| Tool | Halted when |
| --- | --- |
| `browser_click` | Target matches `submit`, `send application`, `apply now`, … |
| `browser_type` | Called with `submit: true` — it presses Enter afterwards |
| `browser_press_key` | The key is Enter/Return |
| `browser_evaluate` | The JS calls `.submit()`, `requestSubmit()` or `.click()` |
| `browser_run_code_unsafe` | Always — arbitrary Playwright code cannot be screened |

A click is matched on **both** the model's description and what the page itself
calls that element, resolved from the last accessibility snapshot. A model that
describes the Submit button as "final action button" is still caught.

`npm run test:bypass` exercises all of these against a real browser. Reads,
navigation and ordinary field fills are never guarded, so the agent keeps full
speed until the point of no return.

A halted action looks like this:

```
========================================================================
🛑 [HUMAN INTERCEPTION REQUIRED] Submit-like browser action halted
========================================================================
Tool     : browser_click
Target   : Submit application button (ref=e42)
Reason   : click target matches guarded phrase "submit"
Live view: https://app.steel.dev/sessions/0f2c...
Arguments: {"element":"Submit application button","ref":"e42"}
------------------------------------------------------------------------
👉 [y] allow once   [a] allow all for this run   [N] block (default):
```

Blocking is the default (including when there is no TTY). The action never
reaches the MCP server; Claude receives a denial result that tells it to stop
retrying and call `report_completion` instead.

**2. Missing information** — [`src/hitl/humanQuestion.ts`](src/hitl/humanQuestion.ts)
handles Claude's `ask_human_and_save` tool. The question (plus any dropdown
options it found) is shown in the terminal, your answer is passed straight back
into the agent loop, and the loop persists it to SQLite so the next application
answers itself.

## Using the pieces from other code

```ts
import { SteelSessionManager, resolveMcpLaunch, GuardedMcpClient, AgentLoop } from "./src/index.js";

const steel = new SteelSessionManager();
const session = await steel.create();
console.log("Watch:", session.liveViewUrl);

const client = new GuardedMcpClient({
  ...resolveMcpLaunch({ cdpEndpoint: session.cdpEndpoint }),
  liveViewUrl: session.liveViewUrl,
  prompt: async ({ match }) => (await myOwnConfirmUi(match.label)) ? "allow" : "deny",
});

await new AgentLoop(client).run({ jobUrl });
await steel.release();
```

## Tests

```bash
npm test
```

Covers submit detection, the interceptor's allow/block/allow-all paths, Steel
CDP + viewer URL construction, API-key redaction, and MCP launch arguments.
