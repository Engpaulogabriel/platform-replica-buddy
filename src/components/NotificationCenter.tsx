import { useMemo, useCallback, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell, CheckCheck, Trash2, AlertTriangle, AlertCircle, Info,
  CheckCircle, FileText,
} from "lucide-react";
import { useNotifications, type NotifSeverity, type Notification } from "@/contexts/NotificationContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const severityConfig: Record<NotifSeverity, { icon: typeof Bell; color: string; bg: string }> = {
  critical: { icon: AlertCircle, color: "text-destructive", bg: "bg-destructive/10 border-destructive/30" },
  warning: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/10 border-warning/30" },
  info: { icon: Info, color: "text-info", bg: "bg-info/10 border-info/30" },
  success: { icon: CheckCircle, color: "text-primary", bg: "bg-primary/10 border-primary/30" },
};

function timeAgo(date: Date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderNotifList(items: Notification[], onClick: (id: string) => void, emptyText: string) {
  if (items.length === 0) {
    return (
      <div className="text-center py-10 px-4">
        <CheckCircle className="w-8 h-8 text-primary/40 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-border">
      {items.map((n) => {
        const cfg = severityConfig[n.severity];
        const Icon = cfg.icon;
        const resolved = !!n.resolvedAt;
        return (
          <button
            key={n.id}
            onClick={() => onClick(n.id)}
            className={`w-full text-left px-3 py-2.5 hover:bg-secondary/50 transition-colors ${
              !n.read ? "bg-primary/5" : ""
            } ${resolved ? "opacity-60" : ""}`}
          >
            <div className="flex gap-2">
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${cfg.bg}`}>
                <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className={`text-xs font-semibold truncate ${!n.read ? cfg.color : "text-muted-foreground"}`}>
                    {n.title}
                  </span>
                  {!n.read && !resolved && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                  {resolved && (
                    <span className="text-[9px] uppercase tracking-wide text-primary/70 shrink-0">resolvido</span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground line-clamp-2">{n.message}</p>
                <span className="text-[10px] text-muted-foreground/60">{timeAgo(n.timestamp)}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function NotificationCenter() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } = useNotifications();
  const [flash, setFlash] = useState(false);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (unreadCount === 0) return;
    void markAllAsRead();
    setFlash(true);
    window.setTimeout(() => setFlash(false), 450);
  }, [markAllAsRead, unreadCount]);

  const failures = useMemo(() => notifications.filter((n) => n.kind === "failure"), [notifications]);
  const system = useMemo(() => notifications.filter((n) => n.kind === "system"), [notifications]);
  const unreadFailures = failures.filter((n) => !n.read).length;
  const unreadSystem = system.filter((n) => !n.read).length;

  const handleOpenChange = useCallback((open: boolean) => {
    // não marca como lido automaticamente — usuário clica em cada item
  }, []);

  // Sino sempre ativo — sem toggle por fazenda.

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={`relative p-2 rounded-xl bg-secondary/60 border border-border hover:bg-secondary transition-colors ${flash ? "ring-2 ring-primary/70 scale-95" : ""}`}
          aria-label="Alertas e notificações — duplo clique para marcar todas como lidas"
          title="Duplo clique para marcar todas como lidas"
          onDoubleClick={handleDoubleClick}
        >
          <Bell className={`w-4 h-4 text-foreground ${flash ? "animate-pulse" : ""}`} />
          {unreadCount > 0 && !flash && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold animate-pulse">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-semibold text-foreground">Alertas</span>
          <div className="flex gap-1">
            {unreadCount > 0 && (
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={markAllAsRead}>
                <CheckCheck className="w-3 h-3" /> Ler todas
              </Button>
            )}
            <Button asChild variant="ghost" size="sm" className="h-7 text-xs gap-1 text-primary">
              <Link to="/alarmes">
                <FileText className="w-3 h-3" /> Ver tudo
              </Link>
            </Button>
          </div>
        </div>

        <Tabs defaultValue="failure" className="w-full">
          <TabsList className="w-full grid grid-cols-2 rounded-none h-9 bg-muted/40">
            <TabsTrigger value="failure" className="text-xs gap-1">
              <AlertTriangle className="w-3 h-3" />
              Falhas
              {unreadFailures > 0 && (
                <span className="ml-1 px-1.5 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold">
                  {unreadFailures}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="system" className="text-xs gap-1">
              <Bell className="w-3 h-3" />
              Sistema
              {unreadSystem > 0 && (
                <span className="ml-1 px-1.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold">
                  {unreadSystem}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="failure" className="m-0">
            <ScrollArea className="h-80">
              {renderNotifList(failures, markAsRead, "Nenhuma falha registrada")}
            </ScrollArea>
            {failures.length > 0 && (
              <div className="border-t border-border px-3 py-2 flex items-center justify-between bg-muted/30">
                <span className="text-[10px] text-muted-foreground">
                  {failures.length} alerta{failures.length === 1 ? "" : "s"}
                </span>
                <Button variant="ghost" size="sm" className="h-6 text-[11px] gap-1 text-destructive hover:text-destructive" onClick={clearAll}>
                  <Trash2 className="w-3 h-3" /> Marcar todas como lidas
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="system" className="m-0">
            <ScrollArea className="h-80">
              {renderNotifList(system, markAsRead, "Nenhum evento de sistema")}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
