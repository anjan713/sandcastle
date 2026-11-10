import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { z } from "zod";
import { freestyle } from "@ai-hero/sandcastle/sandboxes/freestyle";

// freestyle() runs the real `freestyle` SDK against a fake Freestyle API on
// localhost. One server plays the REST API (VMs, `exec-await`, the guest
// filesystem) and the PTY WebSocket. Every command runs in a real local
// `bash` whose HOME is a temp folder, so `$HOME/workspace` and the scratch
// folder are real paths on this machine. A PTY sends the process's output
// as binary frames while it runs, then an `exited` message, as Freestyle's
// does. Nothing here runs as root: `linuxUser` is only recorded.

const ExecRequest = z.object({
  command: z.string(),
  linuxUser: z.string().optional(),
  timeoutMs: z.number().optional(),
});

interface Started {
  readonly command: string;
  readonly linuxUser: string | undefined;
}

interface World {
  home: string;
  failCreate: boolean;
  /** Fail the setup `exec-await` (the one that makes `$HOME/workspace`). */
  failSetup: boolean;
  /** Close the next PTY socket without an `exited` message. */
  dropPty: boolean;
  /** Whether the last PTY's process has exited. */
  ptyExited: boolean;
  readonly apiKeys: string[];
  readonly created: Record<string, unknown>[];
  readonly deleted: string[];
  readonly setup: Started[];
  readonly ptys: Started[];
  readonly closedSessions: string[];
}

const world: World = {
  home: "",
  failCreate: false,
  failSetup: false,
  dropPty: false,
  ptyExited: false,
  apiKeys: [],
  created: [],
  deleted: [],
  setup: [],
  ptys: [],
  closedSessions: [],
};

let nextVm = 0;
let nextSession = 0;

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const body = await readBody(req);
  return JSON.parse(body.toString());
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Run `bash -c <command>` here, as the VM's default user would. */
const runBash = (command: string) => {
  const child = spawn("bash", ["-c", command], {
    cwd: world.home,
    env: { ...process.env, HOME: world.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
};

const execAwait = async (req: IncomingMessage, res: ServerResponse) => {
  const request = ExecRequest.parse(await readJson(req));
  world.setup.push({
    command: request.command,
    linuxUser: request.linuxUser,
  });
  if (world.failSetup && request.command.includes("workspace")) {
    sendJson(res, 200, {
      stdout: "",
      stderr: "mkdir: Permission denied",
      statusCode: 1,
    });
    return;
  }
  const child = runBash(request.command);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("close", (statusCode) => {
    sendJson(res, 200, { stdout, stderr, statusCode });
  });
};

const fsRoute = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
  const op = url.pathname.split("/").at(-1);
  const path = url.searchParams.get("path") ?? "";
  if (op === "write" && req.method === "PUT") {
    const mode = url.searchParams.get("mode");
    await writeFile(path, await readBody(req));
    await chmod(path, mode === null ? 0o600 : Number(mode));
    sendJson(res, 200, {});
    return;
  }
  if (op === "read" && req.method === "GET") {
    const content = await readFile(path).catch(() => undefined);
    if (content === undefined) {
      sendJson(res, 404, { code: "NOT_FOUND", message: `no file ${path}` });
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(content);
    return;
  }
  if (op === "remove" && req.method === "DELETE") {
    await rm(path, { force: true, recursive: true });
    res.writeHead(204).end();
    return;
  }
  sendJson(res, 500, {
    code: "UNEXPECTED",
    message: `${req.method} ${url.pathname}`,
  });
};

const createVm = async (req: IncomingMessage, res: ServerResponse) => {
  const body = z.record(z.string(), z.unknown()).parse(await readJson(req));
  world.created.push(body);
  if (world.failCreate) {
    sendJson(res, 503, { code: "CAPACITY", message: "no capacity" });
    return;
  }
  nextVm += 1;
  sendJson(res, 200, { id: `vm-${String(nextVm)}`, state: "running" });
};

/** `/v5/vms/<id>/<area>/...`: a VM's own routes. */
const vmRoute = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
  const [vmId = "", area, ...rest] = url.pathname.split("/").slice(3);
  if (area === undefined && req.method === "DELETE") {
    world.deleted.push(decodeURIComponent(vmId));
    res.writeHead(204).end();
  } else if (area === "exec-await" && req.method === "POST") {
    await execAwait(req, res);
  } else if (area === "fs") {
    await fsRoute(req, res, url);
  } else if (area === "pty" && rest[0] === "sessions") {
    world.closedSessions.push(rest[1] ?? "");
    sendJson(res, 200, { sessionId: Number(rest[1]) });
  } else {
    sendJson(res, 500, { code: "UNEXPECTED", message: url.pathname });
  }
};

const route = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://fake");
  world.apiKeys.push((req.headers.authorization ?? "").replace("Bearer ", ""));
  if (req.method === "POST" && url.pathname === "/v5/vms") {
    await createVm(req, res);
    return;
  }
  await vmRoute(req, res, url);
};

/** One PTY: run `exec` in bash, stream its output, then report the exit. */
const servePty = (socket: WebSocket, url: URL) => {
  const exec = url.searchParams.get("exec") ?? "";
  world.ptys.push({
    command: exec,
    linuxUser: url.searchParams.get("linuxUser") ?? undefined,
  });
  world.ptyExited = false;
  nextSession += 1;
  socket.send(JSON.stringify({ type: "sessionInfo", sessionId: nextSession }));
  if (world.dropPty) {
    world.dropPty = false;
    socket.close(1011, "guest agent gone");
    return;
  }
  const child = runBash(exec);
  // A PTY merges both streams into one terminal stream.
  child.stdout.on("data", (chunk: Buffer) => {
    socket.send(chunk, { binary: true });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    socket.send(chunk, { binary: true });
  });
  child.on("close", (exitCode) => {
    world.ptyExited = true;
    socket.send(JSON.stringify({ type: "exited", exitCode }));
    socket.close(1000);
  });
};

/** The body of the first create request. */
const firstCreate = (): Record<string, unknown> => world.created[0] ?? {};

/** The command the last PTY session ran. */
const lastPtyCommand = (): string => world.ptys.at(-1)?.command ?? "";

let server: Server;
let baseUrl = "";

const provider = (options: Parameters<typeof freestyle>[0] = {}) =>
  freestyle({ apiKey: "fs_fake", baseUrl, ...options });

describe.skipIf(process.platform === "win32")("freestyle()", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      void route(req, res);
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, req) => {
      servePty(socket, new URL(req.url ?? "/", "http://fake"));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake Freestyle has no port");
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  beforeEach(async () => {
    world.home = await mkdtemp(join(tmpdir(), "freestyle-home-"));
    world.failCreate = false;
    world.failSetup = false;
    world.dropPty = false;
    world.apiKeys.length = 0;
    world.created.length = 0;
    world.deleted.length = 0;
    world.setup.length = 0;
    world.ptys.length = 0;
    world.closedSessions.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("is an isolated provider named 'freestyle', with the env option", () => {
    const sandbox = freestyle({ env: { A: "1" } });

    expect(sandbox.tag).toBe("isolated");
    expect(sandbox.name).toBe("freestyle");
    expect(sandbox.env).toStrictEqual({ A: "1" });
  });

  it("boots a VM with a sandcastle slug and public egress, and deletes it on close()", async () => {
    const handle = await provider({
      snapshotId: "freestyle/ubuntu-sm",
      ttlSeconds: 3600,
    }).create({ env: {} });

    expect(world.created).toHaveLength(1);
    const { slug, ...created } = firstCreate();
    expect(slug).toMatch(/^sandcastle-[0-9a-f-]{36}$/u);
    expect([created]).toStrictEqual([
      {
        snapshotId: "freestyle/ubuntu-sm",
        ttlSeconds: 3600,
        firewall: {
          rules: [
            { action: "allow", source: {}, destination: { public: true } },
          ],
        },
      },
    ]);
    expect(handle.worktreePath).toBe(join(world.home, "workspace"));
    expect(handle.sandboxId).toMatch(/^vm-\d+$/u);
    expect(new Set(world.apiKeys)).toStrictEqual(new Set(["fs_fake"]));

    await handle.close();
    expect(world.deleted).toStrictEqual([handle.sandboxId]);
  });

  it("takes the firewall option in place of the default", async () => {
    await provider({ firewall: { rules: [] } }).create({ env: {} });

    expect(world.created[0]?.["firewall"]).toStrictEqual({ rules: [] });
  });

  it("reads FREESTYLE_API_KEY when apiKey is empty, and fails before creating anything without a key", async () => {
    vi.stubEnv("FREESTYLE_API_KEY", "fs_from_env");
    await provider({ apiKey: "" }).create({ env: {} });
    expect(new Set(world.apiKeys)).toStrictEqual(new Set(["fs_from_env"]));

    vi.stubEnv("FREESTYLE_API_KEY", "");
    world.created.length = 0;
    await expect(provider({ apiKey: "" }).create({ env: {} })).rejects.toThrow(
      "FREESTYLE_API_KEY",
    );
    expect(world.created).toStrictEqual([]);
  });

  it("deletes the VM by its slug when setup fails, naming the command's stderr", async () => {
    world.failSetup = true;

    await expect(provider().create({ env: {} })).rejects.toThrow(
      "mkdir: Permission denied",
    );
    expect(world.deleted).toStrictEqual([world.created[0]?.["slug"]]);
  });

  it("deletes the VM by its slug when the create request fails", async () => {
    world.failCreate = true;

    await expect(provider().create({ env: {} })).rejects.toThrow("no capacity");
    expect(world.deleted).toStrictEqual([world.created[0]?.["slug"]]);
  });

  it("streams stdout lines live, including a last line with no newline, keeping stderr apart", async () => {
    const handle = await provider().create({ env: {} });
    const lines: string[] = [];
    // Whether the command had exited when each line arrived.
    const exitedAtLine: boolean[] = [];

    const result = await handle.exec(
      String.raw`printf 'one\n'; sleep 0.3; echo err >&2; printf 'two\ntail'`,
      {
        onLine: (line) => {
          exitedAtLine.push(world.ptyExited);
          lines.push(line);
        },
      },
    );

    expect(exitedAtLine[0]).toBe(false);
    expect(lines).toStrictEqual(["one", "two", "tail"]);
    expect(result).toStrictEqual({
      stdout: "one\ntwo\ntail",
      stderr: "err\n",
      exitCode: 0,
    });
  });

  it("runs in the worktree by default, or in the given cwd", async () => {
    const handle = await provider().create({ env: {} });

    const inWorktree = await handle.exec("pwd");
    const inRoot = await handle.exec("pwd", { cwd: "/" });

    expect(inWorktree.stdout).toBe(`${handle.worktreePath}\n`);
    expect(inRoot.stdout).toBe("/\n");
  });

  it("pipes stdin, however large, and closes it", async () => {
    const handle = await provider().create({ env: {} });
    const big = `${"x".repeat(300_000)}\n`;

    const result = await handle.exec("cat; echo done", { stdin: "prompt\n" });
    const empty = await handle.exec("cat | wc -c", { stdin: "" });
    const none = await handle.exec("cat | wc -c");
    const large = await handle.exec("wc -c", { stdin: big });

    expect(result.stdout).toBe("prompt\ndone\n");
    expect(empty.stdout.trim()).toBe("0");
    expect(none.stdout.trim()).toBe("0");
    expect(large.stdout.trim()).toBe(String(big.length));
  });

  it("returns a non-zero exit with its output, buffered and streamed", async () => {
    const handle = await provider().create({ env: {} });

    const buffered = await handle.exec("echo out; echo err >&2; exit 3");
    const streamed = await handle.exec("echo err >&2; exit 4", {
      onLine: () => undefined,
    });

    expect(buffered).toStrictEqual({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 3,
    });
    expect(streamed).toStrictEqual({
      stdout: "",
      stderr: "err\n",
      exitCode: 4,
    });
  });

  it("gives every command the env, keeping it off the PTY's URL", async () => {
    const secret = `it's "quoted" $HOME \`x\``;
    const handle = await provider().create({
      env: { SECRET: secret, OTHER: "2" },
    });

    const result = await handle.exec('printf %s "$SECRET"; echo " $OTHER"');

    expect(result.stdout).toBe(`${secret} 2\n`);
    expect(world.ptys.at(-1)?.command).not.toContain("quoted");
  });

  it("refuses an env name the shell can't export", async () => {
    const handle = await provider().create({ env: { "BAD-NAME": "1" } });

    await expect(handle.exec("true")).rejects.toThrow(
      '"BAD-NAME" is not a valid environment variable name',
    );
  });

  it("runs sudo commands as root", async () => {
    const handle = await provider().create({ env: {} });

    await handle.exec("true", { sudo: true });
    await handle.exec("true");

    expect(world.ptys.map((pty) => pty.linuxUser)).toStrictEqual([
      "root",
      undefined,
    ]);
  });

  it("removes each command's script, stderr file and finished PTY session", async () => {
    const handle = await provider().create({ env: { KEY: "value" } });

    await handle.exec("echo hi; echo err >&2");
    await handle.exec("exit 1");

    // Each PTY runs `bash <scratch folder>/exec-<id>.sh`.
    const script = lastPtyCommand().replace(/^bash /u, "");
    expect(script).toMatch(/\/sandcastle-exec-[^/]+\/exec-[0-9a-f-]+\.sh$/u);
    await expect(readdir(dirname(script))).resolves.toStrictEqual([]);
    expect(world.closedSessions).toHaveLength(2);
  });

  it("fails with the command when the PTY closes before the command exits", async () => {
    const handle = await provider().create({ env: {} });
    world.dropPty = true;

    await expect(handle.exec("echo hi")).rejects.toThrow(
      "freestyle(): the connection failed: echo hi",
    );
  });

  it("copies a directory and a file in, keeping modes and handing them to the VM user, and a file out", async () => {
    const handle = await provider().create({ env: {} });
    const host = await mkdtemp(join(tmpdir(), "freestyle-host-"));
    await mkdir(join(host, "dir", "sub"), { recursive: true });
    await writeFile(join(host, "dir", "sub", "a.txt"), "a");
    await writeFile(join(host, "run.sh"), "#!/bin/sh\n");
    await chmod(join(host, "run.sh"), 0o755);

    await handle.copyIn(join(host, "dir"), join(handle.worktreePath, "copy"));
    await handle.copyIn(
      join(host, "run.sh"),
      join(world.home, "new", "run.sh"),
    );
    await handle.copyFileOut(
      join(handle.worktreePath, "copy", "sub", "a.txt"),
      join(host, "out", "a.txt"),
    );

    const copied = await stat(join(world.home, "new", "run.sh"));
    expect(copied.mode % 0o1000).toBe(0o755);
    await expect(readFile(join(host, "out", "a.txt"), "utf8")).resolves.toBe(
      "a",
    );
    const chowns = world.setup.filter((s) => s.command.includes("chown"));
    expect(chowns).toHaveLength(2);
    expect(chowns.every((s) => s.linuxUser === "root")).toBe(true);
    // No archive is left behind in the VM.
    const inTmp = await readdir("/tmp");
    const archives = inTmp.filter((name) =>
      name.startsWith("sandcastle-copyin-"),
    );
    expect(archives).toStrictEqual([]);
  });
});
