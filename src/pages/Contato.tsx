import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail, Phone, Globe, Instagram, Facebook, MapPin } from "lucide-react";

type ContactItem = {
  icon: typeof Phone;
  label: string;
  value: string;
  href: string;
  iconClass?: string;
  iconWrapClass?: string;
};

const contactItems: ContactItem[] = [
  {
    icon: Phone,
    label: "Telefone",
    value: "(77) 98150-3951",
    href: "tel:+5577981503951",
  },
  {
    icon: Mail,
    label: "E-mail",
    value: "contato@renovelectronics.com.br",
    href: "mailto:contato@renovelectronics.com.br",
  },
  {
    icon: Globe,
    label: "Site",
    value: "renovtecnologia.com.br",
    href: "https://renovtecnologia.com.br",
  },
  {
    icon: Instagram,
    label: "Instagram",
    value: "@renovtecnologiaagricola",
    href: "https://www.instagram.com/renovtecnologiaagricola?utm_source=ig_web_button_share_sheet&igsh=ZDNlZDc0MzIxNw==",
    // Gradiente oficial Instagram simulado em fundo
    iconWrapClass:
      "bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5]",
    iconClass: "text-white",
  },
  {
    icon: Facebook,
    label: "Facebook",
    value: "Renov Tecnologia Agrícola",
    href: "https://facebook.com/renovtecnologia",
    // Azul oficial Facebook
    iconWrapClass: "bg-[#1877F2]",
    iconClass: "text-white fill-white",
  },
];

const Contato = () => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Phone className="w-6 h-6 text-primary" /> Contato
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Entre em contato com a Renov Tecnologia Agrícola
        </p>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base text-foreground">
            Canais de Atendimento
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {contactItems.map((item) => (
            <a
              key={item.label}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-4 p-4 rounded-xl bg-secondary/50 border border-border hover:bg-secondary hover:border-primary/30 transition-all duration-200 group"
            >
              <div
                className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                  item.iconWrapClass ??
                  "bg-primary/10 group-hover:bg-primary/20"
                }`}
              >
                <item.icon
                  className={`w-5 h-5 ${item.iconClass ?? "text-primary"}`}
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">
                  {item.label}
                </p>
                <p className="text-sm font-semibold text-foreground">
                  {item.value}
                </p>
              </div>
            </a>
          ))}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <MapPin className="w-4 h-4 text-primary" /> Endereço
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm text-foreground font-medium">
              Rua Piauí, nº 80 — Prédio Via Lajedo, Sala 19
            </p>
            <p className="text-sm text-muted-foreground">
              Luís Eduardo Magalhães — BA
            </p>
            <p className="text-sm text-muted-foreground">CEP: 47850-043</p>
          </div>
          <a
            href="https://share.google/zURaB7MlausesmL74"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <MapPin className="w-4 h-4" />
            Como chegar (Google Maps)
          </a>
        </CardContent>
      </Card>
    </div>
  );
};

export default Contato;
