-- ============================================================================
-- IDENTIDADE DO OPERADOR WHATSAPP — autorização e autoria deixam de ser a
-- mesma coisa.
-- ----------------------------------------------------------------------------
-- Hoje 25 das 27 linhas ativas de whatsapp_operators não têm `user_id`. Como
-- `guard_manual_command_without_user` exige created_by, o webhook preenchia o
-- campo com o primeiro admin/owner da fazenda — e o relatório passou a creditar
-- ao "Admin Renov" o que o Yuri fez. O vínculo auth nunca autorizou nada: quem
-- autoriza é `whatsapp_operators` (is_active, can_control, can_turn_on/off).
--
-- Duas mudanças, as duas de identidade — nenhuma de atuação:
--
--  1. comando manual com created_by NULL passa a ser aceito quando o
--     source_device é 'whatsapp:%'. A identidade viaja ali
--     ('whatsapp:<nome>|<telefone>') e o classificador do relatório já a lê.
--
--  2. `source_device` deixa de ser texto livre para o cliente autenticado nos
--     prefixos que designam OUTRO canal. Sem isso o item 1 abriria falsificação
--     de autoria: qualquer usuário com escrita na fazenda poderia inserir
--     'whatsapp:Fulano|...' e a ação apareceria no relatório como sendo do
--     Fulano. Vale notar que essa falsificação já era possível ANTES desta
--     migration usando created_by próprio — o furo é do RLS, não da exceção.
--
-- Por que o item 2 basta como discriminador: `service_role` tem BYPASSRLS, o
-- webhook usa service_role, e nenhum cliente autenticado jamais escreveu esses
-- prefixos (conferido no NEW: 'whatsapp:%', 'backend-reset:%' e 'cloud-%'
-- aparecem SEMPRE com created_by nulo, ou seja, vindos do servidor).
-- 'platform-scheduler' e 'startup-sync' ficam de fora de propósito: o front
-- legitimamente escreve o primeiro.
--
-- NÃO altera atuação, frame, polling, desired_running, last_outputs_state,
-- agente, automação, nem dado histórico. NÃO concede permissão nova a ninguém.
-- ============================================================================

-- ── 1) A exceção, estreita: só 'whatsapp:%' ────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_manual_command_without_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.type = 'manual' AND NEW.created_by IS NULL THEN
    IF COALESCE(NEW.source_device, '') NOT IN (
      'cloud-automation',
      'cloud-protective-off'
    ) AND COALESCE(NEW.source_device, '') NOT LIKE 'backend-reset:%'
      -- Operador WhatsApp autorizado sem usuário da plataforma. A autorização
      -- já aconteceu no webhook; a identidade está no próprio source_device.
      -- Escrever este prefixo exige service_role (ver política abaixo).
      AND COALESCE(NEW.source_device, '') NOT LIKE 'whatsapp:%'
    THEN
      RAISE EXCEPTION
        'Bloqueado: comando manual sem created_by (source_device=%, frame=%)',
        COALESCE(NEW.source_device, '<null>'), NEW.frame
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2) Prefixos reservados ao servidor ─────────────────────────────────────
-- Mantém as três condições que já existiam e acrescenta a quarta.
ALTER POLICY commands_insert_operators ON public.commands
  WITH CHECK (
    can_write_farm(auth.uid(), farm_id)
    AND ((created_by IS NULL) OR (created_by = auth.uid()))
    AND farm_is_operational_here(farm_id)
    AND (
      source_device IS NULL
      OR (    source_device NOT LIKE 'whatsapp:%'
          AND source_device NOT LIKE 'backend-reset:%'
          AND source_device NOT LIKE 'cloud-%')
    )
  );

-- ============================================================================
-- ROLLBACK:
--   1) reaplicar guard_manual_command_without_user de 20260504222933;
--   2) ALTER POLICY commands_insert_operators ON public.commands WITH CHECK (
--        can_write_farm(auth.uid(), farm_id)
--        AND ((created_by IS NULL) OR (created_by = auth.uid()))
--        AND farm_is_operational_here(farm_id));
-- ============================================================================
