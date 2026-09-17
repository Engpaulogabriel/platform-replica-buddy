# Remediação de segurança — pré-migração

Valores de credencial **não aparecem** aqui. Cada achado traz arquivo, linha, tipo e criticidade.

## S1 — CRÍTICO · Dependência de projeto Supabase antigo em telas admin

| | |
|---|---|
| Arquivo | `src/components/RestrictedAuth.tsx:11` (URL) · `:12` (anon key) · `:163` (chamada) |
| Tipo | URL de projeto + anon key de **outro** projeto, literais |
| Consumo | `Cadastros`, `Configuracoes`, `SuporteTecnico`, `DiagnosticoAuth` |

Chama `POST /functions/v1/validate-2fa` num projeto que **não é** o atual, e essa função **não existe neste repositório**.

**Correção proposta:** portar `validate-2fa` para o projeto novo; trocar as duas constantes por `import.meta.env`; só então desligar o projeto antigo. **Não remover o componente** — ele é o gate das telas administrativas.

Mesmo padrão em `src/pages/Licencas.tsx:10-11`, porém a página não está roteada (severidade menor).

## S2 — CRÍTICO · 10 Edge Functions públicas sem guarda

Todas com `verify_jwt = false` e `SERVICE_ROLE_KEY`, sem verificação própria:

`whatsapp-alerts` · `offline-daily-report` · `command-verifier` · `agent-release-signed-url` · `agent-logs-cleanup` · `diag-license` · `validate-diag-pin` · `diag-session` · `api-rate-limiter` · `bridge-heartbeat`

**Maior risco:** `agent-release-signed-url` entrega URL assinada do binário do agente a qualquer chamador. Depois dele, os três que enviam WhatsApp — a ação sai da plataforma e chega no telefone do cliente.

**Correção proposta:** reaproveitar `_shared/cronAuth.ts` (`guardCron`) nas de cron; para as do agente, exigir fingerprint + token como `agent-auth` já faz; avaliar se `api-rate-limiter` precisa mesmo ser pública.

## S3 — ALTO · Anon key literal em 33 migrations e 3 arquivos de `src/`

A anon key é pública por design — **não é vazamento**. O problema é acoplamento: cada ocorrência fixa o projeto de origem e quebra na migração, além de ensinar o padrão errado.

**Correção proposta:** no destino, cron usa `cron_invoke()` + Vault (já implementado); frontend usa `import.meta.env`. **Não reescrever migrations históricas** — elas são registro do que foi aplicado.

## S4 — ALTO · `SECURITY DEFINER` sem `search_path`

468 ocorrências em 350 migrations. Em função com privilégio elevado, é vetor conhecido de escalonamento.

**Correção proposta:** varredura dirigida no destino, priorizando funções que escrevem em `commands`, `equipments` e `automation_log`. Consulta em `migration-baseline.md`. **Não corrigir em massa às cegas.**

## S5 — MÉDIO · `cron_job_backup` guarda comandos com anon key

Tabela criada para rollback dos jobs; os comandos antigos contêm a chave. Já tem RLS sem policy de leitura pública, mas **o conteúdo não deve ser migrado**.

## S6 — MÉDIO · Dependências externas em runtime nas Edge Functions

`deno.land/std`, `deno.land/x/djwt`, `esm.sh/jose`. Indisponibilidade de terceiro derruba função. **Correção proposta:** fixar versão e avaliar vendoring no destino.

## S7 — A VERIFICAR · Job apontando para função inexistente

`wa-batch-tick-every-minute` chama `wa-batch-tick`, que **não existe no repositório** — criada no painel ou já removida. Se existir e tiver sido criada fora do git, **não tem guarda e não será migrada**.

Consulta: `SELECT jobname, command FROM cron.job WHERE jobname = 'wa-batch-tick-every-minute';`
