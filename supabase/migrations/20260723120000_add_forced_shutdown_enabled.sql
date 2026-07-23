-- v3.25.7: desligamento forçado de bomba ligada localmente.
-- Flag opcional por equipamento. Quando true, um comando manual de DESLIGAR
-- (bit=0) enviado pela plataforma para uma bomba com last_actuation_origin='local'
-- faz o agente executar a sequência {1} -> espera RX -> 10s -> {0} (uma única vez,
-- sem reforços/safety) em vez de {0} direto.
-- Ver electron-agent/app/main.cjs :: runForcedShutdownSequence.

ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS forced_shutdown_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.equipments.forced_shutdown_enabled IS
  'Quando true, um comando manual de DESLIGAR (bit=0) enviado pela plataforma para uma bomba com last_actuation_origin=local executa a sequência {1}->espera RX->10s->{0} (uma vez, sem reforços) em vez de {0} direto. Ver electron-agent/app/main.cjs runForcedShutdownSequence.';
