---
name: Farm Backups
description: Sistema de backup por fazenda — snapshot diário automático (03:00 UTC, pg_cron) + botão 'Backup agora' no /platform. Restauração seletiva por categoria (cadastros/automação/usuários/histórico). Retenção 30 dias. Isolado por farm_id — restaurar fazenda A nunca afeta B.
type: feature
---

## Tabela
- `farm_backups` (farm_id, created_at, trigger_kind, label, size_bytes, cadastros jsonb, automacao jsonb, usuarios jsonb, historico jsonb, meta jsonb)
- RLS: platform_staff lê tudo, owner da fazenda lê própria. Insert/delete só via SECURITY DEFINER.

## Funções
- `farm_backup_create(farm_id, trigger_kind, label)` — cria snapshot. Permitido para platform_admin, owner da farm ou service_role (cron).
- `farm_backup_restore(backup_id, _restore_cadastros, _restore_automacao, _restore_usuarios, _restore_historico)` — restauração seletiva por categoria. SEMPRE cria backup automático `pre-restore` antes. Restringe por `farm_id` do snapshot.
- `farm_backup_list(farm_id)` — lista resumida (sem JSON gigante).
- `farm_backup_create_all_farms()` — usado pelo cron diário (itera todas as farms + chama purge).
- `farm_backup_purge_old()` — apaga snapshots > 30d.

## Cron
- `farm-backups-daily` agendado via pg_cron (`0 3 * * *`) chama `farm_backup_create_all_farms()`.

## Escopo do snapshot
- **Cadastros**: plc_groups, sectors, equipments, rf_routing
- **Automação**: automation_schedules, automation_engine, automation_holiday_configs, automation_guards
- **Usuários**: user_roles + profiles vinculados (id/email/nome/phone)
- **Histórico (90d)**: commands, agent_logs, automation_log, pump_runtime

## Restauração
- Cadastros/Automação/Usuários: DELETE + INSERT (substituição completa daquela fazenda).
- Histórico: MERGE (ON CONFLICT DO NOTHING) — preserva atual + traz registros antigos. Não destrutivo.
- Defaults da UI: cadastros=ON, automação=ON, usuários=OFF, histórico=OFF.
- Confirmação obrigatória + log em agent_logs categoria 'backup'.

## UI
- Aba "Backups" em `/platform` (PlatformBackups.tsx).
- Seletor de fazenda → tabela de snapshots → botão "Backup agora" (admin) + "Restaurar" com modal de checkboxes.
