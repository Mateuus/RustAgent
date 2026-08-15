'use client';

// ============================================================
//  element-view.tsx  -  um elemento do modelo, desenhado em DOM.
//
//  ####  O DESENHO PRECISA PARECER O JOGO  ####
//
//  Não é um `<div>` solto com `left`/`top` em pixels: é a MESMA
//  regra de âncora do CUI, escrita em `calc(% + px)`. Assim a
//  âncora continua sendo uma porcentagem do PAI no DOM,
//  exatamente como no jogo, e um elemento aninhado três níveis
//  abaixo funciona sem ninguém resolver a cadeia.
//
//  Um preview que engana é pior que preview nenhum: o erro de
//  âncora só apareceria depois, dentro do jogo, com a tela inteira
//  já desenhada em cima dele.
//
//  ####  O QUE ESTE ARQUIVO NÃO FAZ  ####
//
//  Ele não converte para CUI. Isso é do agente, onde tem teste —
//  o editor pede pelo `POST /api/ui/documents/:id/preview` quando
//  quer ver o JSON que de fato vai ao jogo.
// ============================================================

import type { CSSProperties, MouseEvent } from 'react';

import { cssColorFromHex } from '@/lib/ui-doc/color';
import { rectToCss } from '@/lib/ui-doc/geometry';
import type { UiElement } from '@/lib/ui-doc/model';
import { cn } from '@/lib/utils';

/**
 * O `align` do Unity -> as duas propriedades do flexbox.
 *
 * São nove combinações de vertical e horizontal, e o nome do Unity
 * junta as duas numa palavra só (`UpperLeft`). Partir a palavra é
 * mais honesto que uma tabela de nove entradas.
 */
function alignToFlex(align: string): { justifyContent: string; alignItems: string } {
  const vertical = align.startsWith('Upper')
    ? 'flex-start'
    : align.startsWith('Lower')
      ? 'flex-end'
      : 'center';

  const horizontal = align.endsWith('Left')
    ? 'flex-start'
    : align.endsWith('Right')
      ? 'flex-end'
      : 'center';

  return { justifyContent: horizontal, alignItems: vertical };
}

export interface ElementViewProps {
  readonly element: UiElement;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /**
   * Escala do palco.
   *
   * O tamanho da fonte é em pixels da base 1280x720, e o palco
   * inteiro é escalado. Se a fonte não fosse escalada junto, um
   * texto de 26px continuaria com 26px enquanto a caixa dele
   * encolhesse — e o preview mentiria justamente sobre o que mais
   * estoura layout no jogo.
   */
  readonly scale: number;
}

export function ElementView({ element, selectedId, onSelect, scale }: ElementViewProps) {
  const css = rectToCss(element.rect);

  const base: CSSProperties = {
    position: 'absolute',
    left: css.left,
    right: css.right,
    top: css.top,
    bottom: css.bottom,
  };

  const selected = element.id === selectedId;

  const children = element.children.map((child) => (
    <ElementView
      key={child.id}
      element={child}
      selectedId={selectedId}
      onSelect={onSelect}
      scale={scale}
    />
  ));

  const outline = selected
    ? 'outline outline-1 outline-offset-0 outline-rust'
    : 'hover:outline hover:outline-1 hover:outline-dashed hover:outline-muted';

  const select = (event: MouseEvent): void => {
    // Sem isto, clicar num filho selecionaria o pai junto — o
    // evento sobe até a raiz e o último `onSelect` ganha.
    event.stopPropagation();
    onSelect(element.id);
  };

  switch (element.type) {
    case 'panel':
      return (
        <div
          style={{ ...base, backgroundColor: cssColorFromHex(element.color) }}
          className={cn(outline, 'cursor-pointer')}
          onClick={select}
          title={element.name}
        >
          {children}
        </div>
      );

    case 'label': {
      const flex = alignToFlex(element.align);

      return (
        <div
          style={{
            ...base,
            display: 'flex',
            ...flex,
            color: cssColorFromHex(element.color),
            fontSize: `${String(element.fontSize * scale)}px`,
            // As fontes do Rust não estão no navegador. O que dá
            // para honrar é a FAMÍLIA: condensada ou monoespaçada —
            // e é ela que muda a largura do texto, que é o que
            // estoura layout.
            fontFamily: element.font.startsWith('DroidSansMono')
              ? 'ui-monospace, monospace'
              : 'var(--font-condensed, system-ui), system-ui',
            fontWeight: element.font.includes('Bold') ? 700 : 400,
            lineHeight: 1.1,
            whiteSpace: 'pre-wrap',
            overflow: 'hidden',
          }}
          className={cn(outline, 'cursor-pointer')}
          onClick={select}
          title={element.name}
        >
          {element.text}
          {children}
        </div>
      );
    }

    case 'button': {
      const flex = alignToFlex(element.align);

      return (
        <div
          style={{ ...base, backgroundColor: cssColorFromHex(element.color) }}
          className={cn(outline, 'cursor-pointer')}
          onClick={select}
          title={element.name}
        >
          {/* ####  UM BOTÃO SÃO DOIS ELEMENTOS  ####

              O `CuiButtonComponent` não tem texto: o rótulo é um
              filho que ocupa o retângulo inteiro. O preview repete
              essa estrutura para que o alinhamento do texto se
              comporte aqui como se comporta lá. */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              ...flex,
              color: cssColorFromHex(element.textColor),
              fontSize: `${String(element.fontSize * scale)}px`,
              fontFamily: 'var(--font-condensed, system-ui), system-ui',
              fontWeight: element.font.includes('Bold') ? 700 : 400,
              overflow: 'hidden',
            }}
          >
            {element.text}
          </div>
          {children}
        </div>
      );
    }

    case 'image':
      return (
        <div
          style={{
            ...base,
            backgroundColor: cssColorFromHex(element.color),
            // A imagem de verdade só existe dentro do jogo: sprite
            // é asset da Facepunch, `item` é o ícone do inventário
            // e `stored` é um número do FileStorage. O preview
            // mostra a CAIXA e a origem — inventar um desenho aqui
            // faria o editor prometer o que não sabe.
            opacity: 0.85,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          className={cn(outline, 'cursor-pointer')}
          onClick={select}
          title={`${element.name} — ${element.source.kind}`}
        >
          <span
            style={{ fontSize: `${String(9 * scale)}px` }}
            className="pointer-events-none select-none uppercase tracking-wide text-background"
          >
            {element.source.kind}
          </span>
          {children}
        </div>
      );
  }
}
