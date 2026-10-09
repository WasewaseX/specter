"use client";

/**
 * SPECTER — central client state (zustand).
 * Single contract between the crypto/session layer, the tabbed Ghost Browser
 * (Ultraviolet engine) and the UI.
 *
 * Privacy: nothing here is persisted — tabs, history and stats live in RAM
 * only and die with the page. The settings object mirrored into
 * localStorage carries booleans only (needed by the injected page hook).
 */

import { create } from "zustand";
import { exportKey, generateSessionKey } from "@/lib/crypto";
import { buildProxySrc, securePost, unsealProxyLocation } from "@/lib/secure-client";
import {
  ensureUvEngine,
  retryUvEngine,
  uvEngineLoaded,
  uvHref,
  uvRealUrl,
  pushUvSettings,
  postUvMessage,
} from "@/lib/uv-browser";
import {
  vaultCreate,
  vaultExists,
  vaultPersist,
  vaultUnlock,
  vaultWipe,
  type VaultEntry,
} from "@/lib/vault";

export interface SearchResult {
  id: number;
  title: string;
  url: string;
  snippet: string;
  host: string;
  date: string;
  rank: number;
}

export type TabKind = "newtab" | "search" | "web";

export interface BrowserTab {
  id: string;
  kind: TabKind;
  title: string;
  /** web tabs: current real URL */
  url: string | null;
  /** search tabs: the query */
  query: string | null;
  history: string[];
  historyIndex: number;
  loading: boolean;
  nonce: number;
}

/** A downloadable media/file source discovered on a page (RAM only). */
export interface MediaItem {
  /** real (unproxied) URL */
  u: string;
  /** video | audio | file */
  k: string;
}

/** One line of the engine's network-pipeline diagnostics (RAM only). */
export interface SelfTestResult {
  name: string;
  pass: boolean;
  detail: string;
  ms: number;
}

/** Lifecycle of the Ghost Browser engine (never silently ambiguous). */
export type UvStatus = "booting" | "ready" | "failed";

export interface BrowserStats {
  blocked: number;
  imagesCompressed: number;
  bytesSaved: number;
  videosDeferred: number;
  /** bytes actually streamed for video/audio (Range = only what was watched) */
  mediaBytes: number;
}

type SearchPhase = "idle" | "searching" | "done" | "error";

interface SpecterState {
  // ── session ────────────────────────────────────────────────
  sid: string | null;
  key: CryptoKey | null;
  sessionReady: boolean;
  booting: boolean;
  sessionQueryCount: number;

  // ── search ─────────────────────────────────────────────────
  query: string;
  activeQuery: string;
  phase: SearchPhase;
  results: SearchResult[];
  tookMs: number;
  filteredCount: number;
  searchError: string | null;
  safeSearch: boolean;
  recencyDays: number | null;

  // ── ghost browser (tabbed, Min-style) ──────────────────────
  tabs: BrowserTab[];
  activeTabId: string | null;
  uvAvailable: boolean;
  /** full engine lifecycle — UI must never guess between booting/broken */
  uvStatus: UvStatus;
  /** readable, stage-tagged boot error (null when ready) */
  uvError: string | null;
  /** user explicitly chose the limited relay viewer after engine failure */
  relayFallbackAck: boolean;
  /** sites where the tracker firewall is suspended this session (RAM only) */
  bypassHosts: string[];
  /** last tracker blocked, with the precise rule that caught it */
  lastBlocked: { host: string; rule: string; ts: number } | null;
  /** network-pipeline diagnostics run by the engine SW */
  selfTest: {
    running: boolean;
    results: SelfTestResult[] | null;
    rev: string | null;
    ts: number | null;
  };
  dataSaver: boolean;
  adBlock: boolean;
  readerOn: boolean;
  stats: BrowserStats;
  /** discovered downloadable sources per tab id (built-in downloader) */
  mediaByTab: Record<string, MediaItem[]>;

  // ── privacy drawer ─────────────────────────────────────────
  drawerOpen: boolean;

  // ── vault ──────────────────────────────────────────────────
  vaultExists: boolean;
  vaultUnlocked: boolean;
  vaultEntries: VaultEntry[];
  vaultKey: CryptoKey | null;

  // ── actions ────────────────────────────────────────────────
  boot: () => Promise<void>;
  setQuery: (q: string) => void;
  search: (q?: string) => Promise<void>;
  setSafeSearch: (v: boolean) => void;
  setRecencyDays: (v: number | null) => void;

  newTab: (opts?: { url?: string; kind?: TabKind; query?: string }) => string;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  /** Open a URL with the full Ghost Browser. Reuses a new-tab surface. */
  openInBrowser: (url: string, opts?: { background?: boolean }) => void;
  /** Omnibox submit: URL → browse, words → encrypted search. */
  omniboxNavigate: (raw: string) => Promise<void>;
  tabNavigate: (url: string) => Promise<void>;
  tabGo: (delta: number) => Promise<void>;
  tabReload: () => Promise<void>;
  tabLoaded: () => Promise<void>;
  /** Poll hook: reconcile SPA (pushState) navigations inside the frame. */
  tabSync: () => void;
  /** Message from the injected page hook (specter-client.js). */
  handlePageMessage: (data: Record<string, unknown>) => void;
  toggleReader: () => void;
  setDataSaver: (v: boolean) => void;
  setAdBlock: (v: boolean) => void;
  addStats: (delta: Partial<BrowserStats>) => void;
  setDrawerOpen: (v: boolean) => void;

  /** Attempt a fresh engine boot after a failure (P0 recovery control). */
  retryEngine: () => Promise<void>;
  /** User explicitly accepts the script-stripped limited viewer. */
  ackRelayFallback: () => void;
  /** Suspend the tracker firewall for one site (this session only). */
  bypassFirewallFor: (host: string) => void;
  /** Re-enable the tracker firewall for a site. */
  restoreFirewallFor: (host: string) => void;
  /** Record a blocked tracker with the rule that caught it (from SW). */
  recordBlocked: (rule: string | undefined, url: string) => void;
  /** Receive diagnostics results from the engine SW. */
  setSelfTest: (r: { results: SelfTestResult[]; rev: string | null; ts: number }) => void;
  /** Run the engine's network-pipeline diagnostics. */
  runSelfTest: () => void;

  createVault: (pass: string, confirm: string) => Promise<string | null>;
  unlockVault: (pass: string) => Promise<string | null>;
  lockVault: () => void;
  clearVault: () => Promise<void>;
  panicWipe: () => Promise<void>;
}

function shortSessionId(sid: string): string {
  return sid.slice(0, 6).toUpperCase();
}

let tabCounter = 0;
function freshTabId(): string {
  tabCounter += 1;
  return `t${Date.now().toString(36)}${tabCounter}`;
}

/** Deterministic first tab — server and client renders must match exactly. */
const INITIAL_TAB: BrowserTab = {
  id: "t0",
  kind: "newtab",
  title: "New Tab",
  url: null,
  query: null,
  history: [],
  historyIndex: -1,
  loading: false,
  nonce: 0,
};

function makeTab(opts?: { url?: string; kind?: TabKind; query?: string }): BrowserTab {
  const kind: TabKind = opts?.kind ?? (opts?.url ? "web" : "newtab");
  const url = opts?.url ?? null;
  const query = opts?.query ?? null;
  return {
    id: freshTabId(),
    kind,
    title:
      kind === "web" && url
        ? hostOf(url)
        : kind === "search" && query
          ? query
          : "New Tab",
    url,
    query,
    history: url ? [url] : [],
    historyIndex: url ? 0 : -1,
    loading: Boolean(url),
    nonce: 0,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 32);
  }
}

function looksLikeUrl(raw: string): boolean {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (t.startsWith("localhost")) return true;
  // host.tld with optional path/port — no spaces already guaranteed
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(t);
}

function normalizeUrl(raw: string): string | null {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export const useSpecter = create<SpecterState>((set, get) => ({
  sid: null,
  key: null,
  sessionReady: false,
  booting: true,
  sessionQueryCount: 0,

  query: "",
  activeQuery: "",
  phase: "idle",
  results: [],
  tookMs: 0,
  filteredCount: 0,
  searchError: null,
  safeSearch: true,
  recencyDays: null,

  tabs: [INITIAL_TAB],
  activeTabId: INITIAL_TAB.id,
  uvAvailable: false,
  uvStatus: "booting",
  uvError: null,
  relayFallbackAck: false,
  bypassHosts: [],
  lastBlocked: null,
  selfTest: { running: false, results: null, rev: null, ts: null },
  /* Data Saver is strictly optional — OFF by default so every site renders at
   * full quality. Bandwidth efficiency never depended on it anyway: media is
   * Range-streamed (only watched seconds download) and trackers are blocked
   * at the engine level, so a 100 MB video costs ≈100 MB with zero recompression. */
  dataSaver: false,
  adBlock: true,
  readerOn: false,
  stats: { blocked: 0, imagesCompressed: 0, bytesSaved: 0, videosDeferred: 0, mediaBytes: 0 },
  mediaByTab: {},

  drawerOpen: false,

  vaultExists: false,
  vaultUnlocked: false,
  vaultEntries: [],
  vaultKey: null,

  // ── boot: fresh encrypted session (RAM-only) + browser engine ──
  boot: async () => {
    set({ booting: true });
    try {
      const key = await generateSessionKey();
      const raw = await exportKey(key);
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: raw }),
      });
      if (!res.ok) throw new Error("session_bootstrap_failed");
      const json = (await res.json()) as { sid: string };
      set({ sid: json.sid, key, sessionReady: true, booting: false });
    } catch {
      set({ sessionReady: false, booting: false });
    }

    // Boot the full browser engine (Ultraviolet SW + bare relay).
    const uv = await ensureUvEngine();
    if (uv.ok) {
      set({ uvStatus: "ready", uvAvailable: true, uvError: null, relayFallbackAck: false });
      const { dataSaver, adBlock, bypassHosts } = get();
      void pushUvSettings({ dataSaver, adBlock, bypassHosts });
    } else {
      set({ uvStatus: "failed", uvAvailable: false, uvError: uv.error });
    }
  },

  retryEngine: async () => {
    if (get().uvStatus === "booting") return;
    set({ uvStatus: "booting", uvError: null });
    const uv = await retryUvEngine();
    if (uv.ok) {
      set({ uvStatus: "ready", uvAvailable: true, uvError: null, relayFallbackAck: false });
      const { dataSaver, adBlock, bypassHosts } = get();
      void pushUvSettings({ dataSaver, adBlock, bypassHosts });
    } else {
      set({ uvStatus: "failed", uvAvailable: false, uvError: uv.error });
    }
  },

  ackRelayFallback: () => set({ relayFallbackAck: true }),

  bypassFirewallFor: (host) => {
    const clean = host.trim().toLowerCase();
    if (!clean) return;
    const { bypassHosts, dataSaver, adBlock } = get();
    if (bypassHosts.includes(clean)) return;
    const next = [...bypassHosts, clean].slice(0, 20);
    set({ bypassHosts: next });
    void pushUvSettings({ dataSaver, adBlock, bypassHosts: next });
  },

  restoreFirewallFor: (host) => {
    const clean = host.trim().toLowerCase();
    const { bypassHosts, dataSaver, adBlock } = get();
    const next = bypassHosts.filter((h) => h !== clean);
    set({ bypassHosts: next });
    void pushUvSettings({ dataSaver, adBlock, bypassHosts: next });
  },

  recordBlocked: (rule, url) => {
    get().addStats({ blocked: 1 });
    if (!rule) return;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep raw */
    }
    set({ lastBlocked: { host, rule, ts: Date.now() } });
  },

  setSelfTest: ({ results, rev, ts }) => {
    set({ selfTest: { running: false, results, rev, ts } });
  },

  runSelfTest: () => {
    if (get().selfTest.running) return;
    set({ selfTest: { running: true, results: null, rev: null, ts: null } });
    void postUvMessage({ type: "specter:selftest" });
    // safety net: if the engine never answers (dead SW), stop "running"
    setTimeout(() => {
      const st = get().selfTest;
      if (st.running && !st.results) {
        set({
          selfTest: {
            running: false,
            results: [
              {
                name: "engine_contact",
                pass: false,
                detail: "engine SW did not answer — retry the browser engine",
                ms: 0,
              },
            ],
            rev: null,
            ts: Date.now(),
          },
        });
      }
    }, 15000);
  },

  setQuery: (q) => set({ query: q }),

  search: async (q) => {
    const state = get();
    const query = (q ?? state.query).trim();
    if (!query) return;
    if (!state.key || !state.sid) {
      set({ searchError: "Secure session is not ready — rehydrating…", phase: "error" });
      return;
    }

    set({ phase: "searching", query, activeQuery: query, searchError: null, readerOn: false });

    // route the results into the active tab (browser behavior)
    const { tabs, activeTabId } = get();
    if (activeTabId) {
      const tabs2 = tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, kind: "search" as const, query, title: query, url: null, loading: false }
          : t
      );
      set({ tabs: tabs2 });
    }

    const { ok, data } = await securePost<{
      results?: SearchResult[];
      total?: number;
      filteredCount?: number;
      tookMs?: number;
      error?: string;
      retryInMs?: number;
    }>(state.key, state.sid, "/api/search", {
      query,
      safe: state.safeSearch,
      recencyDays: state.recencyDays,
      num: 14,
    });

    if (ok && data && data.results) {
      set({
        results: data.results,
        tookMs: data.tookMs ?? 0,
        filteredCount: data.filteredCount ?? 0,
        phase: "done",
        sessionQueryCount: state.sessionQueryCount + 1,
      });

      const v = get();
      if (v.vaultUnlocked && v.vaultKey) {
        const entry: VaultEntry = { q: query, ts: Date.now(), count: data.results.length };
        const next = [entry, ...v.vaultEntries].slice(0, 200);
        await vaultPersist(v.vaultKey, next);
        set({ vaultEntries: next });
      }
      return;
    }

    if (data?.error === "rate_limited") {
      set({
        phase: "error",
        searchError: `Relay cooling off — retry in ${Math.ceil((data.retryInMs ?? 0) / 1000)}s.`,
      });
      return;
    }

    if (data?.error === "search_failed") {
      set({ phase: "error", searchError: "The search relay failed. Try again in a moment." });
      return;
    }

    if (!ok && (data as { error?: string } | undefined)?.error !== undefined) {
      set({ phase: "error", searchError: "Secure session lost. Reopen the app to re-establish." });
      return;
    }

    set({ phase: "error", searchError: "Search failed. Check the connection and retry." });
  },

  setSafeSearch: (v) => set({ safeSearch: v }),
  setRecencyDays: (v) => set({ recencyDays: v }),

  // ── ghost browser ────────────────────────────────────────────

  newTab: (opts) => {
    const tab = makeTab(opts);
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id, readerOn: false });
    return tab.id;
  },

  closeTab: (id) => {
    const { tabs, activeTabId, mediaByTab } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.id !== id);
    if (next.length === 0) {
      const fresh = makeTab();
      set({ tabs: [fresh], activeTabId: fresh.id, readerOn: false });
      return;
    }
    let nextActive = activeTabId;
    if (activeTabId === id) {
      const neighbor = next[Math.min(idx, next.length - 1)];
      nextActive = neighbor.id;
    }
    const mediaNext = { ...mediaByTab };
    delete mediaNext[id];
    set({ tabs: next, activeTabId: nextActive, readerOn: false, mediaByTab: mediaNext });
  },

  activateTab: (id) => {
    if (get().activeTabId === id) return;
    set({ activeTabId: id, readerOn: false });
  },

  openInBrowser: (url, opts) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    const { tabs, activeTabId } = get();
    const active = tabs.find((t) => t.id === activeTabId);
    if (active && active.kind === "newtab" && !opts?.background) {
      // reuse the empty surface
      const tabs2 = tabs.map((t) =>
        t.id === active.id
          ? {
              ...t,
              kind: "web" as const,
              url: normalized,
              title: hostOf(normalized),
              history: [normalized],
              historyIndex: 0,
              loading: true,
              nonce: t.nonce + 1,
            }
          : t
      );
      set({ tabs: tabs2, readerOn: false });
      return;
    }
    const tab = makeTab({ url: normalized });
    if (opts?.background) {
      set({ tabs: [...tabs, tab] });
    } else {
      set({ tabs: [...tabs, tab], activeTabId: tab.id, readerOn: false });
    }
  },

  omniboxNavigate: async (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (looksLikeUrl(trimmed)) {
      const url = normalizeUrl(trimmed);
      if (url) await get().tabNavigate(url);
    } else {
      await get().search(trimmed);
    }
  },

  tabNavigate: async (rawUrl) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    const { tabs, activeTabId } = get();
    if (!activeTabId) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active) return;

    const stack = [...active.history.slice(0, active.historyIndex + 1), url];
    const mediaNext = { ...get().mediaByTab };
    delete mediaNext[activeTabId];
    const tabs2 = tabs.map((t) =>
      t.id === activeTabId
        ? {
            ...t,
            kind: "web" as const,
            url,
            title: hostOf(url),
            query: null,
            history: stack,
            historyIndex: stack.length - 1,
            loading: true,
            nonce: t.nonce + 1,
          }
        : t
    );
    set({ tabs: tabs2, readerOn: false, mediaByTab: mediaNext });
  },

  tabGo: async (delta) => {
    const { tabs, activeTabId, uvAvailable } = get();
    if (!activeTabId) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active || active.kind !== "web") return;
    const next = active.historyIndex + delta;
    if (next < 0 || next >= active.history.length) return;
    const url = active.history[next];

    if (uvAvailable) {
      // same-origin frame → native session history (state preserved)
      const frame = document.getElementById("ghost-frame") as HTMLIFrameElement | null;
      try {
        frame?.contentWindow?.history.go(delta);
        const tabs2 = tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, historyIndex: next, url, loading: true }
            : t
        );
        set({ tabs: tabs2, readerOn: false });
        return;
      } catch {
        // fall through to stack navigation
      }
    }

    const { key, sid } = get();
    if (!key || !sid) return;
    const src = await buildProxySrc(key, sid, url, true, false);
    void src;
    const tabs2 = tabs.map((t) =>
      t.id === activeTabId
        ? { ...t, historyIndex: next, url, loading: true, nonce: t.nonce + 1 }
        : t
    );
    set({ tabs: tabs2, readerOn: false });
  },

  tabReload: async () => {
    const { tabs, activeTabId, uvAvailable } = get();
    if (!activeTabId) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active || active.kind !== "web" || !active.url) return;

    if (uvAvailable) {
      const frame = document.getElementById("ghost-frame") as HTMLIFrameElement | null;
      try {
        frame?.contentWindow?.location.reload();
        const tabs2 = tabs.map((t) =>
          t.id === activeTabId ? { ...t, loading: true } : t
        );
        set({ tabs: tabs2 });
        return;
      } catch {
        // fall through to remount
      }
    }
    const tabs2 = tabs.map((t) =>
      t.id === activeTabId ? { ...t, loading: true, nonce: t.nonce + 1 } : t
    );
    set({ tabs: tabs2 });
  },

  tabLoaded: async () => {
    const { tabs, activeTabId } = get();
    if (!activeTabId) return;
    set({
      tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, loading: false } : t)),
    });
    try {
      const frame = document.getElementById("ghost-frame") as HTMLIFrameElement | null;
      const href = frame?.contentWindow?.location.href;
      if (!href) return;
      const { uvAvailable, key } = get();
      let realUrl: string | null = null;
      if (uvAvailable) {
        realUrl = uvRealUrl(href);
      } else if (key) {
        realUrl = await unsealProxyLocation(key, href);
      }
      if (!realUrl) return;
      get().handlePageMessage({ type: "page", href });
    } catch {
      // cross-origin — ignore
    }
  },

  tabSync: () => {
    const { tabs, activeTabId, uvAvailable } = get();
    if (!activeTabId || !uvAvailable) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active || active.kind !== "web") return;
    try {
      const frame = document.getElementById("ghost-frame") as HTMLIFrameElement | null;
      const href = frame?.contentWindow?.location.href;
      if (!href) return;
      const real = uvRealUrl(href);
      if (!real || real === active.url) return;
      get().handlePageMessage({ type: "page", href });
    } catch {
      // frame not ready — ignore
    }
  },

  /** Messages from specter-client.js inside proxied pages. */
  handlePageMessage: (data) => {
    const type = data.type as string | undefined;
    const { tabs, activeTabId } = get();
    if (!activeTabId) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active || active.kind !== "web") return;

    if (type === "page" && typeof data.href === "string") {
      const real = uvRealUrl(data.href) ?? data.href;
      const title = typeof data.title === "string" && data.title ? data.title : hostOf(real);

      // unchanged?
      if (real === active.url && title === active.title) return;

      // back/forward inside the frame?
      if (active.history[active.historyIndex - 1] === real) {
        set({
          tabs: tabs.map((t) =>
            t.id === activeTabId
              ? { ...t, url: real, title, historyIndex: t.historyIndex - 1, loading: false }
              : t
          ),
        });
        return;
      }
      if (active.history[active.historyIndex + 1] === real) {
        set({
          tabs: tabs.map((t) =>
            t.id === activeTabId
              ? { ...t, url: real, title, historyIndex: t.historyIndex + 1, loading: false }
              : t
          ),
        });
        return;
      }

      // fresh navigation → push onto the stack
      if (real !== active.url) {
        const history = [...active.history.slice(0, active.historyIndex + 1), real];
        set({
          tabs: tabs.map((t) =>
            t.id === activeTabId
              ? { ...t, url: real, title, history, historyIndex: history.length - 1, loading: false }
              : t
          ),
        });
        return;
      }

      // same URL, just a title update
      set({
        tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, title, loading: false } : t)),
      });
      return;
    }

    if (type === "popup" && typeof data.href === "string") {
      get().openInBrowser(data.href);
      return;
    }

    if (type === "video-deferred") {
      get().addStats({ videosDeferred: 1 });
      return;
    }

    /* downloader discovery: the injected hook reports downloadable sources */
    if (type === "media" && Array.isArray(data.items)) {
      const items: MediaItem[] = (data.items as Array<Record<string, unknown>>)
        .filter(
          (it): it is { u: string; k: string } =>
            typeof it?.u === "string" && /^https?:/i.test(it.u) && typeof it?.k === "string"
        )
        .slice(0, 60)
        .map((it) => ({ u: it.u, k: it.k }));
      if (!items.length) return;
      set({ mediaByTab: { ...get().mediaByTab, [activeTabId]: items } });
      return;
    }
  },

  toggleReader: () => set({ readerOn: !get().readerOn }),

  setDataSaver: (v) => {
    set({ dataSaver: v });
    const { adBlock, bypassHosts } = get();
    void pushUvSettings({ dataSaver: v, adBlock, bypassHosts });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("specter:settings", JSON.stringify({ dataSaver: v, adBlock }));
      } catch {
        /* ignore */
      }
    }
  },

  setAdBlock: (v) => {
    set({ adBlock: v });
    const { dataSaver, bypassHosts } = get();
    void pushUvSettings({ dataSaver, adBlock: v, bypassHosts });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("specter:settings", JSON.stringify({ dataSaver, adBlock: v }));
      } catch {
        /* ignore */
      }
    }
  },

  addStats: (delta) => {
    const s = get().stats;
    set({
      stats: {
        blocked: s.blocked + (delta.blocked ?? 0),
        imagesCompressed: s.imagesCompressed + (delta.imagesCompressed ?? 0),
        bytesSaved: s.bytesSaved + (delta.bytesSaved ?? 0),
        videosDeferred: s.videosDeferred + (delta.videosDeferred ?? 0),
        mediaBytes: s.mediaBytes + (delta.mediaBytes ?? 0),
      },
    });
  },

  setDrawerOpen: (v) => set({ drawerOpen: v }),

  // ── vault ───────────────────────────────────────────────────
  createVault: async (pass, confirm) => {
    if (pass.length < 8) return "Passphrase must be at least 8 characters.";
    if (pass !== confirm) return "Passphrases do not match.";
    await vaultCreate(pass);
    const unlocked = await unlockInternal(pass);
    if (!unlocked) return "Vault creation failed unexpectedly.";
    set({ vaultExists: true });
    return null;
  },

  unlockVault: async (pass) => {
    const result = await vaultUnlock(pass);
    if (!result) return "Wrong passphrase — the vault stayed sealed.";
    set({ vaultUnlocked: true, vaultKey: result.key, vaultEntries: result.entries, vaultExists: true });
    return null;
  },

  lockVault: () => set({ vaultUnlocked: false, vaultKey: null, vaultEntries: [] }),

  clearVault: async () => {
    const { vaultKey } = get();
    if (vaultKey) {
      await vaultPersist(vaultKey, []);
    }
    set({ vaultEntries: [] });
  },

  panicWipe: async () => {
    const { sid } = get();
    try {
      if (sid) {
        await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "destroy", sid }),
        });
      }
    } catch {
      // best effort
    }
    vaultWipe();
    const fresh: BrowserTab = {
      id: freshTabId(),
      kind: "newtab",
      title: "New Tab",
      url: null,
      query: null,
      history: [],
      historyIndex: -1,
      loading: false,
      nonce: 0,
    };
    set({
      sid: null,
      key: null,
      sessionReady: false,
      booting: false,
      sessionQueryCount: 0,
      query: "",
      activeQuery: "",
      phase: "idle",
      results: [],
      tookMs: 0,
      filteredCount: 0,
      searchError: null,
      tabs: [fresh],
      activeTabId: fresh.id,
      readerOn: false,
      stats: { blocked: 0, imagesCompressed: 0, bytesSaved: 0, videosDeferred: 0, mediaBytes: 0 },
      mediaByTab: {},
      drawerOpen: false,
      vaultExists: false,
      vaultUnlocked: false,
      vaultEntries: [],
      vaultKey: null,
    });
    await get().boot();
  },
}));

async function unlockInternal(pass: string) {
  const result = await vaultUnlock(pass);
  if (!result) return null;
  useSpecter.setState({
    vaultUnlocked: true,
    vaultKey: result.key,
    vaultEntries: result.entries,
  });
  return result;
}

// hydrate: vault existence + settings mirror for injected pages
if (typeof window !== "undefined") {
  useSpecter.setState({ vaultExists: vaultExists() });
  try {
    const { dataSaver, adBlock } = useSpecter.getState();
    window.localStorage.setItem("specter:settings", JSON.stringify({ dataSaver, adBlock }));
  } catch {
    /* ignore */
  }
}

export { shortSessionId };
