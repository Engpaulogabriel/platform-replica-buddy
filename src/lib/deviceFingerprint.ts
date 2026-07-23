// Device fingerprint utility using FingerprintJS open-source.
// Returns a stable hash + readable info (browser/os/type) for authorization.
import FingerprintJS from "@fingerprintjs/fingerprintjs";
import { UAParser } from "ua-parser-js";

let cached: Promise<DeviceInfo> | null = null;

export interface DeviceInfo {
  fingerprint: string;
  short: string;        // últimos 8 chars (mostrado ao usuário)
  browser: string;
  os: string;
  device_type: "desktop" | "mobile" | "tablet";
  screen: string;
  timezone: string;
  language: string;
  ua: string;
}

export function getDeviceInfo(): Promise<DeviceInfo> {
  if (cached) return cached;
  cached = (async () => {
    const fp = await FingerprintJS.load();
    const result = await fp.get();
    const ua = new UAParser(navigator.userAgent);
    const dev = ua.getDevice().type;
    const type: DeviceInfo["device_type"] =
      dev === "mobile" ? "mobile" : dev === "tablet" ? "tablet" : "desktop";
    const visitor = result.visitorId;
    return {
      fingerprint: visitor,
      short: visitor.slice(-8).toUpperCase(),
      browser: `${ua.getBrowser().name ?? "?"} ${ua.getBrowser().version ?? ""}`.trim(),
      os: `${ua.getOS().name ?? "?"} ${ua.getOS().version ?? ""}`.trim(),
      device_type: type,
      screen: `${window.screen.width}x${window.screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      ua: navigator.userAgent,
    };
  })();
  return cached;
}
