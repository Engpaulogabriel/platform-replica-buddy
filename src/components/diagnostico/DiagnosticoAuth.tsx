import RestrictedAuth from "@/components/RestrictedAuth";

interface DiagnosticoAuthProps {
  children: React.ReactNode;
}

const DiagnosticoAuth = ({ children }: DiagnosticoAuthProps) => (
  <RestrictedAuth
    title="Acesso ao Diagnóstico"
    description="Área restrita para técnicos e pessoal autorizado."
  >
    {children}
  </RestrictedAuth>
);

export default DiagnosticoAuth;
