// Som curto e marcante de "Falha" — dois beeps descendentes (tipo alerta industrial).
// Web Audio API, sem assets externos. Respeita mute global via localStorage.
let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, freq: number, startAt: number, durMs: number, gainVal = 0.18) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainVal, startAt);
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + durMs / 1000);
  osc.start(startAt);
  osc.stop(startAt + durMs / 1000);
}

const MUTE_KEY = "failure_sound_muted_v1";

export function isFailureSoundMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setFailureSoundMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, String(muted));
  } catch {}
}

/**
 * Toca o som padrão de FALHA do sistema:
 * dois beeps descendentes (880Hz → 440Hz), curtos e bem audíveis.
 * Silencioso se o usuário tiver mutado.
 */
export function playFailureSound() {
  if (isFailureSoundMuted()) return;
  const ctx = getCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  tone(ctx, 880, t0, 180);
  tone(ctx, 440, t0 + 0.22, 260);
}
