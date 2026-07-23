// ─────────────────────────────────────────────────────────────────────────────
// ConfirmDialog — modal de confirmação reutilizável (imperativo)
// ─────────────────────────────────────────────────────────────────────────────
// Uso:
//   const ok = await confirmAction({
//     title: "Deseja ligar Poço 03?",
//     confirmLabel: "Ligar",
//     variant: "default", // "default" | "destructive" | "warning"
//   });
//   if (!ok) return;
//
// Renderiza usando o AlertDialog do shadcn. Monta uma única raiz no body
// quando chamado pela primeira vez.
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "destructive" pinta o botão de confirmar de vermelho. */
  variant?: "default" | "destructive" | "warning";
}

let containerRoot: Root | null = null;
function getRoot(): Root {
  if (containerRoot) return containerRoot;
  const el = document.createElement("div");
  el.id = "confirm-dialog-root";
  document.body.appendChild(el);
  containerRoot = createRoot(el);
  return containerRoot;
}

interface InnerProps extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

function ConfirmDialogInner({
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  variant = "default",
  resolve,
}: InnerProps) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!open) {
      // Pequeno atraso para a animação de saída terminar antes de desmontar.
      const t = setTimeout(() => resolve(false), 150);
      return () => clearTimeout(t);
    }
  }, [open, resolve]);

  const confirmClass =
    variant === "destructive"
      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
      : variant === "warning"
      ? "bg-warning text-warning-foreground hover:bg-warning/90"
      : undefined;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setOpen(false)}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            className={confirmClass}
            onClick={() => {
              setOpen(false);
              // Resolve imediatamente como true; o useEffect de close não vai
              // sobrepor porque resolve só é chamado uma vez.
              resolve(true);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Promise<boolean> — true se o usuário confirmou, false se cancelou. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const root = getRoot();
    let settled = false;
    const wrappedResolve = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
      // Desmonta após resolver para liberar o portal.
      setTimeout(() => {
        root.render(<></>);
      }, 200);
    };
    root.render(<ConfirmDialogInner {...opts} resolve={wrappedResolve} />);
  });
}
