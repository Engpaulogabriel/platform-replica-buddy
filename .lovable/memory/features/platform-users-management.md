---
name: Platform Users Management
description: Gestão central de usuários no /platform — listar todos os usuários do sistema (cross-farm), atribuir/remover papéis em fazendas, gerenciar platform_admins/platform_support, criar/resetar senha/excluir via edge function platform-user-admin com service role.
type: feature
---

## RPCs (security definer)
- `platform_users_overview()` — lista todos os usuários com email, nome, fazendas+papéis agregados, último login. Acesso: platform_staff (admin + support).
- `platform_user_detail(user_id)` — detalhes completos (perfil, fazendas, flags admin). Acesso: platform_staff.
- `platform_assign_role(user_id, farm_id, role)` — substitui o papel do usuário naquela fazenda. Acesso: platform_admin.
- `platform_remove_role(user_id, farm_id)` — remove acesso. Acesso: platform_admin.
- `platform_set_admin(user_id, enabled)` — concede/revoga admin. Bloqueia auto-remoção do último admin.
- `platform_set_support(user_id, enabled)` — concede/revoga suporte.

## Edge function: platform-user-admin
Operações que precisam de service role (auth.users).
Body: `{ action: 'invite'|'reset_password'|'delete', email?, full_name?, password?, user_id?, new_password? }`
- `invite`: cria usuário em auth já confirmado, gera senha provisória se não fornecida.
- `reset_password`: gera nova senha provisória.
- `delete`: remove do auth (cascata limpa user_roles, profiles via FK existente).
Validação: JWT do solicitante + `is_platform_admin` → service role faz a operação.

## UI
Aba **Usuários** em `/platform` (`PlatformUsers.tsx`):
- Tabela com busca + filtro (Todos / Plataforma / Sem fazenda).
- Botão "Novo usuário" abre dialog de criação com retorno da senha provisória.
- Click no olho abre detalhes: switches admin/suporte, lista de fazendas com remover, dropdown para adicionar fazenda+papel, botão resetar senha (mostra nova senha) e excluir usuário.
- Suporte vê tudo, mas todas as ações destrutivas/edição requerem isAdmin.
