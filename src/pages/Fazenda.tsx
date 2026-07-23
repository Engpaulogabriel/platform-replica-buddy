import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Building2, Copy, KeyRound, Check } from "lucide-react";
import { notify } from "@/lib/notify";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

export const FAZENDA_STORAGE_KEY = "fazenda_data";

export interface FazendaData {
  nome: string;
  proprietario: string;
  cidadeEstado: string;
  telefone: string;
}

export function loadFazendaData(): FazendaData {
  try {
    const saved = localStorage.getItem(FAZENDA_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return { nome: "Fazenda Santa Maria", proprietario: "João Silva", cidadeEstado: "Uberaba - MG", telefone: "(34) 99999-0000" };
}

const FazendaContent = () => {
  const [form, setForm] = useState<FazendaData>(loadFazendaData);
  const farmId = useDefaultFarmId();
  const [copied, setCopied] = useState(false);

  const save = () => {
    localStorage.setItem(FAZENDA_STORAGE_KEY, JSON.stringify(form));
    window.dispatchEvent(new Event("fazenda-updated"));
    notify.ok("Fazenda", "Dados da fazenda salvos com sucesso!");
  };

  const copyFarmId = async () => {
    if (!farmId) return;
    await navigator.clipboard.writeText(farmId);
    setCopied(true);
    notify.ok("Fazenda", "Farm ID copiado!");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" /> Perfil da Fazenda
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-foreground">Nome da Fazenda</Label>
              <Input className="bg-secondary border-border mt-1" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} />
            </div>
            <div>
              <Label className="text-foreground">Proprietário</Label>
              <Input className="bg-secondary border-border mt-1" value={form.proprietario} onChange={e => setForm(f => ({ ...f, proprietario: e.target.value }))} />
            </div>
            <div>
              <Label className="text-foreground">Cidade / Estado</Label>
              <Input className="bg-secondary border-border mt-1" value={form.cidadeEstado} onChange={e => setForm(f => ({ ...f, cidadeEstado: e.target.value }))} />
            </div>
            <div>
              <Label className="text-foreground">Telefone</Label>
              <Input className="bg-secondary border-border mt-1" value={form.telefone} onChange={e => setForm(f => ({ ...f, telefone: e.target.value }))} />
            </div>
          </div>
          <Button className="bg-primary text-primary-foreground" onClick={save}>
            Salvar Alterações
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" /> Identificação Técnica
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-foreground">Farm ID (UUID)</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Use este código no setup do Renov Agent (.exe) instalado no PC da fazenda.
            </p>
            <div className="flex gap-2">
              <Input
                className="bg-secondary border-border font-mono text-xs"
                value={farmId ?? "Carregando..."}
                readOnly
              />
              <Button
                variant="outline"
                size="icon"
                onClick={copyFarmId}
                disabled={!farmId}
                className="shrink-0"
              >
                {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default FazendaContent;
