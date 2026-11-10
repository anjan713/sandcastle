/**
 * Interrupt teardown for the Freestyle provider (`freestyle.ts`). A Freestyle
 * VM keeps running until it is deleted, so a run interrupted before
 * `close()` would leave its VM running.
 */

import { spawn } from "node:child_process";
import { registerShutdown } from "../shutdownRegistry.js";

/** Deletes the VM at `process.argv[1]`, with the API key from the env. */
const DELETE_SCRIPT =
  "fetch(process.argv[1], { method: 'DELETE', headers: { Authorization: 'Bearer ' + process.env.SANDCASTLE_FREESTYLE_API_KEY } }).catch(() => {});";

/**
 * Register a teardown that deletes the VM `vmIdOrSlug` if the process is
 * interrupted (`SIGINT`/`SIGTERM`) or exits before it is unregistered.
 * Shutdown teardowns are synchronous and the process exits as soon as they
 * return, so the delete can't be awaited: it runs in a detached child process,
 * which outlives this one and finishes it.
 *
 * @returns An idempotent function that unregisters the teardown.
 */
export const registerVmDeletion = (
  baseUrl: string,
  apiKey: string,
  vmIdOrSlug: string,
): (() => void) =>
  registerShutdown(() => {
    const url = `${baseUrl.replace(/\/+$/u, "")}/v5/vms/${encodeURIComponent(vmIdOrSlug)}`;
    spawn(process.execPath, ["-e", DELETE_SCRIPT, url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, SANDCASTLE_FREESTYLE_API_KEY: apiKey },
    }).unref();
  });
