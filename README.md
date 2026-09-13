# utwat2026

Autonomous job-application autofill agent: Claude + Playwright MCP + a Steel
cloud browser, with a human in the loop for anything irreversible.

## Quickstart

Requires **Node 22** (`better-sqlite3@11` does not build on Node 23+).

```bash
npm install
cp .env.example .env     # then set ANTHROPIC_API_KEY and STEEL_API_KEY
npm test
```

Run against a Steel cloud browser, with the live session URL printed so you can
watch it work:

```bash
npm run cli -- "https://jobs.ashbyhq.com/wealthsimple/de09418a-8a12-46aa-a371-34bafaf5be26/application"
```

No Steel key? `npm run cli -- --local "<url>"` drives a local browser instead.

The agent fills what it can, asks you in the terminal for anything it doesn't
know (saving the answer for next time), and **never submits an application** —
any submit-like click is halted for your confirmation first.

## Docs

- [SETUP.md](SETUP.md) — setup and per-person integration notes
- [STEEL.md](STEEL.md) — Steel browser, MCP interception, and the CLI
  human-in-the-loop flow

## Scripts

| Command | What it does |
| --- | --- |
| `npm run cli -- "<url>"` | Steel browser + guarded agent run |
| `npm run agent -- "<url>"` | Core agent loop without the Steel/guard wrapper |
| `npm test` | Unit and integration tests |
| `npm run test:e2e` | Full-loop guard test (needs Playwright browsers) |
