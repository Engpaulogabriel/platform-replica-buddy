// MasterManagerContext — carrega, na sessão, a identidade e permissões
// do Gestor Master (se aplicável). Não afeta nenhum outro perfil (admin/owner/etc.):
// para usuários que NÃO são master managers, isMasterManager = false e
// todas as permissões retornam true (comportamento inalterado).
import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface MasterManagerRecord {
  id: string;
  user_id: string;
  full_name: string;
  cpf: string | null;
  email: string;
  whatsapp: string | null;
  status: string;
  must_change_password?: boolean;
}

export interface MasterManagerPermissions {
  can_view_dashboard: boolean;
  can_view_reports: boolean;
  can_command_pumps: boolean;
  can_edit_schedules: boolean;
  can_manage_maintenance: boolean;
  can_view_financial: boolean;
  can_view_indicators: boolean;
  can_manage_operational_users: boolean;
}

export interface MasterManagerFarm {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

interface MasterManagerContextType {
  loading: boolean;
  isMasterManager: boolean;
  manager: MasterManagerRecord | null;
  permissions: MasterManagerPermissions;
  farms: MasterManagerFarm[];
  mustChangePassword: boolean;
  refresh: () => Promise<void>;
}

// Default: tudo liberado (usuários normais não são afetados)
const FULL_PERMISSIONS: MasterManagerPermissions = {
  can_view_dashboard: true,
  can_view_reports: true,
  can_command_pumps: true,
  can_edit_schedules: true,
  can_manage_maintenance: true,
  can_view_financial: true,
  can_view_indicators: true,
  can_manage_operational_users: true,
};

const MasterManagerContext = createContext<MasterManagerContextType>({
  loading: false,
  isMasterManager: false,
  manager: null,
  permissions: FULL_PERMISSIONS,
  farms: [],
  mustChangePassword: false,
  refresh: async () => {},
});

export function MasterManagerProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [manager, setManager] = useState<MasterManagerRecord | null>(null);
  const [permissions, setPermissions] = useState<MasterManagerPermissions>(FULL_PERMISSIONS);
  const [farms, setFarms] = useState<MasterManagerFarm[]>([]);

  const load = useCallback(async () => {
    if (!user?.id) {
      setManager(null);
      setPermissions(FULL_PERMISSIONS);
      setFarms([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data: mgr } = await supabase
        .from("master_managers" as any)
        .select("id, user_id, full_name, cpf, email, whatsapp, status, must_change_password")
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle();

      if (!mgr) {
        setManager(null);
        setPermissions(FULL_PERMISSIONS);
        setFarms([]);
        return;
      }

      const managerRow = mgr as unknown as MasterManagerRecord;
      setManager(managerRow);

      const [{ data: perms }, { data: farmLinks }] = await Promise.all([
        supabase
          .from("master_manager_permissions" as any)
          .select(
            "can_view_dashboard, can_view_reports, can_command_pumps, can_edit_schedules, can_manage_maintenance, can_view_financial, can_view_indicators, can_manage_operational_users",
          )
          .eq("manager_id", managerRow.id)
          .maybeSingle(),
        supabase
          .from("master_manager_farms" as any)
          .select("farm_id, farms(id, name, city, state)")
          .eq("manager_id", managerRow.id),
      ]);

      setPermissions({
        can_view_dashboard: (perms as any)?.can_view_dashboard ?? true,
        can_view_reports: (perms as any)?.can_view_reports ?? true,
        can_command_pumps: (perms as any)?.can_command_pumps ?? false,
        can_edit_schedules: (perms as any)?.can_edit_schedules ?? false,
        can_manage_maintenance: (perms as any)?.can_manage_maintenance ?? false,
        can_view_financial: (perms as any)?.can_view_financial ?? false,
        can_view_indicators: (perms as any)?.can_view_indicators ?? false,
        can_manage_operational_users: (perms as any)?.can_manage_operational_users ?? false,
      });

      const list: MasterManagerFarm[] = [];
      const seen = new Set<string>();
      for (const link of (farmLinks ?? []) as any[]) {
        const f = link.farms as MasterManagerFarm | null;
        if (f && !seen.has(f.id)) {
          list.push(f);
          seen.add(f.id);
        }
      }
      setFarms(list);
    } catch (err) {
      console.error("[MasterManager] load failed:", err);
      setManager(null);
      setPermissions(FULL_PERMISSIONS);
      setFarms([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (authLoading) return;
    void load();
  }, [authLoading, load]);

  return (
    <MasterManagerContext.Provider
      value={{
        loading,
        isMasterManager: !!manager,
        manager,
        permissions,
        farms,
        mustChangePassword: !!manager && manager.must_change_password === true,
        refresh: load,
      }}
    >
      {children}
    </MasterManagerContext.Provider>
  );
}

export function useMasterManager() {
  return useContext(MasterManagerContext);
}

/**
 * Hook prático para checar permissões.
 * - Retorna true para todos os usuários que NÃO são Gestor Master.
 * - Para Gestor Master, aplica as flags configuradas pelo super-admin.
 */
export function usePermission(key: keyof MasterManagerPermissions): boolean {
  const { isMasterManager, permissions } = useMasterManager();
  if (!isMasterManager) return true;
  return !!permissions[key];
}
