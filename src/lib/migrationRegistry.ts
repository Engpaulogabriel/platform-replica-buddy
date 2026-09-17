// ─────────────────────────────────────────────────────────────────────────────
// migrationRegistry — PONTO ÚNICO da migração de backend por fazenda
// ─────────────────────────────────────────────────────────────────────────────
// Enquanto a plataforma vive em dois projetos Supabase, este arquivo é a ÚNICA
// fonte de verdade sobre qual fazenda já está no backend novo.
//
// Para migrar a próxima fazenda: acrescente o UUID em MIGRATED_FARMS.
// Para reverter tudo: esvazie MIGRATED_FARMS. O sistema inteiro volta ao OLD.
//
// NÃO espalhe UUID de fazenda pelo resto do projeto. Use isFarmMigrated().

/** Fazendas cujo Agent já opera no backend NOVO (uzqvtimpsynnupmfozru). */
export const MIGRATED_FARMS: ReadonlySet<string> = new Set<string>([
  // Fazenda Pérola — piloto, Agent promovido em 2026-09-17T17:14:22Z
  "1014a8ab-b02a-47c7-90fc-1646d52a991e",
]);

/**
 * true  → a fazenda vive no backend NOVO
 * false → a fazenda vive no backend ANTIGO (comportamento histórico)
 *
 * farmId nulo/vazio devolve false de propósito: sem identidade de fazenda não
 * há decisão possível, e o padrão seguro é o backend de sempre. Para ESCRITA,
 * quem decide o bloqueio é assertOperationalClient() no supabaseRouter.
 */
export function isFarmMigrated(farmId: string | null | undefined): boolean {
  if (!farmId) return false;
  return MIGRATED_FARMS.has(farmId);
}

/** Há alguma fazenda migrada? Decide se vale tentar autenticar no backend novo. */
export function hasAnyMigratedFarm(): boolean {
  return MIGRATED_FARMS.size > 0;
}

/**
 * Recursos operacionais que DEVEM seguir o backend da fazenda. Documentação
 * executável do "conjunto coerente": se uma tela operacional lê qualquer um
 * destes, precisa lê-lo do mesmo backend para onde manda comando.
 */
export const OPERATIONAL_TABLES = [
  "equipments",
  "commands",
  "agent_commands",
  "site_health",
  "plc_groups",
] as const;
