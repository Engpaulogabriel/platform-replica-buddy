// Botão "Reiniciar Agente" — fica ao lado do BridgeStatusBadge no header.
// Enfileira um agent_command kind='agent_restart' (já suportado pelo agente),
// pede confirmação e mostra spinner de 60s enquanto o agente reinicia.
import { useEffect, useRef, useState } from "react";
import { RotateCw, Loader2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { enqueueAgentCommand } from "@/lib/agentCommands";
import { notify } from "@/lib/notify";

const REBOOT_WAIT_MS = 60_000;

export function BridgeRebootButton() {
  const farmId = useDefaultFarmId();
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  async function handleConfirm() {
    if (!farmId) { notify.fail("Reiniciar agente", "Fazenda não identificada"); return; }
    try {
      await enqueueAgentCommand({ farmId, kind: "agent_restart", payload: {}, expiresInSec: 90 });
      notify.ok("Reiniciar agente", "Comando enviado. O agente reiniciará em alguns segundos.");
      setOpen(false);
      setWaiting(true);
      setSecondsLeft(Math.round(REBOOT_WAIT_MS / 1000));
      const start = Date.now();
      timerRef.current = setInterval(() => {
        const left = Math.max(0, Math.round((REBOOT_WAIT_MS - (Date.now() - start)) / 1000));
        setSecondsLeft(left);
        if (left <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          setWaiting(false);
        }
      }, 1000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.fail("Reiniciar agente", msg);
    }
  }

  if (waiting) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-warning/15 text-warning">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="hidden md:inline text-[10px] font-bold uppercase tracking-wider">
          Reiniciando agente... {secondsLeft}s
        </span>
      </div>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                aria-label="Reiniciar agente"
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
              >
                <RotateCw className="w-4 h-4" />
                <span className="hidden lg:inline text-[10px] font-bold uppercase tracking-wider">
                  Reiniciar
                </span>
              </button>
            </AlertDialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs max-w-[220px]">
            Reinicia remotamente o agente .exe da fazenda. Útil quando travado ou lento.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reiniciar agente .exe?</AlertDialogTitle>
          <AlertDialogDescription>
            Tem certeza? O agente será reiniciado e ficará offline por ~30 segundos.
            Comandos enviados nesse período ficarão na fila e serão entregues quando o agente voltar.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Reiniciar agora
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
