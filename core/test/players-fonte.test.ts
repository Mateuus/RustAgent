// ============================================================
//  players-fonte.test.ts  -  de onde vem a lista de quem está
//  online, e o que acontece quando a fonte preferida emudece.
//
//  ####  O QUE ESTE ARQUIVO GUARDA  ####
//
//  Em 04/09/2026 um update do Rust mudou a assinatura de
//  `ItemContainer.CanAcceptItem`. O OrigemZAgent parou de
//  compilar, o Oxide não o carregou, e o `origemz.players` deixou
//  de existir no console — que NÃO reclama de comando que não
//  conhece: ele se cala. A aba Jogadores inteira morreu nesse
//  silêncio, com "Erro interno no agente" na tela.
//
//  O acervo continuava dizendo "ligado", e continuava certo: o
//  `.cs` estava na pasta. "Ligado" e "carregado" são perguntas
//  diferentes, e é essa distância que os casos aqui cobrem:
//
//    - plugin que o Oxide NÃO carregou -> a lista vem do nativo,
//      e o snapshot acusa `not-loaded`;
//    - plugin CARREGADO que só demorou -> a lista vem do nativo
//      igual, mas o motivo é `no-answer`. Servidor recém-subido
//      leva segundos para responder qualquer coisa, e acusar o
//      plugin nessa hora é o alarme falso que ensina a ignorar
//      todos os outros;
//    - plugin que responde ERRADO continua sendo 502 — silêncio
//      e resposta fora do contrato pedem coisas diferentes;
//    - silêncio no MEIO da paginação não troca de fonte: metade
//      de uma leitura costurada com metade de outra é pior que
//      uma falha honesta.
// ============================================================

import { describe, expect, it } from 'vitest';

import { PlayersReader, type PluginState } from '../src/game/players.js';
import { isApiError } from '../src/http/error-response.js';
import type { OpsRcon } from '../src/ops/service.js';
import type { OxidePluginRuntime } from '../src/oxide/runtime.js';
import { RconTimeoutError } from '../src/rcon/errors.js';

const WORLD_SIZE = 4000;

/** O acervo dizendo "o .cs está na pasta e ligado". */
function acervo(enabled: boolean): { stateOf: () => Promise<PluginState> } {
  return { stateOf: () => Promise.resolve({ id: 1, enabled }) };
}

/**
 * O Oxide daquele servidor, respondendo se carregou o plugin.
 *
 * `null` = não deu para perguntar — o servidor está parado, ou o
 * próprio `oxide.plugins` não voltou. É o "não sei".
 *
 * ####  O ESTADO PODE MUDAR NO `refresh`  ####
 *
 * `depois` existe porque a ordem importa: o reader só manda o
 * comando quando NÃO sabe que o plugin caiu, e só descobre que
 * caiu ao perguntar de novo, depois do timeout. Um dublê que já
 * soubesse desde o começo testaria o atalho, e não esse caminho —
 * que é exatamente o do dia em que o plugin quebra.
 */
function oxide(
  antes: boolean | null,
  depois: boolean | null = antes,
): {
  pluginOf: () => OxidePluginRuntime | null;
  refresh: () => Promise<null>;
  refreshIfStale: () => void;
} {
  let loaded = antes;

  const view = (): OxidePluginRuntime | null =>
    loaded === null
      ? null
      : { name: 'OrigemZAgent', title: null, version: null, loaded, failure: null };

  return {
    pluginOf: () => view(),
    refresh: () => {
      loaded = depois;
      return Promise.resolve(null);
    },
    refreshIfStale: () => {
      /* sem relógio no teste */
    },
  };
}

/**
 * Um console que responde o que o mapa mandar.
 *
 * A chave é o começo do comando: `origemz.players` e `playerlist`
 * são as duas fontes, e é a diferença entre elas que se testa.
 */
function console_(respostas: Record<string, () => Promise<string>>): OpsRcon {
  return {
    isConnected: true,
    send: (command) => {
      for (const [prefixo, responder] of Object.entries(respostas)) {
        if (command.startsWith(prefixo)) {
          return responder();
        }
      }

      return Promise.reject(new Error(`comando inesperado no teste: ${command}`));
    },
  };
}

const UM_JOGADOR_NATIVO = JSON.stringify([
  {
    SteamID: '76561198123456789',
    DisplayName: 'Fulano',
    Ping: 42,
    ConnectedSeconds: 600,
    Health: 100,
    Address: '203.0.113.10:53248',
  },
]);

describe('a fonte da lista de jogadores', () => {
  it('cai para o nativo quando o Oxide confirma que o plugin não carregou', async () => {
    // Ninguém sabia de nada até o comando não voltar: é assim que
    // o defeito chega de verdade, no primeiro pedido depois de o
    // plugin cair.
    const reader = new PlayersReader({ plugins: acervo(true), runtime: oxide(null, false) });
    const snapshot = await reader.list(
      'server01',
      console_({
        // O plugin que o Oxide não carregou: o comando sai, e nada
        // volta. É o timeout do cliente que encerra a espera.
        'origemz.players': () => Promise.reject(new RconTimeoutError('origemz.players 0 500', 5000)),
        playerlist: () => Promise.resolve(UM_JOGADOR_NATIVO),
      }),
      WORLD_SIZE,
    );

    expect(snapshot.source).toBe('nativo');
    expect(snapshot.players).toHaveLength(1);
    // Ligado no acervo (o arquivo está lá) e mudo no servidor (o
    // Oxide não o carregou). São as duas coisas ao mesmo tempo, e a
    // tela precisa das duas para dizer o que fazer.
    expect(snapshot.plugin.enabled).toBe(true);
    expect(snapshot.plugin.fallback).toBe('not-loaded');
    // Quem administra continua conseguindo agir: o nome e o SteamID
    // estão aqui, e é o que expulsar e banir exigem.
    expect(snapshot.players[0]?.steamId).toBe('76561198123456789');
    // E o que o nativo não sabe sai dito, não inventado.
    expect(snapshot.players[0]?.position).toBeNull();
    expect(snapshot.missing).toContain('position');
  });

  it('trata a resposta VAZIA do plugin como o mesmo silêncio', async () => {
    // O console do Rust responde o frame sem conteúdo quando o
    // comando não existe ali. É o mesmo defeito por outro caminho.
    const reader = new PlayersReader({ plugins: acervo(true), runtime: oxide(null, false) });
    const snapshot = await reader.list(
      'server01',
      console_({
        'origemz.players': () => Promise.resolve(''),
        playerlist: () => Promise.resolve('[]'),
      }),
      WORLD_SIZE,
    );

    expect(snapshot.source).toBe('nativo');
    expect(snapshot.plugin.fallback).toBe('not-loaded');
  });

  it('NÃO acusa o plugin quando ele está carregado e só demorou', async () => {
    // ####  O ALARME QUE NÃO PODE DISPARAR  ####
    //
    // Servidor recém-subido responde qualquer comando em segundos:
    // medido nesta máquina, `origemz.players` levou 4 s no primeiro
    // minuto e 56 ms depois. Se o timeout virasse "o plugin não
    // compila", a tela acusaria um plugin perfeitamente de pé
    // depois de TODO boot — e um alarme que erra sempre ensina a
    // ignorar o alarme que acerta.
    const reader = new PlayersReader({ plugins: acervo(true), runtime: oxide(null, true) });
    const snapshot = await reader.list(
      'server01',
      console_({
        'origemz.players': () => Promise.reject(new RconTimeoutError('origemz.players 0 500', 5000)),
        playerlist: () => Promise.resolve(UM_JOGADOR_NATIVO),
      }),
      WORLD_SIZE,
    );

    // A lista aparece do mesmo jeito — é isso que a queda para o
    // nativo garante.
    expect(snapshot.source).toBe('nativo');
    expect(snapshot.players).toHaveLength(1);
    // Mas o motivo é o fraco, e não a acusação.
    expect(snapshot.plugin.fallback).toBe('no-answer');
  });

  it('sem conseguir confirmar, fica no motivo mais fraco', async () => {
    // Sem prova não se acusa: `no-answer` é o que se pode afirmar
    // quando o `oxide.plugins` também não voltou.
    const reader = new PlayersReader({ plugins: acervo(true), runtime: oxide(null) });
    const snapshot = await reader.list(
      'server01',
      console_({
        'origemz.players': () => Promise.reject(new RconTimeoutError('origemz.players 0 500', 5000)),
        playerlist: () => Promise.resolve('[]'),
      }),
      WORLD_SIZE,
    );

    expect(snapshot.plugin.fallback).toBe('no-answer');
  });

  it('nem tenta o comando quando o Oxide já disse que o plugin não está de pé', async () => {
    // ####  NÃO BATER NUMA PORTA QUE SE SABE FECHADA  ####
    //
    // Cada tentativa custa os 5 s do timeout, e esta lista é
    // relida a cada poucos segundos pela tela e a cada 15 s pelo
    // relógio da presença. Medido nesta máquina com o plugin fora
    // do ar: uma leitura chegou a 20 s, porque o RCON serializa um
    // comando por vez e as chamadas entraram na fila umas das
    // outras — e o console inteiro (Console, operações, tudo)
    // passa por essa mesma fila.
    const enviados: string[] = [];
    const reader = new PlayersReader({ plugins: acervo(true), runtime: oxide(false) });

    const snapshot = await reader.list(
      'server01',
      {
        isConnected: true,
        send: (command) => {
          enviados.push(command);
          return Promise.resolve('[]');
        },
      },
      WORLD_SIZE,
    );

    expect(snapshot.plugin.fallback).toBe('not-loaded');
    expect(enviados).toEqual(['playerlist']);
  });

  it('não cai para o nativo quando o plugin responde FORA do contrato', async () => {
    // Aqui o plugin está vivo e falando outra língua — versão
    // diferente da do agente, tipicamente. Trocar de fonte
    // esconderia isso, e ninguém iria atrás da divergência.
    const reader = new PlayersReader({ plugins: acervo(true) });

    await expect(
      reader.list(
        'server01',
        console_({
          'origemz.players': () => Promise.resolve('{"ok":true,"jogadores":[]}'),
          playerlist: () => Promise.resolve('[]'),
        }),
        WORLD_SIZE,
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'PLUGIN_INVALID_RESPONSE',
    );
  });

  it('não troca de fonte quando o silêncio chega no MEIO da paginação', async () => {
    // A primeira página trouxe 500 de 700. Cair para o nativo agora
    // devolveria uma lista feita de duas leituras diferentes, com
    // gente repetida ou faltando e ninguém sabendo qual.
    let pagina = 0;
    const reader = new PlayersReader({ plugins: acervo(true) });

    const players = Array.from({ length: 500 }, (_, index) => ({
      steamId: `7656119800000${String(index).padStart(4, '0')}`,
      name: `jogador ${String(index)}`,
      health: 100,
      isAlive: true,
      isSleeping: false,
      ping: 30,
      connectedSeconds: 60,
      position: { x: 0, y: 0, z: 0 },
    }));

    await expect(
      reader.list(
        'server01',
        console_({
          'origemz.players': () => {
            pagina += 1;

            if (pagina === 1) {
              return Promise.resolve(
                JSON.stringify({ ok: true, count: 700, offset: 0, limit: 500, players }),
              );
            }

            return Promise.reject(new RconTimeoutError('origemz.players 500 500', 5000));
          },
          playerlist: () => Promise.resolve('[]'),
        }),
        WORLD_SIZE,
      ),
    ).rejects.toThrow(RconTimeoutError);
  });

  it('usa o nativo sem alarme nenhum quando o plugin está desligado', async () => {
    const reader = new PlayersReader({ plugins: acervo(false) });
    const snapshot = await reader.list(
      'server01',
      console_({ playerlist: () => Promise.resolve(UM_JOGADOR_NATIVO) }),
      WORLD_SIZE,
    );

    expect(snapshot.source).toBe('nativo');
    // Desligado não é falha: não há nada de errado a mostrar, e um
    // alarme aqui gastaria a atenção que o alarme de verdade precisa.
    expect(snapshot.plugin.fallback).toBeNull();
    expect(snapshot.plugin.enabled).toBe(false);
  });
});
