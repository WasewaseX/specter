"use client";

/**
 * SPECTER — Zero-Trace Encrypted Search Engine.
 * Single-surface app: search hero / results, ghost viewer overlay, privacy drawer.
 */

import { useEffect } from "react";
import { useSpecter } from "@/store/specter";
import Header from "@/components/specter/header";
import SearchHero from "@/components/specter/search-hero";
import ResultsView from "@/components/specter/results-view";
import Footer from "@/components/specter/footer";
import ViewerOverlay from "@/components/specter/viewer-overlay";
import PrivacyDrawer from "@/components/specter/privacy-drawer";

export default function Home() {
  const boot = useSpecter((s) => s.boot);
  const phase = useSpecter((s) => s.phase);
  const activeQuery = useSpecter((s) => s.activeQuery);
  const drawerOpen = useSpecter((s) => s.drawerOpen);

  useEffect(() => {
    void boot();
  }, [boot]);

  // "/" focuses the search field from anywhere (when no overlay is up)
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

  const showResults = phase !== "idle" || activeQuery.length > 0;

  return (
    <div className="relative flex min-h-screen flex-col bg-zinc-950">
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
      {/* top glow */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-1/2 top-[-320px] z-0 h-[560px] w-[900px] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[140px]"
      />

      <Header />

      <main className="relative z-10 flex w-full flex-1 flex-col">
        {showResults ? <ResultsView /> : <SearchHero />}
      </main>

      <Footer />

      <ViewerOverlay />
      {drawerOpen && <PrivacyDrawer />}
    </div>
  );
}
