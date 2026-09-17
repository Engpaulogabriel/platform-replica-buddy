import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Testes de horário assumem fuso da Bahia (BRT, UTC-3).
process.env.TZ = process.env.TZ || "America/Bahia";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Suítes com Postgres em memória (PGlite) levam alguns segundos para subir.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
