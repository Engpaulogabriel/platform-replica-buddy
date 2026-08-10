-- Diagnóstico Remoto (renov_diag) — PINs do Modo Técnico + sessões de acesso remoto
-- ───────────────────────────────────────────────────────────────────────────
-- WEB (platform_admin): gera PIN, abre sessão remota, enfileira comandos, lê respostas.
-- FERRAMENTA (renov_diag.exe): valida PIN e roda a sessão via edge functions
-- (service_role, gated por machine_id/code). RLS abaixo cobre o acesso da WEB.

-- 1) PINs de 6 dígitos (Modo Técnico) — validade 1h, uso único ---------------
CREATE TABLE IF NOT EXISTS public.diag_pins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pin         text NOT NULL,
  created_by  uuid,
  machine_id  text,                       -- setado quando a ferramenta valida
  used        boolean NOT NULL DEFAULT false,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '1 hour'
);
CREATE INDEX IF NOT EXISTS idx_diag_pins_lookup ON public.diag_pins(pin) WHERE NOT used;

-- 2) Sessões de acesso remoto — código 8 dígitos, 30 min --------------------
CREATE TABLE IF NOT EXISTS public.diag_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  machine_id   text,
  com_port     text,
  status       text NOT NULL DEFAULT 'active',   -- active | closed | expired
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_poll_at timestamptz,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);
CREATE INDEX IF NOT EXISTS idx_diag_sessions_code ON public.diag_sessions(code);

-- 3) Fila de comandos web→ferramenta + respostas ----------------------------
CREATE TABLE IF NOT EXISTS public.diag_commands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES public.diag_sessions(id) ON DELETE CASCADE,
  command      text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',  -- pending | sent | done | error
  response     text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  responded_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_diag_commands_session ON public.diag_commands(session_id, created_at DESC);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Edge functions usam service_role (bypassa RLS). A WEB (platform_admin) tem
-- acesso direto para gerar PIN / enfileirar / ler respostas.
GRANT SELECT, INSERT, UPDATE ON public.diag_pins TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.diag_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.diag_commands TO authenticated;
GRANT ALL ON public.diag_pins, public.diag_sessions, public.diag_commands TO service_role;

ALTER TABLE public.diag_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diag_commands ENABLE ROW LEVEL SECURITY;

-- diag_pins: só platform_admin
DROP POLICY IF EXISTS diag_pins_admin_all ON public.diag_pins;
CREATE POLICY diag_pins_admin_all ON public.diag_pins FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

-- diag_sessions: só platform_admin (ver sessões, criar pela web se preciso)
DROP POLICY IF EXISTS diag_sessions_admin_all ON public.diag_sessions;
CREATE POLICY diag_sessions_admin_all ON public.diag_sessions FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

-- diag_commands: só platform_admin (enfileira comandos, lê respostas)
DROP POLICY IF EXISTS diag_commands_admin_all ON public.diag_commands;
CREATE POLICY diag_commands_admin_all ON public.diag_commands FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

COMMENT ON TABLE public.diag_sessions IS 'Sessões de acesso remoto da ferramenta renov_diag (Diagnóstico Remoto).';
