/**
 * Masks credentials in URLs before they are logged.
 *
 * CDP endpoints carry a Steel session token (and historically an API key) as
 * query parameters, and those URLs get printed to the terminal and passed to a
 * subprocess. Anything printed during a demo is on screen for whoever is
 * watching, so it gets masked first.
 */

/** Query parameters whose values must never be printed. */
export const SENSITIVE_QUERY_PARAMS = [
  "apikey",
  "api_key",
  "token",
  "access_token",
  "auth",
  "key",
  "password",
  "secret",
  "signature",
];

/**
 * Replaces the value of every sensitive query parameter with `***`.
 * Non-URL input is returned unchanged.
 */
export function redactSecrets(value: string): string {
  try {
    const url = new URL(value);
    let touched = false;

    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.includes(name.toLowerCase())) {
        url.searchParams.set(name, "***");
        touched = true;
      }
    }

    return touched ? url.toString() : value;
  } catch {
    return value;
  }
}

/** Redacts each item of a command line (argv), leaving non-URL arguments alone. */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => redactSecrets(arg));
}
