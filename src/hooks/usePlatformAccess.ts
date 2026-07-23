import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type PlatformRole = "admin" | "support" | null;

export function usePlatformAccess() {
  const { user } = useAuth();
  const [role, setRole] = useState<PlatformRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) { setRole(null); setLoading(false); return; }
    setLoading(true);
    (async () => {
      const [admin, support] = await Promise.all([
        supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
        supabase.from("platform_support" as any).select("user_id").eq("user_id", user.id).maybeSingle(),
      ]);
      if (cancelled) return;
      if (admin.data) setRole("admin");
      else if (support.data) setRole("support");
      else setRole(null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  return { role, loading, isAdmin: role === "admin", isStaff: role !== null };
}
