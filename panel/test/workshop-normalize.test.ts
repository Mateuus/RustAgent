// ============================================================
//  Testes do normalize.ts das skins do Workshop.
//
//  ####  O QUE ELES PROTEGEM  ####
//
//  O tipo do painel não valida a resposta: um campo que o agente
//  omitir vira TypeError no render e derruba a página inteira. A
//  reformulação (Docs/OrigemZWorkshop/02 §9) trouxe campos novos —
//  descrição, raridade, ordem, donos, a posse — e um agente velho
//  (ou uma resposta cortada) não os manda. Tudo isso tem de chegar
//  à tela com um padrão pronto.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  describeOwnedExpiry,
  groupByShortname,
  ownedMatches,
  safeFavoriteIds,
  safeOwned,
  safeOwnedList,
  safeRarity,
  safeSkin,
} from '@/components/workshop/normalize';
import type { WorkshopOwned, WorkshopSkin } from '@/lib/api';

describe('safeSkin', () => {
  it('preenche descrição, raridade, ordem e donos quando o agente os omite', () => {
    const skin = safeSkin({ id: 3, label: 'AK Brasa', shortname: 'rifle.ak', skinId: '3802433262' } as WorkshopSkin);

    expect(skin.description).toBeNull();
    expect(skin.rarity).toBeNull();
    expect(skin.sort).toBe(0);
    expect(skin.owners).toBe(0);
    expect(skin.servers).toEqual([]);
  });

  it('descarta raridade desconhecida em vez de desenhar uma etiqueta quebrada', () => {
    expect(safeRarity('mythic')).toBeNull();
    expect(safeRarity('epic')).toBe('epic');
    expect(safeSkin({ rarity: 'mythic' } as unknown as WorkshopSkin).rarity).toBeNull();
  });

  it('sem o campo `season`, a skin NÃO é de temporada', () => {
    // O lado seguro: a tela nunca promete que uma skin sai no wipe
    // por causa de um campo que não veio. Ver 02 §4.6.
    expect(safeSkin({ id: 3 } as WorkshopSkin).season).toBe(false);
    expect(safeSkin({ id: 3, season: true } as WorkshopSkin).season).toBe(true);
    expect(safeSkin({ id: 3, season: 1 } as unknown as WorkshopSkin).season).toBe(false);
  });

  it('mantém o Workshop ID como texto, sem arredondar', () => {
    expect(safeSkin({ skinId: '18446744073709551615' } as WorkshopSkin).skinId).toBe('18446744073709551615');
  });
});

describe('safeOwned', () => {
  it('aguenta uma posse sem skin resolvida e sem campos opcionais', () => {
    const owned = safeOwned({ id: 1, steamId: '76561198000000001', skinId: 9 } as WorkshopOwned);

    expect(owned.skin).toBeNull();
    expect(owned.expiresAt).toBeNull();
    expect(owned.expired).toBe(false);
    expect(owned.note).toBeNull();
    expect(owned.source).toBe('system');
    expect(describeOwnedExpiry(owned)).toBe('permanente');
  });

  it('calcula "vencida" pelo prazo quando o campo falta', () => {
    const owned = safeOwned({ id: 1, expiresAt: '2000-01-01T00:00:00.000Z' } as WorkshopOwned);

    expect(owned.expired).toBe(true);
    expect(describeOwnedExpiry(owned)).toMatch(/^venceu em /);
  });

  it('resolve a skin mesmo sem descrição e raridade', () => {
    const owned = safeOwned({
      id: 2,
      source: 'site',
      skin: { id: 9, label: 'AK Brasa', shortname: 'rifle.ak', workshopId: '1' },
    } as unknown as WorkshopOwned);

    expect(owned.source).toBe('site');
    expect(owned.skin?.description).toBeNull();
    expect(owned.skin?.rarity).toBeNull();
    expect(owned.skin?.servers).toEqual([]);
  });

  it('lista ausente vira lista vazia', () => {
    expect(safeOwnedList(undefined)).toEqual([]);
    expect(safeOwnedList(null)).toEqual([]);
  });
});

describe('groupByShortname', () => {
  it('ordena dentro do item pela ordem do menu e, no empate, pelo nome', () => {
    const skins = [
      { id: 1, label: 'Zeta', shortname: 'rifle.ak', sort: 0 },
      { id: 2, label: 'Alfa', shortname: 'rifle.ak', sort: 0 },
      { id: 3, label: 'Meio', shortname: 'rifle.ak', sort: -5 },
    ].map((skin) => safeSkin(skin as WorkshopSkin));

    expect(groupByShortname(skins)[0]?.skins.map((skin) => skin.label)).toEqual(['Meio', 'Alfa', 'Zeta']);
  });
});

describe('ownedMatches', () => {
  const owned = safeOwned({
    id: 1,
    skinId: 42,
    skin: { id: 42, label: 'AK Brasa', shortname: 'rifle.ak', workshopId: '3802433262' },
  } as unknown as WorkshopOwned);

  it('acha pelo nome, pelo item e pelo Workshop ID, sem caixa', () => {
    expect(ownedMatches(owned, '  brasa ')).toBe(true);
    expect(ownedMatches(owned, 'RIFLE.AK')).toBe(true);
    expect(ownedMatches(owned, '38024')).toBe(true);
    expect(ownedMatches(owned, 'mp5')).toBe(false);
  });

  it('busca vazia aceita tudo, e skin apagada só bate pelo número', () => {
    const orphan = safeOwned({ id: 2, skinId: 77 } as unknown as WorkshopOwned);

    expect(ownedMatches(orphan, '')).toBe(true);
    expect(ownedMatches(orphan, '77')).toBe(true);
    expect(ownedMatches(orphan, 'ak')).toBe(false);
  });
});

describe('safeFavoriteIds', () => {
  it('campo ausente é conjunto vazio: nenhuma estrela, e nenhum erro de tela', () => {
    // Um agente anterior à migração 100 não manda `favorites`.
    expect(safeFavoriteIds(undefined).size).toBe(0);
    expect(safeFavoriteIds(null).size).toBe(0);
    expect(safeFavoriteIds('3,7').size).toBe(0);
  });

  it('aceita os ids e descarta lixo, sem repetir', () => {
    const ids = safeFavoriteIds([3, '7', 3, 0, -1, null, 'ak', Number.NaN]);

    expect([...ids].sort((left, right) => left - right)).toEqual([3, 7]);
  });
});
