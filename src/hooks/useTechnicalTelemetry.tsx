// Autorização ÚNICA para telemetria técnica de comunicação.
// ---------------------------------------------------------------------------
// Só duas pessoas podem ver idade de leitura, horário, latência, RX/TX, sinal
// e saúde do Realtime:
//
//   • platform_admin  → tabela `platform_admins`  (is_platform_admin)
//   • técnico         → tabela `platform_support` (is_platform_support)
//
// Esses são os mecanismos REAIS do projeto — não foi criada role nova. O enum
// `app_role` do banco (owner|admin|operator|viewer|supervisor) NÃO tem técnico;
// quem é técnico está em `platform_support`, que já alimenta `is_platform_staff`.
//
// owner, admin de fazenda, supervisor, gestor, operador e viewer NÃO veem nada
// disso — nem badge, nem tooltip, nem title, nem aria-label.
//
// FALHA FECHADA: enquanto carrega, e em qualquer erro, o valor é `false`. Se a
// consulta falhar, o usuário comum não passa a ver dado técnico por acidente.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface TechnicalTelemetryAccess {
  /** true SOMENTE para platform_admin ou técnico cadastrado em platform_support. */
  canViewTechnicalTelemetry: boolean;
  loading: boolean;
}

const FAIL_CLOSED: TechnicalTelemetryAccess = {
  canViewTechnicalTelemetry: false,
  loading: true,
};

const Ctx = createContext<TechnicalTelemetryAccess>(FAIL_CLOSED);

/**
 * Resolve o acesso uma única vez por usuário e distribui por contexto — evita
 * uma consulta por card. Sem Provider, o valor é `false` (falha fechada).
 */
export function TechnicalTelemetryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<TechnicalTelemetryAccess>(FAIL_CLOSED);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setState({ canViewTechnicalTelemetry: false, loading: false });
      return;
    }
    setState(FAIL_CLOSED);
    (async () => {
      try {
        // platform_admin OU técnico. As duas tabelas deixam o próprio usuário
        // ler a própria linha (policy `user_id = auth.uid()`).
        const [admin, support] = await Promise.all([
          supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
          supabase.from("platform_support").select("user_id").eq("user_id", user.id).maybeSingle(),
        ]);
        if (cancelled) return;
        setState({
          canViewTechnicalTelemetry: Boolean(admin.data) || Boolean(support.data),
          loading: false,
        });
      } catch {
        if (!cancelled) setState({ canViewTechnicalTelemetry: false, loading: false });
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** Acesso completo (inclui `loading`). */
export function useTechnicalTelemetryAccess(): TechnicalTelemetryAccess {
  return useContext(Ctx);
}

/**
 * Atalho booleano — é o que os componentes usam para decidir se CRIAM o
 * elemento no DOM. Nunca use CSS para esconder: o elemento não deve existir.
 */
export function useCanViewTechnicalTelemetry(): boolean {
  return useContext(Ctx).canViewTechnicalTelemetry;
}

export default useCanViewTechnicalTelemetry;
