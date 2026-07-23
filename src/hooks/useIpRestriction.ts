// Verifica se o dispositivo (IP + browser) está aprovado para a fazenda padrão do usuário.
// Fluxo: se a fazenda tem `ip_restriction_enabled = true` e o IP atual NÃO está aprovado,
// o hook cria um registro em `farm_access_requests` (pending) e retorna `blocked`.
// Admin da plataforma e master managers bypassam.
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { usePlatformAdmin } from "./usePlatformAdmin";
import { supabase } from "@/integrations/supabase/client";

type Status = "checking" | "allowed" | "blocked";

async function fetchPublicIp(): Promise<string | null> {
  const providers = ["https://api.ipify.org?format=json", "https://api64.ipify.org?format=json"];
  for (const url of providers) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.ip) return String(j.ip);
    } catch { /* try next */ }
  }
  return null;
}

function parseUA(ua: string) {
  const os = /Windows NT 10/.test(ua) ? "Windows 10/11"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux" : "Desconhecido";
  const browserMatch = ua.match(/(Edg|Chrome|Firefox|Safari)\/(\d+)/);
  const browser = browserMatch ? `${browserMatch[1].replace("Edg", "Edge")} ${browserMatch[2]}` : "Desconhecido";
  const platform = /Mobi|Android|iPhone|iPad/.test(ua) ? "Mobile" : "Desktop";
  return { os, browser, platform };
}

export function useIpRestriction() {
  const { user, loading: authLoading } = useAuth();
  const { isPlatformAdmin, loading: adminLoading } = usePlatformAdmin();
  const [status, setStatus] = useState<Status>("checking");
  const [ip, setIp] = useState<string | null>(null);
  const [farmName, setFarmName] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || adminLoading) return;
    if (!user) { setStatus("checking"); return; }
    if (isPlatformAdmin) { setStatus("allowed"); return; }

    let cancelled = false;
    (async () => {
      try {
        // Admin fixo pelo email nunca é bloqueado
        if ((user.email ?? "").toLowerCase() === "contato@renovelectronics.com.br") {
          if (!cancelled) setStatus("allowed"); return;
        }

        // Master managers nunca são bloqueados
        const { data: mm } = await supabase
          .from("master_managers" as any).select("id").eq("user_id", user.id).limit(1).maybeSingle();
        if (mm) { if (!cancelled) setStatus("allowed"); return; }

        const { data: profile } = await supabase
          .from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle();
        const farmId = (profile as any)?.default_farm_id as string | undefined;
        if (!farmId) { if (!cancelled) setStatus("allowed"); return; }

        const { data: farm } = await supabase
          .from("farms").select("name, ip_restriction_enabled").eq("id", farmId).maybeSingle();
        if (cancelled) return;
        setFarmName((farm as any)?.name ?? null);
        if (!(farm as any)?.ip_restriction_enabled) { setStatus("allowed"); return; }

        const publicIp = await fetchPublicIp();
        if (cancelled) return;
        setIp(publicIp);
        // Fail-closed: se não conseguimos detectar o IP, bloqueia acesso.
        if (!publicIp) { setStatus("blocked"); return; }

        // Verifica se já está aprovado
        const { data: approved } = await supabase
          .from("farm_approved_devices" as any).select("id")
          .eq("farm_id", farmId).eq("ip_address", publicIp).limit(1).maybeSingle();

        if (approved) { setStatus("allowed"); return; }

        // Bloqueado — cria solicitação pendente (evita duplicar solicitação pendente do mesmo IP)
        const ua = navigator.userAgent;
        const { os, browser, platform } = parseUA(ua);
        const { data: existing } = await supabase
          .from("farm_access_requests" as any).select("id")
          .eq("farm_id", farmId).eq("ip_address", publicIp).eq("status", "pending").limit(1).maybeSingle();
        if (!existing) {
          await supabase.from("farm_access_requests" as any).insert({
            farm_id: farmId,
            user_id: user.id,
            user_email: user.email ?? "",
            ip_address: publicIp,
            user_agent: ua,
            os, browser, platform,
          } as any);
        }
        setStatus("blocked");
      } catch (_) {
        // Fail-closed: em caso de erro na verificação, bloqueia.
        if (!cancelled) setStatus("blocked");
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, authLoading, adminLoading, isPlatformAdmin]);

  return { status, ip, farmName };
}
