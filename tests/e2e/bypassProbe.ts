/**
 * Verifies that every known route to submitting a form is intercepted, against
 * a real @playwright/mcp server and a real browser.
 *
 * Each of these bypassed the guard before: they never issue a guarded
 * browser_click, but every one of them can submit the form.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GuardedMcpClient } from "../../src/mcp/guardedMcpClient.js";
import { resolveMcpLaunch } from "../../src/mcp/playwrightMcp.js";

const PAGE = `<!doctype html><html><body>
<form id="f"><input name="email" /><button type="submit">Submit application</button></form>
</body></html>`;

async function main() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/job`;

  const prompted: string[] = [];
  const client = new GuardedMcpClient({
    ...resolveMcpLaunch({}),
    prompt: async ({ toolName, match }) => {
      prompted.push(`${toolName}: ${match.reason}`);
      return "deny";
    },
  });

  await client.connect();
  await client.callTool("browser_navigate", { url });
  const snap = await client.callTool("browser_snapshot", {});
  const submitRef = snap.content.match(/button "Submit application" \[ref=([^\]]+)\]/)?.[1] ?? "e1";

  const attempts: [string, Record<string, unknown>][] = [
    ["browser_type + submit:true", { element: "Email", target: "e5", text: "x", submit: true }],
    ["browser_evaluate form.submit()", { function: "() => document.getElementById('f').submit()" }],
    ["browser_run_code_unsafe", { code: "async (page) => page.getByRole('button').click()" }],
    ["browser_click mislabeled", { element: "final action button", target: submitRef }],
  ];
  const toolFor: Record<string, string> = {
    "browser_type + submit:true": "browser_type",
    "browser_evaluate form.submit()": "browser_evaluate",
    browser_run_code_unsafe: "browser_run_code_unsafe",
    "browser_click mislabeled": "browser_click",
  };

  const results: [string, boolean][] = [];
  for (const [name, args] of attempts) {
    const result = await client.callTool(toolFor[name]!, args);
    results.push([name, result.isError && result.content.includes("BLOCKED BY HUMAN OPERATOR")]);
  }

  // Control: a harmless action must still pass straight through.
  const harmless = await client.callTool("browser_evaluate", { function: "() => document.title" });
  results.push(["control: harmless evaluate still allowed", !harmless.isError]);

  await client.disconnect();
  server.close();

  console.log("\n========== BYPASS PROBE ==========");
  for (const [name, blocked] of results) console.log(`${blocked ? "✅" : "❌"} ${name}`);
  console.log("\nprompts shown to the human:");
  for (const line of prompted) console.log(`  - ${line}`);
  console.log("==================================");
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((error) => {
  console.error("bypass probe failed:", error);
  process.exit(1);
});
