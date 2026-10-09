"use client";

import type { FormEvent } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ExternalLink,
  Ghost,
  Globe,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSpecter, type SearchResult } from "@/store/specter";

const AVATAR_STYLES = [
  "bg-emerald-500/15 text-emerald-300",
  "bg-teal-500/15 text-teal-300",
  "bg-green-500/15 text-green-300",
  "bg-lime-500/15 text-lime-300",
] as const;

function avatarStyle(host: string): string {
  const code = host.length > 0 ? host.charCodeAt(0) : 0;
  return AVATAR_STYLES[code % AVATAR_STYLES.length];
}

function displayPath(url: string, host: string): string {
  try {
    const parsed = new URL(url);
    return `${host}${parsed.pathname}`;
  } catch {
    return url.length > 64 ? `${url.slice(0, 61)}…` : url;
  }
}

function resultHost(result: SearchResult): string {
  if (result.host) return result.host;
  try {
    return new URL(result.url).host;
  } catch {
    return "";
  }
}

export default function ResultsView() {
  const phase = useSpecter((s) => s.phase);
  const activeQuery = useSpecter((s) => s.activeQuery);
  const query = useSpecter((s) => s.query);
  const setQuery = useSpecter((s) => s.setQuery);
  const search = useSpecter((s) => s.search);
  const results = useSpecter((s) => s.results);
  const tookMs = useSpecter((s) => s.tookMs);
  const filteredCount = useSpecter((s) => s.filteredCount);
  const searchError = useSpecter((s) => s.searchError);
  const safeSearch = useSpecter((s) => s.safeSearch);
  const openInBrowser = useSpecter((s) => s.openInBrowser);
  const omniboxNavigate = useSpecter((s) => s.omniboxNavigate);

  if (phase === "idle" && activeQuery.length === 0) return null;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void omniboxNavigate(query);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      {/* compact search bar */}
      <form role="search" onSubmit={handleSubmit} className="mt-6">
        <div className="flex h-12 w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-2 transition-colors focus-within:border-emerald-400/50 focus-within:ring-1 focus-within:ring-emerald-400/30">
          <Search className="ml-1.5 h-4 w-4 flex-none text-zinc-500" aria-hidden="true" />
          <Input
            id="specter-search"
            name="query"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the unfiltered web…"
            aria-label="Search the unfiltered web"
            autoComplete="off"
            spellCheck={false}
            className="h-auto min-w-0 flex-1 border-0 bg-transparent px-1 text-base text-zinc-100 shadow-none placeholder:text-zinc-500 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent md:text-base"
          />
          <Button
            type="submit"
            aria-label="Run encrypted search"
            className="size-9 flex-none bg-emerald-400 text-zinc-950 hover:bg-emerald-300"
          >
            <Search className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </form>

      {/* stats line */}
      {phase === "done" ? (
        <p
          aria-live="polite"
          className="mt-3 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500"
        >
          <span>
            {results.length} results · {tookMs} ms
            {filteredCount > 0 ? (
              <span className="text-emerald-300">
                {" "}
                · {filteredCount} filtered by Safe Search
              </span>
            ) : null}
          </span>
          {safeSearch ? (
            <ShieldCheck className="h-3 w-3 flex-none text-emerald-400" aria-hidden="true" />
          ) : null}
        </p>
      ) : null}

      <section aria-label="Search results" aria-busy={phase === "searching"} className="mt-6">
        {phase === "searching" ? <SkeletonRows /> : null}

        {phase === "error" ? (
          <ErrorState
            message={searchError}
            onRetry={() => {
              void search();
            }}
          />
        ) : null}

        {phase === "done" && results.length === 0 ? (
          <EmptyState query={activeQuery} safeSearch={safeSearch} />
        ) : null}

        {phase === "done" && results.length > 0 ? (
          <div className="divide-y divide-zinc-800/60">
            {results.map((result, index) => (
              <ResultRow
                key={result.id}
                result={result}
                index={index}
                onOpen={(url) => {
                  openInBrowser(url);
                }}
              />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ResultRow({
  result,
  index,
  onOpen,
}: {
  result: SearchResult;
  index: number;
  onOpen: (url: string) => void;
}) {
  const host = resultHost(result);
  const letter = (host.charAt(0) || "?").toUpperCase();

  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index * 0.03, 0.3), ease: "easeOut" }}
      className="flex gap-4 py-4"
    >
      <div
        aria-hidden="true"
        className={`flex h-10 w-10 flex-none items-center justify-center rounded-lg font-semibold ${avatarStyle(host)}`}
      >
        {letter}
      </div>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen(result.url)}
          aria-label={`Open ${host} in the encrypted browser: ${result.title}`}
          className="line-clamp-2 text-left font-medium leading-snug text-zinc-100 transition-colors hover:text-emerald-300"
        >
          {result.title}
        </button>

        <p className="mt-0.5 truncate font-mono text-[11px] text-emerald-300/60">
          {displayPath(result.url, host)}
        </p>

        <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{result.snippet}</p>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {result.date ? (
            <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
              {result.date}
            </span>
          ) : null}

          <button
            type="button"
            onClick={() => onOpen(result.url)}
            aria-label={`Open ${host} in a new encrypted browser tab`}
            className="inline-flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-emerald-300"
          >
            <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            Open Site
          </button>

          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`Open ${host} outside the encrypted browser`}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </motion.article>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden="true" className="divide-y divide-zinc-800/60">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex gap-4 py-4">
          <Skeleton className="h-10 w-10 flex-none rounded-lg bg-zinc-800/70" />
          <div className="min-w-0 flex-1 space-y-2.5 pt-1">
            <Skeleton className="h-4 w-3/4 bg-zinc-800/70" />
            <Skeleton className="h-3 w-2/3 bg-zinc-800/70" />
            <Skeleton className="h-3 w-1/2 bg-zinc-800/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col items-center rounded-lg border border-red-400/20 bg-red-400/5 px-6 py-10 text-center"
    >
      <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden="true" />
      <h2 className="mt-4 font-mono text-xs uppercase tracking-widest text-red-300">
        SEARCH FAILED
      </h2>
      <p className="mt-2 max-w-sm text-sm text-zinc-400">
        {message ?? "Something went wrong while contacting the relay."}
      </p>
      <Button
        type="button"
        onClick={onRetry}
        aria-label="Retry search"
        className="mt-6 border border-emerald-400/30 bg-transparent text-emerald-300 hover:bg-emerald-400/10 hover:text-emerald-200"
      >
        Retry
      </Button>
    </motion.div>
  );
}

function EmptyState({ query, safeSearch }: { query: string; safeSearch: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col items-center rounded-lg border border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center"
    >
      <div
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/60"
      >
        <Ghost className="h-7 w-7 text-zinc-500" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-zinc-100">Nothing surfaced.</h2>
      <p className="mt-2 max-w-sm text-sm text-zinc-400">
        No results for “{query}”.{" "}
        {safeSearch
          ? "Safe Search may be hiding entries — toggle the shields in the header to widen the sweep."
          : "Try different keywords or loosen the time filter."}
      </p>
    </motion.div>
  );
}
