"use client";

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  House,
  Lock,
  RotateCw,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSpecter } from "@/store/specter";

/**
 * BrowserBar — navigation chrome for web tabs (Min-style: minimal, fast).
 * Omnibox doubles as search box: words → encrypted search, hosts → browse.
 */
export default function BrowserBar() {
  const tabs = useSpecter((s) => s.tabs);
  const activeTabId = useSpecter((s) => s.activeTabId);
  const tabGo = useSpecter((s) => s.tabGo);
  const tabReload = useSpecter((s) => s.tabReload);
  const omniboxNavigate = useSpecter((s) => s.omniboxNavigate);
  const readerOn = useSpecter((s) => s.readerOn);
  const toggleReader = useSpecter((s) => s.toggleReader);
  const dataSaver = useSpecter((s) => s.dataSaver);
  const uvAvailable = useSpecter((s) => s.uvAvailable);
  const newTab = useSpecter((s) => s.newTab);

  const active = tabs.find((t) => t.id === activeTabId);
  if (!active || active.kind !== "web") return null;

  const canGoBack = active.historyIndex > 0;
  const canGoForward = active.historyIndex >= 0 && active.historyIndex < active.history.length - 1;

  return <BrowserBarInner
    key={active.id}
    url={active.url}
    loading={active.loading}
    canGoBack={canGoBack}
    canGoForward={canGoForward}
    readerOn={readerOn}
    dataSaver={dataSaver}
    uvAvailable={uvAvailable}
    onBack={() => void tabGo(-1)}
    onForward={() => void tabGo(1)}
    onReload={() => void tabReload()}
    onHome={() => newTab()}
    onToggleReader={toggleReader}
    onSubmit={(value) => void omniboxNavigate(value)}
  />;
}

function BrowserBarInner(props: {
  url: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  readerOn: boolean;
  dataSaver: boolean;
  uvAvailable: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onHome: () => void;
  onToggleReader: () => void;
  onSubmit: (value: string) => void;
}) {
  const [address, setAddress] = useState(props.url ?? "");
  const [syncedUrl, setSyncedUrl] = useState(props.url);

  // adjust state on prop change (React recommended pattern)
  if (props.url !== syncedUrl) {
    setSyncedUrl(props.url);
    setAddress(props.url ?? "");
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-zinc-800/80 bg-zinc-950/95 px-1.5 md:gap-1.5 md:px-2.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        disabled={!props.canGoBack}
        onClick={props.onBack}
        aria-label="Back"
      >
        <ArrowLeft aria-hidden="true" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="hidden size-9 sm:inline-flex"
        disabled={!props.canGoForward}
        onClick={props.onForward}
        aria-label="Forward"
      >
        <ArrowRight aria-hidden="true" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        onClick={props.onReload}
        aria-label="Reload page"
      >
        <RotateCw
          aria-hidden="true"
          className={props.loading ? "animate-spin" : undefined}
        />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="hidden size-9 sm:inline-flex"
        onClick={props.onHome}
        aria-label="New start page"
      >
        <House aria-hidden="true" />
      </Button>

      {/* omnibox */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit(address);
        }}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 focus-within:border-emerald-400/40"
      >
        <Lock aria-hidden="true" className="size-3 shrink-0 text-emerald-400" />
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label="Address or search — everything travels through the encrypted relay"
          className="w-full min-w-0 bg-transparent font-mono text-[11px] text-zinc-300 outline-none placeholder:text-zinc-600"
          placeholder="Search or type an address — relayed, never direct"
        />
        {props.dataSaver ? (
          <span
            className="hidden shrink-0 items-center gap-1 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300 md:inline-flex"
            title="Data Saver: images recompressed server-side, videos load only when you press play"
          >
            <Zap aria-hidden="true" className="size-2.5" />
            DATA SAVER
          </span>
        ) : null}
        <span
          className="hidden shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300 md:inline"
          title={
            props.uvAvailable
              ? "Full browser: the Ultraviolet engine relays everything — images, video and scripts render normally"
              : "Hardened mode: scripts stripped by the encrypted relay"
          }
        >
          {props.uvAvailable ? "FULL BROWSER" : "GHOST"}
        </span>
      </form>

      {/* reader mode (Min feature) */}
      <Button
        variant="ghost"
        size="icon"
        className={`size-9 ${props.readerOn ? "text-emerald-300" : "text-zinc-400"}`}
        onClick={props.onToggleReader}
        aria-pressed={props.readerOn}
        aria-label={
          props.readerOn
            ? "Reader view is on — switch back to the full page"
            : "Reader view — strip the page down to pure text (Min-style Reader Mode)"
        }
      >
        <BookOpen aria-hidden="true" />
      </Button>
    </div>
  );
}
