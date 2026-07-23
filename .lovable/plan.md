# Etapa 2 — Gestor Master (login, seletor, permissões e auditoria)

## Princípio norteador
Nada muda para `admin`, `owner`, `operator`, `viewer`, `supervisor` ou platform_admin. Toda lógica nova é ativada **apenas quando o usuário existir na tabela `master_managers` com status = 'active'**. Não vou adicionar `gestor_master` ao enum `app_role` — o "role" é derivado da presença em `master_managers`, o que evita mexer em RLS/policies existentes.

## 1. Detecção do Gestor Master (novo hook global)

Criar `src/hooks/useMasterManager.ts`:
- Consulta `master_managers` pelo `auth.uid()`; se encontrar e `status='active'`, retorna `{ isMasterManager: true, manager, permissions, farms }`.
- Faz JOIN em `master_manager_permissions` e `master_manager_farms (farms(id,name,city,state))`.
- Cacheia em contexto React para não repetir a query.

Criar `src/contexts/MasterManagerContext.tsx` que injeta esse hook em toda a app (Provider dentro de `AuthContext`).

Fallback: se não é master manager, retorna `{ isMasterManager: false }` e o app se comporta exatamente como hoje.

## 2. Login e carregamento de fazendas

- Rota `/login` já é a mesma para todos (gestor.renovtecnologia.com.br). Nada muda no fluxo de login.
- Estender `useUserFarms` para, quando `isMasterManager === true`, **substituir** a lista de `user_roles` pela lista vinda de `master_manager_farms`. Isso garante que ele só enxergue as fazendas vinculadas do grupo (mesmo que tenham donos diferentes).
- Manter `default_farm_id` no `profiles` como estado da fazenda ativa — sem mudança estrutural.

## 3. FarmSwitcher no header

Já existe (`src/components/FarmSwitcher.tsx`) e é alimentado por `useUserFarms`. Ajustes:
- Se `farms.length <= 1` → não renderizar o botão (comportamento novo apenas para simplificar a UI do Gestor Master de fazenda única). Para os demais perfis, manter comportamento atual.
- Nenhuma mudança visual para admin/owner.

## 4. Aplicação das permissões

Criar helper `usePermissions()` que combina Master Manager + role padrão:
- Para não-master-manager: `hasPermission(x)` sempre `true` (nada muda).
- Para master-manager: consulta `permissions.*` retornado pelo contexto.

Aplicar nos pontos:

| Permissão | Onde aplicar |
|---|---|
| `can_command_pumps` | `PumpCard.tsx`, `PumpTable.tsx` → botão de acionamento: `disabled` + tooltip "Sem permissão". |
| `can_edit_schedules` | `pages/Automacoes.tsx` + `AutomacaoScheduleForm.tsx` → modo somente leitura (inputs `disabled`, esconder Salvar/Excluir). |
| `can_manage_maintenance` | `Manutencao.tsx`, `EquipmentMaintenanceToggle` e botões de bloqueio/desbloqueio → `disabled`. |
| `can_view_financial` | `EnergyEfficiencyCard`, `pages/Financeiro.tsx`, cards de economia em Relatórios → esconder. |
| `can_manage_operational_users` | `pages/Cadastros.tsx` → esconder botão "Novo Usuário" e formulários de cadastro. |
| `can_view_dashboard` | `pages/Index.tsx` (Dashboard) → se false, `<Navigate>` para a primeira rota permitida (ordem: Relatórios → Automações → Manutenção → Cadastros). |
| `can_view_reports` | `AppSidebar.tsx` esconder item; `pages/Relatorios.tsx` bloqueia com aviso. |

Todos os checks usam guard cedo: `if (isMasterManager && !permissions.x) return null/disabled`. Nada afeta outros perfis.

## 5. Auditoria de ações

Estado atual: `useCloudAutomation.ts` e triggers SQL já capturam `user_metadata.full_name` e consultam `profiles.full_name`. O "Remoto Não Identificado" só aparece quando não há user_id/session.

Ajustes:
- Garantir que ao chegar um comando de master manager, o `automation_audit_log.changed_by_name` receba `master_managers.full_name` (mais confiável que profiles). Novo trigger auxiliar `resolve_user_display_name(uuid)` que:
  1. Tenta `master_managers.full_name`
  2. Fallback `profiles.full_name`
  3. Fallback `auth.users.email`
- Adicionar coluna `changed_by_role TEXT` em `automation_audit_log` (se não existir) preenchida com `'gestor_master'` quando aplicável. Se já existir campo similar, apenas reaproveitar.
- Relatório de automação (`AutomacaoReportTab.tsx`): usar a função `resolve_user_display_name` na consulta para nunca mostrar "Remoto Não Identificado" quando o `user_id` existe.

## 6. Migração SQL

```sql
-- 1) Função de nome amigável
CREATE OR REPLACE FUNCTION public.resolve_user_display_name(_uid uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT full_name FROM master_managers WHERE user_id = _uid AND status = 'active' LIMIT 1),
    (SELECT full_name FROM profiles WHERE id = _uid LIMIT 1),
    (SELECT email FROM auth.users WHERE id = _uid LIMIT 1),
    'Remoto Não Identificado'
  );
$$;

-- 2) Coluna de role no audit log (idempotente)
ALTER TABLE public.automation_audit_log
  ADD COLUMN IF NOT EXISTS changed_by_role text;

-- 3) Função helper para checar se é gestor master
CREATE OR REPLACE FUNCTION public.is_master_manager(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM master_managers WHERE user_id = _uid AND status = 'active');
$$;
```

## 7. Novos arquivos

```text
src/hooks/useMasterManager.ts
src/contexts/MasterManagerContext.tsx
src/hooks/usePermissions.ts
```

## 8. Arquivos alterados (mínimo, cirúrgico)

- `src/App.tsx` → envolver com `<MasterManagerProvider>`
- `src/hooks/useUserFarms.ts` → branch master manager
- `src/components/FarmSwitcher.tsx` → hide se 1 fazenda para master manager
- `src/components/dashboard/PumpCard.tsx`, `PumpTable.tsx` → disable toggle
- `src/pages/Automacoes.tsx` + form → read-only
- `src/pages/Manutencao.tsx` + `EquipmentMaintenanceToggle` → disable
- `src/components/dashboard/EnergyEfficiencyCard.tsx` + `pages/Financeiro.tsx` → esconder
- `src/pages/Cadastros.tsx` → esconder novo usuário
- `src/pages/Index.tsx` → redirect se sem dashboard
- `src/pages/Relatorios.tsx` + `AppSidebar.tsx` → esconder aba
- `src/components/reports/AutomacaoReportTab.tsx` → usar `resolve_user_display_name`
- `src/hooks/useCloudAutomation.ts` + edge functions relevantes → gravar `changed_by_role='gestor_master'` quando aplicável

## 9. O que NÃO farei
- Não altero `app_role` enum, `user_roles`, nem RLS existentes.
- Não mudo UI para admin/owner/operator/viewer/supervisor.
- Não crio nova página; só ajusto guards.

## Ordem de execução
1. Migração SQL (funções + coluna).
2. Novo contexto + hooks.
3. useUserFarms + FarmSwitcher.
4. Aplicar guards nas telas.
5. Auditoria (edge functions + relatório).
6. Teste manual com um Gestor Master de teste.
