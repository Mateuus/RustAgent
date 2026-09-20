// ============================================================
//  ui-screen-partes.test.ts  -  a tela que não cabe num frame.
//
//  ####  O TETO QUE ISTO EXISTE PARA REMOVER  ####
//
//  Uma tela gerada viaja do agente ao plugin num comando de
//  console, pelo WebRCON, e o frame são 50.000 bytes. A aba KITS
//  custa ~2.650 bytes por card: doze cards, e acabou.
//
//  Enquanto a grade paginava, isso não aparecia — a paginação
//  cortava antes. Quando ela virou uma área ROLÁVEL, o teto do
//  transporte passou a ser o teto do desenho: a rolagem mostrava
//  três fileiras e empurrava o resto para a página 2, que é
//  exatamente o que ela veio substituir.
//
//  `encodeUiScreenParts` corta a LISTA DE ELEMENTOS em comandos que
//  cabem. O plugin junta pelo `requestId` e desenha quando o último
//  chega — ver `Assemble` em Plugins/OrigemZUI.cs.
//
//  ####  O QUE SE MEDE AQUI  ####
//
//    1. nenhum comando passa do frame — é a razão de tudo isto;
//    2. nenhum elemento se perde, e a ORDEM é a mesma (o CUI monta
//       na ordem da lista: filho antes do pai não aparece);
//    3. a tela que cabe continua saindo num comando SÓ, sem `part`
//       — o caminho de sempre não muda de forma por causa do caso
//       novo;
//    4. o que não couber em oito pedaços é CONTADO, nunca cortado
//       em silêncio.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { CuiElement } from '../src/game/ui-cui.js';
import {
  encodeUiScreenParts,
  UI_DOC_MAX_BYTES,
  type UiScreenBundle,
} from '../src/types/ui-transport.js';

/** Um elemento de CUI do tamanho dos que a grade de kits emite. */
function element(index: number): CuiElement {
  return {
    name: `OrigemZUI.k${String(index)}c`,
    parent: 'OrigemZUI.kg',
    components: [
      { type: 'UnityEngine.UI.Image', color: '0.149 0.149 0.149 1' },
      {
        type: 'RectTransform',
        anchormin: '0 1',
        anchormax: '0 1',
        offsetmin: `0 ${String(-index)}`,
        offsetmax: `250 ${String(-index + 230)}`,
      },
    ],
  };
}

function bundle(count: number): UiScreenBundle {
  return {
    id: 'tela-kits',
    name: 'KITS',
    kind: 'page',
    cui: Array.from({ length: count }, (_unused, index) => element(index)),
    updates: [],
    actions: {},
    volatile: true,
  } as unknown as UiScreenBundle;
}

function partsOf(count: number): ReturnType<typeof encodeUiScreenParts> {
  return encodeUiScreenParts({
    requestId: 'abcdef0123456789',
    documentId: 'menu-principal',
    screen: bundle(count),
  });
}

/** O que o plugin faz ao receber os comandos, em miniatura. */
function assemble(commands: readonly string[]): readonly CuiElement[] {
  const cui: CuiElement[] = [];
  let parts = 0;
  let seen = 0;

  for (const [at, command] of commands.entries()) {
    const payload = JSON.parse(Buffer.from(command, 'base64').toString('utf8')) as {
      part?: number;
      parts?: number;
      screen?: { cui: CuiElement[] };
      cui?: CuiElement[];
    };

    if (at === 0) {
      parts = payload.parts ?? 1;
      cui.push(...(payload.screen?.cui ?? []));
    } else {
      expect(payload.part).toBe(at + 1);
      expect(payload.parts).toBe(parts);
      cui.push(...(payload.cui ?? []));
    }

    seen += 1;
  }

  expect(seen).toBe(parts === 0 ? 1 : parts);

  return cui;
}

describe('a tela partida em pedaços', () => {
  it('a que cabe sai num comando só, e sem `part`', () => {
    const { commands, dropped } = partsOf(10);

    expect(commands).toHaveLength(1);
    expect(dropped).toBe(0);

    const payload = JSON.parse(Buffer.from(commands[0] ?? '', 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;

    // Um plugin que não conheça a divisão continua lendo este
    // pacote exatamente como lia antes.
    expect(payload['part']).toBeUndefined();
    expect(payload['parts']).toBeUndefined();
  });

  it('a que não cabe vira vários, e nenhum passa do frame', () => {
    const { commands } = partsOf(400);

    expect(commands.length).toBeGreaterThan(1);

    for (const command of commands) {
      expect(command.length).toBeLessThan(UI_DOC_MAX_BYTES);
    }
  });

  it('não perde elemento nenhum, e mantém a ordem', () => {
    // A ordem não é capricho: o CUI monta na ordem da lista, e um
    // filho que chega antes do pai não encontra onde se pendurar —
    // ele simplesmente não aparece, sem erro nenhum.
    const { commands, dropped } = partsOf(400);
    const juntos = assemble(commands);

    expect(dropped).toBe(0);
    expect(juntos).toHaveLength(400);
    expect(juntos.map((item) => item.name)).toEqual(
      Array.from({ length: 400 }, (_unused, index) => `OrigemZUI.k${String(index)}c`),
    );
  });

  it('conta o que não couber em oito pedaços, em vez de cortar calado', () => {
    // Oito pedaços são ~264 KB. Uma tela assim não existe hoje — a
    // aba KITS conta bytes antes de desenhar —, e é justamente por
    // isso que o dia em que ela existir precisa aparecer no log.
    const { commands, dropped } = partsOf(4000);

    expect(commands.length).toBeLessThanOrEqual(8);
    expect(dropped).toBeGreaterThan(0);
  });
});
