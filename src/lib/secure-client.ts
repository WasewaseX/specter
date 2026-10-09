"use client";

/**
 * SPECTER — client-side secure transport.
 * Seals request payloads and opens response envelopes with the session key.
 */

import { open as openEnvelope, seal, type SealedEnvelope } from "@/lib/crypto";

export async function securePost<TResponse>(
  key: CryptoKey,
  sid: string,
  path: string,
  payload: unknown
): Promise<{ ok: boolean; status: number; data?: TResponse; raw?: unknown }> {
  const envelope = await seal(key, payload);
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    referrerPolicy: "no-referrer",
    body: JSON.stringify({ sid, iv: envelope.iv, data: envelope.data }),
  });

  const body = (await res.json()) as SealedEnvelope & { error?: string };
  if (!body || !body.iv || !body.data) {
    return { ok: false, status: res.status, raw: body };
  }
  try {
    const data = await openEnvelope<TResponse>(key, { iv: body.iv, data: body.data });
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: res.status, raw: body };
  }
}

/** Build the iframe src for the Ghost Viewer: the URL (and script mode) travels sealed. */
export function buildProxySrc(
  key: CryptoKey,
  sid: string,
  url: string,
  cacheBust = false,
  js = false
): Promise<string> {
  return seal(key, { u: url, js }).then((envelope) => {
    const e = encodeURIComponent(envelope.data);
    const iv = encodeURIComponent(envelope.iv);
    const r = cacheBust ? `&r=${Date.now()}` : "";
    return `/api/open?sid=${encodeURIComponent(sid)}&e=${e}&iv=${iv}${r}`;
  });
}

/** Extract + decrypt the real URL from a /api/open location string. */
export async function unsealProxyLocation(
  key: CryptoKey,
  locationHref: string
): Promise<string | null> {
  try {
    const u = new URL(locationHref, window.location.origin);
    if (!u.pathname.startsWith("/api/open")) return null;
    const data = u.searchParams.get("e");
    const iv = u.searchParams.get("iv");
    if (!data || !iv) return null;
    const payload = await openEnvelope<{ u: string }>(key, { data, iv });
    return payload.u;
  } catch {
    return null;
  }
}
