/**
 * Run Claude Code on your Claude subscription inside a Freestyle VM, with the
 * OAuth token injected at Freestyle's edge so it never enters the VM.
 *
 * Follows https://www.freestyle.sh/docs/guides/inject-claude-code-oauth-token-at-the-edge
 *
 * freestyle({ claudeCodeOauthToken }) does the work:
 * - The VM only holds a placeholder CLAUDE_CODE_OAUTH_TOKEN.
 * - A TLS rule, created with the VM and deleted with it, sets the real token
 *   on the VM's requests to api.anthropic.com.
 * - The real token lives in .sandcastle/.env.host (host-only). Never put it, or
 *   ANTHROPIC_API_KEY, in .sandcastle/.env: Sandcastle forwards that file's keys
 *   into the sandbox.
 *
 * Run: npm run freestyle-oauth
 */
import * as sandcastle from "@ai-hero/sandcastle";
import { freestyle } from "@ai-hero/sandcastle/sandboxes/freestyle";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const token = requiredEnv("HOST_CLAUDE_CODE_OAUTH_TOKEN");
requiredEnv("FREESTYLE_API_KEY");

await using sandbox = await sandcastle.createSandbox({
  branch: `agent/freestyle-oauth-${Date.now()}`,
  sandbox: freestyle({ claudeCodeOauthToken: token }),
});

// Proof: the VM's env holds the placeholder, and no Claude OAuth token at all
// (they all start with sk-ant-oat). The pattern sends nothing of the token in.
const check = await sandbox.exec(
  `printf '%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN"; env | grep -c 'sk-ant-oa[t]' || true`,
);
const [inVm, realTokenHits] = check.stdout.trim().split("\n");
console.log(`VM ${sandbox.sandboxId} sees CLAUDE_CODE_OAUTH_TOKEN=${inVm}`);
console.log(`Env lines with the real token: ${realTokenHits}`);
if (realTokenHits !== "0") throw new Error("The real token reached the VM");

const result = await sandbox.run({
  name: "freestyle-oauth",
  agent: sandcastle.claudeCode("claude-haiku-5-5"),
  prompt: process.argv[2] ?? "Add /foobar to the .gitignore, then commit.",
});
console.log("Commits:", result.commits);
