// Badge compacto no header — mostra status da bridge Electron .exe (RS-232)
// 2026-06-10: removido estado "Instável". Apenas dois estados visuais:
//   • ONLINE  → ícone verde pequeno e discreto (sem texto)
//   • OFFLINE → badge vermelho com texto "OFFLINE" (só após 3min sem heartbeat)
import { Cpu, AlertTriangle, Globe } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useElectronBridgeStatus, formatBeatAge, type BridgeStatus } from "@/hooks/useElectronBridgeStatus";

// Estados "saudáveis" (não alarmar o cliente): ok + no-port.
const isHealthy = (s: BridgeStatus) => s === "ok" || s === "no-port";

export function BridgeStatusBadge() {
  const { status, present, portOpen, lastBeatAt, loadError, pingState } = useElectronBridgeStatus();

  // 2026-06-10 (URGENTE): toast "Sistema de comunicação offline" REMOVIDO.
  // Estava disparando falso alarme porque o heartbeat WebSocket está com
  // kill-switch ativo. O indicador visual (badge) já é suficiente.

  const healthy = isHealthy(status);
  const noBridge = status === "no-bridge";

  // ── ONLINE (ou estado intermediário tratado como online) ────────────────
  // Ícone verde pequeno, sem texto, sem alarme.
  if (healthy) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center justify-center w-7 h-7 rounded-md cursor-default">
              <div className="relative">
                <Cpu className="w-4 h-4 text-primary" />
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="space-y-1 text-xs max-w-[240px]">
            <p className="font-semibold text-primary">Sistema online</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
              <span className="text-muted-foreground">Porta COM:</span>
              <span>{portOpen ? "🟢 aberta" : "⚪ fechada"}</span>
              <span className="text-muted-foreground">Última atividade:</span>
              <span>{formatBeatAge(lastBeatAt)}</span>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // ── SEM BRIDGE (modo web puro) ─────────────────────────────────────────
  if (noBridge) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center justify-center w-7 h-7 rounded-md cursor-default opacity-60">
              <Globe className="w-4 h-4 text-muted-foreground" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs max-w-[240px]">
            <p>Comunicação RS-232 só disponível no aplicativo desktop (.exe).</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // ── OFFLINE (>3min sem heartbeat) ───────────────────────────────────────
  // Badge vermelho com destaque.
  const Icon = status === "error" ? AlertTriangle : Cpu;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-destructive/15 cursor-default">
            <Icon className="w-4 h-4 text-destructive" />
            <span className="hidden md:inline text-[10px] font-bold uppercase tracking-wider text-destructive">
              Offline
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="space-y-1 text-xs max-w-[240px]">
          <p className="font-semibold text-destructive">Sistema sem comunicação</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            <span className="text-muted-foreground">Bridge .exe:</span>
            <span>{present ? "🟢 presente" : "⚪ ausente"}</span>
            <span className="text-muted-foreground">Porta COM:</span>
            <span>{portOpen ? "🟢 aberta" : "⚪ fechada"}</span>
            <span className="text-muted-foreground">Última atividade:</span>
            <span>{formatBeatAge(lastBeatAt)}</span>
            <span className="text-muted-foreground">Heartbeat:</span>
            <span>{pingState === "timeout" ? "❌ sem resposta" : "—"}</span>
          </div>
          {loadError && (
            <p className="text-destructive text-[10px] pt-1 border-t border-border">
              {loadError}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
