/**
 * Telling fzf to repaint — the whole of what the ask commands know about fzf.
 *
 * `POST /` with the body `refresh-preview` to `$FZF_PORT`, authenticated with
 * `$FZF_API_KEY`. Plain `fetch` (global in Node 20), not `curl`: an undeclared
 * dependency for one HTTP request.
 *
 * **Failure is swallowed, and that is not laziness.** fzf may have exited while
 * the answer was in flight, and a POST to a closed port must not take a worker
 * down before it has finished writing the transcript.
 *
 * **The key comes from the environment and goes nowhere else.** fzf exports it
 * to its children, `__ask-send` passes it to the worker by inheritance, and it
 * must never appear in an argv, a binding string or the transcript's `meta`
 * record — argv is world-readable (`ps -ww -o args=`), another process's
 * environment is not. The port takes the opposite route, on the argv, precisely
 * because it is not a secret.
 *
 * Honest about what this buys: the key raises the bar against a different-user
 * or non-local attacker, and it is what stops an unauthenticated POST executing
 * commands as us. It does NOT stop a same-uid local attacker, who can read fzf's
 * environment. The only boundary there is a unix socket, whose fzf floor
 * (0.66.0) is out of reach. Known and accepted.
 */

/** A refresh POST as data, so the policy is testable without a socket. */
export interface RefreshRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: "refresh-preview";
}

export function refreshRequest(port: number, apiKey: string): RefreshRequest {
  return {
    url: `http://127.0.0.1:${port}`,
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: "refresh-preview",
  };
}

/**
 * The notifier for this process, or a no-op.
 *
 * No port or no key means no POST at all: there is no unauthenticated path here
 * to accidentally take. A missing port is also the normal case for `gm __ask-*`
 * driven straight from a shell, where there is no pane to repaint.
 */
export function refreshNotifier(port: string | undefined, env: NodeJS.ProcessEnv = process.env): () => void {
  const parsed = Number.parseInt(port ?? "", 10);
  const apiKey = env["FZF_API_KEY"];
  if (!Number.isFinite(parsed) || parsed <= 0 || !apiKey) return () => {};

  const request = refreshRequest(parsed, apiKey);
  return () => {
    void fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    }).catch(() => {});
  };
}
