// ─────────────────────────────────────────────────────────────────────────────
// BridgeConsole — status do agente Renov Tecnologia Agrícola (headless service)
// ─────────────────────────────────────────────────────────────────────────────
// Esta tela consulta a tabela `site_health` no Supabase para mostrar o estado
// do agente headless instalado no PC da fazenda. O agente faz upsert a cada
// 30s. Regras de classificação:
//   • last_heartbeat < 60s   → 🟢 Online
//   • 60s a 300s             → 🟡 Instável
//   • > 300s ou sem registro → 🔴 Offline

import { Cable, Cpu, Activity, AlertTriangle, Download, CheckCircle2, XCircle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSiteHealth, formatAge, type AgentHealthState } from "@/hooks/useSiteHealth";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useCommandQueueStatus } from "@/hooks/useCommandQueueStatus";
import { useAgentActivity } from "@/hooks/useAgentActivity";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import AgentLiveLogs from "@/components/bridge/AgentLiveLogs";
import RemoteBridgeControl from "@/components/bridge/RemoteBridgeControl";
import { BridgeRebootButton } from "@/components/bridge/BridgeRebootButton";

export default function BridgeConsole() {
  const farmId = useDefaultFarmId();
  const health = useSiteHealth(farmId);
  const queue = useCommandQueueStatus(farmId);
  const activity = useAgentActivity(farmId);
  const { role, isPlatformAdmin } = useFarmAccess();
  const canReboot = isPlatformAdmin || role === "owner";

  // Fallback: se o heartbeat estiver stale mas houver atividade real recente
  // (logs/respostas de comandos nos últimos 120s), considera o agente vivo.
  // Enquanto qualquer um dos dois ainda estiver carregando, evita mostrar OFFLINE prematuro.
  const stillLoading = health.loading || activity.loading;

  const effectiveState: AgentHealthState =
    stillLoading ? "unstable"
    : health.state === "online" ? "online"
    : activity.isLive ? "online"
    : health.state;

  const effectiveAgeSeconds =
    activity.isLive && activity.ageSeconds != null
      ? Math.min(activity.ageSeconds, health.ageSeconds ?? activity.ageSeconds)
      : health.ageSeconds;

  const effectiveLastBeat =
    activity.isLive && activity.lastActivityAt
      ? (health.lastHeartbeat && health.lastHeartbeat > activity.lastActivityAt
          ? health.lastHeartbeat
          : activity.lastActivityAt)
      : health.lastHeartbeat;

  const effectiveComConnected = health.comConnected || activity.isLive;


  const STATE_META = {
    online:   { label: "ONLINE",   color: "bg-primary/10 text-primary border-primary/30",                Icon: CheckCircle2 },
    unstable: { label: stillLoading ? "VERIFICANDO…" : "INSTÁVEL", color: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30", Icon: Clock },
    offline:  { label: "OFFLINE",  color: "bg-destructive/10 text-destructive border-destructive/30",     Icon: XCircle },
  } as const;
  const stateMeta = STATE_META[effectiveState] ?? STATE_META.offline;
  const StateIcon = stateMeta.Icon;

  const uptimeStr = (() => {
    const s = health.uptimeSeconds;
    if (!s) return "—";
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    if (h > 0) return `${h}h ${m}min`;
    if (m > 0) return `${m}min`;
    return `${s}s`;
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Cable className="h-6 w-6 text-primary" /> Bridge Serial — Status do Agente
        </h1>
        <p className="text-sm text-muted-foreground">
          Monitor do agente <strong>Renov Tecnologia Agrícola</strong> — serviço headless instalado no PC da fazenda que faz a ponte entre o interface web e o Servidor RS-232.
        </p>
      </div>

      {/* Card de status principal */}
      <div className={`rounded-xl border-2 p-6 ${stateMeta.color}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <StateIcon className="h-12 w-12" />
            <div>
              <div className="text-3xl font-bold tracking-tight">{stateMeta.label}</div>
              <div className="text-sm opacity-80 mt-1">
                {health.loading ? "Consultando…" : (
                  <>
                    Última atividade: <span className="font-mono">{formatAge(effectiveAgeSeconds)}</span>
                    {effectiveLastBeat && !isNaN(effectiveLastBeat.getTime()) && (
                      <span className="opacity-60 ml-2">({effectiveLastBeat.toLocaleTimeString("pt-BR")})</span>
                    )}
                    {effectiveState === "online" && health.state !== "online" && (
                      <span className="block text-xs opacity-70 mt-0.5">
                        🔄 detectado por logs/comandos recentes (heartbeat travado)
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <Badge variant="outline" className="font-mono text-xs">
            v{health.agentVersion ?? "?"}
          </Badge>
        </div>

        {health.lastError && (
          <div className="mt-4 rounded-lg bg-background/40 border border-destructive/30 p-3 flex items-start gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-destructive">Último erro reportado pelo agente</div>
              <div className="text-xs opacity-80 mt-0.5">{health.lastError}</div>
            </div>
          </div>
        )}
      </div>

      {canReboot && (
        <div className="flex justify-end">
          <BridgeRebootButton />
        </div>
      )}

      {/* Detalhes em grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <DetailCard icon={Cpu} title="Hardware">
          <DetailRow label="Porta COM" value={health.comPort ?? "—"} mono />
          <DetailRow label="Serial conectada" value={effectiveComConnected ? "Sim" : "Não"} valueColor={effectiveComConnected ? "text-primary" : "text-destructive"} />
          <DetailRow label="Uptime" value={uptimeStr} />
        </DetailCard>

        <DetailCard icon={Activity} title="Fila de Comandos">
          <DetailRow label="Pendentes (DB)" value={String(queue.pending)} />
          <DetailRow label="Em envio (DB)" value={String(queue.sent)} />
          <DetailRow label="Reportado pelo agente" value={String(health.pendingCommands)} />
        </DetailCard>

        <DetailCard icon={Cable} title="Conexão">
          <DetailRow label="Modo" value="Headless (system tray)" />
          <DetailRow label="Heartbeat" value="A cada 30s" />
          <DetailRow label="Auto-start Windows" value="Ativado" valueColor="text-primary" />
        </DetailCard>
      </div>

      {/* Controle remoto da bridge (reset, reabrir porta, etc) */}
      <RemoteBridgeControl farmId={farmId} comPort={health.comPort} />

      {/* Logs ao vivo do agente (tabela agent_logs via Realtime) */}
      <AgentLiveLogs farmId={farmId} />

      {/* Como instalar */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2 mb-3">
          <Download className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Como instalar o Gestor de Bombas Key</h2>
        </div>
        <ol className="list-decimal pl-5 space-y-2 text-sm text-muted-foreground">
          <li>Baixe o instalador <strong>Gestor de Bombas Key-win32-x64.zip</strong> e extraia em <code className="text-xs bg-muted px-1.5 py-0.5 rounded">C:\GestorDeBombasKey\</code> no PC da fazenda.</li>
          <li>Conecte o cabo USB do Servidor (ESP_A) ao PC.</li>
          <li>Execute <code className="text-xs bg-muted px-1.5 py-0.5 rounded">Gestor de Bombas Key.exe</code>. Na 1ª vez abrirá uma mini-janela pedindo:
            <ul className="list-disc pl-5 mt-1 space-y-0.5 text-xs">
              <li><strong>Email/senha</strong> da conta de serviço da fazenda (criada em Suporte Técnico → Login)</li>
              <li><strong>Farm ID</strong>: <code className="bg-muted px-1 rounded">{farmId ?? "(carregando…)"}</code></li>
            </ul>
          </li>
          <li>Após salvar, o agente fica oculto na bandeja do sistema (ícone verde = rodando). O Windows iniciará automaticamente nos próximos boots.</li>
          <li>Esta tela passará a mostrar status <strong>ONLINE</strong> em até 60 segundos.</li>
        </ol>
        <div className="mt-4 text-xs text-muted-foreground border-t border-border pt-3">
          💡 <strong>Diagnóstico no PC:</strong> duplo-clique no ícone da bandeja abre a janela de log (TX azul, RX verde). Botão direito → "Reconectar Serial" se a porta COM mudou.
        </div>
      </div>
    </div>
  );
}

// ── Subcomponentes ─────────────────────────────────────────────────────────
function DetailCard({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, mono, valueColor }: { label: string; value: string; mono?: boolean; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`${mono ? "font-mono" : "font-medium"} ${valueColor ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}
