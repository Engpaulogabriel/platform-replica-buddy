import { useEffect, useRef, useState, type ReactNode } from "react";

interface LazyVisibleProps {
  children: ReactNode;
  /** Altura mínima do placeholder enquanto fora do viewport (px). */
  minHeight?: number;
  /** Margem para pré-carregar antes de entrar no viewport. */
  rootMargin?: string;
  /** Se true, uma vez visível permanece montado. Default true. */
  keepMounted?: boolean;
  className?: string;
}

/**
 * Monta os filhos só quando o elemento entra (ou se aproxima) do viewport.
 * Usa IntersectionObserver — leve e suportado em todos os navegadores modernos.
 *
 * Útil para virtualizar grids grandes (ex.: dezenas de cards de bomba no
 * iPad), reduzindo trabalho de render e custo de React reconciliation.
 */
export function LazyVisible({
  children,
  minHeight = 64,
  rootMargin = "200px",
  keepMounted = true,
  className,
}: LazyVisibleProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            if (keepMounted) {
              io.disconnect();
              return;
            }
          } else if (!keepMounted) {
            setVisible(false);
          }
        }
      },
      { rootMargin, threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin, keepMounted]);

  // `content-visibility: auto` permite ao próprio navegador pular layout/paint
  // de elementos fora do viewport — barato e nativo. Combinado com o
  // IntersectionObserver acima, garante que cards só montem React quando perto
  // de aparecer, e mesmo quando montados não consumam pintura fora da tela.
  const style: React.CSSProperties = visible
    ? { contentVisibility: "auto" as React.CSSProperties["contentVisibility"], containIntrinsicSize: `${minHeight}px` }
    : { minHeight, contentVisibility: "auto" as React.CSSProperties["contentVisibility"], containIntrinsicSize: `${minHeight}px` };

  return (
    <div ref={ref} className={className} style={style}>
      {visible ? children : null}
    </div>
  );
}
