"use client";

/**
 * SPECTER — central client state (zustand).
 * This store is the single contract between the crypto/session layer and the UI.
 */

import { create } from "zustand";
import { exportKey, generateSessionKey } from "@/lib/crypto";
import { buildProxySrc, securePost, unsealProxyLocation } from "@/lib/secure-client";
import {
  ensureUvEngine,
  uvEngineLoaded,
  uvHref,
  uvRealUrl,
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

type SearchPhase = "idle" | "searching" | "done" | "error";

interface SpecterState {
  // ── session ────────────────────────────────────────────────
  sid: string | null;
  key: CryptoKey | null;
  sessionReady: boolean;
  booting: boolean;
  sessionQueryCount: number;

  // ── search ─────────────────────────────────────────────────
  query: string; // input value
  activeQuery: string; // last executed query
  phase: SearchPhase;
  results: SearchResult[];
  tookMs: number;
  filteredCount: number;
  searchError: string | null;
  safeSearch: boolean;
  recencyDays: number | null;

  // ── ghost browser ──────────────────────────────────────────
  viewerOpen: boolean;
  viewerSrc: string | null;
  viewerUrl: string | null; // real (decrypted) URL currently shown
  viewerStack: string[];
  viewerIndex: number;
  viewerLoading: boolean;
  /** true = hardened Ghost relay (scripts stripped); false = full Ghost Browser (Ultraviolet engine). */
  viewerGhost: boolean;
  /** true when the full browser engine (service worker + bare relay) booted successfully. */
  uvAvailable: boolean;
  /** bumped to force an iframe remount when a hard reload is required (ghost mode). */
  viewerNonce: number;

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

  openViewer: (url: string) => Promise<void>;
  viewerNavigate: (url: string) => Promise<void>;
  viewerGo: (delta: number) => Promise<void>;
  viewerReload: () => Promise<void>;
  viewerLoaded: () => Promise<void>;
  /** Poll hook: reconcile SPA (pushState) navigations inside the frame. */
  viewerSync: () => void;
  toggleViewerMode: () => Promise<void>;
  closeViewer: () => void;
  setDrawerOpen: (v: boolean) => void;

  createVault: (pass: string, confirm: string) => Promise<string | null>;
  unlockVault: (pass: string) => Promise<string | null>;
  lockVault: () => void;
  clearVault: () => Promise<void>;
  panicWipe: () => Promise<void>;
}

function shortSessionId(sid: string): string {
  return sid.slice(0, 6).toUpperCase();
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

  viewerOpen: false,
  viewerSrc: null,
  viewerUrl: null,
  viewerStack: [],
  viewerIndex: -1,
  viewerLoading: false,
  viewerGhost: false,
  uvAvailable: false,
  viewerNonce: 0,

  drawerOpen: false,

  vaultExists: false,
  vaultUnlocked: false,
  vaultEntries: [],
  vaultKey: null,

  // ── boot: create a fresh encrypted session (RAM-only, never persisted) ──
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

    // Boot the full browser engine (Ultraviolet + bare relay) in the background.
    // If it is unavailable (no SW support, relay down) fall back to Ghost mode.
    const uvReady = await ensureUvEngine();
    set({ uvAvailable: uvReady, viewerGhost: uvReady ? get().viewerGhost : true });
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

    set({ phase: "searching", query, activeQuery: query, searchError: null });
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

      // record into the encrypted vault if unlocked
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

    // session may have died (server restart) → re-boot once
    if (!ok && (data as { error?: string } | undefined)?.error !== undefined) {
      set({ phase: "error", searchError: "Secure session lost. Reopen the app to re-establish." });
      return;
    }

    set({ phase: "error", searchError: "Search failed. Check the connection and retry." });
  },

  setSafeSearch: (v) => set({ safeSearch: v }),
  setRecencyDays: (v) => set({ recencyDays: v }),

  // ── ghost browser ────────────────────────────────────────────

  openViewer: async (url) => {
    const { key, sid, viewerGhost } = get();
    if (!key || !sid) return;
    let src: string | null;
    if (viewerGhost || !uvEngineLoaded()) {
      src = await buildProxySrc(key, sid, url, false, false);
    } else {
      src = uvHref(url);
      if (!src) src = await buildProxySrc(key, sid, url, false, false);
    }
    set({
      viewerOpen: true,
      viewerSrc: src,
      viewerUrl: url,
      viewerStack: [url],
      viewerIndex: 0,
      viewerLoading: true,
    });
  },

  /** Typed address in the viewer URL bar. */
  viewerNavigate: async (rawUrl) => {
    const { key, sid, viewerGhost } = get();
    if (!key || !sid) return;
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    let url = trimmed;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      // validate — throws on garbage
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      url = parsed.toString();
    } catch {
      return;
    }
    let src: string | null;
    if (viewerGhost || !uvEngineLoaded()) {
      src = await buildProxySrc(key, sid, url, false, false);
    } else {
      src = uvHref(url);
      if (!src) src = await buildProxySrc(key, sid, url, false, false);
    }
    set({ viewerSrc: src, viewerUrl: url, viewerLoading: true });
    // push into history stack
    const { viewerStack, viewerIndex } = get();
    const stack = [...viewerStack.slice(0, viewerIndex + 1), url];
    set({ viewerStack: stack, viewerIndex: stack.length - 1 });
  },

  viewerGo: async (delta) => {
    const { viewerGhost, viewerStack, viewerIndex } = get();
    const next = viewerIndex + delta;
    if (next < 0 || next >= viewerStack.length) return;

    if (!viewerGhost) {
      // Full browser mode: the proxied frame is same-origin, so native
      // session history (with full page state) does the navigation.
      const frame = document.getElementById("specter-viewer-frame") as HTMLIFrameElement | null;
      try {
        frame?.contentWindow?.history.go(delta);
        set({ viewerIndex: next, viewerLoading: true });
        return;
      } catch {
        // fall through to stack-based navigation
      }
    }

    const { key, sid } = get();
    if (!key || !sid) return;
    const url = viewerStack[next];
    const src = await buildProxySrc(key, sid, url, true, false);
    set({ viewerIndex: next, viewerSrc: src, viewerUrl: url, viewerLoading: true });
  },

  viewerReload: async () => {
    const { key, sid, viewerUrl, viewerGhost } = get();
    if (!key || !sid || !viewerUrl) return;

    if (!viewerGhost) {
      // same-origin frame → true in-place reload, session history preserved
      const frame = document.getElementById("specter-viewer-frame") as HTMLIFrameElement | null;
      try {
        frame?.contentWindow?.location.reload();
        set({ viewerLoading: true });
        return;
      } catch {
        // fall through to remount
      }
    }
    const src = await buildProxySrc(key, sid, viewerUrl, true, false);
    set({ viewerSrc: src, viewerLoading: true, viewerNonce: get().viewerNonce + 1 });
  },

  /** Swap between the full Ghost Browser (Ultraviolet) and the hardened Ghost relay. */
  toggleViewerMode: async () => {
    const next = !get().viewerGhost;
    set({ viewerGhost: next });
    await get().viewerReload();
  },

  /** Called on iframe load: reconciles the real location with our history stack. */
  viewerLoaded: async () => {
    const { viewerGhost, viewerStack, viewerIndex, viewerUrl } = get();
    set({ viewerLoading: false });
    try {
      const frame = document.getElementById("specter-viewer-frame") as HTMLIFrameElement | null;
      const href = frame?.contentWindow?.location.href;
      if (!href) return;

      let realUrl: string | null = null;
      if (!viewerGhost) {
        realUrl = uvRealUrl(href);
      } else {
        const { key } = get();
        if (key) realUrl = await unsealProxyLocation(key, href);
      }
      if (!realUrl || realUrl === viewerUrl) return;
      // user navigated inside the viewer via the proxy → push history
      if (viewerStack[viewerIndex] === realUrl) return;
      const stack = [...viewerStack.slice(0, viewerIndex + 1), realUrl];
      set({ viewerStack: stack, viewerIndex: stack.length - 1, viewerUrl: realUrl });
    } catch {
      // cross-origin access — ignore
    }
  },

  /**
   * Poll hook (full browser mode): sites navigate with pushState inside the
   * frame, which never fires an iframe load event — reconcile the address
   * bar and history stack by reading the frame location.
   */
  viewerSync: () => {
    const { viewerOpen, viewerGhost, viewerStack, viewerIndex, viewerUrl } = get();
    if (!viewerOpen || viewerGhost) return;
    try {
      const frame = document.getElementById("specter-viewer-frame") as HTMLIFrameElement | null;
      const href = frame?.contentWindow?.location.href;
      if (!href) return;
      const real = uvRealUrl(href);
      if (!real || real === viewerUrl) return;
      // moving through existing stack entries (back/forward) vs a new page
      if (viewerIndex > 0 && viewerStack[viewerIndex - 1] === real) {
        set({ viewerIndex: viewerIndex - 1, viewerUrl: real });
        return;
      }
      if (viewerIndex >= 0 && viewerIndex < viewerStack.length - 1 && viewerStack[viewerIndex + 1] === real) {
        set({ viewerIndex: viewerIndex + 1, viewerUrl: real });
        return;
      }
      const stack = [...viewerStack.slice(0, viewerIndex + 1), real];
      set({ viewerStack: stack, viewerIndex: stack.length - 1, viewerUrl: real });
    } catch {
      // frame not ready / cross-origin — ignore
    }
  },

  closeViewer: () => set({ viewerOpen: false, viewerSrc: null, viewerUrl: null, viewerStack: [], viewerIndex: -1 }),

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
      // ignore — best effort
    }
    vaultWipe();
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
      viewerOpen: false,
      viewerSrc: null,
      viewerUrl: null,
      viewerStack: [],
      viewerIndex: -1,
      viewerGhost: get().uvAvailable ? false : true,
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

// hydrate vault existence on first client load
if (typeof window !== "undefined") {
  useSpecter.setState({ vaultExists: vaultExists() });
}
