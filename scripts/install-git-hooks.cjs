#!/usr/bin/env node
/** Configura git para usar .githooks/ como diretório de hooks. */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
} catch {
  process.exit(0); // não é repo git — nada a fazer
}

try {
  execSync('git config core.hooksPath .githooks');
  for (const h of ['pre-commit', 'pre-push']) {
    const p = path.join('.githooks', h);
    if (fs.existsSync(p)) {
      try { fs.chmodSync(p, 0o755); } catch {}
    }
  }
  console.log('[hooks] .githooks ativado (bloqueio de arquivos > 100 MB)');
} catch (e) {
  console.warn('[hooks] não foi possível configurar core.hooksPath:', e.message);
}
