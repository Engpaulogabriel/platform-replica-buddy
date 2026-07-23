import { useEffect, useRef, useState, useCallback } from "react";

let audioCtx: AudioContext | null = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioCtx;
}

function playBeep(frequency = 880, duration = 150) {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = frequency;
    osc.type = "square";
    gain.gain.value = 0.15;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {}
}

export function useAlarmSound(hasAlarm: boolean) {
  const [muted, setMuted] = useState(false);
  const playedRef = useRef(false);

  useEffect(() => {
    if (hasAlarm && !muted && !playedRef.current) {
      playBeep();
      playedRef.current = true;
    }
    if (!hasAlarm) {
      playedRef.current = false;
      setMuted(false);
    }
  }, [hasAlarm, muted]);

  const toggleMute = useCallback(() => setMuted(m => !m), []);

  return { muted, toggleMute };
}
