/**
 * Running commands in a Freestyle VM, for the Freestyle provider
 * (`./freestyle.ts`).
 *
 * The SDK has two ways in. `vm.exec()` waits for the command and returns its
 * output in one response, with a five-minute cap: fine for the provider's own
 * quick setup commands (`runSetupCommand`). A Sandcastle `exec` can be an
 * agent run that streams for an hour, so it goes over a PTY session instead
 * (`execInVm`), which has no time cap and delivers output as it arrives.
 *
 * A PTY merges stdout and stderr into one terminal stream, so each command
 * runs from a small bash script that keeps them apart: stdout reaches the
 * PTY through `cat` (so the command never sees a terminal), stderr goes to a
 * file read back after the exit. The script also carries the env, the cwd and
 * stdin, so neither a secret nor a large prompt ever rides on a URL or an
 * argument list.
 */

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { posix } from "node:path";
import type { Vm } from "freestyle";
import { shellEscape } from "../AgentProvider.js";
import type { ExecResult } from "../SandboxProvider.js";
import { BoundedTail } from "../boundedTail.js";

/** `vm.exec()`'s ceiling: it refuses a longer timeout. */
const SETUP_TIMEOUT_MS = 300_000;

/** A POSIX environment variable name, which `export` accepts. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Ends the base64 stdin heredoc; base64 output can never contain it. */
const STDIN_EOF = "SANDCASTLE_STDIN_EOF";

/**
 * Run one of the provider's own setup commands to completion with
 * `vm.exec()`, as the VM's default user or as root. Returns its stdout, and
 * throws on a non-zero exit or the five-minute timeout.
 */
export const runSetupCommand = async (
  vm: Vm,
  command: string,
  options?: { readonly root?: boolean },
): Promise<string> => {
  const request = { command, timeoutMs: SETUP_TIMEOUT_MS };
  const result =
    options?.root === true
      ? await vm.linuxUser("root").exec(request)
      : await vm.exec(request);
  const status = result.statusCode;
  if (status === 0) {
    return result.stdout ?? "";
  }
  throw new Error(
    `freestyle(): ${command} failed: ${whyFailed(result.stderr, status)}`,
  );
};

/** Why a setup command failed: its stderr when it has one, else its status. */
const whyFailed = (
  stderr: string | null | undefined,
  status: number | null | undefined,
): string => {
  const text = stderr?.trim() ?? "";
  if (text !== "") {
    return text;
  }
  if (status === null || status === undefined) {
    return `timed out after ${SETUP_TIMEOUT_MS / 1000}s`;
  }
  return `exit ${status}`;
};

/** What one Sandcastle `exec` in the VM needs. */
export interface FreestyleExecRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly onLine?: (line: string) => void;
  readonly sudo?: boolean;
  readonly stdin?: string;
  /** Bound on the stdout and stderr tails of a streamed `exec`. */
  readonly maxOutputTailChars: number;
  /**
   * A folder only the VM's default user can enter, for each command's script
   * and stderr file. Files the SDK writes are root-owned, so this folder is
   * what keeps the script (and the env in it) private, and lets the script
   * delete itself.
   */
  readonly scratchDir: string;
}

/** base64 of `text`, wrapped at 76 columns, as `base64 -d` reads it. */
const base64Lines = (text: string): string[] =>
  Buffer.from(text)
    .toString("base64")
    .match(/.{1,76}/gu) ?? [];

/**
 * The bash script one command runs from. It deletes itself first (bash keeps
 * reading from its open file), puts the PTY in raw mode so output passes
 * through byte for byte, and exits with the command's own status.
 */
const execScript = (request: FreestyleExecRequest, errPath: string): string => {
  const exports = Object.entries(request.env).map(([name, value]) => {
    if (!ENV_NAME.test(name)) {
      throw new Error(
        `freestyle(): ${JSON.stringify(name)} is not a valid environment variable name`,
      );
    }
    return `export ${name}=${shellEscape(value)}`;
  });
  const run =
    `( cd ${shellEscape(request.cwd)} && exec sh -c "$__sandcastle_cmd" )` +
    ` 2>${shellEscape(errPath)}`;
  const pipeline =
    request.stdin === undefined
      ? [`${run} </dev/null | cat`, 'exit "$((PIPESTATUS[0]))"']
      : [
          `base64 -d <<'${STDIN_EOF}' | ${run} | cat`,
          ...base64Lines(request.stdin),
          STDIN_EOF,
          'exit "$((PIPESTATUS[1]))"',
        ];
  return [
    'rm -f -- "$0"',
    "stty raw -echo 2>/dev/null",
    ...exports,
    `__sandcastle_cmd=${shellEscape(request.command)}`,
    ...pipeline,
    "",
  ].join("\n");
};

/**
 * A sink for stdout. Streamed: each complete line goes to `onLine` at once
 * and into a bounded tail, and `flush()` hands over a last line that has no
 * trailing newline. Buffered: the whole output is kept.
 */
const stdoutSink = (maxChars: number, onLine?: (line: string) => void) => {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const tail = new BoundedTail(maxChars, "\n");
  let partial = "";
  const push = (text: string): void => {
    if (onLine === undefined) {
      chunks.push(text);
      return;
    }
    const lines = (partial + text).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      tail.push(line);
      onLine(line);
    }
  };
  return {
    push: (bytes: Uint8Array): void => {
      push(decoder.decode(bytes, { stream: true }));
    },
    finish: (): string => {
      push(decoder.decode());
      if (onLine === undefined) {
        return chunks.join("");
      }
      if (partial !== "") {
        tail.push(partial);
        onLine(partial);
        partial = "";
      }
      return tail.toString();
    },
  };
};

/** One command to run in a PTY session. */
interface PtyRun {
  readonly vm: Vm;
  readonly scriptPath: string;
  readonly sudo: boolean;
  readonly onData: (bytes: Uint8Array) => void;
}

/** Why a PTY session closed before its command exited. */
const closedError = (failure: unknown): Error => {
  if (failure instanceof Error) {
    return failure;
  }
  return new Error("the terminal closed before the command exited", {
    cause: failure,
  });
};

/**
 * Run `bash <scriptPath>` in a PTY session and wait for it to exit. Output
 * bytes go to `onData` as they arrive. Returns the exit code and the session
 * id, so the caller can remove the finished session.
 */
const runInPty = async ({
  vm,
  scriptPath,
  sudo,
  onData,
}: PtyRun): Promise<{ exitCode: number; sessionId: number }> => {
  const events = new EventTarget();
  let exitCode: number | undefined;
  let failure: unknown;
  // Settles on whichever comes first: the command's exit, or the session
  // closing. Set up before `open()`, so an exit can never slip past it.
  const exited = Promise.race([
    once(events, "exit"),
    once(events, "close").then(() => {
      throw closedError(failure);
    }),
  ]);
  // When the session closes before `open()` resolves, `open()` rejects
  // itself, so this rejection must not go unhandled.
  exited.catch(() => undefined);
  const session = await vm.pty.open({
    exec: `bash ${scriptPath}`,
    ...(sudo ? { linuxUser: "root" } : {}),
    onData,
    onExit: (code) => {
      exitCode = code;
      events.dispatchEvent(new Event("exit"));
    },
    onError: (error) => {
      failure = error;
    },
    onClose: () => {
      events.dispatchEvent(new Event("close"));
    },
  });
  try {
    await exited;
    if (exitCode === undefined) {
      throw new TypeError("the terminal reported no exit code");
    }
    return { exitCode, sessionId: session.sessionId };
  } finally {
    session.detach();
  }
};

/** The error for a command whose PTY session failed. */
const connectionError = (command: string, error: unknown): Error => {
  const why = error instanceof Error ? error.message : String(error);
  return new Error(`freestyle(): the connection failed: ${command} (${why})`, {
    cause: error,
  });
};

/**
 * Run a Sandcastle `exec` in the VM. stdin is always closed (empty when
 * unset), so a command that reads it gets EOF rather than waiting. With
 * `onLine`, stdout lines are delivered live as they arrive; without it, the
 * whole stdout comes back, as sync-out needs.
 */
export const execInVm = async (
  vm: Vm,
  request: FreestyleExecRequest,
): Promise<ExecResult> => {
  const id = randomUUID();
  const scriptPath = posix.join(request.scratchDir, `exec-${id}.sh`);
  const errPath = posix.join(request.scratchDir, `exec-${id}.err`);
  await vm.fs.writeFile(scriptPath, execScript(request, errPath), {
    mode: 0o644,
  });
  const stdout = stdoutSink(request.maxOutputTailChars, request.onLine);
  const { exitCode, sessionId } = await runInPty({
    vm,
    scriptPath,
    sudo: request.sudo === true,
    onData: stdout.push,
  }).catch((error: unknown) => {
    throw connectionError(request.command, error);
  });
  const [stderr] = await Promise.all([
    vm.fs.readTextFile(errPath).catch(() => ""),
    vm.pty.close(sessionId).catch(() => undefined),
  ]);
  await vm.fs.remove(errPath).catch(() => undefined);
  if (request.onLine === undefined) {
    return { stdout: stdout.finish(), stderr, exitCode };
  }
  const stderrTail = new BoundedTail(request.maxOutputTailChars);
  stderrTail.push(stderr);
  return { stdout: stdout.finish(), stderr: stderrTail.toString(), exitCode };
};
