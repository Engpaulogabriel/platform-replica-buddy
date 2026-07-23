// F2 — Fingerprint mismatch detection.
// Ao voltar aba (visibilitychange -> visible), recalcula o fingerprint e
// compara com o gravado em active_sessions.device_fp. Diferenças acima do
// limiar disparam logout + alerta.

import { supabase } from "@/integrations/supabase/client";
import { getDeviceInfo } from "@/lib/deviceFingerprint";

const MISMATCH_LIMIT = 2;

let started = false;
let lastCheck = 0;
const MIN_INTERVAL = 5 * 60_000;

export function startFingerprintGuard(
  sessionId: string,
  userId: string,
  onMismatch: () => void,
) {
  if (started) return;
  started = true;

  const check = async () => {
    if (Date.now() - lastCheck < MIN_INTERVAL) return;
    lastCheck = Date.now();
    try {
      const [{ fingerprint }, sess] = await Promise.all([
        getDeviceInfo(),
        supabase
          .from("active_sessions")
          .select("device_fp, fingerprint_mismatch_count")
          .eq("session_id", sessionId)
          .maybeSingle(),
      ]);
      if (sess.error) {
        console.warn("[AUTH] fingerprint_check ignored after query error", sess.error.message);
        return;
      }
      if (!sess.data) return;
      const stored = (sess.data as any).device_fp as string | null;
      const mismatchCount = ((sess.data as any).fingerprint_mismatch_count as number) ?? 0;
      if (!stored) return;

      if (stored !== fingerprint) {
        const next = mismatchCount + 1;
        const { error: updateError } = await supabase
          .from("active_sessions")
          .update({
            fingerprint_mismatch_count: next,
            last_fingerprint_check: new Date().toISOString(),
          } as any)
          .eq("session_id", sessionId);
        if (updateError) {
          console.warn("[AUTH] fingerprint_mismatch ignored after update error", updateError.message);
          return;
        }
        if (next >= MISMATCH_LIMIT) {
          try {
            await supabase.from("security_alerts").insert({
              alert_type: "fingerprint_mismatch",
              severity: "high",
              details: {
                user_id: userId,
                session_id: sessionId,
                stored_fp: stored.slice(-8),
                current_fp: fingerprint.slice(-8),
                mismatch_count: next,
                user_agent: navigator.userAgent,
              } as any,
            } as any);
          } catch { /* noop */ }
          onMismatch();
        }
      } else {
        const { error: updateError } = await supabase
          .from("active_sessions")
          .update({ last_fingerprint_check: new Date().toISOString() } as any)
          .eq("session_id", sessionId);
        if (updateError) {
          console.warn("[AUTH] fingerprint_check timestamp update ignored after error", updateError.message);
        }
      }
    } catch (error) {
      console.warn("[AUTH] fingerprint_check ignored after network error", error);
    }
  };

  const onVisibility = () => { if (document.visibilityState === "visible") void check(); };
  document.addEventListener("visibilitychange", onVisibility);
  // Primeira verificação após pequeno delay
  window.setTimeout(() => void check(), 5000);

  (startFingerprintGuard as any)._cleanup = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    started = false;
  };
}

export function stopFingerprintGuard() {
  const cleanup = (startFingerprintGuard as any)._cleanup as (() => void) | undefined;
  cleanup?.();
}
