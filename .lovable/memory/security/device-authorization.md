---
name: Device Authorization
description: Controle de acesso por device fingerprint — bloqueia login em dispositivos não autorizados, painel em Suporte Técnico → Dispositivos
type: feature
---
- FingerprintJS (open-source) gera hash estável por hardware/browser; código curto = últimos 8 chars uppercase mostrado ao usuário bloqueado.
- Tabelas: `authorized_devices` (UNIQUE user_id+fingerprint), `device_access_attempts` (tentativas bloqueadas), `device_audit_log` (todas ações), `device_register_links` (token 15min para auto-registro).
- `farms.device_limit` (default 2) configurável por fazenda.
- Fluxo: `ProtectedRoute` → `DeviceGate` (usa `useDeviceAuthorization`). platform_admin bypassa. Se fingerprint não está em authorized_devices: registra attempt + audit, mostra tela de bloqueio. Se há link de auto-registro válido para o user, consome e libera. Fail-open em erro de fingerprint pra não travar app.
- UI admin: `src/components/DevicesAdmin.tsx` (aba "Dispositivos" em /suporte-tecnico). Abas: Autorizados / Pendentes / Cadastro Rápido (gera link `/login?register=TOKEN`) / Limites por fazenda.
- Função SQL `deactivate_stale_devices()` desativa dispositivos inativos > 90 dias (chamar via cron quando necessário).
- RLS: usuário vê só os próprios; platform_admin gerencia tudo; platform_staff lê.
