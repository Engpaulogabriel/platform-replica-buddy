import { useMemo, useRef, useState, useLayoutEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Waves } from "lucide-react";
import type { Pump } from "@/components/dashboard/PumpTable";
import type { CloudEquipamento, EquipTipo, FonteTipo } from "@/hooks/useCadastrosCloud";
import { useUserFarms } from "@/hooks/useUserFarms";
import { useLevelHistory } from "@/hooks/useLevelHistory";

interface Reservoir {
  id: string;
  name: string;
  percent: number;
  level: string;
  maxLevel: string;
  alarm: boolean;
  online?: boolean;
}

interface WaterFlowDiagramProps {
  pumps: Pump[];
  reservoirs: Reservoir[];
  cloudEquipments: CloudEquipamento[];
}

type SourceKind = FonteTipo | "nivel" | "unset";

interface SourceNode { key: string; label: string; kind: SourceKind; }
interface EquipNode {
  id: string;
  name: string;
  type: EquipTipo;
  online: boolean;
  running: boolean;
  pending?: Pump["pending"];
  sourceKey: string;
  destKey: string;
}
interface DestNode {
  key: string;
  label: string;
  percent?: number;
  online: boolean;
  missing?: boolean;
  maxLevelM?: number;
  currentLevelM?: number;
}
interface FarmDiagram {
  farm: { id: string; nome: string };
  sources: Map<string, SourceNode>;
  dests: DestNode[];
  equips: EquipNode[];
}

const fonteLabel: Record<FonteTipo, string> = {
  rio: "Rio",
  riacho: "Riacho",
  canal: "Canal",
  piscina: "Piscina",
  poco: "Lençol Freático",
  reservatorio: "Reservatório",
};

function naturalSort(a: string, b: string) {
  return a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" });
}

function buildDiagrams(
  pumps: Pump[],
  reservoirs: Reservoir[],
  cloudEquipments: CloudEquipamento[],
  farmNames: Map<string, string>,
): FarmDiagram[] {
  const active = cloudEquipments.filter(e => e.active);
  if (active.length === 0) return [];

  const pumpsById = new Map(pumps.map(p => [p.id, p] as const));
  const reservoirsById = new Map(reservoirs.map(r => [r.id, r] as const));

  const byFarm = new Map<string, CloudEquipamento[]>();
  active.forEach(e => {
    const list = byFarm.get(e.farm_id) ?? [];
    list.push(e);
    byFarm.set(e.farm_id, list);
  });

  const diagrams: FarmDiagram[] = [];

  byFarm.forEach((farmEquips, farmId) => {
    const equipById = new Map(farmEquips.map(e => [e.id, e] as const));
    const sources = new Map<string, SourceNode>();
    const destMap = new Map<string, DestNode>();
    const equips: EquipNode[] = [];

    const sourceFor = (e: CloudEquipamento): SourceNode => {
      if (e.fonte_id && e.fonte_id !== e.id) {
        const src = equipById.get(e.fonte_id);
        if (src?.type === "nivel") return { key: `n:${src.id}`, label: src.name, kind: "nivel" };
      }
      if (e.fonte_tipo) return { key: `t:${e.fonte_tipo}`, label: fonteLabel[e.fonte_tipo] ?? e.fonte_tipo, kind: e.fonte_tipo };
      if (e.type === "poco") return { key: "t:poco", label: "Lençol Freático", kind: "poco" };
      return { key: "unset", label: "Sem origem", kind: "unset" };
    };

    const destFor = (e: CloudEquipamento): DestNode => {
      if (e.alimenta_id && e.alimenta_id !== e.id) {
        const dst = equipById.get(e.alimenta_id);
        if (dst?.type === "nivel") {
          const r = reservoirsById.get(dst.id);
          const parseM = (s?: string) => {
            if (!s) return undefined;
            const m = String(s).match(/([\d.,]+)/);
            return m ? Number(m[1].replace(",", ".")) : undefined;
          };
          return {
            key: `d:${dst.id}`,
            label: dst.name,
            percent: r?.percent,
            online: r?.online ?? true,
            maxLevelM: parseM(r?.maxLevel),
            currentLevelM: parseM(r?.level),
          };
        }
      }
      return { key: "d:unset", label: "Sem destino", online: false, missing: true };
    };

    farmEquips
      .filter(e => e.type === "poco" || e.type === "bombeamento")
      .forEach(e => {
        const src = sourceFor(e);
        const dst = destFor(e);
        const pump = pumpsById.get(e.id);
        if (!sources.has(src.key)) sources.set(src.key, src);
        if (!destMap.has(dst.key)) destMap.set(dst.key, dst);
        equips.push({
          id: e.id,
          name: e.name,
          type: e.type,
          online: pump?.online ?? true,
          running: pump?.running ?? false,
          pending: pump?.pending,
          sourceKey: src.key,
          destKey: dst.key,
        });
      });

    if (equips.length === 0) return;

    const dests = Array.from(destMap.values()).sort((a, b) => {
      if (!!a.missing !== !!b.missing) return a.missing ? 1 : -1;
      return naturalSort(a.label, b.label);
    });

    diagrams.push({
      farm: { id: farmId, nome: farmNames.get(farmId) ?? "Fazenda" },
      sources,
      dests,
      equips,
    });
  });

  return diagrams.sort((a, b) => naturalSort(a.farm.nome, b.farm.nome));
}

function pumpStatus(e: EquipNode) {
  if (!e.online || e.pending === "comm_fail") return "offline" as const;
  if (e.pending === "error") return "error" as const;
  if (e.pending === "turning_on" || e.pending === "turning_off") return "transitioning" as const;
  if (e.running) return "running" as const;
  return "stopped" as const;
}

function pumpColor(s: ReturnType<typeof pumpStatus>) {
  // Mesmas cores da aba Lista (PumpTable):
  // offline=cinza, transição=amarelo, ligado=verde primary, parada/erro=vermelho
  if (s === "running") return "hsl(var(--primary))";
  if (s === "transitioning") return "hsl(var(--warning))";
  if (s === "offline") return "hsl(var(--muted-foreground))";
  // stopped + error → destructive (igual à Lista)
  return "hsl(var(--destructive))";
}

// =================== Pump Icon (centrifugal water pump) ===================
function PumpIcon({ e, size = 44 }: { e: EquipNode; size?: number }) {
  const status = pumpStatus(e);
  const color = pumpColor(status);
  const active = status === "running";
  const r = size / 2 - 3;
  const cx = size / 2;
  const cy = size / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      {/* Halo ring */}
      <circle cx={cx} cy={cy} r={r} fill="hsl(var(--card))" stroke={color} strokeWidth={1.6} opacity={status === "stopped" ? 0.55 : 1} />

      {/* === Bomba centrífuga === */}
      {/* Corpo circular (voluta) */}
      <circle cx={cx} cy={cy - 1} r={9} fill="hsl(var(--card))" stroke={color} strokeWidth={1.3} />
      {/* Linhas internas da voluta (espiral) */}
      <path d={`M ${cx - 5} ${cy - 4} Q ${cx} ${cy - 8} ${cx + 5} ${cy - 4}`} fill="none" stroke={color} strokeWidth={0.6} opacity={0.5} />
      <path d={`M ${cx - 6} ${cy + 1} Q ${cx} ${cy + 6} ${cx + 6} ${cy + 1}`} fill="none" stroke={color} strokeWidth={0.6} opacity={0.5} />
      {/* Impulsor (cruz no centro) */}
      <g opacity={0.85}>
        <line x1={cx - 4} y1={cy - 1} x2={cx + 4} y2={cy - 1} stroke={color} strokeWidth={1} />
        <line x1={cx} y1={cy - 5} x2={cx} y2={cy + 3} stroke={color} strokeWidth={1} />
      </g>

      {/* Flange de entrada (esquerda) — sucção */}
      <rect x={cx - 14} y={cy - 4} width={5} height={6} rx={1} fill="hsl(var(--card))" stroke={color} strokeWidth={1} />
      <line x1={cx - 14} y1={cy - 4} x2={cx - 14} y2={cy + 2} stroke={color} strokeWidth={0.6} opacity={0.5} />
      <line x1={cx - 12} y1={cy - 4} x2={cx - 12} y2={cy + 2} stroke={color} strokeWidth={0.6} opacity={0.5} />
      {/* Tubo de sucção */}
      <line x1={cx - 14} y1={cy - 1} x2={cx - 9} y2={cy - 1} stroke={color} strokeWidth={1.2} />

      {/* Flange de saída (topo direito) — recalque */}
      <rect x={cx + 5} y={cy - 12} width={6} height={5} rx={1} fill="hsl(var(--card))" stroke={color} strokeWidth={1} />
      <line x1={cx + 5} y1={cy - 12} x2={cx + 11} y2={cy - 12} stroke={color} strokeWidth={0.6} opacity={0.5} />
      <line x1={cx + 5} y1={cy - 10} x2={cx + 11} y2={cy - 10} stroke={color} strokeWidth={0.6} opacity={0.5} />
      {/* Tubo de recalque (curva 90°) */}
      <path d={`M ${cx + 5} ${cy - 9.5} Q ${cx + 2} ${cy - 9.5} ${cx + 2} ${cy - 6}`} fill="none" stroke={color} strokeWidth={1.2} />

      {/* Base / pés de apoio */}
      <rect x={cx - 8} y={cy + 8} width={16} height={2.5} rx={0.5} fill={color} opacity={0.5} />
      <line x1={cx - 5} y1={cy + 10.5} x2={cx - 5} y2={cy + 13} stroke={color} strokeWidth={0.9} opacity={0.6} />
      <line x1={cx + 5} y1={cy + 10.5} x2={cx + 5} y2={cy + 13} stroke={color} strokeWidth={0.9} opacity={0.6} />

      {/* Parafusos no flange (detalhe) */}
      <circle cx={cx - 13} cy={cy - 2.5} r={0.6} fill={color} opacity={0.7} />
      <circle cx={cx - 13} cy={cy + 0.5} r={0.6} fill={color} opacity={0.7} />
      <circle cx={cx + 6} cy={cy - 11} r={0.6} fill={color} opacity={0.7} />
      <circle cx={cx + 10} cy={cy - 11} r={0.6} fill={color} opacity={0.7} />

      {/* Status LED */}
      <circle cx={cx + r - 3} cy={cy - r + 3} r={2.6} fill={color}>
        {active && <animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite" />}
      </circle>
      {/* Glow when active */}
      {active && (
        <circle cx={cx} cy={cy} r={r + 1} fill="none" stroke={color} strokeWidth={0.8} opacity={0.5}>
          <animate attributeName="r" values={`${r};${r + 3};${r}`} dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0.1;0.5" dur="2s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}

// =================== Source Illustration ===================
function SourceIllustration({ kind }: { kind: SourceKind }) {
  if (kind === "rio" || kind === "riacho" || kind === "canal") {
    return (
      <svg viewBox="0 0 160 80" className="w-full h-20">
        <defs>
          <linearGradient id={`water-${kind}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity="0.35" />
            <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity="0.7" />
          </linearGradient>
        </defs>
        <path d="M 0 30 Q 30 20 60 30 T 120 30 T 200 30 L 200 80 L 0 80 Z" fill={`url(#water-${kind})`} />
        {[20, 38, 56].map((y, i) => (
          <path key={y}
            d={`M 5 ${y + 12} Q 30 ${y + 6} 55 ${y + 12} T 105 ${y + 12} T 155 ${y + 12}`}
            fill="none" stroke="hsl(var(--info))" strokeWidth="1.4" opacity={0.7 - i * 0.18}>
            <animate attributeName="d"
              values={`M 5 ${y + 12} Q 30 ${y + 6} 55 ${y + 12} T 105 ${y + 12} T 155 ${y + 12};M 5 ${y + 12} Q 30 ${y + 18} 55 ${y + 12} T 105 ${y + 12} T 155 ${y + 12};M 5 ${y + 12} Q 30 ${y + 6} 55 ${y + 12} T 105 ${y + 12} T 155 ${y + 12}`}
              dur={`${3 + i * 0.5}s`} repeatCount="indefinite" />
          </path>
        ))}
        {/* Pedras */}
        <ellipse cx="22" cy="68" rx="10" ry="4" fill="hsl(var(--muted-foreground) / 0.5)" />
        <ellipse cx="120" cy="72" rx="14" ry="5" fill="hsl(var(--muted-foreground) / 0.4)" />
        {kind === "riacho" && (
          <g>
            {[8, 28, 130, 148].map(x => (
              <g key={x} transform={`translate(${x} 60)`}>
                <line x1="0" y1="0" x2="-2" y2="-10" stroke="hsl(var(--primary))" strokeWidth="1" />
                <line x1="0" y1="0" x2="0" y2="-12" stroke="hsl(var(--primary))" strokeWidth="1" />
                <line x1="0" y1="0" x2="2" y2="-10" stroke="hsl(var(--primary))" strokeWidth="1" />
              </g>
            ))}
          </g>
        )}
      </svg>
    );
  }

  if (kind === "poco") {
    return (
      <svg viewBox="0 0 160 80" className="w-full h-20">
        {/* Camadas de solo */}
        <rect x="0" y="20" width="160" height="14" fill="hsl(35 35% 60% / 0.3)" />
        <rect x="0" y="34" width="160" height="14" fill="hsl(30 40% 50% / 0.35)" />
        <rect x="0" y="48" width="160" height="14" fill="hsl(25 45% 40% / 0.4)" />
        {/* Lençol d'água */}
        <rect x="0" y="62" width="160" height="18" fill="hsl(var(--info) / 0.4)" />
        <path d="M 0 64 Q 40 60 80 64 T 160 64" stroke="hsl(var(--info))" strokeWidth="1.2" fill="none" strokeDasharray="2 3" opacity="0.7" />
        {/* Tubo do poço artesiano */}
        <rect x="76" y="14" width="8" height="56" fill="hsl(var(--card))" stroke="hsl(var(--info))" strokeWidth="1.2" />
        {/* Cabeçote / boca do poço */}
        <rect x="71" y="10" width="18" height="5" rx="1" fill="hsl(var(--info))" opacity="0.75" />
        <rect x="74" y="6" width="4" height="5" fill="hsl(var(--muted-foreground))" opacity="0.7" />
        {/* Tubulação de recalque (linha pontilhada subindo dentro do tubo) */}
        <line x1="80" y1="16" x2="80" y2="62" stroke="hsl(var(--info))" strokeWidth="0.8" strokeDasharray="2 2" opacity="0.85" />
        {/* === Bomba submersa (artesiana) dentro do lençol === */}
        <g>
          {/* Corpo cilíndrico alongado */}
          <rect x="77" y="62" width="6" height="14" rx="1.2" fill="hsl(var(--card))" stroke="hsl(var(--primary))" strokeWidth="1" />
          {/* Estágios da bomba (anéis) */}
          {[64.5, 67, 69.5, 72].map(y => (
            <line key={y} x1="77.5" y1={y} x2="82.5" y2={y} stroke="hsl(var(--primary))" strokeWidth="0.5" opacity="0.7" />
          ))}
          {/* Crivo de sucção (base) */}
          <rect x="78" y="76" width="4" height="1.5" fill="hsl(var(--primary))" opacity="0.8" />
          <line x1="78.5" y1="77.5" x2="78.5" y2="79" stroke="hsl(var(--primary))" strokeWidth="0.5" />
          <line x1="80" y1="77.5" x2="80" y2="79" stroke="hsl(var(--primary))" strokeWidth="0.5" />
          <line x1="81.5" y1="77.5" x2="81.5" y2="79" stroke="hsl(var(--primary))" strokeWidth="0.5" />
          {/* Cabo de energia */}
          <path d="M 78 62 Q 76 50 78 38 Q 80 26 78 16" stroke="hsl(var(--warning))" strokeWidth="0.5" fill="none" opacity="0.7" />
        </g>
        {/* Vegetação */}
        <g>
          {[10, 30, 130, 150].map(x => (
            <g key={x} transform={`translate(${x} 20)`}>
              <line x1="0" y1="0" x2="-2" y2="-6" stroke="hsl(var(--primary))" strokeWidth="0.8" />
              <line x1="0" y1="0" x2="0" y2="-7" stroke="hsl(var(--primary))" strokeWidth="0.8" />
              <line x1="0" y1="0" x2="2" y2="-6" stroke="hsl(var(--primary))" strokeWidth="0.8" />
            </g>
          ))}
        </g>
      </svg>
    );
  }

  if (kind === "piscina" || kind === "reservatorio" || kind === "nivel") {
    return (
      <svg viewBox="0 0 160 80" className="w-full h-20">
        <rect x="14" y="18" width="132" height="50" rx="4" fill="hsl(var(--info) / 0.25)" stroke="hsl(var(--info))" strokeWidth="1.4" />
        <path d="M 18 36 Q 50 30 80 36 T 142 36" stroke="hsl(var(--info))" strokeWidth="1.4" fill="none" />
        <path d="M 18 48 Q 50 42 80 48 T 142 48" stroke="hsl(var(--info))" strokeWidth="1" fill="none" opacity="0.6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 160 80" className="w-full h-20">
      <path d="M 80 20 L 100 56 L 60 56 Z" fill="hsl(var(--warning) / 0.2)" stroke="hsl(var(--warning))" strokeWidth="1.4" />
      <text x="80" y="50" textAnchor="middle" fontSize="22" fontWeight="900" fill="hsl(var(--warning))">!</text>
    </svg>
  );
}

// =================== Trapezoidal Canal Tank ===================
function CanalTank({ d, accent, height = 200 }: { d: DestNode; accent: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, d.percent ?? 0));
  const warn = d.missing || !d.online;
  const w = 200;
  const h = height;

  // Trapézio: topo largo, fundo estreito
  const inset = 26;
  const padX = 14;
  const topY = 14;
  const botY = h - 14;
  const tl = { x: padX, y: topY };
  const tr = { x: w - padX, y: topY };
  const br = { x: w - padX - inset, y: botY };
  const bl = { x: padX + inset, y: botY };
  const trapezoid = `M ${tl.x} ${tl.y} L ${tr.x} ${tr.y} L ${br.x} ${br.y} L ${bl.x} ${bl.y} Z`;

  // Água dentro do canal — interpola lados conforme nível
  const lvl = pct / 100;
  const bodyH = botY - topY;
  const wTopY = botY - bodyH * lvl;
  const tLeft = lvl;
  const wbl = { x: bl.x + (tl.x - bl.x) * tLeft, y: wTopY };
  const wbr = { x: br.x + (tr.x - br.x) * tLeft, y: wTopY };
  const water = `M ${wbl.x} ${wbl.y} L ${wbr.x} ${wbr.y} L ${br.x} ${br.y} L ${bl.x} ${bl.y} Z`;
  const waveMid = (wbl.x + wbr.x) / 2;

  // Régua de metros
  const maxM = d.maxLevelM ?? 3;
  const stepM = maxM <= 2 ? 0.5 : maxM <= 6 ? 1 : 2;
  const ticks: number[] = [];
  for (let m = 0; m <= maxM + 0.0001; m += stepM) ticks.push(Math.round(m * 10) / 10);
  const rulerX = w - padX + 4;

  return (
    <svg viewBox={`0 0 ${w + 28} ${h}`} className="w-full" style={{ maxHeight: h }}>
      {/* Trapézio (canal) */}
      <path d={trapezoid} fill="hsl(var(--background))" stroke={accent} strokeWidth={1.8} strokeLinejoin="round" />

      {/* Régua */}
      {!warn && (
        <g>
          <line x1={rulerX} y1={topY} x2={rulerX} y2={botY} stroke="hsl(var(--muted-foreground))" strokeWidth={0.6} opacity={0.6} />
          {ticks.map((m, i) => {
            const t = m / maxM;
            const ty = botY - bodyH * t;
            const isMajor = i === 0 || i === ticks.length - 1 || m % 1 === 0;
            const len = isMajor ? 5 : 3;
            return (
              <g key={m}>
                <line x1={rulerX} y1={ty} x2={rulerX + len} y2={ty} stroke="hsl(var(--muted-foreground))" strokeWidth={isMajor ? 0.8 : 0.5} opacity={isMajor ? 0.85 : 0.5} />
                {isMajor && (
                  <text x={rulerX + len + 2} y={ty + 3} fontSize="8" fontWeight="600" fill="hsl(var(--muted-foreground))">
                    {m}m
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )}

      {/* Água */}
      {d.percent != null && !warn && (
        <g>
          <path d={water} fill={accent} opacity={0.55} />
          <path
            d={`M ${wbl.x} ${wTopY} Q ${waveMid} ${wTopY - 3} ${wbr.x} ${wTopY} L ${wbr.x} ${wTopY + 2} L ${wbl.x} ${wTopY + 2} Z`}
            fill={accent} opacity={0.85}
          >
            <animate attributeName="d"
              values={`M ${wbl.x} ${wTopY} Q ${waveMid} ${wTopY - 3} ${wbr.x} ${wTopY} L ${wbr.x} ${wTopY + 2} L ${wbl.x} ${wTopY + 2} Z;M ${wbl.x} ${wTopY} Q ${waveMid} ${wTopY + 2} ${wbr.x} ${wTopY} L ${wbr.x} ${wTopY + 2} L ${wbl.x} ${wTopY + 2} Z;M ${wbl.x} ${wTopY} Q ${waveMid} ${wTopY - 3} ${wbr.x} ${wTopY} L ${wbr.x} ${wTopY + 2} L ${wbl.x} ${wTopY + 2} Z`}
              dur="3s" repeatCount="indefinite" />
          </path>
          {/* % grande */}
          <text x={w / 2} y={topY + bodyH / 2 + 8} textAnchor="middle" fontSize="28" fontWeight="900" fill="hsl(var(--card))" stroke={accent} strokeWidth={0.4}>
            {pct}%
          </text>
        </g>
      )}

      {warn && (
        <g transform={`translate(${w / 2 - 12} ${h / 2 - 8})`}>
          <path d="M 12 0 L 24 22 L 0 22 Z" fill="hsl(var(--warning) / 0.2)" stroke="hsl(var(--warning))" strokeWidth={1.5} />
          <text x={12} y={18} textAnchor="middle" fontSize="13" fontWeight="900" fill="hsl(var(--warning))">!</text>
        </g>
      )}
    </svg>
  );
}

// =================== Sparkline 24h (real, agregado por hora) ===================
function Sparkline24h({ equipmentId, currentPct, accent }: { equipmentId: string | null; currentPct: number; accent: string }) {
  const now = useMemo(() => new Date(), []);
  const from = useMemo(() => new Date(now.getTime() - 24 * 60 * 60 * 1000), [now]);
  const { data, loading } = useLevelHistory(equipmentId, from, now);

  // Agrega 24 pontos (1 por hora). Cada bucket = média de % das amostras nessa hora.
  const buckets = useMemo(() => {
    const arr: Array<number | null> = Array(24).fill(null);
    const sum: number[] = Array(24).fill(0);
    const cnt: number[] = Array(24).fill(0);
    const t0 = from.getTime();
    data.forEach(p => {
      if (p.percent == null) return;
      const t = new Date(p.read_at).getTime();
      const idx = Math.min(23, Math.max(0, Math.floor((t - t0) / 3_600_000)));
      sum[idx] += p.percent;
      cnt[idx] += 1;
    });
    for (let i = 0; i < 24; i++) if (cnt[i] > 0) arr[i] = sum[i] / cnt[i];
    // Forward-fill para suavizar buracos
    let last: number | null = null;
    const filled = arr.map(v => {
      if (v != null) { last = v; return v; }
      return last;
    });
    // Garante o último ponto = currentPct
    filled[23] = currentPct;
    // Backward-fill se ainda houver null no início
    let next: number = currentPct;
    for (let i = 23; i >= 0; i--) {
      if (filled[i] == null) filled[i] = next;
      else next = filled[i] as number;
    }
    return filled as number[];
  }, [data, currentPct, from]);

  const w = 200, h = 36;
  const n = 24;
  const pts = buckets.map((v, i) => ({
    x: ((i / (n - 1)) * (w - 4)) + 2,
    y: h - 2 - (Math.max(0, Math.min(100, v)) / 100) * (h - 4),
  }));
  const linePath = "M " + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  const areaPath = `${linePath} L ${pts[n - 1].x} ${h - 2} L ${pts[0].x} ${h - 2} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} className="block" opacity={loading ? 0.5 : 1}>
      {/* eixo base + marcas a cada 6h */}
      <line x1="2" y1={h - 2} x2={w - 2} y2={h - 2} stroke="hsl(var(--muted-foreground))" strokeWidth="0.4" opacity="0.3" />
      {[0, 6, 12, 18, 24].map(hh => {
        const x = ((hh / 24) * (w - 4)) + 2;
        return <line key={hh} x1={x} y1={h - 2} x2={x} y2={h - 4} stroke="hsl(var(--muted-foreground))" strokeWidth="0.4" opacity="0.4" />;
      })}
      <path d={areaPath} fill={accent} opacity={0.18} />
      <path d={linePath} fill="none" stroke={accent} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      {/* ponto atual */}
      <circle cx={pts[n - 1].x} cy={pts[n - 1].y} r="2" fill={accent} />
    </svg>
  );
}

// Calcula tendência %/h média a partir do primeiro e último valor não-nulos das últimas 24h.
function useTrendPerHour(equipmentId: string | null, currentPct: number) {
  const now = useMemo(() => new Date(), []);
  const from = useMemo(() => new Date(now.getTime() - 24 * 60 * 60 * 1000), [now]);
  const { data } = useLevelHistory(equipmentId, from, now);
  return useMemo(() => {
    const valid = data.filter(p => p.percent != null);
    if (valid.length < 2) return 0;
    const first = valid[0];
    const dtH = (now.getTime() - new Date(first.read_at).getTime()) / 3_600_000;
    if (dtH < 0.5) return 0;
    return (currentPct - (first.percent as number)) / dtH;
  }, [data, currentPct, now]);
}

// Bloco do destino: sparkline 24h real + tendência %/h calculada do histórico.
function DestSparklineBlock({ destKey, pct, accent }: { destKey: string; pct: number; accent: string }) {
  // destKey = "d:<equipmentId>"
  const equipmentId = destKey.startsWith("d:") ? destKey.slice(2) : null;
  const trendVal = useTrendPerHour(equipmentId, pct);
  const trendUp = trendVal >= 0;
  const status = pct >= 90 ? "Cheio" : pct <= 15 ? "Crítico" : trendUp ? "Enchendo" : "Esvaziando";
  const trendDisplay = Math.abs(trendVal) < 0.05 ? "Estável" : `${trendVal > 0 ? "+" : ""}${trendVal.toFixed(1)}%/h ${trendUp ? "↑" : "↓"}`;
  return (
    <div className="mt-2">
      <div className="mb-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Últimas 24h</span>
        <span className="font-mono opacity-70">−24h ··· agora</span>
      </div>
      <Sparkline24h equipmentId={equipmentId} currentPct={pct} accent={accent} />
      <div className="mt-1 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: accent }}>
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
          {status}
        </span>
        <span className="rounded-md px-1.5 py-0.5 text-[10px] font-bold text-card" style={{ background: accent }}>
          {trendDisplay}
        </span>
      </div>
    </div>
  );
}

// =================== FarmPanel ===================
function FarmPanel({ diagram }: { diagram: FarmDiagram }) {
  const totalActive = diagram.equips.filter(e => e.online && e.running).length;

  // Paleta suave por destino
  const DEST_PALETTE = [
    "hsl(205 55% 55%)",
    "hsl(28 60% 58%)",
    "hsl(160 38% 50%)",
    "hsl(275 35% 60%)",
    "hsl(340 40% 60%)",
  ];
  const destColor = new Map(diagram.dests.map((d, i) => [d.key, DEST_PALETTE[i % DEST_PALETTE.length]] as const));
  const destLabelByKey = new Map(diagram.dests.map(d => [d.key, d.label] as const));

  // Agrupar por (source × dest) para os section-cards de bombas
  const sourcesArr = Array.from(diagram.sources.values()).sort((a, b) => naturalSort(a.label, b.label));
  const sections = sourcesArr.flatMap(src => {
    const byDest = new Map<string, EquipNode[]>();
    diagram.equips.filter(e => e.sourceKey === src.key).forEach(e => {
      const list = byDest.get(e.destKey) ?? [];
      list.push(e);
      byDest.set(e.destKey, list);
    });
    return Array.from(byDest.entries())
      .sort(([a], [b]) => naturalSort(destLabelByKey.get(a) ?? a, destLabelByKey.get(b) ?? b))
      .map(([destKey, equips]) => ({
        source: src,
        destKey,
        destLabel: destLabelByKey.get(destKey) ?? "Sem destino",
        equips: equips.sort((a, b) => naturalSort(a.name, b.name)),
        accent: destColor.get(destKey) ?? "hsl(var(--info))",
      }));
  });

  // Contagem de bombas por fonte (para o card da fonte)
  const pumpsBySource = new Map<string, number>();
  diagram.equips.forEach(e => pumpsBySource.set(e.sourceKey, (pumpsBySource.get(e.sourceKey) ?? 0) + 1));

  // === Refs para calcular trajetos das conexões ===
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sourceRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const sectionRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const destRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const pivotRef = useRef<HTMLDivElement | null>(null);

  type Edge = { d: string; color: string; dashed?: boolean; opacity?: number };
  const [edges, setEdges] = useState<Edge[]>([]);

  // Refs estáveis dos dados (lidos pelo recalc sem virar dependência)
  const sectionsRef = useRef(sections);
  const destsRef = useRef(diagram.dests);
  const destColorRef = useRef(destColor);
  sectionsRef.current = sections;
  destsRef.current = diagram.dests;
  destColorRef.current = destColor;

  // Chave estrutural — só muda quando a topologia muda (não a cada polling)
  const structKey = useMemo(
    () => sections.map(s => `${s.source.key}|${s.destKey}|${s.equips.length}`).join(",") + "::" + diagram.dests.map(d => d.key).join(","),
    [sections, diagram.dests],
  );

  const recalcEdges = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const rel = (el: HTMLElement | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left - gridRect.left,
        right: r.right - gridRect.left,
        top: r.top - gridRect.top,
        bottom: r.bottom - gridRect.top,
        cy: r.top - gridRect.top + r.height / 2,
      };
    };

    const next: Edge[] = [];

    sectionsRef.current.forEach(sec => {
      const sR = rel(sourceRefs.current.get(sec.source.key));
      const cR = rel(sectionRefs.current.get(`${sec.source.key}|${sec.destKey}`));
      if (!sR || !cR) return;
      const x1 = sR.right;
      const y1 = sR.cy;
      const x2 = cR.left;
      const y2 = cR.top + 18;
      const midX = x1 + Math.max(8, (x2 - x1) / 2);
      next.push({
        d: `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`,
        color: sec.accent,
        opacity: 0.7,
      });

      const dR = rel(destRefs.current.get(sec.destKey));
      if (!dR) return;
      const ax1 = cR.right;
      const ay1 = cR.top + 18;
      const ax2 = dR.left;
      const ay2 = dR.top + 24;
      const aMid = ax1 + Math.max(8, (ax2 - ax1) / 2);
      next.push({
        d: `M ${ax1} ${ay1} L ${aMid} ${ay1} L ${aMid} ${ay2} L ${ax2} ${ay2}`,
        color: sec.accent,
        opacity: 0.75,
      });
    });

    const pR = rel(pivotRef.current);
    if (pR) {
      destsRef.current.forEach(d => {
        const dR = rel(destRefs.current.get(d.key));
        if (!dR) return;
        const accent = destColorRef.current.get(d.key) ?? "hsl(var(--info))";
        const x1 = dR.right;
        const y1 = dR.top + (dR.bottom - dR.top) / 2;
        const x2 = pR.left;
        const y2 = pR.top + (pR.bottom - pR.top) / 2;
        const cx1 = x1 + (x2 - x1) * 0.5;
        const cx2 = x1 + (x2 - x1) * 0.5;
        next.push({
          d: `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`,
          color: accent,
          dashed: true,
          opacity: 0.55,
        });
      });
    }

    setEdges(prev => {
      if (
        prev.length === next.length &&
        prev.every((p, i) => p.d === next[i].d && p.color === next[i].color)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  // Recalc só em: mount, mudança estrutural e window resize.
  // Sem ResizeObserver para evitar loop com setState.
  useLayoutEffect(() => {
    recalcEdges();
    const onResize = () => recalcEdges();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [recalcEdges, structKey]);


  return (
    <div className="flex flex-col gap-3">
      {/* === Header === */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 ring-1 ring-primary/30">
            <Waves className="h-4 w-4 text-primary" />
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground leading-none">Painel SCADA — Captação</div>
            <div className="text-sm font-bold text-foreground leading-tight mt-0.5">{diagram.farm.nome}</div>
          </div>
        </div>

        <div className="ml-2 flex flex-wrap items-center gap-3 text-[11px]">
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-primary" />Operando</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-warning" />Transição</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-destructive" />Falha</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-muted-foreground" />Parada</span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-foreground"><b className="font-bold">{diagram.sources.size}</b> <span className="text-muted-foreground font-normal">origens</span></span>
          <span className="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-foreground"><b className="font-bold">{diagram.equips.length}</b> <span className="text-muted-foreground font-normal">bombas</span></span>
          <span className="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-foreground"><b className="font-bold">{diagram.dests.length}</b> <span className="text-muted-foreground font-normal">destinos</span></span>
          {totalActive > 0 && (
            <span className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-bold text-primary-foreground shadow-[0_0_12px_hsl(var(--primary)/0.4)]">
              {totalActive} em operação
            </span>
          )}
        </div>
      </div>

      {/* === Painel principal === */}
      <Card className="relative overflow-hidden border-border bg-card p-4">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-info/[0.03] via-transparent to-primary/[0.03]" />

        <div ref={gridRef} className="relative grid gap-4" style={{ gridTemplateColumns: "180px minmax(0,1fr) 240px 200px" }}>
          {/* === Overlay de conexões === */}
          {edges.length > 0 && (
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ zIndex: 1 }}
              preserveAspectRatio="none"
            >
              {edges.map((e, i) => (
                <path
                  key={i}
                  d={e.d}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={1.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={e.dashed ? "4 4" : undefined}
                  opacity={e.opacity ?? 0.7}
                />
              ))}
            </svg>
          )}
          {/* Column titles */}
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Fontes</div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Bombas</div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Destinos</div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Irrigação</div>

          {/* === FONTES === */}
          <div className="flex flex-col gap-3">
            {sourcesArr.map(src => (
              <div
                key={src.key}
                ref={el => { sourceRefs.current.set(src.key, el); }}
                className="relative z-10 rounded-xl border border-border bg-background/50 p-3 shadow-sm"
              >
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-foreground">{src.label}</div>
                <SourceIllustration kind={src.kind} />
                <div className="mt-1 text-[11px] text-muted-foreground">
                  <b className="text-foreground font-bold">{pumpsBySource.get(src.key) ?? 0}</b> bombas
                </div>
              </div>
            ))}
          </div>

          {/* === BOMBAS === (section-cards por fonte→destino) */}
          <div className="flex flex-col gap-3">
            {sections.map(sec => (
              <div
                key={`${sec.source.key}-${sec.destKey}`}
                ref={el => { sectionRefs.current.set(`${sec.source.key}|${sec.destKey}`, el); }}
                className="relative z-10 rounded-xl border border-border bg-background/50 p-3 shadow-sm"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">{sec.source.label}</span>
                  <span className="text-[11px] text-muted-foreground">→</span>
                  <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: sec.accent }}>{sec.destLabel}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{sec.equips.length} bombas</span>
                </div>

                <div className="flex flex-wrap items-start gap-y-3">
                  {sec.equips.map((e, idx) => (
                    <div key={e.id} className="flex items-center">
                      <div className="flex flex-col items-center gap-0.5 min-w-[58px] px-1">
                        <PumpIcon e={e} size={42} />
                        <div className="text-[10px] font-bold leading-tight text-foreground">{e.name}</div>
                        <div className="text-[9px] leading-tight text-muted-foreground">T: 4h32</div>
                      </div>
                      {idx < sec.equips.length - 1 && (
                        <svg width="22" height="42" viewBox="0 0 22 42" className="shrink-0 -mx-0.5" style={{ marginTop: -18 }}>
                          {/* Linha horizontal contínua centralizada no ícone (size 42 → cy ≈ 21) */}
                          <line x1="0" y1="21" x2="17" y2="21" stroke={sec.accent} strokeWidth="1.8" strokeLinecap="round" />
                          {/* Cabeça de seta */}
                          <path d="M 14 16 L 21 21 L 14 26" fill="none" stroke={sec.accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* === DESTINOS === */}
          <div className="flex flex-col gap-3">
            {diagram.dests.map(d => {
              const accent = destColor.get(d.key) ?? "hsl(var(--info))";
              return (
                <div
                  key={d.key}
                  ref={el => { destRefs.current.set(d.key, el); }}
                  className="relative z-10 rounded-xl border border-border bg-background/50 p-3 shadow-sm"
                >
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: accent }}>{d.label}</div>
                  <CanalTank d={d} accent={accent} height={140} />
                  {!d.missing && d.online && d.percent != null && (
                    <DestSparklineBlock destKey={d.key} pct={d.percent} accent={accent} />
                  )}
                </div>
              );
            })}
          </div>

          {/* === IRRIGAÇÃO (PIVÔ CENTRAL — vista superior) === */}
          <div className="flex flex-col items-center justify-center">
            <div ref={pivotRef} className="relative z-10 rounded-xl border border-border bg-background/50 p-3 shadow-sm w-full">
              <svg viewBox="-110 -110 220 220" className="w-full h-44">
                <defs>
                  {/* Campo gradiente verde */}
                  <radialGradient id="pivot-field-top" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="hsl(var(--primary) / 0.35)" />
                    <stop offset="70%" stopColor="hsl(var(--primary) / 0.18)" />
                    <stop offset="100%" stopColor="hsl(var(--primary) / 0.05)" />
                  </radialGradient>
                  {/* Setor irrigado (rastro do braço) */}
                  <radialGradient id="pivot-wet" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="hsl(var(--info) / 0.55)" />
                    <stop offset="100%" stopColor="hsl(var(--info) / 0.05)" />
                  </radialGradient>
                  {/* Lança metálica */}
                  <linearGradient id="pivot-lance" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--muted-foreground))" />
                    <stop offset="50%" stopColor="hsl(var(--foreground))" />
                    <stop offset="100%" stopColor="hsl(var(--muted-foreground))" />
                  </linearGradient>
                </defs>

                {/* Campo circular (base) */}
                <circle cx="0" cy="0" r="95" fill="url(#pivot-field-top)" stroke="hsl(var(--primary) / 0.5)" strokeWidth="1.2" strokeDasharray="4 3" />

                {/* Anéis concêntricos sutis (linhas de plantio) */}
                <circle cx="0" cy="0" r="70" fill="none" stroke="hsl(var(--primary) / 0.25)" strokeWidth="0.5" strokeDasharray="2 4" />
                <circle cx="0" cy="0" r="45" fill="none" stroke="hsl(var(--primary) / 0.25)" strokeWidth="0.5" strokeDasharray="2 4" />
                <circle cx="0" cy="0" r="22" fill="none" stroke="hsl(var(--primary) / 0.25)" strokeWidth="0.5" strokeDasharray="2 4" />

                {/* Marcadores cardeais (N/S/L/O sutis) */}
                <text x="0" y="-100" textAnchor="middle" fontSize="6" fontWeight="700" fill="hsl(var(--muted-foreground))" opacity="0.5">N</text>
                <text x="0" y="106" textAnchor="middle" fontSize="6" fontWeight="700" fill="hsl(var(--muted-foreground))" opacity="0.5">S</text>
                <text x="103" y="2" textAnchor="middle" fontSize="6" fontWeight="700" fill="hsl(var(--muted-foreground))" opacity="0.5">L</text>
                <text x="-103" y="2" textAnchor="middle" fontSize="6" fontWeight="700" fill="hsl(var(--muted-foreground))" opacity="0.5">O</text>

                {/* === Braço rotativo === */}
                <g>
                  {totalActive > 0 && (
                    <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="60s" repeatCount="indefinite" />
                  )}

                  {/* Setor irrigado atrás do braço (rastro de 60°) */}
                  {totalActive > 0 && (
                    <path d="M 0 0 L 92 0 A 92 92 0 0 0 46 -79.67 Z" fill="url(#pivot-wet)" opacity="0.6" />
                  )}

                  {/* Treliça (lança principal) */}
                  <line x1="0" y1="-1.4" x2="92" y2="-1.4" stroke="url(#pivot-lance)" strokeWidth="2.2" strokeLinecap="round" />
                  <line x1="0" y1="1.4" x2="92" y2="1.4" stroke="url(#pivot-lance)" strokeWidth="2.2" strokeLinecap="round" />

                  {/* Diagonais da treliça (zig-zag) */}
                  {Array.from({ length: 14 }).map((_, i) => {
                    const x1 = 6 + i * 6;
                    const x2 = x1 + 6;
                    return (
                      <g key={i}>
                        <line x1={x1} y1="-1.4" x2={x2} y2="1.4" stroke="hsl(var(--muted-foreground))" strokeWidth="0.6" opacity="0.85" />
                        <line x1={x1} y1="1.4" x2={x2} y2="-1.4" stroke="hsl(var(--muted-foreground))" strokeWidth="0.6" opacity="0.85" />
                      </g>
                    );
                  })}

                  {/* Torres de apoio (com rodas duplas vista de cima) */}
                  {[24, 48, 72].map((x, i) => (
                    <g key={`tower-${i}`}>
                      {/* base/sapata da torre */}
                      <rect x={x - 4} y={-5} width="8" height="10" rx="1" fill="hsl(var(--card))" stroke="hsl(var(--foreground))" strokeWidth="0.8" />
                      {/* rodas (vista superior = retângulos pretos) */}
                      <rect x={x - 5} y={-6} width="2" height="3" fill="hsl(var(--foreground))" />
                      <rect x={x + 3} y={-6} width="2" height="3" fill="hsl(var(--foreground))" />
                      <rect x={x - 5} y={3} width="2" height="3" fill="hsl(var(--foreground))" />
                      <rect x={x + 3} y={3} width="2" height="3" fill="hsl(var(--foreground))" />
                    </g>
                  ))}

                  {/* Aspersores (gotas pingando) */}
                  {totalActive > 0 && [12, 30, 48, 66, 84].map((x, i) => (
                    <g key={`spray-${i}`}>
                      <circle cx={x} cy={5} r="1.4" fill="hsl(var(--info))">
                        <animate attributeName="opacity" values="0.2;1;0.2" dur="1.6s" begin={`${i * 0.2}s`} repeatCount="indefinite" />
                        <animate attributeName="cy" values="5;10;5" dur="1.6s" begin={`${i * 0.2}s`} repeatCount="indefinite" />
                      </circle>
                      <circle cx={x} cy={-5} r="1.4" fill="hsl(var(--info))">
                        <animate attributeName="opacity" values="0.2;1;0.2" dur="1.6s" begin={`${i * 0.2 + 0.3}s`} repeatCount="indefinite" />
                        <animate attributeName="cy" values="-5;-10;-5" dur="1.6s" begin={`${i * 0.2 + 0.3}s`} repeatCount="indefinite" />
                      </circle>
                    </g>
                  ))}

                  {/* Canhão final (end-gun) */}
                  <circle cx="92" cy="0" r="3" fill="hsl(var(--primary))" stroke="hsl(var(--card))" strokeWidth="0.6" />
                  {totalActive > 0 && (
                    <path d="M 92 0 L 102 -4 L 100 0 L 102 4 Z" fill="hsl(var(--info))" opacity="0.7">
                      <animate attributeName="opacity" values="0.3;0.9;0.3" dur="1.2s" repeatCount="indefinite" />
                    </path>
                  )}
                </g>

                {/* === Pivô central (torre fixa) === */}
                <circle cx="0" cy="0" r="9" fill="hsl(var(--card))" stroke="hsl(var(--primary))" strokeWidth="1.6" />
                <circle cx="0" cy="0" r="5" fill="hsl(var(--primary) / 0.25)" stroke="hsl(var(--primary))" strokeWidth="0.8" />
                {/* LED central piscante */}
                <circle cx="0" cy="0" r="2.2" fill={totalActive > 0 ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"}>
                  {totalActive > 0 && <animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite" />}
                </circle>
                {/* Glow ao redor do pivô quando ativo */}
                {totalActive > 0 && (
                  <circle cx="0" cy="0" r="9" fill="none" stroke="hsl(var(--primary))" strokeWidth="1">
                    <animate attributeName="r" values="9;14;9" dur="2.4s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite" />
                  </circle>
                )}
              </svg>
              <div className="mt-1 text-center text-[11px] font-bold uppercase tracking-wider text-foreground">Pivô Central</div>
              <div className="text-center text-[10px] italic text-muted-foreground">Consumo não monitorado</div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function WaterFlowDiagram({ pumps, reservoirs, cloudEquipments }: WaterFlowDiagramProps) {
  const { farms } = useUserFarms();
  const farmNames = useMemo(() => {
    const m = new Map<string, string>();
    farms.forEach(f => m.set(f.id, f.name));
    return m;
  }, [farms]);

  const diagrams = useMemo(
    () => buildDiagrams(pumps, reservoirs, cloudEquipments, farmNames),
    [pumps, reservoirs, cloudEquipments, farmNames],
  );

  if (diagrams.length === 0) {
    return (
      <Card className="bg-card border-border p-8">
        <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-info/10 ring-2 ring-info/30">
            <Waves className="h-7 w-7 text-info" />
          </div>
          <div>
            <h3 className="text-base font-bold text-foreground">SCADA vazio</h3>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Cadastre poços, bombeamentos e níveis em <span className="font-medium text-foreground">Cadastros → Equipamentos</span>{" "}
              e configure os campos <span className="font-medium text-foreground">Fonte</span> e <span className="font-medium text-foreground">Destino</span>.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {diagrams.map(diagram => <FarmPanel key={diagram.farm.id} diagram={diagram} />)}
    </div>
  );
}
