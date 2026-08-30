/**
 * Running a provider CLI: prompt in on stdin, text out on stdout.
 *
 * The whole vendor abstraction lives here. Both consumers — summaries and
 * `gm ask` — spawn the same way and differ only in argv and timeout, so the
 * spawn, the timeout, the kill and the stderr capture are written once.
 *
 * Errors are plain `Error`s with a readable message; callers wrap them in their
 * own typed error so the `fix` line can say something specific to what failed.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { childEnv } from "./config.js";

export interface RunProviderOptions {
  timeoutMs: number;
  /**
   * Environment for the child.
   *
   * Defaults to `childEnv()` — ours plus GIGAMANAGE_CHILD=1 — because every
   * provider we spawn is an agent that may shell back into `gm`, and a nested
   * `gm` must not start a background summarize pass of its own.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Decoded stdout as it arrives, in order, never a partial UTF-8 sequence,
   * never after the promise settles. Throwing here is swallowed.
   *
   * Every byte handed here is also in the resolved string, in the same order:
   * `resolved === chunks.join("")`. That is what lets a caller record the
   * answer from the resolved string without a late chunk racing it.
   *
   * A tee, not a mechanism. `claude -p` buffers, so against it this fires
   * exactly once — but gm is provider-agnostic, and a provider that trickles
   * gets incremental rendering out of it for free, with no second code path.
   */
  onChunk?: (text: string) => void;
  /** Aborting SIGKILLs the child and rejects. */
  signal?: AbortSignal;
}

export async function runProviderCommand(
  argv: readonly string[],
  prompt: string,
  options: RunProviderOptions,
): Promise<string> {
  const [binary, ...args] = argv;
  if (!binary) throw new Error("provider command is empty");

  return new Promise<string>((resolve, reject) => {
    // Checked before the spawn: a caller that aborts first must not leave a
    // provider running that nobody is waiting for — it would keep billing.
    if (options.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? childEnv(),
    });

    // Not `String(chunk)`: Node splits a stream at arbitrary byte boundaries, so
    // a 3-byte `—` straddling one decodes as `��` on both sides. The decoder
    // holds the incomplete tail until the rest of it arrives.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`timed out after ${options.timeoutMs}ms`));
      });
    }, options.timeoutMs);

    // Not `detached: true`, and that is deliberate: the caller that cancels us
    // is itself the group leader (`spawn(…, { detached: true })` in the worker),
    // and it kills the whole group. A provider in a group of its own would
    // survive that kill — the exact orphan the group kill exists to prevent.
    const onAbort = (): void => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error("aborted"));
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    }

    // Ordered before the string it tees, so the resolved value can never contain
    // a byte the caller was not handed first. Throwing is the caller's problem,
    // not the provider run's.
    const tee = (text: string): void => {
      if (settled || !text) return;
      try {
        options.onChunk?.(text);
      } catch {
        /* swallowed */
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = outDecoder.write(chunk);
      stdout += text;
      tee(text);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += errDecoder.write(chunk)));
    child.on("error", (error) => finish(() => reject(new Error(error.message))));
    child.on("close", (code) => {
      // `end()` flushes a trailing incomplete sequence — a truncated output's
      // last bytes become `�` rather than vanishing. Teed before settle, so the
      // ordering guarantee holds through the flush.
      const rest = outDecoder.end();
      stdout += rest;
      tee(rest);
      stderr += errDecoder.end();
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `exited with code ${code}`));
      });
    });

    // EPIPE: a provider that exits before reading its prompt would otherwise
    // take the whole process down with an unhandled error event, turning a
    // provider bug into a gigamanage crash.
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
