#!/usr/bin/env node
/**
 * Bloqueia commits/pushes com arquivos > 100 MB.
 * Uso:
 *   node scripts/check-large-files.cjs staged   (pre-commit — só staged)
 *   node scripts/check-large-files.cjs tracked  (pre-push — tudo versionado)
 *   node scripts/check-large-files.cjs all      (scan geral, ignora .gitignore)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB (limite do GitHub)
const mode = process.argv[2] || 'staged';

function human(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function listFiles() {
  try {
    if (mode === 'staged') {
      const out = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' });
      return out.split('\n').filter(Boolean);
    }
    if (mode === 'tracked') {
      const out = execSync('git ls-files', { encoding: 'utf8' });
      return out.split('\n').filter(Boolean);
    }
    // all
    const out = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    // Se não estiver em repo git, apenas sai.
    process.exit(0);
  }
}

const files = listFiles();
const offenders = [];

for (const f of files) {
  try {
    const st = fs.statSync(f);
    if (st.isFile() && st.size > LIMIT_BYTES) {
      offenders.push({ file: f, size: st.size });
    }
  } catch {
    /* arquivo removido, ignora */
  }
}

if (offenders.length === 0) {
  process.exit(0);
}

console.error('\n\x1b[31m✖ Commit/push bloqueado — arquivos acima de 100 MB detectados:\x1b[0m\n');
for (const o of offenders) {
  console.error(`  • ${o.file}  (${human(o.size)})`);
}
console.error(`
GitHub rejeita qualquer arquivo > 100 MB. Opções:
  1) Remova do commit:            git rm --cached "<arquivo>"
  2) Adicione ao .gitignore e:    git rm --cached "<arquivo>" && git commit --amend
  3) Use Git LFS se for essencial

Para checar todo o projeto:  node scripts/check-large-files.cjs all
`);
process.exit(1);
