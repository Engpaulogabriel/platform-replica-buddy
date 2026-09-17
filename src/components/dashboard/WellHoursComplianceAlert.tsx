// Placeholder de compatibilidade.
// O Dashboard entregue no pacote importa este componente, mas o módulo de
// alerta de horas de poço ainda não existe neste projeto. Para não inventar
// regra de compliance (INEMA/outorga), o componente não renderiza nada.
interface WellHoursComplianceAlertProps {
  farmId: string | null;
}

export function WellHoursComplianceAlert(_props: WellHoursComplianceAlertProps) {
  return null;
}

export default WellHoursComplianceAlert;
