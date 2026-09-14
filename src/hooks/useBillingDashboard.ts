// Dashboard financeiro: UMA chamada de RPC serve a tela inteira.
// Dez queries separadas fariam indicadores serem calculados em momentos
// diferentes e divergirem entre si na tela.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface RevenueByType { type: string; billed_cents: number; contracts: number }
export interface MonthlyPoint { month: string; billed_cents: number; received_cents: number }
export interface UpcomingDue {
  charge_id: string; customer_id: string; customer_name: string;
  due_date: string; amount_cents: number; status: string;
}
export interface RecentPayment {
  payment_id: string; customer_name: string; paid_at: string;
  amount_cents: number; method: string;
}
export interface RecentCharge {
  charge_id: string; customer_name: string; competence_month: string;
  due_date: string; total_cents: number; status: string; created_at: string;
}

export interface BillingDashboard {
  reference_month: string; generated_at: string;
  mrr_cents: number; billed_month_cents: number; received_month_cents: number;
  open_cents: number; overdue_cents: number; delinquency_pct: number;
  delinquent_customers: number; active_contracts: number; total_customers: number;
  revenue_by_type: RevenueByType[]; monthly_history: MonthlyPoint[];
  upcoming_due: UpcomingDue[]; recent_payments: RecentPayment[]; recent_charges: RecentCharge[];
}

export interface UseBillingDashboardResult {
  data: BillingDashboard | null;
  loading: boolean;
  /** `null` = sem erro. Texto pronto para exibir, sem detalhe interno. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useBillingDashboard(referenceMonth?: string): UseBillingDashboardResult {
  const [data, setData] = useState<BillingDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // A RPC ainda não está no `types.ts` gerado; o cast sai quando os tipos
      // forem regenerados após a migration.
      const rpc = supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data: res, error: err } = await rpc("billing_dashboard_summary", {
        _ref_month: referenceMonth ?? null,
      });
      if (err) throw new Error(err.message);
      setData((res ?? null) as BillingDashboard | null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/forbidden|permission|42501/i.test(msg)
        ? "Você não tem permissão para ver o financeiro."
        : "Não foi possível carregar o dashboard financeiro.");
      setData(null);
    } finally { setLoading(false); }
  }, [referenceMonth]);

  useEffect(() => { void load(); }, [load]);
  return { data, loading, error, refresh: load };
}
