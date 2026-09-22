-- ============================================================================
-- DESTRAVA A GERAÇÃO DE TOKEN DE PROVISIONAMENTO NO NEW
-- ----------------------------------------------------------------------------
-- `platform_generate_provisioning_token` monta o token com gen_random_bytes(2)
-- quatro vezes (formato PROV-XXXX-XXXX-XXXX-XXXX). No NEW, pgcrypto está
-- instalado no schema `extensions`, e a função declara `SET search_path = public`
-- — então a chamada falha com:
--     ERROR: function gen_random_bytes(integer) does not exist
--     CONTEXT: ... line 20 at assignment
--
-- Isso não é específico de uma fazenda: `provisioning_tokens` tem ZERO linhas
-- para as dez fazendas do NEW, e o botão de gerar token na plataforma bate no
-- mesmo erro, porque a proconfig é da função e não da sessão. Apareceu agora
-- porque a São Miguel é o primeiro provisionamento feito neste backend.
--
-- Só o search_path muda. O corpo, o formato do token, a verificação
-- is_platform_admin, o TTL de 30 dias e as permissões ficam exatamente como
-- estão. Não toca licença, comando, equipamento, desired_running nem qualquer
-- caminho físico.
-- ============================================================================
ALTER FUNCTION public.platform_generate_provisioning_token(uuid, text)
  SET search_path = public, extensions;

-- ROLLBACK: ALTER FUNCTION public.platform_generate_provisioning_token(uuid, text)
--           SET search_path = public;
