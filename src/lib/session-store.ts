/**
 * SPECTER — volatile session store.
 * Session keys live in RAM ONLY. Nothing is written to disk, no logs are kept.
 * Sessions self-destruct after 24h of inactivity or on server restart.
 *
 * IMPORTANT: the Map is stored on globalThis so every Next.js route bundle
 * (dev compiles each route separately) shares the exact same store.
 */

import { importKey } from "@/lib/crypto";

export interface Session {
  id: string;
  key: CryptoKey;
  createdAt: number;
  lastSeen: number;
  queryCount: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_SESSIONS = 500;

type SessionMap = Map<string, Session>;
type WindowMap = Map<string, number[]>;

interface SpecterGlobal {
  __specterSessions?: SessionMap;
  __specterWindows?: WindowMap;
  __specterSweeper?: boolean;
}

const g = globalThis as unknown as SpecterGlobal;
const sessions: SessionMap = (g.__specterSessions ??= new Map());
const windows: WindowMap = (g.__specterWindows ??= new Map());

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}

export async function createSessionFromKey(rawKeyBase64: string): Promise<Session | null> {
  prune();
  if (sessions.size >= MAX_SESSIONS) return null;
  const key = await importKey(rawKeyBase64);
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(18));
  const id = Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("");
  const session: Session = {
    id,
    key,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    queryCount: 0,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string | null | undefined): Session | null {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  const now = Date.now();
  if (now - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  session.lastSeen = now;
  return session;
}

export function destroySession(id: string): boolean {
  return sessions.delete(id);
}

export function touchSession(session: Session) {
  session.lastSeen = Date.now();
  session.queryCount += 1;
}

/**
 * Sliding-window rate limiter. Returns ms to wait, or 0 when allowed.
 */
export function rateLimit(key: string, limit: number, windowMs = 60_000): number {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return windowMs - (now - hits[0]);
  }
  hits.push(now);
  windows.set(key, hits);
  return 0;
}

// Periodic sweep so memory stays bounded even without traffic.
export function ensureSweeper() {
  if (g.__specterSweeper) return;
  g.__specterSweeper = true;
  const timer = setInterval(() => prune(), 10 * 60 * 1000);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }
}
