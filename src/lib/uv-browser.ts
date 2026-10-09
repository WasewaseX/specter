"use client";

/**
 * SPECTER — Ghost Browser engine bootstrap (client side).
 *
 * Wires up the open-source proxy engine forked from GitHub:
 *   - Ultraviolet service worker  (github.com/titaniumnetwork-dev/Ultraviolet)
 *   - bare-mux SharedWorker       (github.com/MercuryWorkshop/bare-mux)
 *   - bare-transport + TompHTTP bare relay (github.com/tomphttp)
 *
 * The service worker is registered with the narrow scope `/service/` so it can
 * only ever intercept proxied browsing traffic — never the search app itself.
 *
 * Recovery contract (failures must never strand the page):
 *   - a failed boot is NOT cached — the next ensureUvEngine() call retries;
 *   - SW activation must be OBSERVED, not assumed (no timeout-silently-pass);
 *   - the bare relay is probed before we claim the engine is usable;
 *   - every failure carries a readable, stage-tagged error for the UI.
 */

const UV_BUNDLE = "/uv/uv.bundle.js";
const UV_CONFIG = "/uv/uv.config.js";
const UV_SW = "/uv/sw.js";
const UV_SCOPE = "/service/";
const BAREMUX_CLIENT = "/baremux/index.js";
const BAREMUX_WORKER = "/baremux/worker.js";
// NOTE: the ?v= cache-bust matters — the SharedWorker survives page reloads and
// its dynamic import() caches by URL, so bump v whenever the transport file changes.
// as3-3: transport now tags relay traffic with XTransformPort=3030 (gateway direct route).
const BARE_TRANSPORT = "/baremux/bare-transport.js?v=as3-3";
const BARE_RELAY = "/bare/";

export interface EngineResult {
  ok: boolean;
  /** readable, stage-tagged error — null on success */
  error: string | null;
  /** where the boot stopped (codec / sw / transport / relay / ok) */
  stage: string;
  /** the active engine build (ENGINE_REV inside sw.js) — shown in the UI
   *  so the user can always tell WHICH version they are running. */
  rev: string | null;
}

let enginePromise: Promise<EngineResult> | null = null;
let engineReady = false;
let lastError: string | null = null;
let lastStage = "idle";

interface UvConfig {
  prefix: string;
  encodeUrl: (url: string) => string;
  decodeUrl: (encoded: string) => string;
}

interface UvWindow {
  __uv$config?: UvConfig;
  BareMux?: { BareMuxConnection?: new (workerPath: string) => { setTransport: (p: string, args: unknown[]) => Promise<void> } };
}

function uvWin(): UvWindow {
  return window as unknown as UvWindow;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`load failed: ${src}`)), { once: true });
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      resolve();
    }, { once: true });
    el.addEventListener("error", () => reject(new Error(`load failed: ${src}`)), { once: true });
    document.head.appendChild(el);
  });
}

/**
 * Resolve ONLY when a service worker has verifiably reached the "activated"
 * state. A timeout is a FAILURE (rejects) — never a silent pass, so callers
 * cannot mistake a dead worker for a ready engine.
 */
function waitUntilActive(reg: ServiceWorkerRegistration, timeoutMs = 10000): Promise<void> {
  if (reg.active && reg.active.state === "activated") return Promise.resolve();
  const candidate = reg.installing ?? reg.waiting ?? reg.active;
  if (!candidate) return Promise.reject(new Error("no worker was registered"));
  return new Promise((resolve, reject) => {
    const finish = (err?: Error) => {
      clearTimeout(timer);
      candidate.removeEventListener("statechange", onState);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      // last look — the event may have fired while we were attaching
      if (reg.active && reg.active.state === "activated") finish();
      else finish(new Error("SW activation timed out"));
    }, timeoutMs);
    const onState = () => {
      if (candidate.state === "activated") finish();
      else if (candidate.state === "redundant") {
        finish(new Error("SW was replaced (redundant) before activating"));
      }
    };
    candidate.addEventListener("statechange", onState);
  });
}

/** Lightweight relay heartbeat — the engine is useless without it. */
async function probeRelay(timeoutMs = 6000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${BARE_RELAY}?XTransformPort=3030&t=${Date.now()}`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function fail(stage: string, err: unknown): EngineResult {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  lastError = `${stage}: ${message}`;
  lastStage = stage;
  // CRITICAL: drop the cached attempt so the next call retries from scratch.
  enginePromise = null;
  engineReady = false;
  return { ok: false, error: lastError, stage, rev: cachedRev };
}

/* The running engine build. Read once from the SW script itself (tiny local
 * fetch) and cached for the page lifetime — the UI shows it so the user can
 * always tell which version they are comparing against. */
let cachedRev: string | null = null;
async function swEngineRev(): Promise<string | null> {
  if (cachedRev) return cachedRev;
  try {
    const res = await fetch(`${UV_SW}?revprobe=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/ENGINE_REV\s*=\s*"([^"]+)"/);
    cachedRev = m ? m[1] : null;
  } catch {
    cachedRev = null;
  }
  return cachedRev;
}

/**
 * Idempotent engine boot: loads codec scripts, registers the UV service worker,
 * verifies it truly activated and hands it a bare transport through a
 * bare-mux SharedWorker. Resolves ok:true only when the full browser engine
 * (codec + active SW + transport + healthy relay) is usable. A failed boot is
 * never cached — call again (or retryUvEngine) to retry.
 */
export function ensureUvEngine(): Promise<EngineResult> {
  // success is cached; failure always retries
  if (enginePromise) return enginePromise;
  enginePromise = (async (): Promise<EngineResult> => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return fail("unsupported", "service workers are unavailable in this browser");
    }
    try {
      await loadScript(UV_BUNDLE);
      await loadScript(UV_CONFIG);
    } catch (e) {
      return fail("codec", e);
    }
    if (!uvWin().__uv$config) return fail("codec", "UV config did not initialise");

    let registration: ServiceWorkerRegistration;
    try {
      registration = await navigator.serviceWorker.register(UV_SW, {
        scope: UV_SCOPE,
      });
    } catch (e) {
      return fail("sw", e);
    }
    /* Force-fresh worker: browsers byte-compare sw.js against the cached
     * copy, but only re-check on their own schedule. Calling update() here
     * means a user returning after an engine fix gets the new worker
     * immediately instead of staying stranded on a broken stale one
     * (sw.js carries an ENGINE_REV marker, so this always diffs). */
    try {
      await registration.update();
    } catch {
      /* update is best-effort; an existing active worker still counts */
    }
    try {
      // must OBSERVE activation — no silent timeout pass
      await waitUntilActive(registration);
    } catch (e) {
      return fail("sw", e);
    }

    try {
      await loadScript(BAREMUX_CLIENT);
      const BareMuxConnection = uvWin().BareMux?.BareMuxConnection;
      if (!BareMuxConnection) throw new Error("bare-mux client did not initialise");
      const connection = new BareMuxConnection(BAREMUX_WORKER);
      await connection.setTransport(BARE_TRANSPORT, [
        `${window.location.origin}${BARE_RELAY}`,
      ]);
    } catch (e) {
      return fail("transport", e);
    }

    // the engine is only as alive as its relay — verify before claiming ready
    const relayOk = await probeRelay();
    if (!relayOk) {
      return fail("relay", "secure relay is not responding (it usually recovers in seconds — retry)");
    }

    engineReady = true;
    lastError = null;
    lastStage = "ok";
    const rev = await swEngineRev();
    return { ok: true, error: null, stage: "ok", rev };
  })();
  return enginePromise;
}

/** Force a fresh engine boot (clears the cached result first). */
export async function retryUvEngine(): Promise<EngineResult> {
  enginePromise = null;
  engineReady = false;
  return ensureUvEngine();
}

/** Last boot error, readable for diagnostics UI. */
export function uvEngineError(): { error: string | null; stage: string } {
  return { error: lastError, stage: lastStage };
}

/** True once the engine is fully wired: codec loaded, SW active, transport set. */
export function uvEngineLoaded(): boolean {
  return engineReady && typeof window !== "undefined" && Boolean(uvWin().__uv$config);
}

/** Encode a real URL into a same-origin /service/ href handled by the UV SW. */
export function uvHref(url: string): string | null {
  const config = uvWin().__uv$config;
  if (!config) return null;
  try {
    return `${config.prefix}${config.encodeUrl(url)}`;
  } catch {
    return null;
  }
}

/** Decode an in-frame location (/service/<encoded>) back into the real URL. */
export function uvRealUrl(locationHref: string): string | null {
  const config = uvWin().__uv$config;
  if (!config) return null;
  try {
    const u = new URL(locationHref);
    if (!u.pathname.startsWith(config.prefix)) return null;
    const encoded = u.pathname.slice(config.prefix.length) + u.search;
    const real = config.decodeUrl(encoded);
    return real ? new URL(real).toString() : null;
  } catch {
    return null;
  }
}

/**
 * Push browsing settings into the Ultraviolet service worker (RAM only).
 * The SW uses these for tracker blocking and data-saver image compression.
 */
export async function pushUvSettings(settings: {
  dataSaver: boolean;
  adBlock: boolean;
  bypassHosts?: string[];
}): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/service/");
    reg?.active?.postMessage({ type: "specter:settings", ...settings });
  } catch {
    /* engine not ready — settings are re-pushed after boot */
  }
}

/**
 * Fire-and-forget message to the active engine SW (e.g. self-test trigger).
 */
export async function postUvMessage(msg: Record<string, unknown>): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/service/");
    reg?.active?.postMessage(msg);
  } catch {
    /* engine not ready */
  }
}

/**
 * Subscribe to messages from the engine (blocked trackers, compression
 * stats, self-test results). Returns an unsubscribe function.
 */
export function subscribeUvMessages(cb: (data: Record<string, unknown>) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => undefined;
  }
  const listener = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (data && typeof data === "object" && typeof data.type === "string" && data.type.startsWith("specter:")) {
      cb(data);
    }
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
