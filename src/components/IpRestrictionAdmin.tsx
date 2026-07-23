// Card de gerenciamento da restrição por IP por fazenda.
// Renderizado dentro da aba "Limites" do DevicesAdmin.
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Globe, Plus, Trash2, Settings2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { notify } from "@/lib/notify";

interface Farm { id: string; name: string; ip_restriction_enabled?: boolean | null; }
interface AllowedIp { id: string; farm_id: string; ip_address: string; description: string; created_at: string; }

export default function IpRestrictionAdmin({ farms, onChanged }: { farms: Farm[]; onChanged?: () => void }) {
  const { user } = useAuth();
  const [ips, setIps] = useState<AllowedIp[]>([]);
  const [loading, setLoading] = useState(true);
  const [managing, setManaging] = useState<Farm | null>(null);
  const [newIp, setNewIp] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const reload = async () => {
    setLoading(true);
    const { data } = await supabase.from("farm_allowed_ips" as any).select("*").order("created_at", { ascending: false });
    setIps((data as any as AllowedIp[]) ?? []);
    setLoading(false);
  };
  useEffect(() => { void reload(); }, []);

  const ipsForFarm = (farmId: string) => ips.filter(i => i.farm_id === farmId);

  const toggleRestriction = async (farm: Farm, enabled: boolean) => {
    const { error } = await supabase.from("farms").update({ ip_restriction_enabled: enabled } as any).eq("id", farm.id);
    if (error) return notify.fail("Restrição IP", error.message);
    notify.ok("Restrição IP", enabled ? `Ativada para ${farm.name}` : `Desativada para ${farm.name}`);
    onChanged?.();
  };

  const addIp = async () => {
    if (!managing) return;
    const v = newIp.trim();
    if (!v) return notify.fail("Restrição IP", "Informe um IP");
    // Validação básica
    const ok = v === "*" || /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(v) || /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(v);
    if (!ok) return notify.fail("Restrição IP", "Formato inválido. Ex: 189.45.32.100, 189.45.32.0/24 ou *");
    const { error } = await supabase.from("farm_allowed_ips" as any).insert({
      farm_id: managing.id, ip_address: v, description: newDesc.trim(), created_by: user?.id,
    } as any);
    if (error) return notify.fail("Restrição IP", error.message);
    setNewIp(""); setNewDesc("");
    notify.ok("Restrição IP", "IP adicionado");
    void reload();
  };

  const removeIp = async (row: AllowedIp) => {
    if (!confirm(`Remover IP ${row.ip_address}?`)) return;
    const { error } = await supabase.from("farm_allowed_ips" as any).delete().eq("id", row.id);
    if (error) return notify.fail("Restrição IP", error.message);
    void reload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Globe className="w-4 h-4 text-primary" /> Restrição de Acesso por IP
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Configure quais IPs podem acessar cada fazenda. Quando ativado, apenas máquinas com IP autorizado conseguem operar.
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fazenda</TableHead>
              <TableHead className="w-32">Restrição IP</TableHead>
              <TableHead>IPs Autorizados</TableHead>
              <TableHead className="text-right w-32">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {farms.map(f => {
              const list = ipsForFarm(f.id);
              return (
                <TableRow key={f.id}>
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell>
                    <Switch
                      checked={!!f.ip_restriction_enabled}
                      onCheckedChange={(v) => toggleRestriction(f, v)}
                    />
                  </TableCell>
                  <TableCell className="text-xs">
                    {list.length === 0
                      ? <span className="text-muted-foreground">—</span>
                      : (
                        <div className="flex flex-wrap gap-1">
                          {list.slice(0, 4).map(i => <Badge key={i.id} variant="outline">{i.ip_address}</Badge>)}
                          {list.length > 4 && <Badge variant="secondary">+{list.length - 4}</Badge>}
                        </div>
                      )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => { setManaging(f); setNewIp(""); setNewDesc(""); }}>
                      <Settings2 className="w-4 h-4" /> Gerenciar
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {farms.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-4">Nenhuma fazenda</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        {loading && <p className="text-xs text-muted-foreground mt-2">Carregando…</p>}
      </CardContent>

      <Dialog open={!!managing} onOpenChange={(o) => !o && setManaging(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Globe className="w-4 h-4" /> IPs autorizados — {managing?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              {managing && ipsForFarm(managing.id).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-3">Nenhum IP cadastrado ainda.</p>
              )}
              {managing && ipsForFarm(managing.id).map(row => (
                <div key={row.id} className="flex items-center gap-2 border rounded-lg p-2">
                  <div className="flex-1">
                    <code className="text-sm font-mono">{row.ip_address}</code>
                    {row.description && <div className="text-xs text-muted-foreground">{row.description}</div>}
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => removeIp(row)} title="Remover">
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="border-t pt-3 space-y-2">
              <div>
                <Label className="text-xs">Novo IP (aceita IP exato, CIDR ou *)</Label>
                <Input value={newIp} onChange={e => setNewIp(e.target.value)} placeholder="Ex: 189.45.32.100 ou 189.45.32.0/24" />
              </div>
              <div>
                <Label className="text-xs">Descrição (opcional)</Label>
                <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder='Ex: "PC do escritório"' />
              </div>
              <Button className="gap-2 w-full" onClick={addIp}><Plus className="w-4 h-4" /> Adicionar IP</Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManaging(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
