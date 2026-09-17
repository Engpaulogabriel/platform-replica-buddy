import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type PlatformRole = "admin" | null;

export function usePlatformAccess() {
  const { user } = useAuth();
  const [role, setRole] = useState<PlatformRole>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) { setRole(null); setIsSuperAdmin(false); setLoading(false); return; }
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("profiles" as any)
        .select("is_super_admin")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled) return;
      const profile = data as { is_super_admin?: boolean } | null;
      const superAdmin = !error && profile?.is_super_admin === true;
      setIsSuperAdmin(superAdmin);
      setRole(superAdmin ? "admin" : null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  return {
    role,
    loading,
    isSuperAdmin,
    isAdmin: isSuperAdmin,
    isOwner: isSuperAdmin,
    isStaff: isSuperAdmin,
  };
}
