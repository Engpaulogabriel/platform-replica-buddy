const { app, BrowserWindow } = require("electron");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const fs = require("fs");

let mainWindow;

/* ── Machine fingerprint ── */
function getMachineId() {
  const cpus = os.cpus();
  const networkInterfaces = os.networkInterfaces();

  // Collect stable identifiers
  const parts = [
    os.hostname(),
    cpus.length > 0 ? cpus[0].model : "",
    os.arch(),
    os.totalmem().toString(),
  ];

  // Add first non-internal MAC address
  for (const iface of Object.values(networkInterfaces)) {
    if (!iface) continue;
    for (const cfg of iface) {
      if (!cfg.internal && cfg.mac && cfg.mac !== "00:00:00:00:00:00") {
        parts.push(cfg.mac);
        break;
      }
    }
  }

  // Try to get disk serial (Windows)
  try {
    const { execSync } = require("child_process");
    if (process.platform === "win32") {
      const serial = execSync("wmic diskdrive get SerialNumber", { encoding: "utf8" });
      const lines = serial.trim().split("\n").filter((l) => l.trim() && !l.includes("SerialNumber"));
      if (lines.length > 0) parts.push(lines[0].trim());
    } else {
      const id = execSync("cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo none", { encoding: "utf8" });
      parts.push(id.trim());
    }
  } catch (_) {}

  const raw = parts.join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 32).toUpperCase();
}

/* ── License secret (used to generate/verify keys) ── */
const LICENSE_SECRET = "RENOVA-IRRIGACAO-2024-ANTCLONE";

function generateLicenseKey(machineId) {
  const hmac = crypto.createHmac("sha256", LICENSE_SECRET).update(machineId).digest("hex").substring(0, 24).toUpperCase();
  // Format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
  return hmac.match(/.{1,4}/g).join("-");
}

function verifyLicenseKey(machineId, licenseKey) {
  const expected = generateLicenseKey(machineId);
  return licenseKey.replace(/\s/g, "").toUpperCase() === expected;
}

/* ── License file storage ── */
function getLicensePath() {
  const userDataPath = app.getPath("userData");
  return path.join(userDataPath, "license.json");
}

function readLicense() {
  try {
    const data = JSON.parse(fs.readFileSync(getLicensePath(), "utf8"));
    return data;
  } catch (_) {
    return null;
  }
}

function saveLicense(machineId, licenseKey) {
  const data = { machineId, licenseKey, activatedAt: new Date().toISOString() };
  fs.writeFileSync(getLicensePath(), JSON.stringify(data, null, 2));
}

const PRODUCTION_URL = "https://platform-replica-buddy.lovable.app";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Renova Gestor — Irrigação Inteligente",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Loads the published web panel — preload.cjs injects window.serialAPI
  mainWindow.loadURL(PRODUCTION_URL);

  // Optional: open DevTools with F12
  mainWindow.webContents.on("before-input-event", (_evt, input) => {
    if (input.key === "F12") mainWindow.webContents.toggleDevTools();
  });
}

/* ── Expose license functions globally for preload ── */
global.licenseAPI = {
  getMachineId,
  generateLicenseKey,
  verifyLicenseKey,
  readLicense,
  saveLicense,
};

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
