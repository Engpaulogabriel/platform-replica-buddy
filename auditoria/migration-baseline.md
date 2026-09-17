# Baseline mínimo para a nova produção independente

## Consultas de inventário que só você pode rodar

Não tenho leitura do banco de produção (RLS bloqueia a chave anon). Estas três respostas fecham as lacunas da auditoria.

```sql
-- 1) CRON REAL — o repositório declara 13 jobs; produção tem mais.
--    O que não estiver aqui não existe no git e não será migrado.
SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;

-- 2) TAMANHO E USO DAS TABELAS — decide o que migra quente e o que vai para arquivo frio.
SELECT relname AS tabela,
       n_live_tup AS linhas_estimadas,
       pg_size_pretty(pg_total_relation_size(relid)) AS tamanho,
       seq_scan, idx_scan, last_autovacuum
  FROM pg_stat_user_tables
 WHERE schemaname = 'public'
 ORDER BY pg_total_relation_size(relid) DESC
 LIMIT 40;

-- 3) SECURITY DEFINER SEM search_path — prioridade de remediação.
SELECT n.nspname, p.proname,
       pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c
                    WHERE c LIKE 'search_path=%')
 ORDER BY p.proname;
```

Complementares:

```sql
-- extensões, publicações Realtime e buckets
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT pubname, tablename FROM pg_publication_tables ORDER BY pubname, tablename;
SELECT id, name, public FROM storage.buckets;

-- tabelas SEM RLS habilitada (superfície direta pela anon key)
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity ORDER BY 1;

-- grants amplos a anon/authenticated
SELECT table_name, grantee, string_agg(privilege_type, ',') AS privs
  FROM information_schema.role_table_grants
 WHERE table_schema='public' AND grantee IN ('anon','authenticated')
 GROUP BY 1,2 ORDER BY 1;
```

## Conjunto mínimo para o dia 1 no destino

**Extensões:** `pg_cron`, `pg_net`, `pgcrypto`, `supabase_vault`.

**Schema e dados quentes (migrar íntegros):**
`farms` · `equipments` · `plc_groups` · `sectors` · `profiles` · `user_roles` · `platform_admins` · `platform_support` · `commands` · **`command_audit`** · **`automation_log`** · `automation_cleanup_audit` · `scheduled_automations` · `scheduled_shutdowns` · `site_health` · `whatsapp_config` · `whatsapp_operators` · `maintenance_orders` · `technical_display_prefs` · `switching_protection_audit` · `adaptive_telemetry_*`

`command_audit` e `automation_log` são a prova de autoria e o Relatório oficial — migram **na íntegra**, sem corte.

**Arquivo frio (não migrar quente):** `agent_logs` · `automation_tick_logs` · `system_logs` · `whatsapp_health_log` · `farm_notifications` (só janela recente) · `whatsapp_message_log` (confirmar exigência legal antes).

**Não migrar conteúdo:** `cron_job_backup` (comandos com anon key antiga).

**Segredos a recriar no destino, nunca copiar:** `CRON_SECRET`, `AGENT_TOKEN_SECRET`, `MASTER_PASSWORD`, chave AES do asar (FASE 3), credenciais Meta WhatsApp, `SERVICE_ROLE_KEY`. Vault do banco: `CRON_SECRET`, `PROJECT_FUNCTIONS_URL`.

**Edge Functions (38)** — todas migram. As 10 sem guarda **só depois** de S2 corrigido.

**Buckets:** `agent-releases` (revalidar hash e assinatura das releases) · `agent-logs` (com retenção definida).

## Ordem de bring-up

1. Extensões, schema e RLS — sem dados.
2. Rodar as três consultas de inventário e comparar com este baseline.
3. Segredos no Vault e nas Functions.
4. Dados quentes.
5. Edge Functions, começando pelas guardadas.
6. Cron via `cron_invoke()`, **nunca** com anon key literal.
7. Storage e revalidação de OTA.
8. Frontend com `import.meta.env` apontando ao projeto novo.
9. `validate-2fa` portada — **pré-requisito** para desligar o projeto antigo.
