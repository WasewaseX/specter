/**
 * SPECTER — bare relay supervisor (Node.js runtime ONLY).
 *
 * Imported exclusively from instrumentation.register() under the nodejs
 * runtime guard. Keeps the TompHTTP bare relay mini-service (:3030) alive as
 * a child of the Next.js server — the same lifecycle as Next's own postcss
 * workers — restarting it if it ever exits.
 *
 * RUNTIME IDENTITY GUARD: the sandbox environment auto-launches mini services
 * with `bun run dev`. A bun-owned relay SILENTLY DROPS POST bodies (Bun's
 * Request loses Node IncomingMessage bodies when bare-server-node builds its
 * upstream fetch) — every POST-based site API (YouTube's youtubei, iwara's
 * API) breaks with no error anywhere. This exact failure has surfaced twice
 * (user-visible "it is buggy"). So the supervisor no longer trusts "the port
 * is up": it asks the listener for its runtime identity (GET /specter-identity
 * → { runtime: "node" | "bun" }) and EVICTS any non-node listener, then spawns
 * the real relay itself. Belt: the mini service's package.json dev script now
 * runs node directly, so even the sandbox's own bun launcher executes node.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const RELAY_PORT = 3030;
const RELAY_DIR = path.join(process.cwd(), "mini-services", "bare-server");

function relayUp(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(RELAY_PORT, "127.0.0.1");
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

/** Ask the :3030 listener what runtime it is. null = no/foreign answer. */
function relayIdentity(): Promise<{ runtime: string; pid?: number } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: RELAY_PORT, path: "/specter-identity", timeout: 900 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 4096) req.destroy(); // never trust huge answers
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(body) as { runtime?: string; pid?: number };
            if (j && typeof j.runtime === "string") {
              resolve({ runtime: j.runtime, pid: j.pid });
              return;
            }
          } catch {
            /* not our relay */
          }
          resolve(null);
        });
        res.on("error", () => resolve(null));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Find the pids holding a LISTEN socket on `port` by walking
 * /proc/net/tcp(6) → socket inode → /proc/<pid>/fd. No external tools.
 */
function pidsOnPort(port: number): number[] {
  const inodes = new Set<string>();
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        // sl local_address rem_address st ... inode
        if (cols.length < 10) continue;
        if (!cols[1].toUpperCase().endsWith(":" + hex)) continue;
        if (cols[3] !== "0A") continue; // TCP_LISTEN only
        inodes.add(cols[9]);
      }
    } catch {
      /* ignore */
    }
  }
  if (inodes.size === 0) return [];
  const pids: number[] = [];
  try {
    for (const dir of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(dir)) continue;
      const fdPath = `/proc/${dir}/fd`;
      let fds: string[];
      try {
        fds = fs.readdirSync(fdPath);
      } catch {
        continue; // not ours (permissions) or already gone
      }
      for (const fd of fds) {
        try {
          const link = fs.readlinkSync(`${fdPath}/${fd}`);
          const m = /^socket:\[(\d+)\]$/.exec(link);
          if (m && inodes.has(m[1])) {
            pids.push(Number(dir));
            break;
          }
        } catch {
          /* fd vanished */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return pids;
}

function waitUntilDown(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<boolean>((resolve) => {
    const tick = () => {
      void relayUp().then((up) => {
        if (!up) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

let starting = false;
let announcedUp = false;
let evicting = false;

/** Wait until the relay port answers (spawn is async). */
function waitUntilUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<boolean>((resolve) => {
    const tick = () => {
      void relayUp().then((up) => {
        if (up) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

function spawnRelay() {
  if (starting) return;
  starting = true;
  try {
    /* Run under NODE, never bun: Bun's Request drops Node IncomingMessage
     * bodies when bare-server-node builds its upstream fetch (empty POSTs →
     * every POST-based site API breaks — this is what killed YouTube).
     * Node 24 runs index.ts natively via type stripping.
     * --max-http-header-size=1MB: bare v3 carries the upstream request's
     * headers in x-bare-headers chunks; long sessions (YouTube cookies,
     * big referers) can exceed Node's 16KB default → HTTP 431 for exactly
     * the pages that matter (watch pages). 1MB removes the whole class. */
    const child = spawn(
      "node",
      ["--max-http-header-size=1048576", "index.ts"],
      {
        cwd: RELAY_DIR,
        stdio: "ignore",
        detached: false,
        env: process.env,
      }
    );
    child.on("exit", (code) => {
      starting = false;
      announcedUp = false;
      console.log(`[relay-supervisor] relay exited (code=${code}) — watching for recovery`);
      setTimeout(() => {
        void relayUp().then((up) => {
          if (!up) spawnRelay();
        });
      }, 1000);
    });
    child.on("error", (err) => {
      starting = false;
      announcedUp = false;
      console.error("[relay-supervisor] spawn failed:", err.message);
    });
    console.log("[relay-supervisor] spawned bare relay (child of next-server)");
    void waitUntilUp(10_000).then((up) => {
      if (up && !announcedUp) {
        announcedUp = true;
        console.log("[relay-supervisor] relay healthy on :3030");
      }
    });
  } catch (err) {
    starting = false;
    announcedUp = false;
    console.error("[relay-supervisor] unexpected spawn error:", err);
  }
}

/**
 * One supervision cycle. Spawns the relay when down; when the port is up,
 * verifies the listener is genuinely OUR node relay and evicts impostors
 * (bun relays drop POST bodies — see the file header).
 */
async function ensureRelay() {
  if (evicting) return;
  const up = await relayUp();
  if (!up) {
    if (!starting) spawnRelay();
    return;
  }
  const ident = await relayIdentity();
  if (ident && ident.runtime === "node") {
    if (!announcedUp) {
      announcedUp = true;
      console.log(
        `[relay-supervisor] relay healthy on :3030 (node, pid=${ident.pid ?? "?"})`
      );
    }
    return;
  }
  evicting = true;
  try {
    console.log(
      `[relay-supervisor] :3030 held by non-node runtime (${ident?.runtime ?? "unknown"}) — POST bodies would be dropped, evicting`
    );
    const pids = pidsOnPort(RELAY_PORT);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await waitUntilDown(4_000);
  } finally {
    evicting = false;
  }
  if (!starting) spawnRelay();
}

export function startRelaySupervisor() {
  void ensureRelay();
  /* Self-chaining watchdog — deliberately NOT setInterval + unref: some dev
   * runtimes drop unreferenced timers from instrumentation contexts. A
   * chaining timer re-arms itself after every check and LOGS what it saw, so
   * a silent stop is impossible. The check is an identity check, not just a
   * port check, so a bun relaunch by the sandbox is evicted within seconds. */
  const watchdog = () => {
    void ensureRelay().finally(() => {
      setTimeout(watchdog, 5_000);
    });
  };
  setTimeout(watchdog, 5_000);
}
