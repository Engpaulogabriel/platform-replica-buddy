import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { registerPwa } from "./lib/pwaRegister";
import { installRealtimeKillSwitch } from "./lib/realtimeKillSwitch";

// EMERGÊNCIA: desabilita TODO o Realtime antes de qualquer hook montar.
installRealtimeKillSwitch();

// Failsafe: limpa qualquer estado antigo do device authorization no boot.
// O sistema de fingerprint é exclusivo do agente Electron; o interface web
// nunca pode bloquear por dispositivo.
try {
  for (const store of [localStorage, sessionStorage]) {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && (k.startsWith("device_") || k.includes("device_blocked") || k.includes("device_fingerprint"))) {
        keys.push(k);
      }
    }
    keys.forEach((k) => store.removeItem(k));
  }
} catch (_) {}

createRoot(document.getElementById("root")!).render(<App />);

// Registra o Service Worker (no-op em dev/preview).
registerPwa();
