/**
 * Keeping the Claude Code OAuth token out of a Freestyle VM, for the
 * Freestyle provider (`./freestyle.ts`).
 *
 * The VM's `CLAUDE_CODE_OAUTH_TOKEN` is a placeholder. A TLS rule declared in
 * the VM's create request sets the real token on the VM's requests to
 * `api.anthropic.com` at Freestyle's edge. The rule is created with the VM and
 * deleted with it, so every path that deletes the VM also removes the rule.
 *
 * Follows https://www.freestyle.sh/docs/guides/inject-claude-code-oauth-token-at-the-edge
 */

import type { CreateVmOptions, InlineTlsRule } from "freestyle";

/** Where Claude Code reads its subscription token. */
const CLAUDE_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/** What the VM holds in place of the Claude Code token. */
const CLAUDE_TOKEN_PLACEHOLDER =
  "sandcastle-placeholder-replaced-at-freestyle-edge";

/**
 * Lets the VM reach `api.anthropic.com`, with the real token set at the edge.
 * No `match`: Claude Code calls more than `POST /v1/messages` on that host.
 * The bare source is the VM being created, so the rule lives and dies with it.
 */
const claudeTokenRule = (token: string): InlineTlsRule => ({
  action: "allow",
  domain: "api.anthropic.com",
  source: {},
  destination: { public: true },
  transform: [{ headers: { authorization: `Bearer ${token}` } }],
});

/** The token to protect: the option, then a real one in the env. */
const findToken = (
  env: Record<string, string>,
  option: string | undefined,
): string | undefined => {
  if (option !== undefined && option !== "") {
    return option;
  }
  const fromEnv = env[CLAUDE_TOKEN_VAR];
  if (fromEnv === undefined || fromEnv === "") {
    return undefined;
  }
  return fromEnv === CLAUDE_TOKEN_PLACEHOLDER ? undefined : fromEnv;
};

/** The env a VM gets and the TLS rules it is created with. */
export interface ProtectedVm {
  readonly env: Record<string, string>;
  readonly tls: CreateVmOptions["tls"];
}

/**
 * Take the Claude Code token out of the env and into an edge rule. Without a
 * token, the env and the TLS rules come back unchanged.
 */
export const protectClaudeToken = (
  env: Record<string, string>,
  option: string | undefined,
  tls: CreateVmOptions["tls"],
): ProtectedVm => {
  const token = findToken(env, option);
  if (token === undefined) {
    return { env, tls };
  }
  return {
    env: { ...env, [CLAUDE_TOKEN_VAR]: CLAUDE_TOKEN_PLACEHOLDER },
    tls: { rules: [...(tls?.rules ?? []), claudeTokenRule(token)] },
  };
};
