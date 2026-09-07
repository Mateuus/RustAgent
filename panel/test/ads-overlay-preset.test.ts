// ============================================================
//  Testes do PRESET do overlay de propagandas.
//
//  ####  O QUE ELES PROTEGEM  ####
//
//  A ida e a volta precisam ser a MESMA conta. Se o preset
//  desenhar o painel num lugar e a leitura interpretar outro, o
//  admin arrasta no editor, traz as medidas de volta, e o widget
//  pula para um canto que ele não escolheu — sem erro nenhum e
//  sem nada dizer por quê.
//
//  E a geometria aqui precisa bater com a do AGENTE
//  (`cornerOf`/`cornerOffsets` em core/src/game/ads-timeline.ts):
//  se divergirem, o desenho no editor deixa de valer como
//  medida, que é a única razão de ele existir.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  ADS_DOCUMENT_ID,
  ADS_LOGO_ID,
  ADS_PANEL_ID,
  ADS_ROOT_ID,
  buildAdsOverlayDocument,
  readAdsOverlayLayout,
  type AdsOverlayLayout,
} from '../src/lib/ui-doc/presets/ads-overlay';
import { findElement } from '../src/lib/ui-doc/model';
import { findDocumentProblems } from '../src/lib/ui-doc/validate';

const LAYOUT: AdsOverlayLayout = {
  anchor: 'top-right',
  marginTop: 24,
  marginRight: 32,
  logoWidth: 90,
  logoHeight: 90,
  panelWidth: 360,
  panelHeight: 120,
  panelColor: '#0A0A0AEB',
  panelBorderColor: '#FFFFFF26',
  logoImageUrl: 'https://exemplo.com/logo.png',
};

describe('o documento gerado', () => {
  it('é válido para o agente', () => {
    const document = buildAdsOverlayDocument(LAYOUT);

    // ####  AQUI TODO PROBLEMA E PROBLEMA  ####
    //
    // No editor antigo a validação tinha severidade, e este teste
    // filtrava os `error`. O `findDocumentProblems` deste painel
    // só devolve o que o CORE recusaria na gravação — não há
    // aviso brando para descartar.
    //
    // Se este teste falhar, o botão "Mandar para o editor"
    // devolveria 400 e ninguém saberia dizer por quê.
    expect(findDocumentProblems(document)).toEqual([]);
  });

  it('tem id fixo: regerar SUBSTITUI em vez de duplicar', () => {
    expect(buildAdsOverlayDocument(LAYOUT).id).toBe(ADS_DOCUMENT_ID);
    expect(buildAdsOverlayDocument(LAYOUT).id).toBe(buildAdsOverlayDocument(LAYOUT).id);
  });

  it('nasce SEM cursor', () => {
    // O overlay de verdade não recebe clique. Uma maquete que
    // rouba o mouse ensinaria a coisa errada sobre o que se está
    // desenhando.
    expect(buildAdsOverlayDocument(LAYOUT).cursor).toBe(false);
  });

  it('ancora no canto superior direito, com as margens', () => {
    const document = buildAdsOverlayDocument(LAYOUT);
    const screen = document.screens[0];
    const root = findElement(screen?.elements ?? [], ADS_ROOT_ID);

    expect(root).not.toBeNull();
    expect(root?.rect.anchorMin).toEqual({ x: 1, y: 1 });
    expect(root?.rect.anchorMax).toEqual({ x: 1, y: 1 });

    // Os dois offsets NEGATIVOS: é o que a mesma conta do agente
    // produz. Um sinal trocado joga o widget para fora da tela.
    expect(root?.rect.offsetMax.x).toBe(-32);
    expect(root?.rect.offsetMax.y).toBe(-24);
    expect(root?.rect.offsetMin.x).toBe(-(32 + 360));
    expect(root?.rect.offsetMin.y).toBe(-(24 + 120));
  });

  it('o logo e o painel entram com as medidas pedidas', () => {
    const document = buildAdsOverlayDocument(LAYOUT);
    const elements = document.screens[0]?.elements ?? [];

    const logo = findElement(elements, ADS_LOGO_ID);
    const panel = findElement(elements, ADS_PANEL_ID);

    expect(Math.abs((logo?.rect.offsetMax.x ?? 0) - (logo?.rect.offsetMin.x ?? 0))).toBe(90);
    expect(Math.abs((panel?.rect.offsetMax.x ?? 0) - (panel?.rect.offsetMin.x ?? 0))).toBe(360);
    expect(Math.abs((panel?.rect.offsetMax.y ?? 0) - (panel?.rect.offsetMin.y ?? 0))).toBe(120);
  });

  it('o canto superior esquerdo espelha os sinais', () => {
    const document = buildAdsOverlayDocument({ ...LAYOUT, anchor: 'top-left' });
    const root = findElement(document.screens[0]?.elements ?? [], ADS_ROOT_ID);

    expect(root?.rect.anchorMin).toEqual({ x: 0, y: 1 });
    expect(root?.rect.offsetMin.x).toBe(32);
    expect(root?.rect.offsetMax.x).toBe(32 + 360);
  });
});

describe('a volta', () => {
  it('a ida e a volta devolvem as MESMAS medidas', () => {
    const document = buildAdsOverlayDocument(LAYOUT);
    const back = readAdsOverlayLayout(document);

    expect(back).not.toBeNull();
    // Se isto divergir, arrastar no editor e trazer de volta
    // moveria o widget para um canto que ninguém escolheu.
    expect(back).toMatchObject({
      anchor: 'top-right',
      marginTop: 24,
      marginRight: 32,
      logoWidth: 90,
      logoHeight: 90,
      panelWidth: 360,
      panelHeight: 120,
      logoImageUrl: 'https://exemplo.com/logo.png',
    });
  });

  it('a ida e a volta funcionam nos quatro cantos', () => {
    for (const anchor of ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const) {
      const back = readAdsOverlayLayout(buildAdsOverlayDocument({ ...LAYOUT, anchor }));

      expect(back?.anchor).toBe(anchor);
      expect(back?.marginTop).toBe(24);
      expect(back?.marginRight).toBe(32);
    }
  });

  it('as cores voltam junto', () => {
    const back = readAdsOverlayLayout(buildAdsOverlayDocument(LAYOUT));

    expect(back?.panelColor).toBe('#0A0A0AEB');
    expect(back?.panelBorderColor).toBe('#FFFFFF26');
  });

  it('documento sem a raiz da convenção devolve null, e não números errados', () => {
    const document = buildAdsOverlayDocument(LAYOUT);

    const semRaiz = {
      ...document,
      screens: document.screens.map((screen) => ({ ...screen, elements: [] })),
    };

    // `null` é a resposta certa: a tela mantém o que tinha, em vez
    // de mover o widget para um lugar deduzido de um desenho que
    // não é mais aquele.
    expect(readAdsOverlayLayout(semRaiz)).toBeNull();
  });

  it('um elemento renomeado só faz aquela medida ser ignorada', () => {
    const document = buildAdsOverlayDocument(LAYOUT);
    const screen = document.screens[0];
    const root = screen?.elements[0];

    // Apaga só o logo, mantendo a raiz e o painel.
    const semLogo = {
      ...document,
      screens: [
        {
          ...screen!,
          elements: [
            {
              ...root!,
              children: root!.children.filter((child) => child.id !== ADS_LOGO_ID),
            },
          ],
        },
      ],
    };

    const back = readAdsOverlayLayout(semLogo);

    expect(back?.panelWidth).toBe(360);
    expect(back?.logoWidth).toBeUndefined();
  });
});
