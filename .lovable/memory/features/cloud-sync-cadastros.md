---
name: Cloud Sync Cadastros
description: Sync bidirecional + migração automática localStorage→nuvem para PLCs, setores e equipamentos. Regras de hw_id, rollback, backup 30d, fila offline e bridge temporária para Dashboard.
type: feature
---

# Cadastros 100% Nuvem

## Arquitetura
- **Tabelas**: `plc_groups`, `sectors`, `equipments` no Supabase, escopo por `farm_id`
- **Hook único**: `useCadastrosCloud()` em `src/hooks/useCadastrosCloud.ts` é fonte da verdade
- **CRUDs**: `createPlc/updatePlc/deletePlc`, `createEquip/updateEquip/deleteEquip`, `createSector/updateSector/deleteSector`
- **Realtime**: 1 channel por farm escutando as 3 tabelas, com debounce 250ms para evitar storm
- **Permissões**: apenas `owner`/`admin` editam (guard em runtime + botões disabled na UI)

## hw_id
- PLC: 4 chars hex `[0-9A-F]` (ex: "1A2B"), único por `farm_id`
- Equipamento: `<plcHex><saida2dígitos>` (ex: PLC "2101" + saída 3 → "210103")
- Helper `buildEquipHwId(plcHex, saida)` em `src/lib/cadastrosCloud.ts`

## Fila Offline
- `src/lib/offlineQueue.ts` enfileira insert/update/delete em localStorage
- Drena quando volta online, polling 30s, retry até 5x
- UI mostra badges Online/Offline/N pendentes em Cadastros.tsx

## Migração automática (1ª vez)
- Em `AppLayout.tsx` ao logar: `migrateLocalCadastrosToCloud()` migra localStorage→nuvem se admin/owner e nuvem vazia
- Backup local em `*_backup_v1` por 30 dias, purga automática via `purgeExpiredBackups()`
- Rollback automático em caso de falha
- Persiste `cloud_id_map_v1` (UUID↔number) para compatibilidade com Dashboard

## Bridge temporária (será removida)
- `src/lib/cadastrosBridge.ts` espelha Cloud→localStorage no formato antigo (`registered_equipment`, `plc_groups_v1`, `sectors_v1`) com IDs numéricos via `cloud_id_map_v1`
- Mantém Dashboard, Automático, Alarmes funcionando enquanto não migram para UUID
- Será deletada quando Dashboard for refatorado para UUID nativo

## Estado das fases
- ✅ Fase 1: Cadastros 100% nuvem com fila offline + bridge
- ⏳ Fase 2: Dashboard + PumpTable/PumpDetails/PumpMap/WaterFlowDiagram → UUID nativo
- ⏳ Fase 3: sectors.ts, automationLog.ts, Automatico.tsx, Alarmes.tsx → UUID
- ⏳ Fase 4: Status RF online/offline via `equipments.last_communication < 20min`
