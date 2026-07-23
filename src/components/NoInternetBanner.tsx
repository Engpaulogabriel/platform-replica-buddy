// NoInternetBanner — overlay vermelho no topo quando o USUÁRIO perde internet.
// Cobre toda a UI com opacidade reduzida; quando volta, mostra confirmação verde 3s.
import { useEffect, useState } from "react";
import { WifiOff, Wifi, Loader2 } from "lucide-react";
import { useUserOnline } from "@/contexts/UserOnlineContext";

export function NoInternetBanner() {
  const { online, lastOkAt, reconnectingNow, softReconnecting } = useUserOnline();
  const [showRecovered, setShowRecovered] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (!online) {
      setWasOffline(true);
      return;
    }
    if (online && wasOffline) {
      setShowRecovered(true);
      const t = setTimeout(() => {
        setShowRecovered(false);
        setWasOffline(false);
      }, 3_000);
      return () => clearTimeout(t);
    }
  }, [online, wasOffline]);

  // Banner amarelo discreto: microinterrupção Starlink (3-4 falhas consecutivas)
  // antes de declarar offline duro. Não bloqueia UI, não mostra overlay.
  if (online && softReconnecting && !showRecovered) {
    return (
      <div className="fixed top-0 left-0 right-0 z-[100] bg-amber-500 text-white shadow-md">
        <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="font-medium">Reconectando…</span>
          <span className="opacity-90 hidden sm:inline">conexão instável, tentando novamente</span>
        </div>
      </div>
    );
  }

  if (online && !showRecovered) return null;

  if (!online) {
    const lastOk = new Date(lastOkAt);
    const hh = lastOk.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return (
      <>
        {/* Overlay que reduz opacidade da UI atrás */}
        <div className="fixed inset-0 z-[90] bg-background/40 backdrop-blur-[1px] pointer-events-none" />
        {/* Banner topo */}
        <div className="fixed top-0 left-0 right-0 z-[100] bg-destructive text-destructive-foreground shadow-lg">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-start gap-3">
            <WifiOff className="w-6 h-6 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-base">SEM CONEXÃO COM A INTERNET</div>
              <div className="text-sm opacity-95 mt-0.5">
                Sua conexão com a internet foi perdida. Os dados exibidos podem estar desatualizados.
                <span className="block mt-1 font-medium">
                  ✅ As bombas continuam operando normalmente na fazenda.
                </span>
                <span className="block text-xs opacity-90 mt-1">
                  Última atualização: {hh}
                </span>
              </div>
              <div className="mt-2 inline-flex items-center gap-2 text-xs bg-destructive-foreground/15 px-2 py-1 rounded">
                <Loader2 className="w-3 h-3 animate-spin" />
                {reconnectingNow ? "Reconectando…" : "Tentando reconectar…"}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Recuperado
  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-emerald-600 text-white shadow-lg animate-in fade-in slide-in-from-top">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
        <Wifi className="w-5 h-5" />
        <div className="font-semibold">CONEXÃO RESTABELECIDA</div>
        <span className="text-sm opacity-90">Atualizando dados…</span>
      </div>
    </div>
  );
}
