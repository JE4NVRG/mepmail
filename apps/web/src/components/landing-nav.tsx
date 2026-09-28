"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/**
 * Casco de navegação do header da landing.
 *
 * Desktop (>=1024px): o botão fica escondido por CSS e a <nav> aparece na mesma
 * linha do logo, exatamente como antes.
 *
 * Mobile/tablet (<1024px): a <nav> colapsa num painel pendurado abaixo do header
 * fixo, aberto pelo hamburger. O corte em 1024px é medido: com a linha completa
 * o header precisa de ~1050px para não apertar os rótulos (EN é o pior caso) e
 * abaixo disso os links quebravam a palavra e a CTA saía da tela (t_38d21dc4).
 *
 * O painel fecha ao tocar num link (o alvo já rolou a página; o painel não pode
 * ficar por cima do conteúdo), com Escape e quando a viewport volta para
 * desktop (evita estado "aberto" invisível depois de girar a tela).
 */
export function LandingNav({
  label,
  menuLabel,
  children,
}: {
  label: string;
  menuLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    // Fecha ao tocar em qualquer link do painel: o clique já navegou/rolou.
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
    };
    const panel = panelRef.current;
    document.addEventListener("keydown", onKeyDown);
    panel?.addEventListener("click", onClick);
    desktop.addEventListener("change", onDesktop);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      panel?.removeEventListener("click", onClick);
      desktop.removeEventListener("change", onDesktop);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="gtm-nav-burger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={menuLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <nav
        id={panelId}
        ref={panelRef}
        className={open ? "gtm-nav is-open" : "gtm-nav"}
        aria-label={label}
      >
        {children}
      </nav>
    </>
  );
}
