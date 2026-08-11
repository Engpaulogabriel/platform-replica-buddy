import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ExternalLink, Hand, MapPin, Wrench } from "lucide-react";
import type { Pump } from "./PumpTable";

export interface MapReservoir {
  id: string;
  name: string;
  lat: number;
  lng: number;
  alarm?: boolean;
  online?: boolean;
}

interface PumpMapProps {
  pumps: Pump[];
  flowEnabled: boolean;
  consumptionEnabled: boolean;
  /** Sede da fazenda (marcador distinto no mapa). */
  sede?: { lat: number; lng: number; name?: string } | null;
  /** Reservatórios/níveis (marcadores azuis). */
  reservoirs?: MapReservoir[];
}

const abbreviateWellName = (name: string): string =>
  name.replace(/\bpo(?:ç|c|Ã§)o\s*[-_.:/#]?\s*(\d+)/giu, "P$1");

export default function PumpMap({ pumps, sede, reservoirs }: PumpMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Layer[]>([]);
  const sedeMarkerRef = useRef<L.Marker | null>(null);
  const [mapError, setMapError] = useState(false);

  const wells = useMemo(
    () => pumps.filter((p) => p.lat != null && p.lng != null),
    [pumps],
  );
  const reservoirsWithCoords = useMemo(
    () => (reservoirs ?? []).filter((r) => r.lat != null && r.lng != null && !Number.isNaN(r.lat) && !Number.isNaN(r.lng)),
    [reservoirs],
  );
  const reservoirKey = useMemo(
    () => reservoirsWithCoords.map((r) => `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`).join("|"),
    [reservoirsWithCoords],
  );

  const centerLat = wells.length > 0
    ? wells.reduce((sum, pump) => sum + (pump.lat as number), 0) / wells.length
    : 0;
  const centerLng = wells.length > 0
    ? wells.reduce((sum, pump) => sum + (pump.lng as number), 0) / wells.length
    : 0;

  useEffect(() => {
    if (!containerRef.current || wells.length === 0 || mapRef.current) return;

    try {
      const map = L.map(containerRef.current, {
        attributionControl: false,
        zoomControl: true,
      });

      // Satélite real estilo Google Earth, evitando tiles "Map data not yet available" em área rural.
      L.tileLayer(
        "https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
        {
          maxZoom: 20,
          subdomains: ["mt0", "mt1", "mt2", "mt3"],
          attribution: "Imagery © Google",
        }
      ).addTo(map);

      mapRef.current = map;
      setMapError(false);

      requestAnimationFrame(() => {
        map.invalidateSize();
      });

      window.setTimeout(() => {
        map.invalidateSize();
      }, 200);
    } catch (error) {
      console.error("Map init error:", error);
      setMapError(true);
    }

    return () => {
      markersRef.current.forEach((marker) => {
        try {
          marker.remove();
        } catch {
          // noop
        }
      });
      markersRef.current = [];

      if (mapRef.current) {
        try {
          mapRef.current.remove();
        } catch {
          // noop
        }
        mapRef.current = null;
      }
    };
    // Inicializa o mapa UMA ÚNICA VEZ. Antes dependia de wells.length, e qualquer
    // variação na telemetria (poço sumindo temporariamente) destruía o mapa e
    // perdia o zoom/posição que o usuário tinha escolhido manualmente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chave estável baseada nas coordenadas dos poços — só refaz fitBounds
  // quando algum poço é adicionado/removido ou tem coordenada alterada.
  // Evita "desaproximar" o mapa toda vez que a telemetria atualiza.
  const wellsCoordKey = useMemo(
    () =>
      wells
        .map((p) => `${p.id}:${(p.lat as number).toFixed(5)},${(p.lng as number).toFixed(5)}`)
        .sort()
        .join("|"),
    [wells],
  );
  const didFitRef = useRef<string>("");

  useEffect(() => {
    const map = mapRef.current;
    const hasSede = !!(sede && sede.lat != null && sede.lng != null);
    if (!map || (wells.length === 0 && reservoirsWithCoords.length === 0 && !hasSede)) return;
    const fitKey = wellsCoordKey + `|R:${reservoirKey}` + (hasSede ? `|S:${sede!.lat.toFixed(5)},${sede!.lng.toFixed(5)}` : "");
    if (didFitRef.current === fitKey) return;

    const pts: [number, number][] = wells.map((p) => [p.lat as number, p.lng as number]);
    reservoirsWithCoords.forEach((r) => pts.push([r.lat, r.lng]));
    if (hasSede) pts.push([sede!.lat, sede!.lng]);
    const bounds = L.latLngBounds(pts);

    map.fitBounds(bounds, { padding: [40, 40] });
    map.invalidateSize();
    didFitRef.current = fitKey;
  }, [wellsCoordKey, wells, sede, reservoirsWithCoords, reservoirKey]);

  // Marcador DISTINTO da sede (independente do cleanup dos marcadores de poço).
  useEffect(() => {
    const map = mapRef.current;
    if (sedeMarkerRef.current) { try { sedeMarkerRef.current.remove(); } catch { /* noop */ } sedeMarkerRef.current = null; }
    if (!map || !sede || sede.lat == null || sede.lng == null) return;
    const icon = L.divIcon({
      className: "",
      html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-4px)">
        <div style="background:#1e3a5f;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4)">🏠 ${(sede.name ?? "Sede").replace(/[<>&]/g, "")}</div>
        <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #1e3a5f"></div>
      </div>`,
      iconAnchor: [0, 0],
    });
    const m = L.marker([sede.lat, sede.lng], { icon, zIndexOffset: 1000 }).addTo(map);
    sedeMarkerRef.current = m;
    return () => { try { m.remove(); } catch { /* noop */ } };
  }, [sede, wells]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((marker) => {
      try {
        marker.remove();
      } catch {
        // noop
      }
    });
    markersRef.current = [];

    // Agrupa poços que compartilham (praticamente) a mesma coordenada
    const groups = new Map<string, typeof wells>();
    wells.forEach((p) => {
      const key = `${(p.lat as number).toFixed(5)}_${(p.lng as number).toFixed(5)}`;
      const arr = groups.get(key) ?? [];
      arr.push(p);
      groups.set(key, arr);
    });

    groups.forEach((groupPumps) => {
      const total = groupPumps.length;
      groupPumps.forEach((pump, idx) => {
        const isClustered = total > 1;
        // Bolinhas menores que se tocam formando um círculo um pouco maior que o ícone normal.
        const dotSize = isClustered ? 12 : 18;
        // Raio para que as bolinhas fiquem encostadas (com leve sobreposição visual).
        const ringSize = isClustered
          ? (dotSize * 0.95) / (2 * Math.sin(Math.PI / Math.max(total, 2)))
          : 0;
        let dx = 0;
        let dy = 0;
        if (isClustered) {
          const angle = (2 * Math.PI * idx) / total - Math.PI / 2;
          dx = ringSize * Math.cos(angle);
          dy = ringSize * Math.sin(angle);
        }

        const isTransitioning = pump.pending === "turning_on" || pump.pending === "turning_off" || pump.pending === "resetting";
        const isOffline = pump.communicationStatus === "offline";
        const isUnstable = pump.communicationStatus === "unstable";
        const fillColor = isOffline
          ? "hsl(var(--muted-foreground))"
          : isTransitioning
            ? "hsl(var(--warning))"
            : pump.running
              ? "hsl(var(--primary))"
              : "hsl(var(--destructive))";

        // Pulso só para marcadores únicos
        if (!isClustered && pump.online && pump.running && !pump.pending) {
          const pulseMarker = L.circleMarker([pump.lat as number, pump.lng as number], {
            radius: 14,
            color: fillColor,
            weight: 1.5,
            fillColor: "transparent",
            fillOpacity: 0,
            opacity: 0.4,
            className: "animate-pulse",
          }).addTo(map);
          markersRef.current.push(pulseMarker);
        }

        // Badge LOCAL no canto do ícone: último acionamento foi no painel físico
        // (last_actuation_origin="local"). Só em estado ESTÁVEL — nunca durante uma
        // transição (Ligando/Desligando). Não aparece p/ origem remota nem offline.
        const showLocal = !isOffline && pump.actuationOrigin === "local" && !isTransitioning;
        const localBadge = showLocal
          ? `<div style="
              position:absolute;top:-7px;right:-9px;z-index:1;
              background:hsl(var(--warning));color:#1a1200;
              font-size:7px;font-weight:800;line-height:1;letter-spacing:0.2px;
              padding:1px 3px;border-radius:4px;white-space:nowrap;
              border:1px solid hsl(var(--background));box-shadow:0 1px 2px rgba(0,0,0,0.4);
            ">LOCAL</div>`
          : "";
        const html = `<div style="position:relative;width:${dotSize}px;height:${dotSize}px;">
          <div style="
            width:100%;height:100%;border-radius:9999px;
            background:${fillColor};border:2px solid hsl(var(--background));
            box-shadow:0 0 0 1px rgba(0,0,0,0.3);
          "></div>${localBadge}
        </div>`;

        const icon = L.divIcon({
          className: "pump-cluster-marker",
          html,
          iconSize: [dotSize, dotSize],
          // iconAnchor centraliza o ponto no latlng e aplica offset em pixels
          iconAnchor: [dotSize / 2 - dx, dotSize / 2 - dy],
        });

        const marker = L.marker([pump.lat as number, pump.lng as number], { icon }).addTo(map);

        marker.bindTooltip(
          `<strong>${abbreviateWellName(pump.name)}</strong>`,
          { permanent: !isClustered, direction: "top", offset: [0, -dotSize / 2] },
        );

        markersRef.current.push(marker);
      });
    });

    // Reservatórios / níveis — marcadores AZUIS com o nome ao lado.
    reservoirsWithCoords.forEach((res) => {
      const size = 16;
      const blue = res.alarm ? "#dc2626" : "#2563eb"; // alarme → vermelho; normal → azul
      const html = `<div style="
        width:${size}px;height:${size}px;border-radius:4px;
        background:${blue};border:2px solid hsl(var(--background));
        box-shadow:0 0 0 1px rgba(0,0,0,0.3);
      "></div>`;
      const icon = L.divIcon({
        className: "reservoir-marker",
        html,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const marker = L.marker([res.lat, res.lng], { icon, zIndexOffset: 500 }).addTo(map);
      marker.bindTooltip(`🔵 <strong>${(res.name ?? "Reservatório").replace(/[<>&]/g, "")}</strong>`, {
        permanent: true, direction: "top", offset: [0, -size / 2],
      });
      markersRef.current.push(marker);
    });
  }, [wells, reservoirsWithCoords]);

  if (wells.length === 0 && reservoirsWithCoords.length === 0) {
    return (
      <div className="h-[640px] rounded-lg border border-border bg-card flex items-center justify-center text-sm text-muted-foreground">
        Nenhum poço ou reservatório com coordenadas cadastradas.
      </div>
    );
  }

  if (mapError) {
    return (
      <div className="h-[640px] rounded-lg border border-border bg-card flex items-center justify-center text-sm text-muted-foreground">
        Não foi possível carregar o mapa.
      </div>
    );
  }

  const externalAllUrl = `https://www.google.com/maps/@${centerLat},${centerLng},16z`;

  return (
    <div className="space-y-3">
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-secondary/50">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Mapa dos Poços</span>
          </div>
          <a
            href={externalAllUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Google Maps
          </a>
        </div>
        <div ref={containerRef} className="h-[640px] w-full bg-muted/20" />
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/50">
          <MapPin className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Localização dos Poços</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 p-2">
          {wells.map((pump) => {
            // Amarelo apenas em transição (ligando/desligando).
            const isTransitioning = pump.pending === "turning_on" || pump.pending === "turning_off" || pump.pending === "resetting";
            const isPending = !!pump.pending;
            const isOffline = pump.communicationStatus === "offline";
            const isUnstable = pump.communicationStatus === "unstable";
            const statusDot = isOffline
              ? "bg-muted-foreground"
              : isTransitioning
                ? "bg-warning animate-pulse"
                : pump.running
                  ? "bg-primary"
                  : "bg-destructive";
            const statusBadge = isOffline
              ? "text-muted-foreground"
              : isTransitioning
                ? "text-warning"
                : isUnstable
                  ? "text-info"
                  : pump.running
                    ? "text-primary"
                    : "text-destructive";

            return (
              <div key={pump.id} className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusDot}`} />
                    <span className="text-sm font-bold text-foreground truncate">{abbreviateWellName(pump.name)}</span>
                    {pump.mode === "auto" && (
                      <span
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-info/20 text-info font-bold text-[9px] uppercase tracking-wide border border-info/40 shrink-0"
                        title="Bomba em modo Automático — controlada por programação"
                      >
                        AUTO
                      </span>
                    )}
                    {!isOffline && pump.actuationOrigin === "local" && !isTransitioning && (
                      <span
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-warning/20 text-warning font-bold text-[9px] uppercase tracking-wide border border-warning/40 shrink-0"
                        title="Último acionamento via painel local/botoeira"
                      >
                        <Hand className="w-2.5 h-2.5" />
                        LOCAL
                      </span>
                    )}
                    {!isOffline && pump.actuationOrigin === "tech_terminal" && !isTransitioning && (
                      <span
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-600 dark:text-sky-400 font-bold text-[9px] uppercase tracking-wide border border-sky-500/40 shrink-0"
                        title="Acionado pelo Suporte Técnico (Terminal Serial) — não é a botoeira local"
                      >
                        <Wrench className="w-2.5 h-2.5" />
                        TÉCNICO
                      </span>
                    )}
                  </div>
                  <a
                    href={`https://www.google.com/maps?q=${pump.lat},${pump.lng}&t=k`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    title="Abrir no Google Maps"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">Status</p>
                    <p className={`font-semibold ${statusBadge}`}>
                      {isOffline ? "Offline" : isUnstable ? "Instável" : pump.pending === "error" ? "Verificar Poço" : pump.pending === "turning_on" ? "Ligando..." : pump.pending === "turning_off" ? "Desligando..." : pump.pending === "resetting" ? "Resetando..." : pump.running ? "Ligada" : "Desligada"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Modo</p>
                    <p className="font-semibold text-foreground">
                      {pump.mode === "auto"
                        ? "Automático"
                        : pump.actuationOrigin === "local"
                          ? "Local"
                          : pump.actuationOrigin === "tech_terminal"
                            ? "Técnico"
                            : "Remoto"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Coordenadas</p>
                    <p className="font-semibold text-foreground text-[10px]">
                      {pump.lat?.toFixed(4)}, {pump.lng?.toFixed(4)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
