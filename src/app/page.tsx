"use client";

/**
 * SPECTER — Zero-Trace Search Engine + Ghost Browser.
 * Browser chrome: header / tab strip / navigation bar / tab surface / status.
 * Everything between the omnibox and the status bar is the active tab.
 */

import { useEffect } from "react";
import { useSpecter } from "@/store/specter";
import { subscribeUvMessages } from "@/lib/uv-browser";
import Header from "@/components/specter/header";
import TabStrip from "@/components/specter/tab-strip";
import BrowserBar from "@/components/specter/browser-bar";
import GhostBrowser from "@/components/specter/ghost-browser";
import Footer from "@/components/specter/footer";
import PrivacyDrawer from "@/components/specter/privacy-drawer";

export default function Home() {
  const boot = useSpecter((s) => s.boot);
  const drawerOpen = useSpecter((s) => s.drawerOpen);
  const tabs = useSpecter((s) => s.tabs);
  const activeTabId = useSpecter((s) => s.activeTabId);
  const handlePageMessage = useSpecter((s) => s.handlePageMessage);
  const recordBlocked = useSpecter((s) => s.recordBlocked);
  const setSelfTest = useSpecter((s) => s.setSelfTest);

  useEffect(() => {
    void boot();
  }, [boot]);

  // messages from the engine SW: blocked trackers + diagnostics results
  useEffect(() => {
    const unsubscribe = subscribeUvMessages((data) => {
      if (data.type === "specter:blocked") {
        recordBlocked(
          typeof data.rule === "string" ? data.rule : undefined,
          typeof data.url === "string" ? data.url : ""
        );
      } else if (data.type === "specter:img") {
        const saved = Number(data.saved) || 0;
        useSpecter.getState().addStats({ imagesCompressed: 1, bytesSaved: saved });
      } else if (data.type === "specter:media") {
        // bytes the video element actually pulled over the wire (Range
        // streaming = only what was watched; browser cache serves replays)
        const bytes = Number(data.bytes) || 0;
        if (bytes > 0) useSpecter.getState().addStats({ mediaBytes: bytes });
      } else if (data.type === "specter:selftest" && Array.isArray(data.results)) {
        setSelfTest({
          results: data.results as { name: string; pass: boolean; detail: string; ms: number }[],
          rev: typeof data.rev === "string" ? data.rev : null,
          ts: Number(data.ts) || Date.now(),
        });
      } else if (data.type === "specter:relay-debug") {
        // transport-level failure diagnostics (code + envelope size) —
        // surfaced in the console only; nothing is persisted (RAM-only rule)
        console.info(
          "[specter] relay failure:",
          String(data.code),
          "HTTP",
          String(data.status),
          "meta",
          String(data.metaBytes),
          "B →",
          String(data.target)
        );
      }
    });
    return unsubscribe;
  }, [recordBlocked, setSelfTest]);

  // messages from injected page hooks: address-bar sync + popup → tab
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object" || data.__specter !== true) return;
      if (event.source === window) return;
      handlePageMessage(data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handlePageMessage]);

  // "/" focuses the search field from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("specter-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl/Cmd+T new tab, Ctrl/Cmd+W close tab (browser feel)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const store = useSpecter.getState();
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        store.newTab();
      } else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (store.activeTabId) store.closeTab(store.activeTabId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const showBrowserBar = activeTab?.kind === "web";

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-zinc-950">
      {/* ambient security-grid backdrop */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(52,211,153,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,0.04) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 100%)",
        }}
      />

      <Header />
      <TabStrip />
      {showBrowserBar ? <BrowserBar /> : null}

      <main className="relative z-10 flex min-h-0 w-full flex-1 flex-col">
        <GhostBrowser />
      </main>

      <Footer />

      {drawerOpen && <PrivacyDrawer />}
    </div>
  );
}
