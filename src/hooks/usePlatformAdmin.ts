// usePlatformAdmin — verifica se o usuário logado é super-admin global da plataforma
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export function usePlatformAdmin(): { isPlatformAdmin: boolean; loading: boolean } {
  const { user } = useAuth();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) { setIsPlatformAdmin(false); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void supabase
      .from("profiles" as any)
      .select("is_super_admin")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        const profile = data as { is_super_admin?: boolean } | null;
        setIsPlatformAdmin(!error && profile?.is_super_admin === true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [user?.id]);

  return { isPlatformAdmin, loading };
}
