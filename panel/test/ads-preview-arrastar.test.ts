// ============================================================
//  Arrastar o painel e o logo na pre-visualizacao.
//
//  ####  O SINAL TROCADO NAO QUEBRA NADA — E ESSE E O PROBLEMA  ####
//
//  Um sinal errado nao da erro, nao aparece em teste de tipo e
//  nao derruba pagina nenhuma: o elemento so anda para o lado
//  CONTRARIO do dedo. Quem esta ajustando acha que errou a mao,
//  corrige na direcao errada, e o defeito vira "essa tela e
//  estranha" em vez de um bug que alguem relata.
//
//  Daqui sai um caso por canto, e a regra e sempre a mesma frase:
//  ARRASTAR PARA UM LADO TEM DE LEVAR O ELEMENTO PARA AQUELE LADO.
//  Onde a margem cresce ou encolhe para isso acontecer e detalhe
//  da geometria — o que o teste guarda e o que a pessoa sente.
//
//  Os sinais espelham `cornerOf` e `detachedOffsets` de
//  core/src/game/ads-timeline.ts. Se aqueles mudarem, estes
//  precisam mudar junto, e e este arquivo que avisa.
// ============================================================

import { describe, expect, it } from 'vitest';

import { panLogo, panPanel } from '../src/components/ads-preview';

/** Um arrasto de 50 px para a direita e 30 para baixo. */
const DX = 50;
const DY = 30;

describe('arrastar o painel', () => {
  it('num canto da DIREITA, ir para a direita ENCOLHE a margem', () => {
    // `marginRight` mede ate a borda direita: chegar mais perto
    // dela e ter uma margem menor.
    const antes = { anchor: 'bottom-right' as const, marginRight: 220, marginTop: 40 };
    const depois = panPanel(antes, DX, 0);

    expect(depois.marginRight).toBe(170);
  });

  it('num canto da ESQUERDA, ir para a direita AUMENTA a margem', () => {
    // Aqui o mesmo campo mede ate a borda ESQUERDA. O nome do
    // campo nao muda; o que ele conta, sim.
    const antes = { anchor: 'bottom-left' as const, marginRight: 220, marginTop: 40 };
    const depois = panPanel(antes, DX, 0);

    expect(depois.marginRight).toBe(270);
  });

  it('num canto de BAIXO, ir para baixo ENCOLHE a margem', () => {
    // `marginTop` num canto de baixo mede ate o FUNDO.
    const antes = { anchor: 'bottom-right' as const, marginRight: 220, marginTop: 40 };
    const depois = panPanel(antes, 0, DY);

    expect(depois.marginTop).toBe(10);
  });

  it('num canto de CIMA, ir para baixo AUMENTA a margem', () => {
    const antes = { anchor: 'top-right' as const, marginRight: 220, marginTop: 40 };
    const depois = panPanel(antes, 0, DY);

    expect(depois.marginTop).toBe(70);
  });

  it('nao passa do teto que o agente aceita', () => {
    // `adsSettingsSchema` recusa acima de 400. Sem o limite, um
    // arrasto longo gravaria um ajuste que volta 400 do agente —
    // e o erro apareceria num toast, sem ligacao com o arrasto.
    const antes = { anchor: 'bottom-left' as const, marginRight: 380, marginTop: 40 };

    expect(panPanel(antes, 1000, 0).marginRight).toBe(400);
    expect(panPanel(antes, -1000, 0).marginRight).toBe(-400);
  });

  it('devolve inteiro: o schema do agente nao aceita fracao', () => {
    const antes = { anchor: 'bottom-left' as const, marginRight: 220, marginTop: 40 };

    expect(Number.isInteger(panPanel(antes, 12.7, 3.3).marginRight)).toBe(true);
    expect(Number.isInteger(panPanel(antes, 12.7, 3.3).marginTop)).toBe(true);
  });
});

describe('arrastar o logo solto', () => {
  it('no ALTO E AO CENTRO, ir para a direita aumenta o deslocamento', () => {
    // No centro o numero nao e margem: e "tantos pixels para o
    // lado", e ele pode ser negativo.
    const antes = { logoAnchor: 'top-center' as const, logoMarginX: 0, logoMarginY: 24 };

    expect(panLogo(antes, DX, 0).logoMarginX).toBe(50);
    expect(panLogo(antes, -DX, 0).logoMarginX).toBe(-50);
  });

  it('no alto, ir para baixo AFASTA do topo', () => {
    const antes = { logoAnchor: 'top-center' as const, logoMarginX: 0, logoMarginY: 24 };

    expect(panLogo(antes, 0, DY).logoMarginY).toBe(54);
  });

  it('embaixo, ir para baixo APROXIMA do fundo', () => {
    const antes = { logoAnchor: 'bottom-center' as const, logoMarginX: 0, logoMarginY: 100 };

    expect(panLogo(antes, 0, DY).logoMarginY).toBe(70);
  });

  it('a DIREITA, ir para a direita encolhe a margem', () => {
    const antes = { logoAnchor: 'middle-right' as const, logoMarginX: 100, logoMarginY: 0 };

    expect(panLogo(antes, DX, 0).logoMarginX).toBe(50);
  });

  it('a ESQUERDA, ir para a direita aumenta a margem', () => {
    const antes = { logoAnchor: 'middle-left' as const, logoMarginX: 100, logoMarginY: 0 };

    expect(panLogo(antes, DX, 0).logoMarginX).toBe(150);
  });
});

describe('o sentido, dito de uma vez', () => {
  // ####  A FRASE QUE TODOS OS CASOS ACIMA DIZEM  ####
  //
  // Independentemente do canto, arrastar para um lado tem de
  // levar o elemento para AQUELE lado. Este bloco prova isso
  // convertendo a margem de volta em posicao na tela.
  const posicaoX = (anchor: string, marginRight: number): number =>
    anchor.endsWith('-right') ? 1280 - marginRight : marginRight;

  for (const anchor of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
    it(`em ${anchor}, arrastar para a direita move para a direita`, () => {
      const antes = { anchor, marginRight: 200, marginTop: 40 };
      const depois = panPanel(antes, DX, 0);

      expect(posicaoX(anchor, depois.marginRight)).toBeGreaterThan(
        posicaoX(anchor, antes.marginRight),
      );
    });
  }

  const posicaoY = (anchor: string, marginTop: number): number =>
    anchor.startsWith('bottom-') ? 720 - marginTop : marginTop;

  for (const anchor of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
    it(`em ${anchor}, arrastar para baixo move para baixo`, () => {
      const antes = { anchor, marginRight: 200, marginTop: 100 };
      const depois = panPanel(antes, 0, DY);

      expect(posicaoY(anchor, depois.marginTop)).toBeGreaterThan(
        posicaoY(anchor, antes.marginTop),
      );
    });
  }
});
