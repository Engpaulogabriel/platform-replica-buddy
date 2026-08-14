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
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getRealtimeChannel, removeRealtimeChannel } from "@/lib/realtimeKillSwitch";
import { useAuth } from "@/contexts/AuthContext";

export interface TechnicalTelemetryAccess {
  /** true SOMENTE para platform_admin ou técnico cadastrado em platform_support. */
  canViewTechnicalTelemetry: boolean;
  /** Chave "Exibir tempos técnicos nos cards". DESLIGADA por padrão. */
  showTechnicalTimes: boolean;
  loading: boolean;
  /** Liga/desliga a chave. Só funciona para staff técnico. */
  setShowTechnicalTimes: (v: boolean) => Promise<void>;
}

const FAIL_CLOSED: TechnicalTelemetryAccess = {
  canViewTechnicalTelemetry: false,
  showTechnicalTimes: false,
  loading: true,
  setShowTechnicalTimes: async () => {},
};

const Ctx = createContext<TechnicalTelemetryAccess>(FAIL_CLOSED);

/**
 * Resolve o acesso uma única vez por usuário e distribui por contexto — evita
 * uma consulta por card. Sem Provider, o valor é `false` (falha fechada).
 */
export function TechnicalTelemetryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [canView, setCanView] = useState(false);
  const [showTimes, setShowTimes] = useState(false);   // DESLIGADA por padrão
  const [loading, setLoading] = useState(true);

  // Escrita: valida o papel no servidor e atualiza a tela na hora (sem F5).
  const setShowTechnicalTimes = useCallback(async (v: boolean) => {
    if (!user?.id) return;
    const { error } = await supabase.rpc("set_technical_display_pref", { _show: v });
    if (error) throw error;
    setShowTimes(v);
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setCanView(false); setShowTimes(false); setLoading(false);
      return;
    }
    setCanView(false); setShowTimes(false); setLoading(true);

    (async () => {
      try {
        // platform_admin OU técnico. As duas tabelas deixam o próprio usuário
        // ler a própria linha (policy `user_id = auth.uid()`).
        const [admin, support, pref] = await Promise.all([
          supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
          supabase.from("platform_support").select("user_id").eq("user_id", user.id).maybeSingle(),
          supabase.rpc("get_technical_display_pref"),
        ]);
        if (cancelled) return;
        setCanView(Boolean(admin.data) || Boolean(support.data));
        setShowTimes(pref.data === true);
        setLoading(false);
      } catch {
        if (!cancelled) { setCanView(false); setShowTimes(false); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // A chave muda sem F5, inclusive em outra aba do mesmo usuário.
  useEffect(() => {
    if (!user?.id) return;
    const ch = getRealtimeChannel(`tdp:${user.id}`)
      ?.on("postgres_changes",
        { event: "*", schema: "public", table: "technical_display_prefs",
          filter: `user_id=eq.${user.id}` },
        (payload: { new?: { show_technical_times?: boolean } }) => {
          setShowTimes(payload.new?.show_technical_times === true);
        })
      .subscribe();
    return () => { if (ch) removeRealtimeChannel(ch); };
  }, [user?.id]);

  const value: TechnicalTelemetryAccess = {
    canViewTechnicalTelemetry: canView,
    // A chave só vale para quem tem permissão. Cliente com linha ligada
    // continua sem ver nada — as duas condições precisam ser verdadeiras.
    showTechnicalTimes: canView && showTimes,
    loading,
    setShowTechnicalTimes,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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

/**
 * Tempos técnicos (idade da leitura, "sem comunicação há X", contadores).
 * Exige as DUAS coisas: ser staff técnico E ter a chave ligada. Falso por
 * padrão, para todo mundo, inclusive platform_admin.
 */
export function useShowTechnicalTimes(): boolean {
  return useContext(Ctx).showTechnicalTimes;
}

export default useCanViewTechnicalTelemetry;
