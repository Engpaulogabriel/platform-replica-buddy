// Dashboard Financeiro — SPRINT 1.
// Só leitura, só billing_*. Nenhuma ação de cobrança, pagamento, PIX, bloqueio,
// NF ou régua: esta Sprint entrega exclusivamente a visão.
import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertTriangle, CalendarClock, CircleDollarSign, FileText, Inbox,
  RefreshCw, TrendingUp, Users, Wallet,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useBillingDashboard, type BillingDashboard as Dados } from "@/hooks/useBillingDashboard";
import {
  BILLING_TYPE_LABEL, CHARGE_STATUS_CLASS, CHARGE_STATUS_LABEL,
  centsToBRL, centsToCompactBRL, dateBR, dateTimeBR, monthLabel, pctBR,
} from "@/lib/billingFormat";

// ── Peças reutilizáveis ────────────────────────────────────────────────────
interface IndicadorProps {
  titulo: string; valor: string; Icon: typeof Wallet;
  detalhe?: string; destaque?: "normal" | "alerta" | "positivo";
}
export const IndicadorCard = memo(function IndicadorCard(
  { titulo, valor, Icon, detalhe, destaque = "normal" }: IndicadorProps,
) {
  const cor = destaque === "alerta" ? "text-destructive"
    : destaque === "positivo" ? "text-primary" : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{titulo}</p>
            <p className={`text-2xl font-bold truncate ${cor}`}>{valor}</p>
            {detalhe && <p className="text-xs text-muted-foreground mt-1 truncate">{detalhe}</p>}
          </div>
          <Icon className={`w-5 h-5 shrink-0 ${cor}`} />
        </div>
      </CardContent>
    </Card>
  );
});

/** Estado vazio: diz o que está faltando, não só "sem dados". */
export const Vazio = memo(function Vazio({ mensagem }: { mensagem: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
      <Inbox className="w-8 h-8 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">{mensagem}</p>
    </div>
  );
});

const SkeletonDashboard = () => (
  <div className="space-y-6" data-testid="billing-skeleton">
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-28 w-full" />)}
    </div>
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
      <Skeleton className="h-72 w-full lg:col-span-2" />
      <Skeleton className="h-72 w-full" />
    </div>
    <Skeleton className="h-64 w-full" />
  </div>
);

const CORES = ["hsl(var(--info))", "hsl(var(--primary))", "hsl(var(--warning))",
               "hsl(var(--muted-foreground))", "hsl(var(--destructive))"];

// ── Tela ───────────────────────────────────────────────────────────────────
export function BillingDashboard({ referenceMonth }: { referenceMonth?: string }) {
  const { data, loading, error, refresh } = useBillingDashboard(referenceMonth);

  if (loading) return <SkeletonDashboard />;

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="pt-6 flex flex-col items-center gap-3 text-center">
          <AlertTriangle className="w-8 h-8 text-destructive" />
          <p className="text-sm text-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="w-4 h-4 mr-2" />Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) return <Vazio mensagem="Nenhum dado financeiro disponível." />;

  const d: Dados = data;
  const semMovimento = d.billed_month_cents === 0 && d.received_month_cents === 0
    && d.open_cents === 0 && d.active_contracts === 0;

  const historico = d.monthly_history.map((m) => ({
    mes: monthLabel(m.month),
    Faturado: m.billed_cents / 100,
    Recebido: m.received_cents / 100,
  }));
  const porTipo = d.revenue_by_type
    .filter((t) => t.billed_cents > 0)
    .map((t) => ({ nome: BILLING_TYPE_LABEL[t.type] ?? t.type, valor: t.billed_cents / 100 }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Dashboard Financeiro</h2>
          <p className="text-xs text-muted-foreground">
            Referência {monthLabel(d.reference_month)} · atualizado em {dateTimeBR(d.generated_at)}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="w-4 h-4 mr-2" />Atualizar
        </Button>
      </div>

      {semMovimento && (
        <Card><CardContent className="pt-6">
          <Vazio mensagem="Ainda não há movimento financeiro. Importe a carteira para começar." />
        </CardContent></Card>
      )}

      {/* Indicadores */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <IndicadorCard titulo="MRR" valor={centsToBRL(d.mrr_cents)} Icon={TrendingUp}
          detalhe={`${d.active_contracts} contrato(s) ativo(s)`} destaque="positivo" />
        <IndicadorCard titulo="Faturado no mês" valor={centsToBRL(d.billed_month_cents)}
          Icon={FileText} detalhe="por competência" />
        <IndicadorCard titulo="Recebido no mês" valor={centsToBRL(d.received_month_cents)}
          Icon={Wallet} detalhe="por data de pagamento" destaque="positivo" />
        <IndicadorCard titulo="Em aberto" valor={centsToBRL(d.open_cents)} Icon={CircleDollarSign}
          detalhe="saldo a receber" />
        <IndicadorCard titulo="Vencido" valor={centsToBRL(d.overdue_cents)} Icon={AlertTriangle}
          detalhe="saldo em atraso" destaque={d.overdue_cents > 0 ? "alerta" : "normal"} />
        <IndicadorCard titulo="Inadimplência" valor={pctBR(d.delinquency_pct)} Icon={AlertTriangle}
          detalhe="vencido ÷ faturado do mês"
          destaque={d.delinquency_pct > 0 ? "alerta" : "normal"} />
        <IndicadorCard titulo="Clientes inadimplentes" valor={String(d.delinquent_customers)}
          Icon={Users} detalhe={`de ${d.total_customers} ativo(s)`}
          destaque={d.delinquent_customers > 0 ? "alerta" : "normal"} />
        <IndicadorCard titulo="Contratos ativos" valor={String(d.active_contracts)}
          Icon={CalendarClock} detalhe="base do MRR" />
      </div>

      {/* Gráficos */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Receita × Recebimento — 12 meses</CardTitle></CardHeader>
          <CardContent>
            {historico.length === 0 ? <Vazio mensagem="Sem histórico ainda." /> : (
              <div className="w-full h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={historico}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                    <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }}
                      tickFormatter={(v: number) => centsToCompactBRL(v * 100)} width={70} />
                    <Tooltip formatter={(v: number) => centsToBRL(v * 100)} />
                    <Legend />
                    <Bar dataKey="Faturado" fill="hsl(var(--info))" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Recebido" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Receita por tipo</CardTitle></CardHeader>
          <CardContent>
            {porTipo.length === 0 ? <Vazio mensagem="Sem receita no mês de referência." /> : (
              <div className="w-full h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={porTipo} dataKey="valor" nameKey="nome" innerRadius={45} outerRadius={80}>
                      {porTipo.map((_, i) => <Cell key={i} fill={CORES[i % CORES.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: number) => centsToBRL(v * 100)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Listas */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">Próximos vencimentos</CardTitle></CardHeader>
          <CardContent className="p-0">
            {d.upcoming_due.length === 0 ? <Vazio mensagem="Nenhum vencimento a caminho." /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Cliente</TableHead><TableHead>Vence</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {d.upcoming_due.map((c) => (
                      <TableRow key={c.charge_id}>
                        <TableCell className="max-w-[160px] truncate">{c.customer_name}</TableCell>
                        <TableCell className="whitespace-nowrap">{dateBR(c.due_date)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{centsToBRL(c.amount_cents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Últimos pagamentos</CardTitle></CardHeader>
          <CardContent className="p-0">
            {d.recent_payments.length === 0 ? <Vazio mensagem="Nenhum pagamento registrado." /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Cliente</TableHead><TableHead>Data</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {d.recent_payments.map((p) => (
                      <TableRow key={p.payment_id}>
                        <TableCell className="max-w-[160px] truncate">{p.customer_name}</TableCell>
                        <TableCell className="whitespace-nowrap">{dateTimeBR(p.paid_at)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap text-primary">
                          {centsToBRL(p.amount_cents)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Últimas cobranças</CardTitle></CardHeader>
          <CardContent className="p-0">
            {d.recent_charges.length === 0 ? <Vazio mensagem="Nenhuma cobrança gerada." /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Cliente</TableHead><TableHead>Status</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {d.recent_charges.map((c) => (
                      <TableRow key={c.charge_id}>
                        <TableCell className="max-w-[140px] truncate">{c.customer_name}</TableCell>
                        <TableCell>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${
                            CHARGE_STATUS_CLASS[c.status] ?? "bg-secondary text-muted-foreground"}`}>
                            {CHARGE_STATUS_LABEL[c.status] ?? c.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">{centsToBRL(c.total_cents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default BillingDashboard;
