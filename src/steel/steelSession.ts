/**
 * Steel.dev cloud browser session lifecycle.
 *
 * Creates a remote Chrome session on Steel, exposes the CDP endpoint that
 * @playwright/mcp attaches to via `--cdp-endpoint`, and surfaces the live
 * session viewer URL so humans (and judges) can watch the run in real time.
 */

import { redactSecrets } from "../util/redact.js";

export const DEFAULT_STEEL_API_URL = "https://api.steel.dev";
export const DEFAULT_STEEL_CONNECT_URL = "wss://connect.steel.dev";
export const DEFAULT_STEEL_APP_URL = "https://app.steel.dev";

export interface SteelSessionOptions {
  apiKey?: string;
  apiUrl?: string;
  connectUrl?: string;
  /** Session idle/total timeout in milliseconds. */
  sessionTimeoutMs?: number;
  useProxy?: boolean;
  solveCaptcha?: boolean;
  blockAds?: boolean;
  /** Persisted browser context id, so cookies/logins survive across runs. */
  contextId?: string;
  /** Milliseconds to wait on the Steel REST API before giving up. */
  requestTimeoutMs?: number;
}

export interface SteelSession {
  id: string;
  /** Passed to `@playwright/mcp --cdp-endpoint`. */
  cdpEndpoint: string;
  /** Embeddable live view of the remote browser. */
  liveViewUrl: string;
  apiUrl: string;
}

/** Shape of the subset of Steel's create-session response we rely on. */
interface SteelCreateSessionResponse {
  id?: string;
  sessionId?: string;
  websocketUrl?: string;
  debugUrl?: string;
  sessionViewerUrl?: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Builds the CDP websocket URL @playwright/mcp connects to.
 *
 * Prefers the `websocketUrl` Steel returned for the session, falling back to
 * the connect host, and makes sure `sessionId` is present.
 *
 * Steel's `websocketUrl` already carries a short-lived, session-scoped `token`,
 * which is sufficient to connect (verified against the live API). When it is
 * present the long-lived API key is deliberately NOT appended: this URL becomes
 * a subprocess argument, visible in `ps` to every local user and in any log
 * that echoes the command line.
 */
export function buildCdpEndpoint(params: {
  sessionId: string;
  websocketUrl?: string | null;
  connectUrl?: string;
  apiKey?: string;
}): string {
  const base =
    params.websocketUrl && /^wss?:\/\//i.test(params.websocketUrl)
      ? params.websocketUrl
      : params.connectUrl || DEFAULT_STEEL_CONNECT_URL;

  const url = new URL(base);
  if (!url.searchParams.has("sessionId")) {
    url.searchParams.set("sessionId", params.sessionId);
  }

  const hasSessionToken = url.searchParams.has("token");
  if (params.apiKey && !hasSessionToken && !url.searchParams.has("apiKey")) {
    url.searchParams.set("apiKey", params.apiKey);
  }
  return url.toString();
}

/**
 * Resolves the human-watchable URL for a session, preferring whatever Steel
 * handed back and falling back to the canonical dashboard path.
 */
export function buildLiveViewUrl(
  sessionId: string,
  response: { sessionViewerUrl?: string | null; debugUrl?: string | null } = {},
  appUrl: string = DEFAULT_STEEL_APP_URL
): string {
  return (
    response.sessionViewerUrl ||
    response.debugUrl ||
    `${trimTrailingSlash(appUrl)}/sessions/${sessionId}`
  );
}

export class SteelSessionManager {
  private readonly options: Required<
    Pick<SteelSessionOptions, "apiUrl" | "connectUrl" | "sessionTimeoutMs" | "requestTimeoutMs">
  > &
    SteelSessionOptions;
  private current: SteelSession | null = null;
  private released = false;

  constructor(options: SteelSessionOptions = {}) {
    this.options = {
      apiKey: options.apiKey ?? process.env.STEEL_API_KEY,
      apiUrl: trimTrailingSlash(options.apiUrl ?? process.env.STEEL_API_URL ?? DEFAULT_STEEL_API_URL),
      connectUrl: trimTrailingSlash(
        options.connectUrl ?? process.env.STEEL_CONNECT_URL ?? DEFAULT_STEEL_CONNECT_URL
      ),
      sessionTimeoutMs:
        options.sessionTimeoutMs ?? Number(process.env.STEEL_SESSION_TIMEOUT_MS || 900_000),
      useProxy: options.useProxy ?? process.env.STEEL_USE_PROXY === "true",
      solveCaptcha: options.solveCaptcha ?? process.env.STEEL_SOLVE_CAPTCHA === "true",
      blockAds: options.blockAds ?? process.env.STEEL_BLOCK_ADS !== "false",
      contextId: options.contextId ?? process.env.STEEL_CONTEXT_ID,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    };
  }

  public get hasApiKey(): boolean {
    return Boolean(this.options.apiKey);
  }

  public get session(): SteelSession | null {
    return this.current;
  }

  /** Creates a remote Steel browser session and returns its CDP + viewer URLs. */
  public async create(): Promise<SteelSession> {
    if (this.current) {
      return this.current;
    }
    if (!this.options.apiKey) {
      throw new Error(
        "STEEL_API_KEY is not set. Set it in .env to use a Steel cloud browser, or pass --local to run Playwright locally."
      );
    }

    const endpoint = `${this.options.apiUrl}/v1/sessions`;
    console.log(`[Steel] Creating cloud browser session at ${endpoint} ...`);

    const payload: Record<string, unknown> = {
      sessionTimeout: this.options.sessionTimeoutMs,
      blockAds: this.options.blockAds,
    };
    if (this.options.useProxy) payload.useProxy = true;
    if (this.options.solveCaptcha) payload.solveCaptcha = true;
    if (this.options.contextId) payload.sessionContext = { id: this.options.contextId };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "steel-api-key": this.options.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Steel session creation failed (HTTP ${response.status} ${response.statusText}): ${body.slice(0, 500)}`
      );
    }

    const data = (await response.json()) as SteelCreateSessionResponse;
    const sessionId = data.id || data.sessionId;
    if (!sessionId) {
      throw new Error(`Steel returned a session without an id: ${JSON.stringify(data).slice(0, 500)}`);
    }

    this.current = {
      id: sessionId,
      cdpEndpoint: buildCdpEndpoint({
        sessionId,
        websocketUrl: data.websocketUrl,
        connectUrl: this.options.connectUrl,
        apiKey: this.options.apiKey,
      }),
      liveViewUrl: buildLiveViewUrl(sessionId, data),
      apiUrl: this.options.apiUrl,
    };
    this.released = false;

    return this.current;
  }

  /** Releases the remote session. Safe to call repeatedly. */
  public async release(): Promise<void> {
    const session = this.current;
    if (!session || this.released) {
      return;
    }
    this.released = true;

    try {
      const response = await fetch(`${session.apiUrl}/v1/sessions/${session.id}/release`, {
        method: "POST",
        headers: { "steel-api-key": this.options.apiKey! },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
      if (!response.ok) {
        console.warn(`[Steel] Release returned HTTP ${response.status}. The session will expire on its own.`);
      } else {
        console.log(`[Steel] Released session ${session.id}.`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Steel] Could not release session ${session.id}: ${message}`);
    } finally {
      this.current = null;
    }
  }
}

/** Prints the live session URL prominently so it is easy to spot in the terminal. */
export function logSessionViewer(session: SteelSession): void {
  const line = "=".repeat(72);
  console.log("\n" + line);
  console.log("🖥️  STEEL LIVE SESSION VIEWER — watch the remote browser in real time");
  console.log(line);
  console.log(`Session ID : ${session.id}`);
  console.log(`Live view  : ${session.liveViewUrl}`);
  console.log(`CDP        : ${redactSecrets(session.cdpEndpoint)}`);
  console.log(line + "\n");
}
