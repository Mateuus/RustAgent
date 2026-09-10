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
//  compartilham a revisão de propósito: recarregar o plugin
//  reescreve os DOIS arquivos sozinho, e uma revisão só faria
//  gravar o multiplicador recusar o próximo salvamento de caixa —
//  e vice-versa.
//
//  E a da tabela é por CAIXA (`tableRevision`), não do arquivo: o
//  `save` copia as outras caixas do disco de agora, então só a
//  caixa aberta pode entrar em conflito de verdade. O `revision`
//  que o `GET /betterloot` devolve é do arquivo inteiro e serve à
//  lista — nunca para gravar.
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

import type { BetterLootJunkRepository } from '../../db/betterloot-junk-repository.js';
import type { BetterLootEditor, BetterLootTable } from '../../oxide/betterloot.js';
import { ApiError } from '../error-response.js';

export interface BetterLootRoutesDeps {
  readonly editor: BetterLootEditor;
  /**
   * A lista de "lixo" de cada servidor.
   *
   * ####  ELA NÃO VAI PARA O DISCO DO SERVIDOR  ####
   *
   * O BetterLoot não conhece a palavra "junk" — a lista é
   * curadoria nossa, e o que chega ao jogo é a caixa já sem esses
   * itens. Por isso ela é banco, e não arquivo do plugin. Ver
   * `db/betterloot-junk-repository.ts`.
   */
  readonly junk: BetterLootJunkRepository;
}

/** Um shortname de item. É a chave da lista de lixo. */
const junkShortname = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9_.-]+$/, 'Um shortname de item do Rust é minúsculo, sem espaço nem acento.');

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
  /**
   * A revisão DA CAIXA em que a tela abriu — o `tableRevision` que
   * o GET devolveu, e não o sha do arquivo. `null` = a tela não viu
   * nenhuma, e grava por cima do que houver.
   *
   * Ver `tableRevisionOf` em `oxide/betterloot.ts` para por que a
   * revisão deixou de ser a do arquivo inteiro.
   */
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

    const { tableRevision, table } = await deps.editor.table(id, prefab);

    return { ok: true, serverId: id, tableRevision, table };
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
      tableRevision: result.tableRevision,
      revision: result.fileRevision,
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
  // ----------------------------------------------------------
  //  OS PERFIS — o `LootGroups.json`
  // ----------------------------------------------------------
  //
  //  Eles são do servidor, como as caixas, e por isso moram no
  //  mesmo `/servers/:id/`. O que os separa da tabela é o ARQUIVO:
  //  outro arquivo, outra revisão, outro salvamento.

  /** A lista de perfis, com em quais caixas cada um está. */
  app.get('/servers/:id/betterloot/profiles', async (request) => {
    const { id } = serverParams.parse(request.params);
    const result = await deps.editor.profiles(id);

    return {
      ok: true,
      serverId: id,
      // `false` = não existe LootGroups.json ali. NÃO é erro: um
      // servidor sem perfil nenhum é o estado normal de quem nunca
      // criou um, e criar o primeiro tem de funcionar.
      configured: result.configured,
      revision: result.revision,
      count: result.profiles.length,
      profiles: result.profiles,
    };
  });

  /** Um perfil inteiro. */
  app.get('/servers/:id/betterloot/profile', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { name } = z.object({ name: profileName }).parse(request.query);

    const { revision, profile } = await deps.editor.profile(id, name);

    return { ok: true, serverId: id, revision, profile };
  });

  /** Cria ou grava um perfil, recarrega e devolve o que releu. */
  app.put('/servers/:id/betterloot/profile', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = saveProfileSchema.parse(request.body);

    assertProfileConsistent(body.profile);

    const result = await deps.editor.saveProfile(id, {
      baseRevision: body.baseRevision,
      profile: body.profile,
    });

    return {
      ok: true,
      serverId: id,
      revision: result.revision,
      profile: result.profile,
      backup: result.backup,
      reloaded: result.reloaded,
      reloadOutput: result.reloadOutput,
    };
  });

  /**
   * Apaga um perfil.
   *
   * Em uso e sem `detach`, responde 409 com os nomes das caixas —
   * é a pergunta que o Looty não faz antes de apagar.
   */
  app.delete('/servers/:id/betterloot/profile', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { name } = z.object({ name: profileName }).parse(request.query);
    const body = deleteProfileSchema.parse(request.body ?? {});

    const result = await deps.editor.deleteProfile(id, { name, detach: body.detach });

    return {
      ok: true,
      serverId: id,
      // As caixas de onde a associação saiu junto. A tela precisa
      // dizer quantas foram: o admin autorizou um apagamento, e não
      // uma edição de seis caixas que ele não abriu.
      detached: result.detached,
      backup: result.backup,
      reloaded: result.reloaded,
      reloadOutput: result.reloadOutput,
    };
  });

  // ----------------------------------------------------------
  //  O LIXO — a lista de curadoria, que é NOSSA
  // ----------------------------------------------------------
  //
  //  ####  NENHUMA DESTAS ROTAS TOCA O DISCO DO SERVIDOR  ####
  //
  //  Elas mexem numa tabela do agente. Quem tira os itens da caixa
  //  é a TELA, montando o rascunho sem eles — e é o "Gravar" da
  //  caixa que leva isso ao jogo, com a mesma revisão, o mesmo
  //  backup e o mesmo "descartar" de qualquer outra edição.
  //
  //  Esse é o ponto em que somos melhores que o Looty: lá o
  //  `Remove Junk` apaga na hora e sem confirmar. Aqui o admin vê o
  //  que vai sair e ainda pode desistir.

  /** A lista de lixo daquele servidor: os padrões e os do admin. */
  app.get('/servers/:id/betterloot/junk', async (request) => {
    const { id } = serverParams.parse(request.params);

    const items = deps.junk.list(id);

    return {
      ok: true,
      serverId: id,
      count: items.filter((item) => item.active).length,
      items,
    };
  });

  /** Marca um item como lixo — ou religa um padrão desligado. */
  app.post('/servers/:id/betterloot/junk', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { shortname } = z.object({ shortname: junkShortname }).parse(request.body);

    deps.junk.add(id, shortname, Date.now());

    return { ok: true, serverId: id, items: deps.junk.list(id) };
  });

  /** Tira um item da lista. O padrão fica desligado; o do admin some. */
  app.delete('/servers/:id/betterloot/junk', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { shortname } = z.object({ shortname: junkShortname }).parse(request.query);

    deps.junk.remove(id, shortname, Date.now());

    return { ok: true, serverId: id, items: deps.junk.list(id) };
  });

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
 * O nome de um perfil.
 *
 * ####  ELE É A CHAVE DO ARQUIVO, E VIAJA EM QUERY STRING  ####
 *
 * O admin escolhe o nome livremente e ele vira chave do
 * `LootGroups.json`. Barra e ponto ficam de fora porque o nome
 * também aparece em caminho de log e em mensagem de erro do plugin;
 * o resto é dele.
 */
const profileName = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[^/\\{}"']+$/u,
    'O nome do perfil não pode ter barra, chaves nem aspas — ele vira chave de um JSON que o ' +
      'BetterLoot lê.',
  );

const profileItemSchema = entrySchema.extend({
  /**
   * O peso dentro do perfil.
   *
   * Zero é aceito de propósito: é o estado de um item recém-posto
   * na lista, antes de o admin distribuir os pesos. Quem cobra a
   * soma 100 é a tela — e, no fim, o rebalanceamento do plugin.
   */
  probability: z.number().min(0).max(100),
});

const profileSchema = z.object({
  name: profileName,
  enabled: z.boolean(),
  guaranteed: z.array(guaranteedSchema).max(MAX_ENTRIES),
  items: z.array(profileItemSchema).max(MAX_ENTRIES),
});

const saveProfileSchema = z.object({
  /** `null` = a tela está CRIANDO. Ver `saveProfile`. */
  baseRevision: z.string().nullable(),
  profile: profileSchema,
});

const deleteProfileSchema = z.object({
  /**
   * Apagar também a associação nas caixas que pedem este perfil.
   *
   * Sem isto, um perfil em uso é recusado com 409 e a lista das
   * caixas — para a tela poder perguntar antes, em vez de apagar e
   * deixar o admin descobrir depois.
   */
  detach: z.boolean().default(false),
});

/**
 * As conferências que o zod não faz sozinho.
 *
 * ####  MÍNIMO MAIOR QUE MÁXIMO É SILÊNCIO NO JOGO  ####
 *
 * O BetterLoot sorteia com `Random.Range(min, max)`; com os dois
 * trocados o resultado é o mínimo, sempre, e nada reclama. A tela
 * mostraria "2 a 1" e o admin acharia que pediu isso.
 */
/**
 * As mesmas conferências, para um perfil.
 *
 * ####  A SOMA 100 NÃO ESTÁ AQUI, E ISSO É DE PROPÓSITO  ####
 *
 * Um perfil cuja soma não dá 100 é REBALANCEADO pelo plugin, e não
 * recusado — e o meio de uma edição é um lugar legítimo para a soma
 * estar errada. Quem avisa é a tela, antes de gravar; recusar aqui
 * obrigaria a acertar tudo antes de poder salvar qualquer coisa.
 */
function assertProfileConsistent(profile: z.infer<typeof profileSchema>): void {
  const named: readonly { readonly key: string; readonly min: number; readonly max: number }[] = [
    ...profile.items,
    ...profile.guaranteed,
  ];

  for (const entry of named) {
    if (entry.min > entry.max) {
      throw new ApiError(
        'BETTERLOOT_INVALID_RANGE',
        `No perfil "${profile.name}", a entrada "${entry.key}" tem mínimo ${String(
          entry.min,
        )} maior que o máximo ${String(entry.max)}. Nada foi alterado.`,
        400,
      );
    }
  }

  const keys = new Set<string>();

  for (const item of profile.items) {
    if (keys.has(item.key)) {
      // O `Item List` é um DICIONÁRIO: duas entradas com a mesma
      // chave viram uma no arquivo, e a tela mostraria uma lista
      // que o disco não tem.
      throw new ApiError(
        'BETTERLOOT_DUPLICATE_KEY',
        `O perfil "${profile.name}" tem "${item.key}" duas vezes. No arquivo do BetterLoot a ` +
          'chave é única — use o sufixo {1}, {2} para repetir o mesmo item. Nada foi alterado.',
        400,
      );
    }

    keys.add(item.key);
  }
}

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
