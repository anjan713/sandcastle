/**
 * Packing a host directory into a tarball, for the isolated providers that
 * copy a directory in as one archive (`./e2bFiles.ts`, `./freestyleFiles.ts`).
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

/** Pack `dir` into a gzipped tarball at `archive` on the host. */
export const tarDirectory = async (
  archive: string,
  dir: string,
): Promise<void> => {
  const child = spawn("tar", ["-czf", archive, "-C", dir, "."], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(
      `tar exited with ${String(child.exitCode)}: ${stderr.trim()}`,
    );
  }
};
