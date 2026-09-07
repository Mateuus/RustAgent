// ============================================================
//  routes/betterloot.ts  -  o editor de loot.
//
//      GET /api/servers/:id/betterloot                resumos + globais
//      GET /api/servers/:id/betterloot/table?prefab=  uma caixa
//      PUT /api/servers/:id/betterloot/table          grava e relê
//      PUT /api/servers/:id/betterloot/globals        o que vale no servidor todo
//
//  ####  DUAS ESCRITAS, DOIS ARQUIVOS, DUAS REVISÕES  ####
//
//  A de tabela mexe em `oxide/data/BetterLoot/LootTables.json`; a
//  de globais, em `oxide/config/BetterLoot.json`. Elas não
//  compartilham a `revision` de propósito: recarregar o plugin
//  reescreve a TABELA sozinho, e uma revisão só faria gravar o
//  multiplicador recusar o próximo salvamento de caixa — e
//  vice-versa.
//
//  ####  ELAS SÃO DE UM SERVIDOR, E NÃO DA REDE  ####
//
//  Ao contrário de quase tudo o mais no agente, o que se edita
//  aqui não é cadastro nosso: é um arquivo no disco de UM
//  servidor. Trocar o `:id` troca o arquivo aberto, e não filtra
//  uma lista.
//
//  ####  O PREFAB VIAJA EM QUERY STRING  ####
//
//  A chave do `LootTables.json` é o CAMINHO INTEIRO do prefab —
//  `assets/bundled/prefabs/radtown/crate_elite.prefab` —, com
//  barra e, em dezessete casos medidos, espaço (`dmloot/dm
//  ammo.prefab`). Como pedaço de caminho ele quebraria a rota; o
//  Fastify o veria como vários segmentos.
//
//  ####  ELAS RESPONDEM COM O PLUGIN AUSENTE  ####
//
//  O BetterLoot está DESLIGADO no `server01` (Docs/CustomItem/07
//  §4), e a lista precisa responder assim mesmo: `configured:
//  false`, tabelas vazias e uma frase que ensina. Só as duas rotas
//  de tabela recusam — abrir uma caixa que não existe não tem
//  resposta útil.
//
//  ####  E O SERVIDOR PODE ESTAR PARADO  ####
//
//  Ler é disco: funciona com tudo desligado, que é quando se
//  configura loot. Gravar também: o arquivo vai para o lugar e o
//  `oxide.reload` só acontece se der. A resposta diz se ele foi —
//  fingir que foi seria pior que não mandar.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { BetterLootEditor, BetterLootTable } from '../../oxide/betterloot.js';
import { ApiError } from '../error-response.js';

export interface BetterLootRoutesDeps {
  readonly editor: BetterLootEditor;
}

const serverParams = z.object({ id: z.string().min(1) });

const tableQuery = z.object({
  /**
   * O caminho inteiro do prefab.
   *
   * Sem `.regex()`: as chaves reais têm barra, ponto, espaço e o
   * prefixo sintético `unwrap/`, que não é pasta nenhuma. Quem
   * decide se existe é o arquivo, e a resposta de "não existe" já
   * é específica.
   */
  prefab: z.string().min(1).max(400),
});

/**
 * Teto de entradas numa caixa.
 *
 * A maior medida no `server01` tem 145; o jogo não deixa uma caixa
 * entregar mais de 36 itens por vez, mas a TABELA pode listar
 * quantos quiser — é dela que se sorteia. 2.000 é folga de mais de
 * dez vezes, e existe só para o corpo da requisição ter um teto.
 */
const MAX_ENTRIES = 2_000;

const bonusSchema = z.object({
  key: z.string().min(1).max(200),
  shortname: z.string().min(1).max(200),
  /** Texto, e não número: é `ulong` no plugin. */
  skinId: z.string().regex(/^\d{1,20}$/),
  customName: z.string().max(200).nullable(),
  min: z.number().int().min(0),
  max: z.number().int().min(0),
});

const guaranteedSchema = bonusSchema.extend({
  displayName: z.string().nullable(),
});

const entrySchema = bonusSchema.extend({
  displayName: z.string().nullable(),
  allowDuplicates: z.boolean(),
  canConvertToBlueprint: z.boolean().nullable(),
  durability: z
    .object({ min: z.number().min(0).max(100), max: z.number().min(0).max(100) })
    .nullable(),
  /**
   * A raridade vem de VOLTA no corpo porque a tela devolve a
   * entrada inteira — mas ela é IGNORADA na gravação: o arquivo
   * não tem esse campo, e quem sabe a raridade é o catálogo do
   * agente. Aceitá-la e não gravá-la é melhor que recusar o corpo
   * que a própria tela montou.
   */
  rarity: z.number().int().nullable(),
  bonusItems: z.array(bonusSchema).max(50),
  hasWeaponProperties: z.boolean(),
});

const itemSettingsSchema = z.object({
  minItems: z.number().int().min(0).max(36),
  maxItems: z.number().int().min(0).max(36),
  minScrap: z.number().int().min(0),
  maxScrap: z.number().int().min(0),
  minBlueprints: z.number().int().min(0),
  maxBlueprints: z.number().int().min(0),
  bonusItemsCountToTotal: z.boolean(),
  guaranteedItemsCountToTotal: z.boolean(),
});

const tableSchema = z.object({
  prefab: z.string().min(1).max(400),
  enabled: z.boolean(),
  itemCount: z.number().int().min(0),
  guaranteedCount: z.number().int().min(0),
  profileCount: z.number().int().min(0),
  itemSettings: itemSettingsSchema,
  poolLocking: z.boolean(),
  ignoreRarityBias: z.boolean(),
  profiles: z
    .array(
      z.object({
        name: z.string().max(200),
        enabled: z.boolean(),
        probability: z.number().min(0).max(100),
        maxItems: z.number().int().min(0),
      }),
    )
    .max(100),
  guaranteed: z.array(guaranteedSchema).max(MAX_ENTRIES),
  items: z.array(entrySchema).max(MAX_ENTRIES),
});

const saveSchema = z.object({
  /** A revisão em que a tela abriu. `null` = a tela não viu nenhuma. */
  baseRevision: z.string().nullable(),
  table: tableSchema,
});

/**
 * Teto sanitário dos multiplicadores.
 *
 * O plugin não tem teto: `LootMultiplier` é um `int` e ele
 * multiplica a quantidade de todo item de todo container. 1.000 é
 * absurdo de sobra para qualquer servidor 10x, e existe para que um
 * dígito a mais digitado por engano não vire uma caixa com quarenta
 * mil enxofres — que o jogo entrega, e ninguém quis.
 */
const MAX_MULTIPLIER = 1_000;

const globalsSchema = z.object({
  /**
   * Inteiro, e no mínimo 1 — os dois são medidos, e por razões
   * diferentes.
   *
   * INTEIRO porque o campo é `int` no plugin (BetterLoot.cs:174):
   * aceitar `1.5` gravaria um decimal onde o Newtonsoft espera um
   * inteiro, e o que ele faz com isso não é coisa que a tela possa
   * prometer.
   *
   * MÍNIMO 1 porque o multiplicador entra numa MULTIPLICAÇÃO
   * (`:2815`): com zero, todo item de todo container do servidor
   * passa a sair com quantidade zero. Não existe intenção por trás
   * desse número — só o dedo escorregando.
   */
  lootMultiplier: z.number().int().min(1).max(MAX_MULTIPLIER),
  scrapMultiplier: z.number().int().min(1).max(MAX_MULTIPLIER),
  /** `double` de 0 a 1 (`:127`). A tela é que fala em porcentagem. */
  blueprintWeight: z.number().min(0).max(1),
  blueprintConversion: z.boolean(),
});

const saveGlobalsSchema = z.object({
  /** A revisão do `BetterLoot.json`, e não a da tabela. */
  baseRevision: z.string().nullable(),
  globals: globalsSchema,
});

export function registerBetterLootRoutes(app: FastifyInstance, deps: BetterLootRoutesDeps): void {
  /**
   * A lista de caixas daquele servidor.
   *
   * ####  RESUMOS, E NÃO O ARQUIVO  ####
   *
   * O `LootTables.json` do `server01` tem 2,53 MB. O que sai daqui
   * são 111 linhas de resumo — 34,8 KB medidos. A caixa inteira é
   * a segunda chamada, uma por vez.
   */
  app.get('/servers/:id/betterloot', async (request) => {
    const { id } = serverParams.parse(request.params);
    const status = await deps.editor.status(id);

    return {
      ok: true,
      serverId: id,
      // ####  `loaded` É OUTRA PERGUNTA, E ELA NÃO É DAQUI  ####
      //
      // "O arquivo existe" é o que esta rota sabe; "o Oxide
      // carregou o plugin" quem responde é a tela de plugins, que
      // já pergunta ao servidor. Misturar as duas faria um servidor
      // parado parecer um servidor sem BetterLoot — e o arquivo
      // está lá, e é editável do mesmo jeito.
      loaded: status.configured ? null : false,
      version: null,
      readAt: status.readAt,
      revision: status.revision,
      // A revisão do OUTRO arquivo — a que o PUT de globais
      // devolve. Ver o cabeçalho.
      configRevision: status.configRevision,
      globals: status.globals,
      blacklist: status.blacklist,
      count: status.tables.length,
      tables: status.tables,
      // A frase existe porque "lista vazia" sozinha se lê como
      // defeito. Ver Docs/CustomItem/07 §2.4 para o que faz a
      // tabela nascer.
      note: status.configured
        ? null
        : 'O BetterLoot nunca rodou neste servidor: não existe oxide/data/BetterLoot/' +
          'LootTables.json. A tabela nasce sozinha no primeiro carregamento do plugin, gerada ' +
          'do loot nativo daquele mapa — são ~2,5 MB e 111 prefabs.',
    };
  });

  /** Uma caixa inteira. */
  app.get('/servers/:id/betterloot/table', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { prefab } = tableQuery.parse(request.query);

    const { revision, table } = await deps.editor.table(id, prefab);

    return { ok: true, serverId: id, revision, table };
  });

  /**
   * Grava a caixa, recarrega e devolve o que RELEU do disco.
   *
   * A resposta não é o que foi enviado: o `scanEntry` do plugin
   * reescreve durabilidade, propriedades e "pode virar blueprint"
   * ao validar. Quem ignorar o retorno mostra ao admin o que ele
   * pediu, e não o que o servidor tem.
   */
  app.put('/servers/:id/betterloot/table', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = saveSchema.parse(request.body);

    assertConsistent(body.table);

    const result = await deps.editor.save(id, {
      baseRevision: body.baseRevision,
      table: body.table as BetterLootTable,
    });

    return {
      ok: true,
      serverId: id,
      revision: result.revision,
      table: result.table,
      // Onde ficou a cópia do arquivo anterior. É o que torna um
      // salvamento errado reversível — e um caminho na resposta é
      // melhor que uma promessa no log.
      backup: result.backup,
      reloaded: result.reloaded,
      reloadOutput: result.reloadOutput,
    };
  });

  /**
   * Grava o que vale no SERVIDOR INTEIRO, recarrega e relê.
   *
   * ####  ISTO NÃO É UMA CAIXA, E A DIFERENÇA É O ALCANCE  ####
   *
   * `Loot Multiplier` e `Scrap Multipler` multiplicam a quantidade
   * de todo item de todo container daquele servidor
   * (BetterLoot.cs:1532, :2815, :2972, :2585). Não existe "2x só
   * nos barris" por esta rota — quem quer isso mexe no `Item
   * Minimum`/`Item Maximum` das entradas daquela caixa, que é a
   * outra rota.
   *
   * A escrita é um MERGE sobre o arquivo do disco: o
   * `BetterLoot.json` guarda também as 111 chaves de `Watched
   * Container Prefabs`, e montá-lo do zero as devolveria todas
   * ligadas.
   */
  app.put('/servers/:id/betterloot/globals', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = saveGlobalsSchema.parse(request.body);

    const result = await deps.editor.saveGlobals(id, {
      baseRevision: body.baseRevision,
      globals: body.globals,
    });

    return {
      ok: true,
      serverId: id,
      revision: result.revision,
      globals: result.globals,
      backup: result.backup,
      reloaded: result.reloaded,
      reloadOutput: result.reloadOutput,
    };
  });
}

/**
 * As conferências que o zod não faz sozinho.
 *
 * ####  MÍNIMO MAIOR QUE MÁXIMO É SILÊNCIO NO JOGO  ####
 *
 * O BetterLoot sorteia com `Random.Range(min, max)`; com os dois
 * trocados o resultado é o mínimo, sempre, e nada reclama. A tela
 * mostraria "2 a 1" e o admin acharia que pediu isso.
 */
function assertConsistent(table: z.infer<typeof tableSchema>): void {
  const settings = table.itemSettings;

  for (const [min, max, what] of [
    [settings.minItems, settings.maxItems, 'a quantidade de itens'],
    [settings.minScrap, settings.maxScrap, 'o scrap'],
    [settings.minBlueprints, settings.maxBlueprints, 'os blueprints'],
  ] as const) {
    if (min > max) {
      throw new ApiError(
        'BETTERLOOT_INVALID_RANGE',
        `Em "${table.prefab}", ${what} tem mínimo ${String(min)} maior que o máximo ${String(
          max,
        )}. Nada foi alterado.`,
        400,
      );
    }
  }

  const named: readonly { readonly key: string; readonly min: number; readonly max: number }[] = [
    ...table.items,
    ...table.guaranteed,
  ];

  for (const entry of named) {
    if (entry.min > entry.max) {
      throw new ApiError(
        'BETTERLOOT_INVALID_RANGE',
        `A entrada "${entry.key}" tem mínimo ${String(entry.min)} maior que o máximo ${String(
          entry.max,
        )}. Nada foi alterado.`,
        400,
      );
    }
  }

  for (const entry of table.items) {
    if (entry.durability !== null && entry.durability.min > entry.durability.max) {
      throw new ApiError(
        'BETTERLOOT_INVALID_RANGE',
        `A durabilidade de "${entry.key}" tem mínimo maior que o máximo. Nada foi alterado.`,
        400,
      );
    }
  }
}
