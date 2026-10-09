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

let enginePromise: Promise<boolean> | null = null;
let engineReady = false;

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

function waitUntilActive(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return Promise.resolve();
  const candidate = reg.installing ?? reg.waiting;
  if (!candidate) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    candidate.addEventListener(
      "statechange",
      () => {
        if (candidate.state === "activated") {
          clearTimeout(timer);
          resolve();
        }
      },
      { once: true }
    );
  });
}

/**
 * Idempotent engine boot: loads codec scripts, registers the UV service worker
 * and hands it a bare transport through a bare-mux SharedWorker.
 * Resolves true when the full browser engine is usable.
 */
export function ensureUvEngine(): Promise<boolean> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;
    try {
      await loadScript(UV_BUNDLE);
      await loadScript(UV_CONFIG);
      if (!uvWin().__uv$config) return false;

      const registration = await navigator.serviceWorker.register(UV_SW, {
        scope: UV_SCOPE,
      });
      /* Force-fresh worker: browsers byte-compare sw.js against the cached
       * copy, but only re-check on their own schedule. Calling update() here
       * means a user returning after an engine fix gets the new worker
       * immediately instead of staying stranded on a broken stale one
       * (sw.js carries an ENGINE_REV marker, so this always diffs). */
      void registration.update().catch(() => undefined);
      await waitUntilActive(registration);

      await loadScript(BAREMUX_CLIENT);
      const BareMuxConnection = uvWin().BareMux?.BareMuxConnection;
      if (!BareMuxConnection) return false;
      const connection = new BareMuxConnection(BAREMUX_WORKER);
      await connection.setTransport(BARE_TRANSPORT, [
        `${window.location.origin}${BARE_RELAY}`,
      ]);
      engineReady = true;
      return true;
    } catch {
      return false;
    }
  })();
  return enginePromise;
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
export async function pushUvSettings(settings: { dataSaver: boolean; adBlock: boolean }): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/service/");
    reg?.active?.postMessage({ type: "specter:settings", ...settings });
  } catch {
    /* engine not ready — settings are re-pushed after boot */
  }
}

/**
 * Subscribe to messages from the engine (blocked trackers, compression
 * stats). Returns an unsubscribe function.
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
