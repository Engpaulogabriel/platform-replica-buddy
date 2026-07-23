// useFarmAccess — resolve a role do usuário na fazenda atualmente ativa
// e expõe flags de permissão para gating de UI. NÃO substitui RLS — é só
// para esconder/mostrar botões. RLS continua sendo a fonte da verdade.
//
// Hierarquia atual (3 perfis + platform):
//   platform_admin (Renov)         → TUDO, inclusive /platform
//   owner          (Administrador) → TUDO da fazenda (financeiro + automático),
//                                    MAS NÃO cria/edita/remove usuários (só Renov)
//   supervisor     (Supervisor)    → operar + editar config + automático,
//                                    SEM acesso a páginas financeiras (ROI)
//   operator       (Operador)      → só comandar bombas; SEM Automático e SEM financeiro
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

export type FarmRole = "platform_admin" | "owner" | "supervisor" | "operator" | null;

export interface FarmAccess {
  role: FarmRole;
  loading: boolean;
  isPlatformAdmin: boolean;
  /** Apenas platform_admin pode deletar qualquer coisa. */
  canDelete: boolean;
  /** Ligar/desligar bombas. */
  canCommand: boolean;
  /** Ver relatórios completos. */
  canViewReports: boolean;
  /** Criar/editar/remover usuários da fazenda. SOMENTE Renov (platform_admin). */
  canManageMembers: boolean;
  /** Editar cadastros (PLCs, equipamentos, setores, schedules). */
  canEditConfig: boolean;
  /** Acessar página /automatico (operator NÃO pode). */
  canAccessAutomation: boolean;
  /** Ver ROI e qualquer página financeira (/produtividade, ROI em /indicadores). */
  canViewFinancial: boolean;
}

export function useFarmAccess(): FarmAccess {
  const { user } = useAuth();
  const farmId = useDefaultFarmId();
  const [role, setRole] = useState<FarmRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) { setRole(null); setLoading(false); return; }
    setLoading(true);
    (async () => {
      // 1) platform_admin sobrepõe tudo
      const { data: pa } = await supabase
        .from("platform_admins")
        .select("user_id").eq("user_id", user.id).maybeSingle();
      if (cancelled) return;
      if (pa) { setRole("platform_admin"); setLoading(false); return; }

      // 2) role na fazenda ativa
      if (!farmId) { setRole(null); setLoading(false); return; }
      const { data: ur } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("farm_id", farmId)
        .maybeSingle();
      if (cancelled) return;
      const raw = (ur?.role as string | undefined) ?? null;
      // Compat: papéis legados que possam ter sobrado no banco
      const mapped: FarmRole =
        raw === "admin" ? "owner" :
        raw === "viewer" ? "operator" :
        (raw as FarmRole) ?? null;
      setRole(mapped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user?.id, farmId]);

  const isPlatformAdmin = role === "platform_admin";
  const canCommand = isPlatformAdmin || role === "owner" || role === "supervisor" || role === "operator";
  const canEditConfig = isPlatformAdmin || role === "owner" || role === "supervisor";
  const canViewReports = isPlatformAdmin || role === "owner" || role === "supervisor";
  // IMPORTANTE: Administrador (owner) NÃO pode gerir usuários — só a Renov.
  const canManageMembers = isPlatformAdmin;
  const canDelete = isPlatformAdmin;
  const canAccessAutomation = isPlatformAdmin || role === "owner" || role === "supervisor";
  const canViewFinancial = isPlatformAdmin || role === "owner";

  return {
    role, loading, isPlatformAdmin,
    canDelete, canCommand, canViewReports, canManageMembers, canEditConfig,
    canAccessAutomation, canViewFinancial,
  };
}
