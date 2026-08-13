# Anti-IA / Anti-scraping — deploy

## ⚠️ Cobertura (leia primeiro — expectativa correta)
Leituras do Supabase vão **direto ao PostgREST**, não passam por edge functions.
Logo:
- **A contenção de cópia em massa é a RLS por fazenda** (cada login só vê a própria
  fazenda). Isto é o que mais protege — audite a RLS.
- `api-rate-limiter` cobre **o que o client roteia por ela** (navegação, export,
  rate-check) — não é um gateway global. Um scraper que bate direto no `/rest/v1`
  **não** passa por aqui; a RLS o limita ao escopo dele.
- O bloqueio de UA de IA aqui vale para chamadas de **API**; para os **assets
  estáticos** (HTML/JS), bloqueie também no CDN (Cloudflare/host) + `robots.txt`.

## 1) Migrations (SQL Editor, na ordem)
1. `20260813120000_anti_scraping.sql` — tabelas `user_activity_log`,
   `rate_limit_violations`, `export_log` + índices + RLS + RPCs
   `check_and_bump_rate_limit`, `check_export_limit`.
2. `20260813120500_schedule_security_anomaly_watchdog.sql` — cron `*/5 min` do
   watchdog (requer pg_cron + pg_net).

## 2) Edge functions (deploy via Lovable/CLI)
- `api-rate-limiter` (importa `_shared/security.ts`)
- `security-anomaly-watchdog` (importa `_shared/security.ts`)
- `_shared/security.ts` vai junto (é importado pelas duas).
- `config.toml` já tem `verify_jwt = false` para as duas (necessário: a função
  precisa devolver 403 de UA de IA e 429 sem o gateway barrar antes; a identidade
  vem do claim `sub` do JWT e a whitelist trata service_role/agente).
- Envs já existentes bastam: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. O alerta
  WhatsApp usa `whatsapp_config` (template `alerta_equipamento`, pt_BR) e envia aos
  operadores `role='super_admin'` (fallback: sufixos 99608294 / 81503951).

## 3) Estático (robots.txt + headers)
- `public/robots.txt` → **Disallow: / para todos** + bots de IA explícitos.
  **⚠️ TRADEOFF:** isto desindexa o site do Google/Bing e remove previews sociais.
  Se você tem landing page pública que precisa de SEO, reverta o curinga
  (`User-agent: *` → `Allow: /` e mantenha só os bots de IA em Disallow).
- `public/_headers` → adicionado `X-Robots-Tag: noindex, nofollow, noarchive,
  nosnippet`. **Só vale se o host honrar `_headers`** (Cloudflare Pages/Netlify).
  Confirme no DevTools → Network → resposta do documento. Em Vercel, use `vercel.json`.
- **Bloqueio de UA de IA nos assets**: idealmente uma regra no CDN (Cloudflare WAF)
  barrando GPTBot/CCBot/… — o `robots.txt` é respeitado pela maioria, mas não é
  imposição. A edge só cobre chamadas de API.

## 4) Frontend (opcional, mas o watermark é obrigatório para atribuição)
`src/lib/securityClient.ts` expõe:
- `logActivity(path)` — chame num efeito de mudança de rota (auditoria).
- `checkRate('api'|'export')` — antes de rajadas (opcional).
- `guardExport('pdf'|'csv', nome)` — **antes** de gerar; se `allowed=false`, avise
  e não gere.
- `watermarkPdf(doc, emailDoUsuario)` — **depois** de montar o PDF (jsPDF), antes de
  `doc.save()`. Rodapé 1pt quase-branco com `RENOV • <user> • <ISO>` em cada página.

Exemplo no export de PDF:
```ts
import { guardExport, watermarkPdf } from "@/lib/securityClient";
const g = await guardExport("pdf", fileName);
if (!g.allowed) { toast.error(`Limite de PDFs atingido (${g.used}/${g.limit}). Fale com o suporte.`); return; }
// ...monta o doc jsPDF...
watermarkPdf(doc, user?.email ?? user?.id ?? "?");
doc.save(fileName);
```

## 5) Verificação
- `SELECT * FROM user_activity_log ORDER BY created_at DESC LIMIT 20;` (após navegar).
- Rate: dispare >300 chamadas/min de `action:'rate'` → 429 + linha `flag='rate_limited'`.
- Export: gere 11 PDFs em 1h (não-admin) → o 11º volta `allowed:false`.
- Anomalia: navegue >50 paths em 5 min → WhatsApp ao super_admin (dedup 1h).
- UA de IA: `curl -H 'User-Agent: GPTBot' .../functions/v1/api-rate-limiter` → 403 vazio.

## O que NÃO foi feito (confirmado inútil/contraproducente)
Desabilitar DevTools/F12 · canvas fingerprint · sessão única hard-kill · bloqueio
por IP · detecção de headless. (Ver avaliação anterior.)

## Whitelist (nunca bloqueada)
- Agente Electron (header `x-renov-agent` ou JWT com claim `fp` da FASE 2).
- `service_role` key (`apikey == service_role`).
- User-agents normais de browser (Chrome/Safari/Firefox/Edge) — passam sempre.
