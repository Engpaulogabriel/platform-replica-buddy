// "Remember me" seguro: salva o refresh_token do Supabase criptografado
// (AES-GCM) com chave derivada do device fingerprint + TTL de 7 dias.
// Copiar o localStorage para outra máquina não permite descriptografar,
// pois o fingerprint (canvas/UA/hardware) será diferente.
import { getDeviceInfo } from "@/lib/deviceFingerprint";

const STORAGE_KEY = "renov-persist-refresh";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Chave derivada via PBKDF2 (100k iterações, SHA-256) a partir do device
// fingerprint. Encarece brute-force offline e amarra o token ao hardware.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = enc.encode("renov-salt-v1");

async function deriveKey(): Promise<CryptoKey> {
  const info = await getDeviceInfo();
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(info.fingerprint),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function savePersistedRefreshToken(token: string): Promise<void> {
  try {
    const key = await deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token)));
    const payload = {
      v: 1,
      iv: b64encode(iv),
      ct: b64encode(ct),
      expires: Date.now() + TTL_MS,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("[persistRefresh] save failed", e);
  }
}

export async function readPersistedRefreshToken(): Promise<string | null> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as { iv?: string; ct?: string; expires?: number };
    if (!payload?.iv || !payload?.ct || !payload?.expires) {
      clearPersistedRefreshToken();
      return null;
    }
    if (Date.now() > payload.expires) {
      clearPersistedRefreshToken();
      return null;
    }
    const key = await deriveKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(payload.iv).buffer as ArrayBuffer },
      key,
      b64decode(payload.ct).buffer as ArrayBuffer,
    );
    return dec.decode(pt);
  } catch (e) {
    console.warn("[persistRefresh] read/decrypt failed — clearing", e);
    clearPersistedRefreshToken();
    return null;
  }
}

export function clearPersistedRefreshToken(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
}
