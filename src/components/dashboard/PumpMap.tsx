import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Crosshair, ExternalLink, Hand, MapPin } from "lucide-react";
import type { Pump } from "./PumpTable";
import type { Reservoir } from "./ReservoirGauges";

interface PumpMapProps {
  pumps: Pump[];
  flowEnabled: boolean;
  consumptionEnabled: boolean;
  /** Equipamentos de nível (reservatórios/canais) com coordenadas. */
  reservoirs?: Reservoir[];
  /** Sede da fazenda (marcador distinto no mapa). */
  sede?: { lat: number; lng: number; name?: string; endereco?: string | null; proprietario?: string | null; phone?: string | null } | null;
  /** Habilita GPS/navegação (perfil Técnico/Admin ou preferência do usuário). */
  gpsEnabled?: boolean;
}

const abbreviateWellName = (name: string): string =>
  name.replace(/\bpo(?:ç|c|Ã§)o\s*[-_.:/#]?\s*(\d+)/giu, "P$1");

const shortReservoirName = (name: string): string => {
  const m = name.match(/\b(?:reservat[oó]rio|canal|n[ií]vel)?\s*([RNC]?\s*\d+)/iu);
  if (m) return m[1].replace(/\s+/g, "").toUpperCase();
  return name.trim().split(/\s+/)[0].slice(0, 6).toUpperCase();
};

const escapeHtml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));

/** Distância em linha reta (Haversine), em metros. */
const haversineMeters = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

/** Bloco de "Navegar até aqui" + distância para o popup de um destino. */
const buildNavHtml = (
  lat: number,
  lng: number,
  from: { lat: number; lng: number } | null,
): string => {
  const dist = from ? `<div style="margin-top:6px;font-size:11px;opacity:.85">📍 ~${formatDistance(haversineMeters(from.lat, from.lng, lat, lng))} de você (linha reta)</div>` : "";
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const waze = `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  return `${dist}
    <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
      <a href="${gmaps}" target="_blank" rel="noreferrer" style="display:inline-flex;align-items:center;gap:4px;min-height:32px;padding:6px 10px;border-radius:6px;background:#1a73e8;color:#fff;font-weight:700;font-size:11px;text-decoration:none">🧭 Google Maps</a>
      <a href="${waze}" target="_blank" rel="noreferrer" style="display:inline-flex;align-items:center;gap:4px;min-height:32px;padding:6px 10px;border-radius:6px;background:#33ccff;color:#062b3a;font-weight:700;font-size:11px;text-decoration:none">🚗 Waze</a>
    </div>`;
};

const GPS_PREF_KEY = "renov.map.gps";

export default function PumpMap({ pumps, reservoirs = [], sede, gpsEnabled: gpsDefault = false }: PumpMapProps) {
  // Ativo por padrão para Técnico/Admin, mas qualquer usuário pode ligar/desligar.
  const [gpsEnabled, setGpsEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return gpsDefault;
    const saved = window.localStorage.getItem(GPS_PREF_KEY);
    return saved === "on" ? true : saved === "off" ? false : gpsDefault;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Layer[]>([]);
  const levelMarkersRef = useRef<L.Layer[]>([]);
  const sedeMarkerRef = useRef<L.Marker | null>(null);
  const meMarkerRef = useRef<L.Marker | null>(null);
  const meCircleRef = useRef<L.Circle | null>(null);
  const posRef = useRef<{ lat: number; lng: number } | null>(null);
  const [myPos, setMyPos] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [mapError, setMapError] = useState(false);

  const wells = useMemo(
    () => pumps.filter((p) => p.lat != null && p.lng != null),
    [pumps],
  );

  const levels = useMemo(
    () => reservoirs.filter((r) => r.lat != null && r.lng != null),
    [reservoirs],
  );

  const centerLat = wells.length > 0
    ? wells.reduce((sum, pump) => sum + (pump.lat as number), 0) / wells.length
    : 0;
  const centerLng = wells.length > 0
    ? wells.reduce((sum, pump) => sum + (pump.lng as number), 0) / wells.length
    : 0;


  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    try {
      const map = L.map(containerRef.current, {
        attributionControl: false,
        zoomControl: true,
      }).setView([-13.0, -45.0], 6);

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
  const levelsCoordKey = useMemo(
    () =>
      levels
        .map((r) => `${r.id}:${(r.lat as number).toFixed(5)},${(r.lng as number).toFixed(5)}`)
        .sort()
        .join("|"),
    [levels],
  );
  const didFitRef = useRef<string>("");

  useEffect(() => {
    const map = mapRef.current;
    const hasSede = !!(sede && sede.lat != null && sede.lng != null);
    if (!map || (wells.length === 0 && levels.length === 0 && !hasSede)) return;
    const fitKey = wellsCoordKey + "#" + levelsCoordKey + (hasSede ? `|S:${sede!.lat.toFixed(5)},${sede!.lng.toFixed(5)}` : "");
    if (didFitRef.current === fitKey) return;

    const pts: [number, number][] = wells.map((p) => [p.lat as number, p.lng as number]);
    levels.forEach((r) => pts.push([r.lat as number, r.lng as number]));
    if (hasSede) pts.push([sede!.lat, sede!.lng]);
    const bounds = L.latLngBounds(pts);

    map.fitBounds(bounds, { padding: [40, 40] });
    map.invalidateSize();
    didFitRef.current = fitKey;
  }, [wellsCoordKey, levelsCoordKey, wells, levels, sede]);

  // ---- GPS do técnico: watchPosition em tempo real -------------------------
  useEffect(() => {
    if (!gpsEnabled) { setMyPos(null); posRef.current = null; return; }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError("Geolocalização não suportada neste dispositivo.");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const next = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? 0 };
        posRef.current = { lat: next.lat, lng: next.lng };
        setMyPos(next);
        setGeoError(null);
      },
      (err) => {
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Permissão de localização negada."
            : "Não foi possível obter sua localização.",
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => { try { navigator.geolocation.clearWatch(id); } catch { /* noop */ } };
  }, [gpsEnabled]);

  // Marcador "você está aqui" (ponto azul pulsante) + círculo de precisão.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!myPos) {
      if (meMarkerRef.current) { try { meMarkerRef.current.remove(); } catch { /* noop */ } meMarkerRef.current = null; }
      if (meCircleRef.current) { try { meCircleRef.current.remove(); } catch { /* noop */ } meCircleRef.current = null; }
      return;
    }
    const latlng: [number, number] = [myPos.lat, myPos.lng];
    if (!meMarkerRef.current) {
      const icon = L.divIcon({
        className: "",
        html: `<div style="position:relative;width:18px;height:18px">
          <div class="animate-ping" style="position:absolute;inset:0;border-radius:9999px;background:#1a73e8;opacity:.35"></div>
          <div style="position:absolute;inset:3px;border-radius:9999px;background:#1a73e8;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></div>
        </div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      meMarkerRef.current = L.marker(latlng, { icon, zIndexOffset: 2000, interactive: false }).addTo(map);
    } else {
      meMarkerRef.current.setLatLng(latlng);
    }
    const accuracy = Math.min(Math.max(myPos.accuracy || 0, 5), 200);
    if (!meCircleRef.current) {
      meCircleRef.current = L.circle(latlng, {
        radius: accuracy, color: "#1a73e8", weight: 1, fillColor: "#1a73e8", fillOpacity: 0.12, interactive: false,
      }).addTo(map);
    } else {
      meCircleRef.current.setLatLng(latlng);
      meCircleRef.current.setRadius(accuracy);
    }
  }, [myPos]);

  const centerOnMe = () => {
    const map = mapRef.current;
    if (!map) return;
    if (posRef.current) { map.setView([posRef.current.lat, posRef.current.lng], Math.max(map.getZoom(), 16)); return; }
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        posRef.current = { lat: p.coords.latitude, lng: p.coords.longitude };
        setMyPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? 0 });
        map.setView([p.coords.latitude, p.coords.longitude], 16);
      },
      () => setGeoError("Permissão de localização negada."),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  };


  // Marcador DISTINTO da sede (independente do cleanup dos marcadores de poço).
  useEffect(() => {
    const map = mapRef.current;
    if (sedeMarkerRef.current) { try { sedeMarkerRef.current.remove(); } catch { /* noop */ } sedeMarkerRef.current = null; }
    if (!map || !sede || sede.lat == null || sede.lng == null) return;
    const label = escapeHtml(sede.name ?? "Sede");
    const icon = L.divIcon({
      className: "",
      html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%)">
        <div style="background:#4b3621;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.5);border:1px solid #f5f0e6">🏠 ${label}</div>
        <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #4b3621"></div>
      </div>`,
      iconAnchor: [0, 0],
    });
    const rows = [
      ["Fazenda", sede.name ?? "—"],
      ["Endereço", sede.endereco || "—"],
      ["Proprietário", sede.proprietario || "—"],
      ["Telefone", sede.phone || "—"],
    ]
      .map(([k, v]) => `<div style="display:flex;gap:6px"><span style="opacity:.6">${k}:</span><span style="font-weight:600">${escapeHtml(String(v))}</span></div>`)
      .join("");
    const m = L.marker([sede.lat, sede.lng], { icon, zIndexOffset: 1000 }).addTo(map);
    const sedePopup = () =>
      `<div style="font-size:12px;line-height:1.5;min-width:190px"><div style="font-weight:700;margin-bottom:4px">🏠 Sede da Fazenda</div>${rows}${gpsEnabled ? buildNavHtml(sede.lat, sede.lng, posRef.current) : ""}</div>`;
    m.bindPopup(sedePopup());
    m.on("popupopen", () => m.setPopupContent(sedePopup()));
    sedeMarkerRef.current = m;
    return () => { try { m.remove(); } catch { /* noop */ } };
  }, [sede, wells, gpsEnabled]);

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

        if (gpsEnabled) {
          const pLat = pump.lat as number;
          const pLng = pump.lng as number;
          const pumpPopup = () =>
            `<div style="min-width:190px;font-size:12px">
              <strong>${escapeHtml(pump.name)}</strong><br/>
              Status: <b>${isOffline ? "Offline" : pump.running ? "Ligada" : "Desligada"}</b>
              ${buildNavHtml(pLat, pLng, posRef.current)}
            </div>`;
          marker.bindPopup(pumpPopup());
          marker.on("popupopen", () => marker.setPopupContent(pumpPopup()));
        }

        markersRef.current.push(marker);
      });
    });
  }, [wells, gpsEnabled]);

  // Marcadores dos equipamentos de NÍVEL (reservatórios/canais) — ícone azul
  // com gota, deslocado ~22px à direita para nunca sobrepor o poço quando
  // as coordenadas coincidem.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    levelMarkersRef.current.forEach((m) => { try { m.remove(); } catch { /* noop */ } });
    levelMarkersRef.current = [];

    levels.forEach((r) => {
      const lat = r.lat as number;
      const lng = r.lng as number;
      const overlapsWell = wells.some(
        (p) => Math.abs((p.lat as number) - lat) < 0.0003 && Math.abs((p.lng as number) - lng) < 0.0003,
      );
      const offsetX = overlapsWell ? 22 : 0;
      const size = 20;
      const short = escapeHtml(shortReservoirName(r.name));
      const isOffline = r.online === false;
      const bg = isOffline ? "hsl(var(--muted-foreground))" : "#2563EB";

      const html = `<div style="position:relative;display:flex;flex-direction:column;align-items:center;">
        <div style="
          width:${size}px;height:${size}px;border-radius:9999px;display:flex;align-items:center;justify-content:center;
          background:${bg};border:2px solid hsl(var(--background));box-shadow:0 0 0 1px rgba(0,0,0,0.35);
          color:#fff;font-size:11px;line-height:1;">💧</div>
        <div style="margin-top:2px;background:rgba(37,99,235,.92);color:#fff;font-size:9px;font-weight:800;
          padding:1px 4px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.4)">${short}</div>
      </div>`;

      const icon = L.divIcon({
        className: "level-marker",
        html,
        iconSize: [size, size],
        iconAnchor: [size / 2 - offsetX, size / 2],
      });

      const marker = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(map);
      const levelPopup = () =>
        `<div style="min-width:190px;font-size:12px">
          <strong>${escapeHtml(r.name)}</strong><br/>
          Nível atual: <b>${r.percent}%</b> (${escapeHtml(r.level)} m)<br/>
          Altura do sensor: ${escapeHtml(r.maxLevel)}<br/>
          Limite baixo: ${r.alarmLow != null ? r.alarmLow : "—"}<br/>
          Limite alto: ${r.alarmHigh != null ? r.alarmHigh : "—"}
          ${gpsEnabled ? buildNavHtml(lat, lng, posRef.current) : ""}
        </div>`;
      marker.bindPopup(levelPopup());
      marker.on("popupopen", () => marker.setPopupContent(levelPopup()));
      levelMarkersRef.current.push(marker);
    });

    return () => {
      levelMarkersRef.current.forEach((m) => { try { m.remove(); } catch { /* noop */ } });
      levelMarkersRef.current = [];
    };
  }, [levels, wells, gpsEnabled]);

  const hasSedeCoords = !!(sede && sede.lat != null && sede.lng != null);

  if (wells.length === 0 && levels.length === 0 && !hasSedeCoords) {
    return (
      <div className="h-[640px] rounded-lg border border-border bg-card flex items-center justify-center text-sm text-muted-foreground">
        Nenhum poço com coordenadas cadastradas.
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setGpsEnabled((v) => {
                  const next = !v;
                  try { window.localStorage.setItem(GPS_PREF_KEY, next ? "on" : "off"); } catch { /* noop */ }
                  if (!next) setGeoError(null);
                  return next;
                });
              }}
              className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium min-h-[36px] ${gpsEnabled ? "border-primary/50 bg-primary/15 text-primary" : "border-border bg-background text-foreground hover:bg-secondary"}`}
              title="Ativar/desativar navegação GPS no mapa"
            >
              <Crosshair className="w-3.5 h-3.5" />
              GPS
            </button>
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

        </div>
        <div className="relative">
          <div ref={containerRef} className="h-[640px] w-full bg-muted/20" />
          <div className="absolute bottom-3 left-3 z-[500] rounded-md border border-border bg-card/90 backdrop-blur px-3 py-2 text-[11px] space-y-1 shadow-lg pointer-events-none">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-primary shrink-0" />
              <span className="w-2.5 h-2.5 rounded-full bg-destructive shrink-0" />
              <span className="text-foreground">Poço (ligado / desligado)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-info shrink-0" />
              <span className="text-foreground">Reservatório / Nível</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: "#4b3621" }} />
              <span className="text-foreground">Sede da Fazenda</span>
            </div>
            {gpsEnabled && (
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: "#1a73e8" }} />
                <span className="text-foreground">Você (GPS)</span>
              </div>
            )}
          </div>
          {gpsEnabled && (
            <button
              type="button"
              onClick={centerOnMe}
              aria-label="Minha localização"
              title="Minha localização"
              className="absolute top-3 right-3 z-[500] h-11 w-11 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full border border-border bg-card/95 text-foreground shadow-lg active:scale-95"
            >
              <Crosshair className="w-5 h-5" />
            </button>
          )}
          {gpsEnabled && geoError && (
            <div className="absolute top-16 right-3 z-[500] max-w-[220px] rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-lg">
              {geoError}
            </div>
          )}
        </div>

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
