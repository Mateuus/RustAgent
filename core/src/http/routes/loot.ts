// ============================================================
//  routes/loot.ts  -  a regra de loot: o que NÓS acrescentamos ao
//  que o jogo já põe na caixa.
//
//      GET    /loot/rules[?serverId=]   a lista
//      GET    /loot/containers          as caixas que a tela oferece
//      GET    /loot/rules/:id/stats     a medição, por dia
//      POST   /loot/rules               cria
//      PUT    /loot/rules/:id           edita (a regra INTEIRA)
//      DELETE /loot/rules/:id           remove
//
//  ####  ESTAS ROTAS RESPONDEM COM OS SERVIDORES DESLIGADOS  ####
//
//  Como as de item custom, e pela mesma razão: configurar loot é
//  trabalho de madrugada, com tudo parado. Nenhuma rota daqui fala
//  com o RCON — quem leva a regra ao jogo é a sincronização, e ela
//  acontece quando o servidor sobe.
//
//  ####  O `mode` É O CAMPO QUE MAIS IMPORTA DESTA TELA  ####
//
//  `measuring` conta e NÃO cria item nenhum; `live` cria. É a Q8 do
//  `Docs/CustomItem/04`, respondida pelo dono: mede antes de
//  soltar. Sem uma semana de contagem, a chance de partida é um
//  chute com fator de erro de 5 — o estudo mediu 400 containers de
//  mundo aberto vivos, mas não conseguiu medir o GIRO deles.
//
//  Por isso o default do banco é `measuring`, e por isso este
//  arquivo NÃO tem default no zod para o campo: uma regra criada
//  sem dizer o modo tem de dizer o modo. Errar para "conta" é
//  barato; errar para "solta item no mundo" não é.
//
//  ####  A VALIDAÇÃO PESADA MORA AQUI  ####
//
//  Mesmo desenho do `custom-items.ts`: o banco tem os CHECK que
//  pegam o caminho de quem esqueceu de validar, e as regras longas
//  — o item custom existir, valer naquele servidor, a lista de
//  containers — são zod e código aqui, porque um CHECK que entende
//  metade delas é pior que nenhum.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { CustomItemsRepository } from '../../db/custom-items-repository.js';
import type {
  LootRuleInput,
  LootRuleRecord,
  LootRulesRepository,
} from '../../db/loot-rules-repository.js';
import { LOOT_RULE_MODES } from '../../db/loot-rules-repository.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import {
  CONTAINER_PREFAB,
  LOOT_CONTAINERS,
  LOOT_CONTAINER_GROUPS,
} from '../../game/loot-containers.js';
import {
  BETTERLOOT_PLUGIN,
  LOOT_TABLES_FILE,
  natureOfPrefab,
  parseLootTables,
  shortPrefabOf,
} from '../../oxide/betterloot.js';
import { readPluginDataFile } from '../../oxide/data-files.js';
import { ApiError } from '../error-response.js';

export interface LootRoutesDeps {
  readonly repository: LootRulesRepository;
  /** Para conferir que o item custom existe e vale nos servidores. */
  readonly customItems: CustomItemsRepository;
  /** Para conferir que os servidores escolhidos existem. */
  readonly servers: ServersRepository;
  /**
   * Quem leva a regra ao jogo.
   *
   * Opcional porque os testes montam as rotas sem ele: a
   * configuração tem de funcionar com todos os servidores parados,
   * e é essa a promessa que os testes guardam.
   */
  readonly sync?: { pushAll(trigger: string): Promise<unknown> };
  /**
   * Onde ficam as pastas de cada servidor.
   *
   * Só a lista de contêineres a usa, e só para ENRIQUECER: com um
   * `serverId`, ela junta ao catálogo curado os prefabs que o
   * BetterLoot daquele servidor de fato conhece. Opcional porque os
   * testes montam as rotas sem ele — e sem ele a lista continua
   * respondendo, com o catálogo e mais nada.
   */
  readonly supervisor?: {
    configOf(id: string): { readonly paths: { readonly oxideDataDir: string } } | null;
  };
}

/**
 * Quantos containers cabem numa regra.
 *
 * O build inteiro tem 105 (medido no `Docs/CustomItem/05` §2.3), e
 * o teto é maior que isso de propósito: uma regra que valha em
 * TODOS é legítima ("o troféu pode sair de qualquer caixa"). O que
 * o teto impede é o corpo de requisição de tamanho arbitrário.
 */
export const MAX_CONTAINERS = 200;

/**
 * O piso da chance.
 *
 * `1e-9` é um sorteio a cada bilhão de containers — com os ~2.000
 * containers/dia estimados no `Docs/CustomItem/04` §6.3, isso é
 * uma vez a cada 1.400 anos. Abaixo disso a regra não é rara: ela
 * está desligada, e desligar tem um interruptor próprio.
 *
 * O teto é 1: o `chance` é uma probabilidade, não um multiplicador.
 */
const chanceSchema = z
  .number()
  .gt(1e-9, 'A chance é tão baixa que a regra nunca dispararia — use o interruptor "ligada".')
  .max(1, 'A chance é uma probabilidade por caixa: no máximo 1 (sempre).');

const containersSchema = z
  .array(
    z
      .string()
      .regex(
        CONTAINER_PREFAB,
        'O nome da caixa é o ShortPrefabName do jogo: minúscula, dígito, ponto, hífen ou sublinhado.',
      ),
  )
  .min(1, 'A regra precisa de pelo menos uma caixa — sem caixa ela não dispara em lugar nenhum.')
  .max(MAX_CONTAINERS);

const bodySchema = z
  .object({
    label: z.string().min(1).max(120),
    customItemId: z.string().min(1).max(120),
    containers: containersSchema,
    chance: chanceSchema,
    amountMin: z.number().int().min(1).max(1000).default(1),
    amountMax: z.number().int().min(1).max(1000).default(1),
    // Ver o cabeçalho: sem default de propósito.
    mode: z.enum(LOOT_RULE_MODES),
    // ####  NULL É "SEM TETO", E NÃO "ZERO"  ####
    //
    // Um teto de zero seria uma regra que nunca emite, escrita de
    // um jeito que ninguém lê como "desligada". Quem quer isso
    // desliga a regra; quem não quer teto manda `null`.
    dailyCap: z.number().int().min(1).max(10_000).nullable().default(null),
    playerCooldownHours: z.number().int().min(1).max(24 * 365).nullable().default(null),
    enabled: z.boolean().default(true),
    servers: z.array(z.string().min(1)).default([]),
  })
  .refine((body) => body.amountMax >= body.amountMin, {
    path: ['amountMax'],
    message: 'A quantidade máxima não pode ser menor que a mínima.',
  });

const idParams = z.object({ id: z.string().min(1) });

const listQuery = z.object({ serverId: z.string().min(1).optional() });

const containersQuery = z.object({
  /**
   * De qual servidor.
   *
   * Opcional: sem ele a resposta é só o catálogo curado, que
   * responde com tudo desligado — a promessa desta tela. Com ele, o
   * agente abre o `LootTables.json` daquele servidor e acrescenta o
   * que ele achar lá.
   */
  serverId: z.string().min(1).optional(),
});

const statsQuery = z.object({
  serverId: z.string().min(1).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/** Uma caixa, na forma que a tela lê. Espelha `LootContainerInfo`. */
interface LootContainerInfo {
  /** O `ShortPrefabName` — a identidade, e o que a regra guarda. */
  readonly name: string;
  readonly label: string | null;
  readonly group: string | null;
  readonly refreshSeconds: number | null;
}

/**
 * Junta ao catálogo o que o BetterLoot daquele servidor conhece.
 *
 * ####  POR QUE ESTA FONTE, E NÃO UMA PERGUNTA AO JOGO  ####
 *
 * O `LootTables.json` é gerado pelo próprio plugin a partir do loot
 * NATIVO daquele build, no primeiro carregamento
 * (Docs/CustomItem/06 §2.6). Ou seja: é o retrato do mundo daquele
 * servidor, escrito em disco, legível com o jogo parado — que é
 * quando se configura loot. Uma pergunta por RCON só responderia
 * com o servidor no ar, e exigiria um comando de plugin que ainda
 * não existe.
 *
 * ####  O QUE ELE TRAZ QUE NÃO É CAIXA  ####
 *
 * Das 111 chaves do `server01`, 31 são corpo de cientista e 9 são
 * as sintéticas `unwrap/` — o que sai ao ABRIR um presente. Nem uma
 * nem outra é contêiner no mapa, e as duas são descartadas aqui: o
 * admin não pensa em cientista como caixa, e uma lista que os
 * misturasse afogaria o barril que ele veio procurar.
 *
 * Falha em silêncio de propósito. Esta rota tem UM dever — oferecer
 * as caixas —, e o catálogo já o cumpre. Deixar de responder porque
 * um arquivo opcional está corrompido seria trocar uma lista boa por
 * um erro.
 *
 * @returns quantos entraram que o catálogo não tinha.
 */
async function enrichFromBetterLoot(
  deps: LootRoutesDeps,
  serverId: string,
  into: Map<string, LootContainerInfo>,
): Promise<number> {
  const paths = deps.supervisor?.configOf(serverId)?.paths;

  if (paths === undefined) {
    return 0;
  }

  let file;

  try {
    file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE);
  } catch {
    return 0;
  }

  if (file === null) {
    return 0;
  }

  let prefabs: readonly string[];

  try {
    prefabs = Object.keys(parseLootTables(file.text, serverId).tables);
  } catch {
    return 0;
  }

  let added = 0;

  for (const prefab of prefabs) {
    if (natureOfPrefab(prefab) !== 'container') {
      continue;
    }

    const name = shortPrefabOf(prefab);

    // O nome curto pode ter ESPAÇO (`dm ammo`), e aí ele não passa
    // pelo `CONTAINER_PREFAB` — a regra que o usasse seria recusada
    // na criação. Oferecer o que não se pode escolher é pior que
    // não oferecer.
    if (!CONTAINER_PREFAB.test(name) || into.has(name)) {
      continue;
    }

    into.set(name, {
      name,
      // Sem apelido: quem humaniza é a tela, e ela já sabe (ver
      // `labelOf`, no painel). Inventar um rótulo em português aqui
      // seria adivinhar o que aquele prefab é.
      label: null,
      group: null,
      refreshSeconds: null,
    });

    added += 1;
  }

  return added;
}

export function registerLootRoutes(app: FastifyInstance, deps: LootRoutesDeps): void {
  /**
   * As caixas que a tela oferece.
   *
   * Registrada ANTES da rota de `:id` por clareza — o Fastify
   * prefere o caminho estático de qualquer jeito, mas ler o
   * arquivo na ordem em que ele resolve poupa a dúvida.
   *
   * Ela é OFERTA, e não trava: o plugin aceita qualquer
   * `ShortPrefabName`, e o cadastro aqui também. Ver o cabeçalho de
   * `game/loot-containers.ts`.
   */
  app.get('/loot/containers', async (request) => {
    const { serverId } = containersQuery.parse(request.query);

    const containers = new Map<string, LootContainerInfo>(
      LOOT_CONTAINERS.map((container) => [
        container.prefab,
        {
          // ####  O CAMPO CHAMA-SE `name`, E ISSO NÃO É DETALHE  ####
          //
          // A tela lê `container.name` para agrupar, rotular e
          // buscar. Até 06/09/2026 esta rota devolvia `prefab`, e o
          // painel recebia 33 linhas com `name` indefinido: todas
          // caíam em "Outros", sem apelido e sem casar com a busca.
          // O catálogo estava certo e chegava inútil.
          name: container.prefab,
          label: container.label,
          group: container.group,
          // "Não sei", e não "nunca". O `Docs/CustomItem/05` §2.6
          // mediu que 71 dos 105 refazem o loot a cada 1–2 h, mas a
          // medição está no AGREGADO — não existe, hoje, a lista de
          // qual prefab tem qual intervalo. Inventar um número aqui
          // faria a tela afirmar o que ninguém mediu.
          refreshSeconds: null,
        },
      ]),
    );

    // O que AQUELE servidor conhece, por cima do catálogo. Ver o
    // cabeçalho de `enrichFromBetterLoot`.
    const enriched =
      serverId === undefined ? 0 : await enrichFromBetterLoot(deps, serverId, containers);

    return {
      ok: true,
      groups: LOOT_CONTAINER_GROUPS,
      count: containers.size,
      /** Quantos vieram do disco daquele servidor, e não do catálogo. */
      fromServer: enriched,
      containers: [...containers.values()],
    };
  });

  /**
   * A lista.
   *
   * Com `serverId`, devolve o que AQUELE servidor de fato recebe —
   * as três condições do `listForServer`, incluindo a que ninguém
   * vê: o item custom valer ali. Sem ele, devolve tudo, que é o
   * que a tela de administração quer.
   */
  app.get('/loot/rules', async (request) => {
    const { serverId } = listQuery.parse(request.query);

    const rules =
      serverId === undefined
        ? deps.repository.list()
        : deps.repository.listForServer(serverId);

    return { ok: true, count: rules.length, rules: rules.map(toBody) };
  });

  /**
   * A medição, por dia.
   *
   * ####  `rolls` É O NÚMERO QUE O ESTUDO NÃO CONSEGUIU MEDIR  ####
   *
   * O `Docs/CustomItem/04` §6.3 precisa de "quantos containers são
   * populados por dia neste servidor" para calcular a chance, e não
   * havia como medir: `spawn.report` só cobre populações, e os
   * containers de monumento não são população. Esta série responde
   * isso — e responde de graça, porque o hook já está lá.
   */
  app.get('/loot/rules/:id/stats', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = statsQuery.parse(request.query);

    mustGet(deps, id);

    const stats = deps.repository.statsOf(id, {
      ...(query.serverId === undefined ? {} : { serverId: query.serverId }),
      ...(query.days === undefined ? {} : { days: query.days }),
    });

    return { ok: true, stats };
  });

  app.post('/loot/rules', async (request, reply) => {
    const input = toInput(bodySchema.parse(request.body));

    validate(deps, input);

    const created = deps.repository.create(input);

    request.log.info(
      { rule: created.id, item: created.customItemId, mode: created.mode },
      'regra de loot criada',
    );

    // ####  SEM ISTO, A REGRA NÃO EXISTE NO JOGO  ####
    //
    // Ela fica no banco, aparece na tela, e o plugin nunca soube —
    // nem para contar, nem para emitir. Ver
    // game/custom-items-sync.ts, que é o MESMO canal do cadastro de
    // itens: a regra depende do item, e dois canais poderiam
    // entregá-los fora de ordem.
    //
    // `void` e sem `await`: um servidor reiniciando não pode
    // segurar a resposta de quem acabou de salvar.
    void deps.sync?.pushAll('loot-rule-created');

    await reply.code(201).send({ ok: true, rule: toBody(created) });
  });

  app.put('/loot/rules/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const input = toInput(bodySchema.parse(request.body));

    mustGet(deps, id);
    validate(deps, input);

    const saved = deps.repository.update(id, input);

    if (saved === null) {
      // Só chega aqui se alguém apagou a regra entre o `mustGet` e
      // o `update`. É improvável, e é por isso que merece um 404
      // honesto em vez de um 500.
      throw notFound(id);
    }

    request.log.info({ rule: id, mode: saved.mode }, 'regra de loot editada');

    void deps.sync?.pushAll('loot-rule-updated');

    return { ok: true, rule: toBody(saved) };
  });

  app.delete('/loot/rules/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    mustGet(deps, id);

    // ####  APAGAR LEVA A MEDIÇÃO JUNTO  ####
    //
    // A contagem só faz sentido ao lado da chance e dos containers
    // que a produziram — guardá-la órfã daria um número sem
    // denominador. Quem quer parar de emitir sem perder a semana de
    // medição desliga a regra em vez de apagá-la, e a tela precisa
    // oferecer o primeiro antes do segundo.
    deps.repository.remove(id);

    request.log.info({ rule: id }, 'regra de loot apagada');

    // O `clear` do plugin é o que faz a regra apagada parar de
    // valer no jogo: sem esta linha ela continuaria disparando lá
    // até o próximo restart.
    void deps.sync?.pushAll('loot-rule-removed');

    return { ok: true };
  });
}

/**
 * As conferências que o banco não faz.
 *
 * @throws ApiError com a frase pronta.
 */
function validate(deps: LootRoutesDeps, input: LootRuleInput): void {
  // ####  O ITEM CUSTOM PRECISA EXISTIR — ELE É A MARCA  ####
  //
  // MEDIDO em `Docs/CustomItem/04` §4.1: a tabela de loot do Rust
  // cria todo item com `skin = 0`, e o `Match` do plugin sai em
  // `item.skin == 0UL`. Sem a marca, o item que nasceria no barril
  // não teria nome, não viraria ponto, e o jogador o leria como
  // lixo. A regra sem item não é uma regra incompleta: é uma regra
  // que produz lixo.
  const item = deps.customItems.get(input.customItemId);

  if (item === null) {
    throw new ApiError(
      'UNKNOWN_CUSTOM_ITEM',
      `Nenhum item custom com o id "${input.customItemId}". A regra de loot precisa de um item ` +
        'nosso para saber qual MARCA carimbar — a tabela de loot do Rust cria tudo com skin 0, e ' +
        'um item sem skin não é reconhecido pelo plugin.',
      400,
    );
  }

  // Servidor que não existe na tabela vira uma ligação órfã que o
  // FOREIGN KEY recusaria com uma mensagem que ninguém entende.
  const known = new Set(deps.servers.list().map((server) => server.id));
  const unknown = input.servers.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw new ApiError('UNKNOWN_SERVER', `Estes servidores não existem: ${unknown.join(', ')}.`, 400);
  }

  // ####  O DEFEITO QUE ESTA CONFERÊNCIA MATA É SILENCIOSO  ####
  //
  // As duas listas — em quais servidores a regra vale e em quais o
  // item custom vale — são independentes, e nada impede ligá-las em
  // conjuntos diferentes. O resultado seria uma regra que aparece
  // ligada na tela e NUNCA sobe àquele servidor: o `listForServer`
  // do repositório a descarta, sem erro nenhum.
  //
  // Dizer isso agora, com o nome dos servidores, é a diferença
  // entre corrigir num clique e passar uma semana perguntando por
  // que a medição de um servidor está zerada.
  const missing = input.servers.filter((id) => !item.servers.includes(id));

  if (missing.length > 0) {
    throw new ApiError(
      'ITEM_NOT_IN_SERVER',
      `O item "${item.displayName}" não está ligado a estes servidores: ${missing.join(', ')}. ` +
        'A regra só vale onde o item também vale — senão ela nasceria ligada e nunca chegaria ao ' +
        'jogo. Ligue o item nesses servidores, ou tire-os da regra.',
      400,
    );
  }

  // Item desligado é um cadastro que continua sendo RECONHECIDO no
  // jogo (quem já tem o troféu não fica com lixo), mas que não é
  // mais ENTREGUE. Criar uma regra que o solta no mundo é pedir o
  // oposto do que o interruptor diz.
  if (!item.enabled) {
    throw new ApiError(
      'CUSTOM_ITEM_DISABLED',
      `O item "${item.displayName}" está desligado. Uma regra de loot em cima dele não chegaria ` +
        'ao jogo — ligue o item antes, ou escolha outro.',
      400,
    );
  }
}

function mustGet(deps: LootRoutesDeps, id: string): LootRuleRecord {
  const rule = deps.repository.get(id);

  if (rule === null) {
    throw notFound(id);
  }

  return rule;
}

function notFound(id: string): ApiError {
  return new ApiError('LOOT_RULE_NOT_FOUND', `Nenhuma regra de loot com o id "${id}".`, 404);
}

/** O corpo validado vira o que o repositório espera. */
function toInput(body: z.infer<typeof bodySchema>): LootRuleInput {
  return {
    label: body.label,
    customItemId: body.customItemId,
    containers: body.containers,
    chance: body.chance,
    amountMin: body.amountMin,
    amountMax: body.amountMax,
    mode: body.mode,
    dailyCap: body.dailyCap,
    playerCooldownHours: body.playerCooldownHours,
    enabled: body.enabled,
    servers: body.servers,
  };
}

/** Uma regra, na forma que a API entrega. Datas em ISO. */
function toBody(rule: LootRuleRecord) {
  return {
    id: rule.id,
    label: rule.label,
    customItemId: rule.customItemId,
    // A marca vai junto porque a tela precisa mostrar QUAL item a
    // regra solta, e pedi-lo numa segunda chamada por linha seria o
    // N+1 desta tela.
    item: {
      displayName: rule.itemDisplayName,
      baseShortname: rule.itemBaseShortname,
      skinId: rule.itemSkinId,
      enabled: rule.itemEnabled,
    },
    containers: rule.containers,
    chance: rule.chance,
    amountMin: rule.amountMin,
    amountMax: rule.amountMax,
    mode: rule.mode,
    dailyCap: rule.dailyCap,
    playerCooldownHours: rule.playerCooldownHours,
    enabled: rule.enabled,
    servers: rule.servers,
    createdAt: new Date(rule.createdAt).toISOString(),
    updatedAt: new Date(rule.updatedAt).toISOString(),
  };
}
