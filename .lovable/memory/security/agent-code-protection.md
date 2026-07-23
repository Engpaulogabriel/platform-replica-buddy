---
name: Agent Code Protection (Layers 1+3)
description: Pipeline bytenode + javascript-obfuscator + anti-debug watchdog + asarIntegrity para blindar o Electron Agent
type: feature
---
# Proteção do código do Electron Agent — Fase A (Camadas 1 + 3)

## Camada 1 — Bytecode + Ofuscação
Pipeline disparado automaticamente em `npm run build` / `npm run release`:

1. `scripts/protect-build.cjs`:
   - Backup `main.cjs` → `main.original.cjs` (gitignored).
   - Ofusca com `javascript-obfuscator` (controlFlowFlattening 0.75, deadCode 0.4, debugProtection, selfDefending, stringArray rc4 0.75, transformObjectKeys, identifiers hex, target node).
   - `renameGlobals: false` (evita quebrar `require('electron')`).
   - Compila resultado para bytecode V8 com `bytenode` → `main.jsc` (electron mode, compileAsModule).
   - Substitui `main.cjs` por loader 2 linhas: `require('bytenode'); require('./main.jsc');`
2. electron-builder empacota loader + `main.jsc` no app.asar.
3. `scripts/protect-restore.cjs` restaura o original após o build.

**`REBUILD-COMPLETO.bat` (2026-06) agora chama `protect-build.cjs` antes do `electron-builder` e `protect-restore.cjs` depois** — todo `.exe` gerado pelo BAT padrão já sai ofuscado + bytenode. Use `npm run build:unprotected` só para builds locais de debug.

**ZIPs de update OTA (Atualizar-Agente-Renov.bat)** também levam o `main.cjs` já ofuscado (sem bytenode, pois o BAT roda no PC da fazenda sem Electron pra compilar). Primeira release ofuscada via ZIP: **v3.10.7**.

`bytenode` é runtime dependency. `javascript-obfuscator` é devDependency.


## Camada 3 — Anti-debug + asarIntegrity
- `startAntiDebugWatchdog(cfg)` em `main.cjs` roda 5s:
  - Checa `inspector.url()` (--inspect flag).
  - Mede latência de `debugger;` statement (>100ms = pausado).
  - 2 detecções consecutivas → `reportTampering(kind=debugger_attached, level=critical)` e `app.exit(1)`.
  - Só liga em `app.isPackaged` para não atrapalhar dev.
- ASAR integrity check (já existente desde 2026-04) com hash build-time em `resources/asar-hash.txt`.
- `asarIntegrity` opcional via electron-builder (assinatura no header do .exe).

## Pendente (próximas fases)
- **Fase B**: Hardware fingerprint híbrido (alerta em 1 mudança, bloqueia em 2+) + revisão se vale migrar safeStorage→keytar.
- **Fase C**: HMAC frames seriais — adiado até PLCs suportarem.

## Arquivos
- electron-agent/scripts/protect-build.cjs
- electron-agent/scripts/protect-restore.cjs
- electron-agent/main.cjs (startAntiDebugWatchdog)
- electron-agent/package.json (deps + scripts build/release)
- electron-agent/electron-builder.yml (main.jsc nos files, exclusão de main.original.cjs)
- electron-agent/.gitignore (main.jsc, main.original.cjs, main.obf.tmp.cjs)
