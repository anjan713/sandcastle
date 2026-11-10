/**
 * Freestyle isolated sandbox provider — wraps the `freestyle` SDK's VMs into
 * a SandboxProvider.
 *
 * Usage:
 *   import { freestyle } from "@ai-hero/sandcastle/sandboxes/freestyle";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: freestyle() });
 */

import { randomUUID } from "node:crypto";
import { Config, Effect } from "effect";
import type { CreateVmOptions, Vm } from "freestyle";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { protectClaudeToken } from "./freestyleClaudeToken.js";
import { execInVm, runSetupCommand } from "./freestyleExec.js";
import { makeCopyFileOut, makeCopyIn } from "./freestyleFiles.js";
import { registerVmDeletion } from "./freestyleShutdown.js";

/**
 * Options for the Freestyle sandbox provider.
 *
 * All `freestyle.vms.create()` options from the `freestyle` SDK pass through
 * (`snapshotId`, `firewall`, `ttlSeconds`, `metadata`, `vpcs`, ...), except
 * `slug` and `reassignSlug`: the provider names each VM `sandcastle-<uuid>`
 * so it can delete it.
 */
export interface FreestyleOptions
  extends Omit<CreateVmOptions, "firewall" | "slug" | "reassignSlug"> {
  /**
   * Freestyle API key. Falls back to the `FREESTYLE_API_KEY` environment
   * variable.
   */
  readonly apiKey?: string;

  /** Freestyle API base URL (default: `https://api.freestyle.sh`). */
  readonly baseUrl?: string;

  /**
   * What the VM may reach. A Freestyle VM reaches nothing it has not been
   * allowed to, and an agent needs its model's API, so the default allows
   * all outbound traffic to the public Internet and nothing inbound.
   */
  readonly firewall?: CreateVmOptions["firewall"];

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Claude Code OAuth token (from `claude setup-token`) to keep out of the VM.
   * Defaults to `CLAUDE_CODE_OAUTH_TOKEN` in the sandbox env.
   *
   * The VM never holds the token. Its `CLAUDE_CODE_OAUTH_TOKEN` is a
   * placeholder, and a TLS rule created with the VM (and deleted with it)
   * sets the real token on the VM's requests to `api.anthropic.com` at
   * Freestyle's edge. So nothing in the VM can read the token or send it
   * anywhere else.
   *
   * A long-lived sandbox (`createSandbox()`) exports each agent's own `env`
   * inside the agent's command, where this provider cannot see it. Pass the
   * token here, not in `claudeCode(..., { env })`, for that case.
   */
  readonly claudeCodeOauthToken?: string;

  /**
   * Maximum characters of streamed `exec` output kept per stream for
   * `ExecResult` when `onLine` is supplied (default: 64KiB). `onLine` still
   * gets every line.
   */
  readonly maxOutputTailChars?: number;
}

/** Outbound to the public Internet, nothing inbound. */
const PUBLIC_EGRESS: CreateVmOptions["firewall"] = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};

/** `FREESTYLE_API_KEY` from the environment, "" when unset. */
const envApiKey = Config.string("FREESTYLE_API_KEY").pipe(
  Config.withDefault(""),
);

/** The API key: the option, then `FREESTYLE_API_KEY`. Empty counts as unset. */
const resolveApiKey = async (option: string | undefined): Promise<string> => {
  if (option !== undefined && option !== "") {
    return option;
  }
  const fromEnv = await Effect.runPromise(envApiKey);
  if (fromEnv === "") {
    throw new Error(
      "freestyle(): no Freestyle API key. Set FREESTYLE_API_KEY, or pass the apiKey option.",
    );
  }
  return fromEnv;
};

/** Where the VM's default user works, and who that user is. */
interface VmLayout {
  readonly worktreePath: string;
  /** `<uid>:<gid>` of the VM's default user, for `chown`. */
  readonly owner: string;
  /** A folder only that user can enter, for each `exec`'s script. */
  readonly scratchDir: string;
}

/**
 * Create `$HOME/workspace` and a private scratch folder as the VM's default
 * user (`ubuntu` on the Ubuntu base snapshots), and read back where they are
 * and who owns them.
 */
const prepareVm = async (vm: Vm): Promise<VmLayout> => {
  const out = await runSetupCommand(
    vm,
    'mkdir -p "$HOME/workspace" && cd "$HOME/workspace" && pwd && id -u && id -g && mktemp -d -t sandcastle-exec-XXXXXX',
  );
  const [worktreePath, uid, gid, scratchDir] = out.trim().split("\n");
  if (
    worktreePath === undefined ||
    uid === undefined ||
    gid === undefined ||
    scratchDir === undefined
  ) {
    throw new Error(`freestyle(): unexpected setup output: ${out}`);
  }
  return {
    worktreePath: worktreePath.trim(),
    owner: `${uid.trim()}:${gid.trim()}`,
    scratchDir: scratchDir.trim(),
  };
};

/** What a handle needs beyond its VM. */
interface HandleContext {
  readonly vmId: string;
  readonly layout: VmLayout;
  readonly env: Record<string, string>;
  readonly maxOutputTailChars: number;
  readonly unregisterShutdown: () => void;
}

/** The Sandcastle handle over a VM whose worktree folder exists. */
const makeHandle = (vm: Vm, context: HandleContext): IsolatedSandboxHandle => {
  const { worktreePath, owner, scratchDir } = context.layout;
  return {
    worktreePath,
    sandboxId: context.vmId,
    exec: async (command, opts) =>
      execInVm(vm, {
        ...opts,
        command,
        cwd: opts?.cwd ?? worktreePath,
        env: context.env,
        maxOutputTailChars: context.maxOutputTailChars,
        scratchDir,
      }),
    copyIn: makeCopyIn(vm, owner),
    copyFileOut: makeCopyFileOut(vm),
    close: async () => {
      await vm.delete();
      // Only once the delete has gone through: if it threw, the exit
      // teardown tries again.
      context.unregisterShutdown();
    },
  };
};

/** How to reach the Freestyle API. */
interface Connection {
  readonly apiKey: string;
  readonly baseUrl: string | undefined;
}

/**
 * Boot a VM named `sandcastle-<uuid>` and lay out its worktree. The VM is
 * deleted if anything fails before a handle exists.
 */
const bootVm = async (
  { apiKey, baseUrl }: Connection,
  createOptions: Omit<CreateVmOptions, "slug">,
  handleOptions: Pick<HandleContext, "env" | "maxOutputTailChars">,
): Promise<IsolatedSandboxHandle> => {
  // Dynamic import so the peer dependency is only loaded at runtime
  const { Freestyle, DEFAULT_BASE_URL } = await import("freestyle");
  const client = new Freestyle({
    apiKey,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  const slug = `sandcastle-${randomUUID()}`;
  // Registered before the create request, so an interrupt while it is in
  // flight still deletes the VM (deleting a missing slug is a no-op).
  const unregisterShutdown = registerVmDeletion(
    baseUrl ?? DEFAULT_BASE_URL,
    apiKey,
    slug,
  );
  try {
    const { vm, vmId } = await client.vms.create({ ...createOptions, slug });
    const layout = await prepareVm(vm);
    return makeHandle(vm, {
      ...handleOptions,
      vmId,
      layout,
      unregisterShutdown,
    });
  } catch (error) {
    // No handle exists yet, so neither Sandcastle's teardown nor `close()`
    // can reach the VM, and it would keep running.
    await client.vms.delete(slug).catch(() => undefined);
    unregisterShutdown();
    throw error;
  }
};

/**
 * Create a Freestyle isolated sandbox provider.
 *
 * Each `create()` boots a new Freestyle VM, and `close()` deletes it. VMs
 * keep running until deleted, so Sandcastle also deletes the VM when setup
 * fails, and when the process is interrupted or exits without closing it.
 * The default `freestyle/ubuntu` snapshot ships `git`, Node and the common
 * coding-agent CLIs; boot from your own snapshot with `snapshotId`, or
 * install more in an `onSandboxReady` hook.
 *
 * Requires `freestyle` to be installed as a peer dependency, and
 * `FREESTYLE_API_KEY` in the host environment (or the `apiKey` option).
 *
 * @example
 * ```ts
 * import { freestyle } from "@ai-hero/sandcastle/sandboxes/freestyle";
 *
 * const provider = freestyle({ env: { MY_VAR: "value" } });
 * ```
 */
export const freestyle = (
  options?: FreestyleOptions,
): IsolatedSandboxProvider => {
  const {
    env: providerEnv,
    maxOutputTailChars = MAX_TAIL_CHARS,
    apiKey,
    baseUrl,
    firewall,
    tls,
    claudeCodeOauthToken,
    ...vmOptions
  } = options ?? {};
  return createIsolatedSandboxProvider({
    name: "freestyle",
    env: providerEnv,
    create: async ({ env }): Promise<IsolatedSandboxHandle> => {
      const protectedVm = protectClaudeToken(env, claudeCodeOauthToken, tls);
      return bootVm(
        { apiKey: await resolveApiKey(apiKey), baseUrl },
        {
          ...vmOptions,
          firewall: firewall ?? PUBLIC_EGRESS,
          ...(protectedVm.tls === undefined ? {} : { tls: protectedVm.tls }),
        },
        { env: protectedVm.env, maxOutputTailChars },
      );
    },
  });
};
