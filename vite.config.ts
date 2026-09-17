import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/supabase/vite";
// vite-plugin-pwa REMOVIDO (emergência 2026-06-10): o SW Workbox cacheava o
// bundle antigo quebrado. /public/sw.js agora é um kill-switch worker estático
// que se auto-destrói nos navegadores que ainda têm o SW antigo registrado.
// O manifest (Adicionar à tela inicial) continua em /public/manifest.webmanifest.

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: '/',
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    mcpPlugin(),
    mode === "development" && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Split vendor chunks para reduzir o bundle principal e melhorar cache.
    // Cada vendor é baixado uma vez e reaproveitado entre rotas.
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return;
          if (id.includes("@supabase")) return "vendor-supabase";
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("react-router")) return "vendor-router";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler"))
            return "vendor-react";
          if (id.includes("@tanstack")) return "vendor-query";
          if (id.includes("date-fns")) return "vendor-date";
          if (id.includes("zustand")) return "vendor-state";
        },
      },
    },
  },
}));

