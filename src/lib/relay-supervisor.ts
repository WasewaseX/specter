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

function spawnRelay() {
  if (starting) return;
  starting = true;
  try {
    /* Run under NODE, never bun: Bun's Request drops Node IncomingMessage
     * bodies when bare-server-node builds its upstream fetch (empty POSTs →
     * every POST-based site API breaks — this is what killed YouTube).
     * Node 24 runs index.ts natively via type stripping. */
    const child = spawn("node", ["index.ts"], {
      cwd: RELAY_DIR,
      stdio: "ignore",
      detached: false,
      env: process.env,
    });
    child.on("exit", (code) => {
      starting = false;
      console.log(`[relay-supervisor] relay exited (code=${code}) — watching for recovery`);
      setTimeout(() => {
        void relayUp().then((up) => {
          if (!up) spawnRelay();
        });
      }, 1500);
    });
    child.on("error", (err) => {
      starting = false;
      console.error("[relay-supervisor] spawn failed:", err.message);
    });
    console.log("[relay-supervisor] spawned bare relay (child of next-server)");
  } catch (err) {
    starting = false;
    console.error("[relay-supervisor] unexpected spawn error:", err);
  }
}

export function startRelaySupervisor() {
  void relayUp().then((up) => {
    if (!up) spawnRelay();
    else console.log("[relay-supervisor] relay already up on :3030");
  });
  const guard = setInterval(() => {
    void relayUp().then((up) => {
      if (!up) spawnRelay();
    });
  }, 15_000);
  guard.unref?.();
}
