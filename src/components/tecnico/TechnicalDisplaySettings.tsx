// Setor Técnico → chave "Exibir tempos técnicos nos cards".
// ---------------------------------------------------------------------------
// Desligada por padrão para todos, inclusive platform_admin. Quando ligada, os
// tempos só aparecem para platform_admin e platform_support autenticados —
// cliente, owner, gestor, operador e viewer nunca veem, mesmo com a chave
// ligada, porque a permissão é verificada separadamente.
//
// A tela é só isto: um switch com texto claro. Nada no PumpCard indica que a
// função existe.
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useTechnicalTelemetryAccess } from "@/hooks/useTechnicalTelemetry";
import { notify } from "@/lib/notify";

export function TechnicalDisplaySettings() {
  const { canViewTechnicalTelemetry, showTechnicalTimes, setShowTechnicalTimes } =
    useTechnicalTelemetryAccess();
  const [saving, setSaving] = useState(false);

  // Fecha a porta também no cliente: sem permissão, a tela nem monta.
  if (!canViewTechnicalTelemetry) return null;

  const toggle = async (v: boolean) => {
    setSaving(true);
    try {
      await setShowTechnicalTimes(v);
      notify.ok("Tempos técnicos", v
        ? "passam a aparecer nos seus cards"
        : "ocultos nos cards");
    } catch {
      notify.fail("Tempos técnicos", "não foi possível alterar a preferência");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="technical-display-settings"
      className="flex items-start justify-between gap-4 rounded-md border border-border bg-secondary/40 p-3"
    >
      <div className="text-xs text-muted-foreground">
        <p className="font-semibold text-foreground">Exibir tempos técnicos nos cards</p>
        <p>
          Mostra a idade da última leitura nos cards de poço. Desligado por padrão.
          Vale só para o seu login técnico — nenhum cliente, dono de fazenda,
          gestor ou operador passa a ver esses tempos.
        </p>
      </div>
      <Switch
        checked={showTechnicalTimes}
        disabled={saving}
        onCheckedChange={toggle}
        aria-label="Exibir tempos técnicos nos cards"
      />
    </div>
  );
}

export default TechnicalDisplaySettings;
