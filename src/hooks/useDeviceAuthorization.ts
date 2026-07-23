// Verifica se o dispositivo atual está autorizado para o usuário logado.
// platform_admin (Renov) bypassa a checagem.
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { usePlatformAdmin } from "./usePlatformAdmin";
import { supabase } from "@/integrations/supabase/client";
import { getDeviceInfo, type DeviceInfo } from "@/lib/deviceFingerprint";

type Status = "checking" | "authorized" | "blocked";

export function useDeviceAuthorization() {
  const { user, loading: authLoading } = useAuth();
  const { isPlatformAdmin, loading: adminLoading } = usePlatformAdmin();
  const [status, setStatus] = useState<Status>("checking");
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    if (authLoading || adminLoading) return;
    if (!user) { setStatus("checking"); return; }
    if (isPlatformAdmin) { setStatus("authorized"); return; }

    let cancelled = false;
    (async () => {
      // Autorização por dispositivo: se a flag global estiver desligada,
      // ainda assim mantém o bloqueio para usuários/fazendas já marcados
      // com controle por dispositivo. Nunca auto-libera uma máquina nova.
      try {
        const [{ data: setting }, { count: userDevicesCount }, { data: profile }] = await Promise.all([
          supabase.from("platform_settings").select("value").eq("key", "device_auth").maybeSingle(),
          supabase.from("authorized_devices").select("id", { count: "exact", head: true })
            .eq("user_id", user.id).eq("is_active", true),
          supabase.from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle(),
        ]);
        const authSetting = (setting?.value as any) ?? {};
        const globalEnabled = authSetting.enabled === true;
        const perUserEnabled = (userDevicesCount ?? 0) > 0;
        const defaultFarmId = (profile as any)?.default_farm_id as string | undefined;
        const targetedUser = Array.isArray(authSetting.user_ids) && authSetting.user_ids.includes(user.id);
        const targetedFarm = !!defaultFarmId && Array.isArray(authSetting.farm_ids) && authSetting.farm_ids.includes(defaultFarmId);
        if (!globalEnabled && !perUserEnabled && !targetedUser && !targetedFarm) {
          if (!cancelled) setStatus("authorized");
          return;
        }
      } catch (_) {
        if (!cancelled) setStatus("authorized");
        return;
      }

      try {
        const info = await getDeviceInfo();
        if (cancelled) return;
        setDeviceInfo(info);
        const { data: existing } = await supabase
          .from("authorized_devices")
          .select("id, is_active")
          .eq("user_id", user.id)
          .eq("device_fingerprint", info.fingerprint)
          .maybeSingle();

        if (existing) {
          // Só bloqueia se o dispositivo existe E foi explicitamente revogado (is_active=false)
          if (existing.is_active === false) {
            await supabase.from("device_access_attempts").insert({
              user_id: user.id,
              device_fingerprint: info.fingerprint,
              device_info: {
                browser: info.browser,
                os: info.os,
                device_type: info.device_type,
                screen: info.screen,
                timezone: info.timezone,
                language: info.language,
              },
              status: "blocked",
            });
            await supabase.from("device_audit_log").insert({
              action: "attempt_blocked",
              actor_id: user.id,
              target_user_id: user.id,
              details: { fingerprint_short: info.short, reason: "revoked" },
            });
            setStatus("blocked");
            return;
          }
          await supabase
            .from("authorized_devices")
            .update({ last_used_at: new Date().toISOString() })
            .eq("id", existing.id);
          setStatus("authorized");
          return;
        }

        // Dispositivo desconhecido: NÃO auto-registra. Bloqueia, mostra o código
        // e registra a solicitação para aprovação manual na plataforma.
        const { count: existingAttemptCount } = await supabase
          .from("device_access_attempts")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("device_fingerprint", info.fingerprint)
          .eq("status", "blocked");

        if ((existingAttemptCount ?? 0) === 0) await supabase.from("device_access_attempts").insert({
          user_id: user.id,
          device_fingerprint: info.fingerprint,
          device_info: {
            browser: info.browser,
            os: info.os,
            device_type: info.device_type,
            screen: info.screen,
            timezone: info.timezone,
            language: info.language,
            ua: info.ua,
          },
          status: "blocked",
        });
        await supabase.from("device_audit_log").insert({
          action: "attempt_blocked",
          actor_id: user.id,
          target_user_id: user.id,
          details: { fingerprint_short: info.short, reason: "unregistered" },
        });
        setStatus("blocked");

      } catch (err) {
        console.error("[deviceAuth] erro", err);
        // Segurança: em falha de fingerprint/checagem, não libera acesso direto.
        setStatus("blocked");
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, authLoading, adminLoading, isPlatformAdmin]);

  return { status, deviceInfo, isPlatformAdmin };
}
