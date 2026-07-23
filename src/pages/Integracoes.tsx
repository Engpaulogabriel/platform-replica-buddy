import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bot, MessageCircle, Settings2, Sparkles, Wifi, WifiOff } from "lucide-react";
import { useUserFarms } from "@/hooks/useUserFarms";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { supabase } from "@/integrations/supabase/client";
import { WhatsAppConfigDialog } from "@/components/integracoes/WhatsAppConfigDialog";
import { WhatsAppAlertsCard } from "@/components/integracoes/WhatsAppAlertsCard";
import { WhatsAppAccessPanel } from "@/components/integracoes/WhatsAppAccessPanel";
import { WhatsAppBroadcastCard } from "@/components/integracoes/WhatsAppBroadcastCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import HistoricoWhatsApp from "@/pages/HistoricoWhatsApp";

import RestrictedAuth from "@/components/RestrictedAuth";


const sb = supabase as unknown as {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: string) => {
        maybeSingle: () => Promise<{ data: { is_connected: boolean } | null }>;
      };
    };
  };
};

const Integracoes = () => {
  const farmId = useDefaultFarmId();
  const { farms } = useUserFarms();
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!farmId) return;
    void sb.from("whatsapp_config").select("is_connected").eq("farm_id", farmId).maybeSingle()
      .then(({ data }) => setConnected(Boolean(data?.is_connected)));
  }, [farmId, open]);

  return (
    <RestrictedAuth title="IA e Integrações" description="Área restrita para configuração de integrações e IA">
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/30">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-semibold text-primary uppercase tracking-wider">IA e Integrações</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground">Conecte sua operação</h1>
        <p className="text-muted-foreground">Automatize controle, alertas e atendimento usando IA e canais externos.</p>
      </header>

      <Tabs defaultValue="integracoes" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="integracoes">Integrações</TabsTrigger>
          <TabsTrigger value="historico">Histórico de Conversas</TabsTrigger>
        </TabsList>

        <TabsContent value="integracoes" className="space-y-6 mt-6">
          {/* WhatsApp */}
          <Card className="border-2 border-[#25D366]/30 bg-gradient-to-br from-[#25D366]/5 to-transparent">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="rounded-2xl bg-[#25D366]/15 p-3 border border-[#25D366]/30">
                  <MessageCircle className="w-8 h-8 text-[#25D366]" />
                </div>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    WhatsApp — Assistente Renov
                    {connected ? (
                      <Badge className="bg-[#25D366]/15 text-[#1ea952] border border-[#25D366]/40">
                        <Wifi className="w-3 h-3 mr-1" /> Conectado
                      </Badge>
                    ) : (
                      <Badge variant="destructive"><WifiOff className="w-3 h-3 mr-1" /> Desconectado</Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    Controle de bombas por mensagem/áudio e atendimento inteligente
                  </CardDescription>
                </div>
              </div>
              <Button onClick={() => setOpen(true)} disabled={!farmId}>
                <Settings2 className="w-4 h-4 mr-2" /> Configurar
              </Button>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Operadores autorizados podem ligar/desligar bombas e consultar status enviando mensagens.
              A IA pode atender clientes, transcrever áudios e disparar alertas para a equipe técnica.
            </CardContent>
          </Card>

          {/* Alertas Proativos WhatsApp */}
          <WhatsAppAlertsCard farmId={farmId} />

          {/* Solicitações de Acesso & Auditoria */}
          <WhatsAppAccessPanel farmId={farmId} farms={farms.map((f) => ({ id: f.id, name: f.name }))} />

          {/* Broadcast — comunicados em massa */}
          <WhatsAppBroadcastCard farmId={farmId} farms={farms.map((f) => ({ id: f.id, name: f.name }))} />

          {/* Outras integrações - placeholder */}
          <Card className="opacity-75">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="rounded-2xl bg-primary/10 p-3 border border-primary/30">
                  <Bot className="w-8 h-8 text-primary" />
                </div>
                <div>
                  <CardTitle>Mais integrações em breve</CardTitle>
                  <CardDescription className="mt-1">Telegram, e-mail, webhooks e mais.</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        </TabsContent>

        <TabsContent value="historico" className="mt-6">
          <HistoricoWhatsApp />
        </TabsContent>
      </Tabs>

      <WhatsAppConfigDialog
        open={open}
        onOpenChange={setOpen}
        farmId={farmId}
        farms={farms.map((f) => ({ id: f.id, name: f.name }))}
        onConnectionChange={setConnected}
      />
    </div>
    </RestrictedAuth>
  );
};

export default Integracoes;

