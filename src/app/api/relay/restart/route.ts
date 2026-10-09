import { NextResponse } from "next/server";
import { restartRelay } from "@/lib/relay-supervisor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Deliberately restarts the bare relay (:3030) and waits for it to be
 * healthy again. Used ONLY by the in-product compatibility suite's
 * recovery drill ("relay restart → tabs recover without a browser
 * restart"). Same-origin only, nothing logged.
 */
export async function POST() {
  try {
    const result = await restartRelay();
    if (!result.ok) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "restart failed" },
      { status: 500 }
    );
  }
}
