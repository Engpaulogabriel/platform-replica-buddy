import renovLogo from "@/assets/renov-logo.png";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield } from "lucide-react";

const Privacidade = () => {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50">
        <div className="max-w-3xl mx-auto px-4 py-6 flex items-center gap-3">
          <img src={renovLogo} alt="RENOV Tecnologia Agrícola" className="h-12 w-auto object-contain" />
          <div>
            <h1 className="text-xl font-bold text-primary">RENOV Tecnologia Agrícola</h1>
            <p className="text-xs text-muted-foreground">Gestor de Bombas</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-6">
          <Shield className="w-8 h-8 text-primary" />
          <h1 className="text-3xl font-bold">Política de Privacidade</h1>
        </div>

        <p className="text-sm text-muted-foreground mb-8">
          Esta Política de Privacidade descreve como a <strong>RENOV Tecnologia Agrícola LTDA</strong> coleta,
          utiliza e protege os dados relacionados ao uso da integração com WhatsApp Business para
          gerenciamento remoto de equipamentos (sistema de controle de bombas).
        </p>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-primary">1. Dados Coletados</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-2">
              <p>Coletamos os seguintes dados durante o uso da integração:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Número de telefone do operador</li>
                <li>Mensagens de comando enviadas via WhatsApp (liga, desliga, status)</li>
                <li>Logs de operação dos equipamentos</li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-primary">2. Finalidade</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Os dados são utilizados exclusivamente para automação e controle remoto de equipamentos
              de irrigação e captação de água.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-primary">3. Armazenamento</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Os dados são armazenados de forma segura em servidores criptografados (Supabase/AWS)
              com acesso restrito apenas a pessoal autorizado.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-primary">4. Compartilhamento</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Não compartilhamos dados pessoais com terceiros, exceto quando exigido por lei.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-primary">5. Direitos do Usuário</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              O operador pode solicitar a exclusão dos seus dados a qualquer momento entrando em
              contato com o administrador do sistema.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-primary">6. Contato</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Para dúvidas ou solicitações relacionadas a esta política, entre em contato pelo e-mail:{" "}
              <a
                href="mailto:contato@renovelectronics.com.br"
                className="text-primary hover:underline font-medium"
              >
                contato@renovelectronics.com.br
              </a>
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground mt-8 text-center">
          Última atualização: Junho de 2026
        </p>
      </main>

      <footer className="border-t border-border mt-10">
        <div className="max-w-3xl mx-auto px-4 py-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} RENOV Tecnologia Agrícola LTDA. Todos os direitos reservados.
        </div>
      </footer>
    </div>
  );
};

export default Privacidade;
