/**
 * Copying files into an E2B sandbox, for the E2B sandbox provider
 * (`./e2b.ts`). A directory goes in as one tarball.
 */

import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "e2b";
import { shellEscape } from "../AgentProvider.js";
import { tarDirectory } from "./hostTar.js";

/** Upload as a raw body, not multipart (the SDK falls back on an old envd). */
const OCTET = { useOctetStream: true } as const;

/**
 * A host file's bytes, read now: a lazy `openAsBlob` would fail mid-upload
 * as "fetch failed" instead of naming the error, such as EACCES.
 */
const fileBlob = async (path: string): Promise<Blob> =>
  new Blob([await readFile(path)]);

/** Run a setup command to completion and return its stdout. */
export const runToEnd = async (
  sandbox: Sandbox,
  command: string,
): Promise<string> => {
  const result = await sandbox.commands.run(command, { timeoutMs: 0 });
  return result.stdout;
};

/** Copy a host directory in as a tarball, unpacked at `sandboxPath`. */
const copyDirIn = async (
  sandbox: Sandbox,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const id = randomUUID();
  const tarPath = join(tmpdir(), `sandcastle-copyin-${id}.tar.gz`);
  const sandboxTarPath = `/tmp/sandcastle-copyin-${id}.tar.gz`;
  const tar = shellEscape(sandboxTarPath);
  try {
    await tarDirectory(tarPath, hostPath);
    await sandbox.files.write(sandboxTarPath, await fileBlob(tarPath), OCTET);
    const dest = shellEscape(sandboxPath);
    // Remove the archive even if extraction fails, keeping its exit code
    await runToEnd(
      sandbox,
      `mkdir -p ${dest} && tar -xzf ${tar} -C ${dest}; s=$?; rm -f ${tar}; exit $s`,
    );
  } finally {
    await rm(tarPath, { force: true });
  }
};

/** The handle's `copyIn`: a file or a directory, keeping the host's mode. */
export const makeCopyIn =
  (sandbox: Sandbox) =>
  async (hostPath: string, sandboxPath: string): Promise<void> => {
    const info = await stat(hostPath);
    if (info.isDirectory()) {
      await copyDirIn(sandbox, hostPath, sandboxPath);
      return;
    }
    await sandbox.files.write(sandboxPath, await fileBlob(hostPath), OCTET);
    // files.write keeps an existing file's mode, so always apply the host's
    const mode = (info.mode % 0o1000).toString(8);
    await runToEnd(sandbox, `chmod ${mode} ${shellEscape(sandboxPath)}`);
  };
