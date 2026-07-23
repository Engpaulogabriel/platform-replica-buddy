-- Remove o trigger que deletava comandos assim que ficavam finalizados.
-- Esse DELETE imediato impedia o frontend de ler o resultado (status/response)
-- após o Electron marcar o comando como 'executed'. A linha some antes do
-- primeiro poll do useCommandTracker.
DROP TRIGGER IF EXISTS trg_delete_finished_command ON public.commands;
-- Mantemos a função caso queiramos reusá-la em um cleanup agendado (pg_cron)
-- no futuro, mas ela não é mais chamada automaticamente.