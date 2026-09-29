"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/**
 * Casco de navegação do header da landing.
 *
 * Desktop (>=880px): o botão fica escondido por CSS e a <nav> aparece na mesma
 * linha do logo (nav v2 flat de 6 itens), com o miolo compactado entre 880 e
 * 1199px.
 *
 * Mobile/tablet (<880px): a <nav> colapsa num painel pendurado abaixo do header
 * fixo, aberto pelo hamburger. O corte em 880px é medido: a linha completa
 * (6 chips + idioma + entrar + CTA + wordmark) cabe a partir daí em EN e PT-BR
 * (medidor de header), e abaixo disso os rótulos apertavam e a CTA saía da tela
 * (t_38d21dc4). Acima de 900px a nav é obrigatoriamente inline (reclamação do
 * fundador: hambúrguer em ~1100px escondia os links).
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
    const desktop = window.matchMedia("(min-width: 880px)");
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
