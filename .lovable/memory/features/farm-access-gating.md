---
name: Farm Access Gating
description: 3 perfis de fazenda (Administrador=owner, Supervisor, Operador) + platform_admin (Renov). useFarmAccess expõe canCommand/canEditConfig/canAccessAutomation/canViewFinancial/canManageMembers. Só Renov cria/edita/remove usuários.
type: feature
---

## Perfis
- **platform_admin** (Renov): tudo + /platform + único que cria/edita/remove usuários.
- **owner** (Administrador): tudo da fazenda, INCLUSIVE /produtividade e ROI. NÃO acessa /platform e NÃO cria usuários.
- **supervisor** (Supervisor): operar + editar config + /automatico. SEM /produtividade e SEM ROI no /indicadores.
- **operator** (Operador): só comandar bombas. SEM /automatico, SEM financeiro.

## Hook `useFarmAccess`
Flags: `isPlatformAdmin`, `canCommand`, `canEditConfig`, `canViewReports`, `canManageMembers` (só Renov), `canDelete` (só Renov), `canAccessAutomation` (não-operator), `canViewFinancial` (só owner + platform).

## Guards
- `RoleGuards.tsx`: `RequireAutomation` (em /automatico) e `RequireFinancial` (em /produtividade).
- `/indicadores` esconde `RoiTravelCard` se `!canViewFinancial`.
- Sidebar esconde "Automático" para Operador.
- `/usuarios` e `CadastroLogin`: botão "Novo Usuário" + selects de papel só aparecem para platform_admin. Opções limitadas a Administrador/Supervisor/Operador.

## Migração legada (aplicada 2026-05-18)
- `admin → owner`; `viewer → operator`. Enum mantém valores antigos por compat, mas sem rows.
