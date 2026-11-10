/**
 * Copying files into and out of a Freestyle VM, for the Freestyle provider
 * (`./freestyle.ts`). A directory goes in as one tarball.
 *
 * The SDK's filesystem API writes as root, so every copy ends by handing the
 * files to the VM's default user, who runs the agent and must be able to
 * write them. Folders are made as that user beforehand, so none is left
 * root-owned.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Vm } from "freestyle";
import { shellEscape } from "../AgentProvider.js";
import { runSetupCommand } from "./freestyleExec.js";
import { tarDirectory } from "./hostTar.js";

/** The VM, and `<uid>:<gid>` of the user who gets the copied files. */
interface CopyTarget {
  readonly vm: Vm;
  readonly owner: string;
}

/** Copy a host directory in as a tarball, unpacked at `sandboxPath`. */
const copyDirIn = async (
  { vm, owner }: CopyTarget,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const id = randomUUID();
  const tarPath = join(tmpdir(), `sandcastle-copyin-${id}.tar.gz`);
  const sandboxTarPath = `/tmp/sandcastle-copyin-${id}.tar.gz`;
  const tar = shellEscape(sandboxTarPath);
  const dest = shellEscape(sandboxPath);
  try {
    await tarDirectory(tarPath, hostPath);
    await vm.fs.writeFile(sandboxTarPath, await readFile(tarPath));
    await runSetupCommand(vm, `mkdir -p ${dest}`);
    // Remove the archive even if extraction fails, keeping its exit code
    await runSetupCommand(
      vm,
      `tar -xzf ${tar} -C ${dest} --no-same-owner && chown -R ${owner} ${dest}; s=$?; rm -f ${tar}; exit $s`,
      { root: true },
    );
  } finally {
    await rm(tarPath, { force: true });
  }
};

/**
 * The handle's `copyIn`: a file or a directory, keeping the host's mode and
 * owned by `owner` (`<uid>:<gid>` of the VM's default user).
 */
export const makeCopyIn =
  (vm: Vm, owner: string) =>
  async (hostPath: string, sandboxPath: string): Promise<void> => {
    const info = await stat(hostPath);
    if (info.isDirectory()) {
      await copyDirIn({ vm, owner }, hostPath, sandboxPath);
      return;
    }
    await runSetupCommand(
      vm,
      `mkdir -p ${shellEscape(posix.dirname(sandboxPath))}`,
    );
    await vm.fs.writeFile(sandboxPath, await readFile(hostPath), {
      mode: info.mode % 0o1000,
    });
    await runSetupCommand(vm, `chown ${owner} ${shellEscape(sandboxPath)}`, {
      root: true,
    });
  };

/** The handle's `copyFileOut`: one VM file to the host, making its folder. */
export const makeCopyFileOut =
  (vm: Vm) =>
  async (sandboxPath: string, hostPath: string): Promise<void> => {
    const bytes = await vm.fs.readFile(sandboxPath);
    await mkdir(dirname(hostPath), { recursive: true });
    await writeFile(hostPath, bytes);
  };
