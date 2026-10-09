/**
 * SPECTER — Next.js instrumentation hook (runs once per server boot).
 *
 * Delegates to the Node-only relay supervisor (src/lib/relay-supervisor.ts)
 * which keeps the bare relay mini-service (:3030) alive as a child of the
 * Next.js server process. The Edge bundle never executes it — the runtime
 * guard below is what keeps Turbopack honest.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SPECTER_NO_RELAY === "1") return;
  const { startRelaySupervisor } = await import("@/lib/relay-supervisor");
  startRelaySupervisor();
}
