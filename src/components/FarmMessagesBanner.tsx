import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertOctagon, AlertTriangle, Info, X } from "lucide-react";

interface Msg {
  id: string;
  level: string;
  title: string;
  body: string;
  created_at: string;
  expires_at: string | null;
}

export function FarmMessagesBanner({ farmId }: { farmId: string | null }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);

  const load = useCallback(async () => {
    if (!farmId) { setMsgs([]); return; }
    const { data } = await supabase.rpc("farm_messages_active" as any, { _farm_id: farmId });
    setMsgs((data as any) ?? []);
  }, [farmId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime + polling de segurança a cada 60s
  useEffect(() => {
    if (!farmId) return;
    const ch = supabase
      .channel("farm-messages-" + farmId)
      .on("postgres_changes",
          { event: "*", schema: "public", table: "farm_messages", filter: `farm_id=eq.${farmId}` },
          () => void load())
      .subscribe();
    const t = setInterval(() => void load(), 300_000); // 5 min p/ cota Cloud
    return () => { void supabase.removeChannel(ch); clearInterval(t); };
  }, [farmId, load]);

  const dismiss = async (id: string) => {
    setMsgs(prev => prev.filter(m => m.id !== id));
    await supabase.rpc("farm_messages_dismiss" as any, { _message_id: id });
  };

  if (!msgs.length) return null;

  return (
    <div className="space-y-2 px-3 md:px-6 pt-3">
      {msgs.map(m => {
        const isCritical = m.level === "critical";
        const isWarning = m.level === "warning";
        const Icon = isCritical ? AlertOctagon : isWarning ? AlertTriangle : Info;
        const variant = isCritical ? "destructive" : "default";
        return (
          <Alert key={m.id} variant={variant as any}
            className={isWarning ? "border-amber-500/60 text-amber-700 dark:text-amber-400 [&>svg]:text-amber-500" : ""}
          >
            <Icon className="h-4 w-4" />
            <div className="flex items-start justify-between gap-3 w-full">
              <div className="flex-1 min-w-0">
                <AlertTitle className="text-sm">{m.title}</AlertTitle>
                <AlertDescription className="text-xs whitespace-pre-wrap">{m.body}</AlertDescription>
                <div className="text-[10px] opacity-70 mt-1">
                  Mensagem oficial Renov · {new Date(m.created_at).toLocaleString("pt-BR")}
                </div>
              </div>
              <Button variant="ghost" size="sm" className="shrink-0 h-7 w-7 p-0" onClick={() => dismiss(m.id)} title="Dispensar">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </Alert>
        );
      })}
    </div>
  );
}
