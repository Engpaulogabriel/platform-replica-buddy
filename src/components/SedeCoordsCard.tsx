// Editor das coordenadas da SEDE da fazenda (farms.latitude_sede/longitude_sede).
// Aparece na aba Fazenda (Suporte Técnico). Grava direto no banco.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MapPin } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { notify } from "@/lib/notify";

export default function SedeCoordsCard() {
  const farmId = useDefaultFarmId();
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!farmId) return;
    const { data } = await supabase.from("farms").select("latitude_sede, longitude_sede" as any).eq("id", farmId).maybeSingle();
    const d = data as any;
    setLat(d?.latitude_sede != null ? String(d.latitude_sede) : "");
    setLng(d?.longitude_sede != null ? String(d.longitude_sede) : "");
  }, [farmId]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!farmId) return;
    const nlat = lat.trim() === "" ? null : Number(lat.replace(",", "."));
    const nlng = lng.trim() === "" ? null : Number(lng.replace(",", "."));
    if ((nlat != null && Number.isNaN(nlat)) || (nlng != null && Number.isNaN(nlng))) {
      notify.fail("Sede", "Latitude/longitude inválida."); return;
    }
    setSaving(true);
    const { error } = await supabase.from("farms").update({ latitude_sede: nlat, longitude_sede: nlng } as any).eq("id", farmId);
    setSaving(false);
    if (error) notify.fail("Sede", error.message);
    else notify.ok("Sede", "Coordenadas da sede salvas. Aparecem no mapa (Início → Mapa).");
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <MapPin className="w-4 h-4 text-primary" /> Localização da Sede
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">Marca a sede da fazenda no mapa, junto com os poços. Cole as coordenadas (ex.: do Google Maps).</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-foreground">Latitude</Label>
            <Input className="bg-secondary border-border mt-1" placeholder="-12.34567" value={lat} onChange={(e) => setLat(e.target.value)} />
          </div>
          <div>
            <Label className="text-foreground">Longitude</Label>
            <Input className="bg-secondary border-border mt-1" placeholder="-45.67890" value={lng} onChange={(e) => setLng(e.target.value)} />
          </div>
        </div>
        <Button size="sm" onClick={save} disabled={saving || !farmId}>{saving ? "Salvando…" : "Salvar sede"}</Button>
      </CardContent>
    </Card>
  );
}
