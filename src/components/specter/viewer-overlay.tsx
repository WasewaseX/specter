"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Lock,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useSpecter } from "@/store/specter";

/**
 * ViewerOverlay — full-screen secure browsing surface ("Ghost Browser").
 *
 * Full browser mode (default): the Ultraviolet engine (open-source, forked
 * from GitHub) runs a same-origin service worker + bare relay, so sites load
 * completely — images, video, styles and scripts — while every request is
 * fetched by the relay, never directly from this device's network.
 *
 * Ghost mode (opt-in hardened): pages are relayed through the encrypted
 * /api/open proxy with all scripts stripped — a script-free reading mode for
 * when you don't want a site executing anything at all.
 */
export default function ViewerOverlay() {
  const viewerOpen = useSpecter((s) => s.viewerOpen);
  const viewerSrc = useSpecter((s) => s.viewerSrc);
  const viewerUrl = useSpecter((s) => s.viewerUrl);
  const viewerStack = useSpecter((s) => s.viewerStack);
  const viewerIndex = useSpecter((s) => s.viewerIndex);
  const viewerLoading = useSpecter((s) => s.viewerLoading);
  const viewerGhost = useSpecter((s) => s.viewerGhost);
  const viewerNonce = useSpecter((s) => s.viewerNonce);
  const uvAvailable = useSpecter((s) => s.uvAvailable);
  const viewerGo = useSpecter((s) => s.viewerGo);
  const viewerReload = useSpecter((s) => s.viewerReload);
  const viewerLoaded = useSpecter((s) => s.viewerLoaded);
  const viewerSync = useSpecter((s) => s.viewerSync);
  const viewerNavigate = useSpecter((s) => s.viewerNavigate);
  const toggleViewerMode = useSpecter((s) => s.toggleViewerMode);
  const closeViewer = useSpecter((s) => s.closeViewer);

  const [address, setAddress] = useState(viewerUrl ?? "");
  const [syncedUrl, setSyncedUrl] = useState(viewerUrl);

  // keep the address bar in sync with the page actually being viewed
  // (React's recommended adjust-state-on-prop-change pattern, no effect needed)
  if (viewerUrl !== syncedUrl) {
    setSyncedUrl(viewerUrl);
    setAddress(viewerUrl ?? "");
  }

  // Escape closes the secure viewer while it is open.
  useEffect(() => {
    if (!viewerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeViewer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewerOpen, closeViewer]);

  // Full browser mode: sites navigate via pushState inside the frame (no load
  // event) — poll the frame location to keep the address bar and history honest.
  useEffect(() => {
    if (!viewerOpen || viewerGhost) return;
    const timer = setInterval(viewerSync, 700);
    return () => clearInterval(timer);
  }, [viewerOpen, viewerGhost, viewerSync]);

  if (!viewerOpen) return null;

  const canGoBack = viewerIndex > 0;
  const canGoForward = viewerIndex >= 0 && viewerIndex < viewerStack.length - 1;

  const submitAddress = (e: React.FormEvent) => {
    e.preventDefault();
    void viewerNavigate(address);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="fixed inset-0 z-50 flex flex-col bg-zinc-950"
      role="dialog"
      aria-modal="true"
      aria-label="Ghost Browser — secure encrypted browsing"
    >
      {/* toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-zinc-800 px-2 md:gap-2 md:px-3">
        <Button
          variant="ghost"
          size="icon"
          disabled={!canGoBack}
          onClick={() => viewerGo(-1)}
          aria-label="Back"
        >
          <ArrowLeft aria-hidden="true" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="hidden sm:inline-flex"
          disabled={!canGoForward}
          onClick={() => viewerGo(1)}
          aria-label="Forward"
        >
          <ArrowRight aria-hidden="true" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => viewerReload()}
          aria-label="Reload page"
        >
          <RotateCw
            aria-hidden="true"
            className={viewerLoading ? "animate-spin" : undefined}
          />
        </Button>

        {/* address bar */}
        <form
          onSubmit={submitAddress}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 focus-within:border-emerald-400/40"
        >
          <Lock aria-hidden="true" className="size-3 shrink-0 text-emerald-400" />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Address — travels sealed through the encrypted relay"
            className="w-full min-w-0 bg-transparent font-mono text-[11px] text-zinc-300 outline-none placeholder:text-zinc-600"
            placeholder="Type an address and press Enter — relayed through the encrypted tunnel"
          />
          {viewerGhost ? (
            <span
              className="hidden shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300 md:inline"
              title="Ghost mode: scripts stripped, text-only reading via the hardened relay"
            >
              GHOST
            </span>
          ) : (
            <span
              className="hidden shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300 md:inline"
              title="Full browser: Ultraviolet engine relays everything — images, video and scripts render normally"
            >
              FULL BROWSER
            </span>
          )}
        </form>

        {/* browser mode toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void toggleViewerMode()}
          disabled={!uvAvailable && !viewerGhost}
          aria-label={
            viewerGhost
              ? "Ghost mode is on — switch to the full Ghost Browser (scripts and media enabled)"
              : "Full browser is on — switch to Ghost mode (strip all scripts)"
          }
          title={
            viewerGhost
              ? "Ghost mode: scripts stripped. Click to enable the full Ghost Browser."
              : "Full browser: images, video and scripts render via the encrypted relay. Click for Ghost mode (text only)."
          }
        >
          {viewerGhost ? (
            <ShieldCheck aria-hidden="true" className="text-emerald-400" />
          ) : (
            <Globe aria-hidden="true" className="text-emerald-300" />
          )}
        </Button>

        {viewerUrl ? (
          <a
            href={viewerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original site without the viewer"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <ExternalLink aria-hidden="true" />
          </a>
        ) : null}

        <Button
          variant="ghost"
          size="icon"
          onClick={closeViewer}
          aria-label="Close secure viewer"
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      {/* loading indicator */}
      {viewerLoading ? (
        <div
          className="h-0.5 w-full shrink-0 animate-pulse bg-emerald-400"
          aria-hidden="true"
        />
      ) : null}

      <iframe
        id="specter-viewer-frame"
        key={`${viewerSrc ?? "empty"}#${viewerNonce}`}
        src={viewerSrc ?? undefined}
        title="Ghost Browser — secure encrypted viewer"
        className="w-full flex-1 bg-white"
        sandbox={
          viewerGhost
            ? "allow-same-origin"
            : "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock"
        }
        onLoad={() => viewerLoaded()}
      />
    </motion.div>
  );
}
