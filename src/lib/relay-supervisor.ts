/**
 * SPECTER — bare relay supervisor (Node.js runtime ONLY).
 *
 * Imported exclusively from instrumentation.register() under the nodejs
 * runtime guard. Keeps the TompHTTP bare relay mini-service (:3030) alive as
 * a child of the Next.js server — the same lifecycle as Next's own postcss
 * workers — restarting it if it ever exits.
 */

import { spawn } from "node:child_process";
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

let starting = false;
let announcedUp = false;

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

export function startRelaySupervisor() {
  void relayUp().then((up) => {
    if (!up) spawnRelay();
    else console.log("[relay-supervisor] relay already up on :3030");
  });
  /* Self-chaining watchdog — deliberately NOT setInterval + unref: some dev
   * runtimes drop unreferenced timers from instrumentation contexts. A
   * chaining timer re-arms itself after every check and LOGS what it saw, so
   * a silent stop is impossible. */
  const watchdog = () => {
    void relayUp().then((up) => {
      if (!up) {
        console.log("[relay-supervisor] watchdog: relay down — respawning");
        spawnRelay();
      }
      setTimeout(watchdog, up ? 5_000 : 1_500);
    });
  };
  setTimeout(watchdog, 5_000);
}
