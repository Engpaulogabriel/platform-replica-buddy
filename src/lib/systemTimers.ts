export const SYSTEM_TIMERS_KEY = "system_timers_v1";

export interface SystemTimers {
  commSystem: string;
  commLevels: string;
  offlineAuto: string;
  offlineLevels: string;
  autoReset: string;
}

export const DEFAULT_SYSTEM_TIMERS: SystemTimers = {
  commSystem: "10",
  commLevels: "10",
  offlineAuto: "1200",
  offlineLevels: "60",
  autoReset: "2",
};

function toSafeInt(value: unknown, fallback: string, min: number): string {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return String(parsed);
}

function normalizeTimers(raw: unknown): SystemTimers {
  const parsed = typeof raw === "object" && raw !== null ? (raw as Partial<Record<keyof SystemTimers, unknown>>) : {};
  return {
    commSystem: toSafeInt(parsed.commSystem, DEFAULT_SYSTEM_TIMERS.commSystem, 3),
    commLevels: toSafeInt(parsed.commLevels, DEFAULT_SYSTEM_TIMERS.commLevels, 1),
    offlineAuto: toSafeInt(parsed.offlineAuto, DEFAULT_SYSTEM_TIMERS.offlineAuto, 10),
    offlineLevels: toSafeInt(parsed.offlineLevels, DEFAULT_SYSTEM_TIMERS.offlineLevels, 10),
    autoReset: toSafeInt(parsed.autoReset, DEFAULT_SYSTEM_TIMERS.autoReset, 1),
  };
}

export function loadSystemTimers(): SystemTimers {
  if (typeof window === "undefined") return DEFAULT_SYSTEM_TIMERS;
  try {
    const raw = window.localStorage.getItem(SYSTEM_TIMERS_KEY);
    return raw ? normalizeTimers(JSON.parse(raw)) : DEFAULT_SYSTEM_TIMERS;
  } catch {
    return DEFAULT_SYSTEM_TIMERS;
  }
}

export function saveSystemTimers(timers: SystemTimers): SystemTimers {
  const normalized = normalizeTimers(timers);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SYSTEM_TIMERS_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent<SystemTimers>("timers:updated", { detail: normalized }));
  }
  return normalized;
}

export function onSystemTimersUpdated(callback: (timers: SystemTimers) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleCustomEvent = (event: Event) => {
    const detail = (event as CustomEvent<SystemTimers>).detail;
    callback(detail ? normalizeTimers(detail) : loadSystemTimers());
  };

  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key && event.key !== SYSTEM_TIMERS_KEY) return;
    callback(loadSystemTimers());
  };

  window.addEventListener("timers:updated", handleCustomEvent as EventListener);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    window.removeEventListener("timers:updated", handleCustomEvent as EventListener);
    window.removeEventListener("storage", handleStorageEvent);
  };
}

export function getSystemTimingConfig() {
  const timers = loadSystemTimers();
  const commSystemSeconds = Math.max(3, Number(timers.commSystem));
  const commLevelsSeconds = Math.max(1, Number(timers.commLevels));
  const offlineAutoSeconds = Math.max(10, Number(timers.offlineAuto));
  const offlineLevelsSeconds = Math.max(10, Number(timers.offlineLevels));
  const autoResetMinutes = Math.max(1, Number(timers.autoReset));

  return {
    timers,
    commSystemMs: commSystemSeconds * 1_000,
    commLevelsMs: commLevelsSeconds * 1_000,
    offlineAutoMs: offlineAutoSeconds * 1_000,
    offlineLevelsMs: offlineLevelsSeconds * 1_000,
    autoResetMs: autoResetMinutes * 60_000,
  };
}