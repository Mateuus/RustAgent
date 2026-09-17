// ============================================================
//  Testes do rótulo e do detalhe de `owned.season-cleared` no
//  registro do Workshop (components/workshop/audit-panel.tsx).
//
//  ####  O QUE ELES PROTEGEM  ####
//
//  O wipe grava UMA linha para a remoção inteira, com as contagens
//  no detalhe (Docs/OrigemZWorkshop/02 §4.6). Duas coisas podem dar
//  errado nela: aparecer com o nome cru da ação — "owned.season-
//  cleared" no meio de uma tela em português —, ou derrubar o
//  render por causa de um campo que o agente não mandou.
// ============================================================

import { describe, expect, it } from 'vitest';

import { actionLabel, describeDetail } from '@/components/workshop/audit-panel';
import type { WorkshopAuditEntry } from '@/lib/api';

function entry(detail: Record<string, unknown>): WorkshopAuditEntry {
  return {
    id: 1,
    at: '2026-09-17T12:00:00.000Z',
    actor: 'sistema',
    source: 'system',
    action: 'owned.season-cleared',
    target: 'posse de skins de temporada',
    serverId: 'server01',
    steamId: null,
    detail,
  } as WorkshopAuditEntry;
}

describe('a posse de temporada removida no wipe', () => {
  it('tem rótulo em português, e não o nome da ação', () => {
    expect(actionLabel('owned.season-cleared')).toBe(
      'Posse de skins de temporada removida no wipe',
    );
  });

  it('mostra a contagem: quantas posses, de quantos jogadores, de quantas skins', () => {
    const line = describeDetail(entry({ removed: 12, players: 3, skins: [7, 9] }));

    expect(line).toContain('12 posse(s) removida(s)');
    expect(line).toContain('3 jogador(es)');
    expect(line).toContain('2 skin(s)');
  });

  it('detalhe sem os campos não derruba a tela', () => {
    expect(describeDetail(entry({}))).toBe(
      'o wipe mandou remover a posse das skins de temporada',
    );
    expect(describeDetail(entry({ removed: 5 }))).toContain('5 posse(s) removida(s)');
  });
});
