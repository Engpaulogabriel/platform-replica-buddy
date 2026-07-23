// ─────────────────────────────────────────────────────────────────────────────
// notify — helpers centralizados para toasts do sistema
// ─────────────────────────────────────────────────────────────────────────────
// Padroniza mensagens, ícones, durações e deduplicação. Toda notificação deve
// dizer QUAL equipamento e O QUE aconteceu.
//
// Regras de exibição (definidas pelo produto):
//   • Sucesso/Info  → 5s
//   • Alerta        → 10s
//   • Erro          → persistente (Infinity) — usuário precisa fechar
//   • Máximo 3 toasts visíveis (controlado pelo <Toaster visibleToasts={3} />)
//   • Não repete: se o mesmo `id` já está visível, atualiza em vez de duplicar
import { toast } from "sonner";

const DURATION = {
  info: 5_000,
  success: 5_000,
  warning: 10_000,
  error: Infinity,
} as const;

/** Garante id estável para deduplicar toasts repetidos do mesmo evento. */
const k = (parts: Array<string | number | undefined | null>) =>
  parts.filter((p) => p != null && p !== "").join(":");

// ─── 1. COMANDO (Ligar/Desligar) ────────────────────────────────────────────
export const notifyCommand = {
  sent(equipName: string, action: "ligar" | "desligar") {
    return toast.info(`⏳ Comando enviado para ${equipName}…`, {
      id: k(["cmd-sent", equipName, action]),
      duration: DURATION.info,
    });
  },
  turnedOn(equipName: string) {
    return toast.success(`✅ ${equipName} ligou com sucesso`, {
      id: k(["cmd-on", equipName]),
      duration: DURATION.success,
    });
  },
  turnedOff(equipName: string) {
    return toast.success(`✅ ${equipName} desligou com sucesso`, {
      id: k(["cmd-off", equipName]),
      duration: DURATION.success,
    });
  },
  notConfirmed(equipName: string) {
    return toast.warning(`⚠️ ${equipName} não confirmou o comando. Aguardando…`, {
      id: k(["cmd-pending", equipName]),
      duration: DURATION.warning,
    });
  },
  safetyExpired(_equipName: string) {
    // DESATIVADO 2026-06-25 — timeout de 60s produzia falsos positivos
    // (equipamento respondia mas o estado ainda não havia sido refletido na UI).
    // A detecção real de falha de obediência é feita pelo motor da nuvem
    // (`mark_automation_command_failures` + telemetria 120s). Não emitir toast.
    return null;
  },

  localActuation(equipName: string) {
    return toast.info(`ℹ️ ${equipName} foi acionado localmente (botoeira)`, {
      id: k(["cmd-local", equipName]),
      duration: DURATION.info,
    });
  },
  blocked(equipName: string, reason: string) {
    return toast.warning(`⚠️ ${equipName}: ${reason}`, {
      id: k(["cmd-blocked", equipName, reason]),
      duration: DURATION.warning,
    });
  },
  error(equipName: string, message: string) {
    return toast.error(`🔴 ${equipName} — erro: ${message}`, {
      id: k(["cmd-error", equipName]),
      duration: DURATION.error,
    });
  },
};

// ─── 2. COMUNICAÇÃO ─────────────────────────────────────────────────────────
export const notifyComm = {
  online(equipName: string) {
    return toast.success(`✅ ${equipName} — comunicação restabelecida`, {
      id: k(["comm-online", equipName]),
      duration: DURATION.success,
    });
  },
  unstable(equipName: string, minutes: number) {
    return toast.warning(`⚠️ ${equipName} sem comunicação há ${minutes} minutos`, {
      id: k(["comm-unstable", equipName]),
      duration: DURATION.warning,
    });
  },
  offline(equipName: string, minutes: number) {
    return toast.error(`🔴 ${equipName} offline há ${minutes} minutos`, {
      id: k(["comm-offline", equipName]),
      duration: DURATION.error,
    });
  },
  bridgeDown() {
    return toast.error(
      `🔴 Sistema de comunicação offline — verificar PC da fazenda`,
      { id: "bridge-down", duration: DURATION.error },
    );
  },
  bridgeUp() {
    // Encerra o toast persistente de "bridgeDown" se ainda estiver na tela.
    toast.dismiss("bridge-down");
    return toast.success(`✅ Sistema de comunicação restabelecido`, {
      id: "bridge-up",
      duration: DURATION.success,
    });
  },
};

// ─── 3. NÍVEL ───────────────────────────────────────────────────────────────
export const notifyLevel = {
  updated(equipName: string, percent: number) {
    return toast.info(`ℹ️ ${equipName} — Nível: ${percent}%`, {
      id: k(["level-updated", equipName]),
      duration: DURATION.info,
    });
  },
  critical(equipName: string, percent: number) {
    return toast.error(`🔴 ${equipName} — Nível CRÍTICO: ${percent}%`, {
      id: k(["level-critical", equipName]),
      duration: DURATION.error,
    });
  },
  recovered(equipName: string, percent: number) {
    return toast.success(`✅ ${equipName} — Nível normalizado: ${percent}%`, {
      id: k(["level-recovered", equipName]),
      duration: DURATION.success,
    });
  },
};

// ─── 4. SEGURANÇA ───────────────────────────────────────────────────────────
export const notifySecurity = {
  unauthorizedDevice() {
    return toast.error(`🔴 Tentativa de acesso de dispositivo não autorizado`, {
      id: "sec-unauth-device",
      duration: DURATION.error,
    });
  },
  updateAvailable(version: string) {
    return toast.info(`ℹ️ Nova versão disponível: v${version}`, {
      id: k(["update-avail", version]),
      duration: DURATION.info,
    });
  },
  updateApplied(version: string) {
    return toast.success(`✅ Agente atualizado para v${version}`, {
      id: k(["update-applied", version]),
      duration: DURATION.success,
    });
  },
};

// ─── 5. AUTOMAÇÃO ───────────────────────────────────────────────────────────
export const notifyAutomation = {
  executed(equipName: string, action: "ligado" | "desligado") {
    return toast.info(`🤖 Automação: ${equipName} ${action} conforme programação`, {
      id: k(["auto-exec", equipName, action]),
      duration: DURATION.info,
    });
  },
  failed(equipName: string) {
    return toast.warning(`⚠️ Automação: falha ao executar comando para ${equipName}`, {
      id: k(["auto-fail", equipName]),
      duration: DURATION.warning,
    });
  },
};

// ─── 6. CADASTROS (PLCs, Equipamentos, Setores) ─────────────────────────────
export const notifyRegistry = {
  created(kind: string, name: string) {
    return toast.success(`✅ ${kind} "${name}" criado(a)`, {
      id: k(["reg-create", kind, name]),
      duration: DURATION.success,
    });
  },
  updated(kind: string, name: string) {
    return toast.success(`✅ ${kind} "${name}" atualizado(a)`, {
      id: k(["reg-update", kind, name]),
      duration: DURATION.success,
    });
  },
  removed(kind: string, name: string) {
    return toast.success(`✅ ${kind} "${name}" removido(a)`, {
      id: k(["reg-remove", kind, name]),
      duration: DURATION.success,
    });
  },
  error(kind: string, message: string) {
    return toast.error(`🔴 ${kind}: ${message}`, {
      id: k(["reg-error", kind, message]),
      duration: DURATION.error,
    });
  },
  queuedOffline(kind: string) {
    return toast.info(`ℹ️ Sem internet — ${kind} enfileirado(a) para sincronizar`, {
      id: k(["reg-queue", kind]),
      duration: DURATION.info,
    });
  },
};

// ─── 7. CONFIGURAÇÕES (toggles, tarifas, horários) ──────────────────────────
export const notifyConfig = {
  saved(setting: string) {
    return toast.success(`✅ ${setting} salvo`, {
      id: k(["cfg-saved", setting]),
      duration: DURATION.success,
    });
  },
  toggled(setting: string, on: boolean) {
    return toast.success(`✅ ${setting} ${on ? "ativado" : "desativado"}`, {
      id: k(["cfg-toggle", setting]),
      duration: DURATION.success,
    });
  },
  error(setting: string, message: string) {
    return toast.error(`🔴 ${setting}: ${message}`, {
      id: k(["cfg-error", setting]),
      duration: DURATION.error,
    });
  },
};

// ─── 8. USUÁRIOS / TÉCNICOS ────────────────────────────────────────────────
export const notifyUser = {
  created(email: string) {
    return toast.success(`✅ Usuário ${email} criado`, {
      id: k(["user-create", email]),
      duration: DURATION.success,
    });
  },
  updated(email: string) {
    return toast.success(`✅ Usuário ${email} atualizado`, {
      id: k(["user-update", email]),
      duration: DURATION.success,
    });
  },
  removed(email: string) {
    return toast.success(`✅ Usuário ${email} removido`, {
      id: k(["user-remove", email]),
      duration: DURATION.success,
    });
  },
  rolePromoted(email: string, role: string) {
    return toast.success(`✅ ${email} agora é ${role}`, {
      id: k(["user-role", email, role]),
      duration: DURATION.success,
    });
  },
  passwordCopied(email: string) {
    return toast.success(`✅ Senha de ${email} copiada`, {
      id: k(["user-pwd-copy", email]),
      duration: DURATION.success,
    });
  },
  error(message: string) {
    return toast.error(`🔴 Usuários: ${message}`, {
      id: k(["user-error", message]),
      duration: DURATION.error,
    });
  },
};

// ─── 9. RELATÓRIOS / EXPORTAÇÃO ─────────────────────────────────────────────
export const notifyReport = {
  exported(format: "PDF" | "CSV", reportName?: string) {
    const suffix = reportName ? ` — ${reportName}` : "";
    return toast.success(`✅ Relatório${suffix} exportado em ${format}`, {
      id: k(["report-export", format, reportName]),
      duration: DURATION.success,
    });
  },
  error(format: "PDF" | "CSV", message: string) {
    return toast.error(`🔴 Falha ao exportar ${format}: ${message}`, {
      id: k(["report-err", format]),
      duration: DURATION.error,
    });
  },
};

// ─── 10. DISPOSITIVOS (anti-clone) ─────────────────────────────────────────
export const notifyDevice = {
  blocked(label?: string) {
    const who = label ? ` — ${label}` : "";
    return toast.error(`🔴 Dispositivo bloqueado${who}`, {
      id: k(["dev-block", label]),
      duration: DURATION.error,
    });
  },
  unlinked(label?: string) {
    const who = label ? ` — ${label}` : "";
    return toast.success(`✅ Dispositivo desvinculado${who}`, {
      id: k(["dev-unlink", label]),
      duration: DURATION.success,
    });
  },
  authChanged(enabled: boolean) {
    return toast.success(
      enabled
        ? "✅ Autorização por dispositivo ATIVADA"
        : "✅ Autorização por dispositivo DESATIVADA",
      { id: "dev-auth-toggle", duration: DURATION.success },
    );
  },
  error(message: string) {
    return toast.error(`🔴 Dispositivos: ${message}`, {
      id: k(["dev-error", message]),
      duration: DURATION.error,
    });
  },
};

// ─── 11. ATUALIZAÇÕES OTA / RELEASES ────────────────────────────────────────
export const notifyUpdate = {
  available(version: string) {
    return toast.info(`ℹ️ Nova versão disponível: v${version}`, {
      id: k(["ota-avail", version]),
      duration: DURATION.info,
    });
  },
  downloadStarted(version: string) {
    return toast.info(`⏳ Baixando atualização v${version}…`, {
      id: k(["ota-dl", version]),
      duration: DURATION.info,
    });
  },
  applied(version: string) {
    return toast.success(`✅ Agente atualizado para v${version}`, {
      id: k(["ota-applied", version]),
      duration: DURATION.success,
    });
  },
  failed(version: string, message: string) {
    return toast.error(`🔴 Falha ao atualizar v${version}: ${message}`, {
      id: k(["ota-fail", version]),
      duration: DURATION.error,
    });
  },
  releasePublished(version: string) {
    return toast.success(`✅ Release v${version} publicada`, {
      id: k(["release-pub", version]),
      duration: DURATION.success,
    });
  },
  releaseSet(version: string) {
    return toast.success(`✅ v${version} marcada como atual`, {
      id: k(["release-cur", version]),
      duration: DURATION.success,
    });
  },
  releaseRemoved(version: string) {
    return toast.success(`✅ Release v${version} removida`, {
      id: k(["release-rm", version]),
      duration: DURATION.success,
    });
  },
};

// ─── 12. GENÉRICOS — fallback padronizado ───────────────────────────────────
// Use APENAS quando nenhum dos namespaces específicos couber. Sempre passe um
// `context` (ex: "Tarifa Coelba") para que a mensagem identifique o recurso.
export const notify = {
  ok(context: string, message: string) {
    return toast.success(`✅ ${context}: ${message}`, {
      id: k(["g-ok", context, message]),
      duration: DURATION.success,
    });
  },
  warn(context: string, message: string) {
    return toast.warning(`⚠️ ${context}: ${message}`, {
      id: k(["g-warn", context, message]),
      duration: DURATION.warning,
    });
  },
  fail(context: string, message: string) {
    return toast.error(`🔴 ${context}: ${message}`, {
      id: k(["g-fail", context, message]),
      duration: DURATION.error,
    });
  },
  tip(context: string, message: string) {
    return toast.info(`ℹ️ ${context}: ${message}`, {
      id: k(["g-tip", context, message]),
      duration: DURATION.info,
    });
  },
};

// ─── Re-export do sonner para casos pontuais (mantém compat) ───────────────
export { toast };

