// ============================================================
//  quests.ts  -  O CONTRATO DAS QUESTS.
//
//  O vocabulário e a RÉGUA. Quatro consumidores dependem do que
//  está aqui — o repositório (db/quests-repository.ts), o serviço
//  (quests/service.ts), a rota (http/routes/quests.ts) e a
//  sincronização com o plugin — e é por isso que a régua mora
//  neste arquivo, e não dentro de um deles.
//
//  ####  UMA RÉGUA SÓ, E ELA É IMPORTADA  ####
//
//  A lição está escrita em site/appliers/store.ts: "uma segunda
//  régua para a mesma tabela é uma régua que vai divergir, e a que
//  ficar mais frouxa é a que grava". A rota valida com estes
//  schemas; o repositório grava o que eles produziram; o serviço
//  lê o mesmo tipo. Ninguém redigita um `z.object` equivalente.
//
//  ------------------------------------------------------------
//  ####  A DEFINIÇÃO É DE REDE; O PROGRESSO É DE SERVIDOR  ####
//
//  Uma quest é escrita UMA vez e vale em todos os servidores —
//  como VIP, kit, loja e mensagem. O que é por servidor é onde ela
//  aparece (`servers`, lista vazia = todos) e, sobretudo, o
//  PROGRESSO: "minerar 5.000 de enxofre" conta separado em cada
//  mundo, e o wipe de um não mexe no outro.
//
//  ------------------------------------------------------------
//  ####  NADA AQUI CALCULA NADA  ####
//
//  Cooldown, cadeia, teto de quests ativas, "ele já pode aceitar?"
//  e a frase que o jogador lê são todos de `quests/service.ts`.
//  Este arquivo diz o que uma quest É; o serviço diz o que ela
//  FAZ.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §3, §5 e §6.
// ============================================================

import { z } from 'zod';

// ------------------------------------------------------------
//  §1  VOCABULÁRIO
// ------------------------------------------------------------

/**
 * Como a quest se repete.
 *
 *   once     uma vez por servidor, na vida
 *   cooldown volta depois de `cooldownSeconds`
 *   daily    volta na virada do dia
 *   weekly   volta na virada da semana
 *
 * A virada de `daily` e `weekly` é a do agente, na hora que
 * `quest_settings.reset_at_minute` marcar — nunca a do relógio do
 * jogador, que está em qualquer fuso do mundo.
 */
export type QuestRepeatMode = 'once' | 'cooldown' | 'daily' | 'weekly';

/** O que o wipe do mundo faz com o progresso dela. Ver §14 do plano. */
export type QuestWipePolicy = 'reset' | 'keep';

/**
 * De onde o número de um objetivo vem.
 *
 *   kill     matar. `target` é o nome curto normalizado da criatura
 *   gather   colher. `target` é o shortname do recurso
 *   craft    fabricar. `target` é o shortname do item
 *   loot     pegar de container ou do chão. `target` é o shortname
 *   deliver  levar de um NPC a outro. `target` é o id do NPC DESTINO
 *   playtime tempo online, em MINUTOS. Sem alvo — o agente mede
 *   metric   qualquer métrica do ranking. `metric` preenchido
 *
 * Os três primeiros e o `metric` custam zero em performance: o
 * `OrigemZAgent` já roda esses hooks para o ranking. O `loot` é o
 * único caro, e §5.4 do plano descreve as três contenções dele.
 */
export type QuestObjectiveKind =
  | 'kill'
  | 'gather'
  | 'craft'
  | 'loot'
  | 'deliver'
  | 'playtime'
  | 'metric';

/** O que a quest dá. Nenhum deles é código novo — ver §6.2 do plano. */
export type QuestRewardKind = 'item' | 'coins' | 'kit' | 'points' | 'vip';

/**
 * Onde uma TENTATIVA está.
 *
 *   active     aceita, contando
 *   completed  os objetivos fecharam; a recompensa espera o resgate
 *   claimed    resgatada. É o estado final feliz
 *   abandoned  ele cancelou, ou o admin resetou
 *
 * `completed` é um estado, e não um instante: concluir e receber
 * são coisas diferentes, e sem essa separação a recompensa sairia
 * num inventário cheio, no meio de um tiroteio. Ver §7.1 do plano.
 */
export type PlayerQuestStatus = 'active' | 'completed' | 'claimed' | 'abandoned';

/** O que a auditoria registra. Ver §3.7 do plano. */
export type QuestEventKind =
  | 'accept'
  | 'progress'
  | 'complete'
  | 'claim'
  | 'abandon'
  | 'reset'
  | 'reward_failed';

/** Quem produziu o evento. */
export type QuestEventSource = 'plugin' | 'agent' | 'panel' | 'wipe';

/** O papel de um NPC. Ver §10 do plano. */
export type QuestNpcKind = 'quest' | 'delivery';

/** O que o wipe faz com a posição dele. */
export type QuestNpcWipePolicy = 'keep' | 'remove';

/**
 * Os objetivos que PASSAM pelo plugin, e por isso entram no
 * catálogo do `origemz.quest.watch`.
 *
 * `playtime` e `metric` ficam de fora porque o agente os calcula
 * sozinho, do lote que o ranking já traz. Mandá-los ao plugin
 * pediria a ele que contasse o que ele não tem como contar.
 */
export const PLUGIN_OBJECTIVE_KINDS: readonly QuestObjectiveKind[] = [
  'kill',
  'gather',
  'craft',
  'loot',
  'deliver',
];

// ------------------------------------------------------------
//  §2  AS RÉGUAS BÁSICAS
// ------------------------------------------------------------

/**
 * O id de uma quest: o slug que a URL do painel guarda e que o
 * endereço da tela do jogo carrega.
 *
 * Sem acento, sem maiúscula, sem espaço — pela mesma razão que o
 * id do item custom não os tem: ele viaja num comando de console
 * do Rust, onde o espaço separa argumentos.
 */
const questIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9.-]*$/, 'o id da quest usa só minúscula, dígito, ponto e hífen');

/**
 * O formato de uma métrica: `familia.nome`, minúsculas.
 *
 * É o MESMO de `game/stats-contract.ts` e o mesmo que a migração
 * 033 documenta. Uma terceira régua para a mesma coisa é a que vai
 * divergir.
 */
const questMetricSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)*$/, 'a métrica é familia.nome, em minúsculas');

/**
 * O alvo de um objetivo.
 *
 * Serve para três coisas diferentes — shortname de item
 * (`sulfur.ore`), nome curto de criatura (`scientist`) e id de NPC
 * (`velho-do-outpost`) —, e por isso a régua é a UNIÃO delas, e
 * não a mais estrita. Quem confere se aquele alvo existe de fato é
 * o serviço, que tem o catálogo de itens e a lista de NPCs na mão.
 */
const questTargetSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'o alvo usa só minúscula, dígito, ponto, hífen e sublinhado');

// ------------------------------------------------------------
//  §3  O OBJETIVO
// ------------------------------------------------------------

/**
 * Um objetivo, como o painel o manda e como o banco o guarda.
 *
 * ####  `seq` É A CHAVE QUE ATRAVESSA  ####
 *
 * Ele — e não o `id` autoincremento — é o que viaja até o plugin
 * (`origemz.quest.assign`), o que a linha de progresso guarda e o
 * que o snapshot da tentativa referencia. O id do banco nunca sai
 * daqui.
 */
const questObjectiveSchema = z
  .object({
    seq: z.number().int().min(0).max(31),
    kind: z.enum(['kill', 'gather', 'craft', 'loot', 'deliver', 'playtime', 'metric']),
    target: questTargetSchema.nullable().default(null),
    metric: questMetricSchema.nullable().default(null),
    /**
     * Zero é recusado de propósito: um objetivo de zero conclui
     * sozinho, e a quest inteira vira um botão de recompensa
     * grátis que ninguém queria ter cadastrado.
     */
    amount: z.number().int().min(1).max(100_000_000),
    /** `null` = o agente monta a frase a partir do resto. */
    label: z.string().max(120).nullable().default(null),
    /**
     * Os itens SAEM do inventário no resgate. É o `ItemDeduction`
     * do Quests.cs. Só faz sentido em `loot` e `gather` — e o
     * refine abaixo cobra isso.
     */
    consume: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    // `metric` é o único que usa a coluna `metric`; para todos os
    // outros ela precisa estar vazia, senão duas colunas dizem de
    // onde o número vem e nenhuma delas manda.
    if (value.kind === 'metric') {
      if (value.metric === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['metric'],
          message: 'um objetivo de tipo "metric" precisa dizer qual métrica',
        });
      }

      if (value.target !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['target'],
          message: 'um objetivo de tipo "metric" não tem alvo: o alvo dele é a métrica',
        });
      }

      return;
    }

    if (value.metric !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['metric'],
        message: `só o tipo "metric" usa o campo metric — "${value.kind}" usa target`,
      });
    }

    // `playtime` é o outro sem alvo: o alvo dele é o relógio.
    if (value.kind === 'playtime') {
      if (value.target !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['target'],
          message: 'um objetivo de tipo "playtime" não tem alvo: são minutos online',
        });
      }

      return;
    }

    if (value.target === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: `um objetivo de tipo "${value.kind}" precisa de um alvo`,
      });
    }

    // ####  POR QUE ISTO É ERRO, E NÃO UM CAMPO IGNORADO  ####
    //
    // `consume` marcado num objetivo de matar não teria o que
    // retirar do inventário, e o resgate falharia com uma frase
    // sem sentido para quem jogou. Recusar no cadastro custa um
    // aviso no painel; deixar passar custa um jogador travado.
    if (value.consume && value.kind !== 'loot' && value.kind !== 'gather') {
      ctx.addIssue({
        code: 'custom',
        path: ['consume'],
        message: 'só objetivos de "loot" e "gather" podem consumir os itens no resgate',
      });
    }
  });

export type QuestObjective = z.infer<typeof questObjectiveSchema>;

// ------------------------------------------------------------
//  §4  A RECOMPENSA
// ------------------------------------------------------------

/**
 * O item entregue.
 *
 * `skinId` é TEXT porque é um UInt64 na rede e não cabe no inteiro
 * com sinal do SQLite — a mesma escolha de `store_offer_items` e
 * de `custom_items`. `'0'` é legítimo aqui (item sem skin), ao
 * contrário do item custom, onde a skin é a MARCA.
 */
const itemRewardSchema = z.object({
  kind: z.literal('item'),
  shortname: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  amount: z.number().int().min(1).max(1_000_000),
  skinId: z
    .string()
    .regex(/^\d{1,20}$/)
    .default('0'),
});

// ####  NÃO HÁ CAMPO `blueprint` AQUI, E ISSO É DELIBERADO  ####
//
// Ele existiu por uma hora e saiu: o caminho de entrega
// (`StoreService.deliverPlan`) manda `origemz.give` com o modo
// FIXO, e um `blueprint: true` no cadastro não teria efeito
// nenhum no jogo.
//
// Prometer um campo que não faz nada é pior que não ter o campo:
// o admin cadastra a recompensa, testa uma vez, vê o item comum
// chegar e passa a desconfiar do resto. Quando a entrega souber
// mandar blueprint, ele volta — com teste.

/**
 * Moeda.
 *
 * ####  DUAS FORMAS, E A SEGUNDA É SÓ PARA ENTREGA  ####
 *
 * `amount` é o valor fixo. `perMeter` é a recompensa por distância
 * da quest de entrega (o `Multiplier` do Quests.cs), e ela vem com
 * piso e teto porque uma entrega entre dois NPCs distantes num
 * mapa de 6 km pagaria um número que ninguém escolheu.
 *
 * Quem multiplica é o agente, com a distância que ELE mediu entre
 * os dois NPCs — nunca com a que o plugin mandou.
 */
const coinsRewardSchema = z
  .object({
    kind: z.literal('coins'),
    amount: z.number().int().min(0).max(10_000_000).nullable().default(null),
    perMeter: z.number().min(0).max(1000).nullable().default(null),
    min: z.number().int().min(0).max(10_000_000).nullable().default(null),
    max: z.number().int().min(0).max(10_000_000).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.amount === null && value.perMeter === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a recompensa em moeda precisa de um valor fixo ou de um valor por metro',
      });
    }

    if (value.amount !== null && value.perMeter !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'valor fixo e por metro juntos: escolha um — dois seriam duas recompensas',
      });
    }

    if (value.min !== null && value.max !== null && value.min > value.max) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: 'o piso é maior que o teto' });
    }
  });

/** Um kit já cadastrado. A chave é o `slug`, e não o id — ver appliers/kits.ts. */
const kitRewardSchema = z.object({
  kind: z.literal('kit'),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9.-]*$/),
});

/**
 * Pontos num ranking.
 *
 * É a MESMA ação `points` que o item custom já tem, e é o que faz
 * uma quest virar fonte de ranking sem uma linha de código: um
 * ranking "quests concluídas" é uma linha em `rankings` apontando
 * para a métrica que esta recompensa soma.
 */
const pointsRewardSchema = z.object({
  kind: z.literal('points'),
  metric: questMetricSchema,
  amount: z.number().int().min(1).max(1_000_000),
});

/**
 * VIP.
 *
 * `days` nunca é nulo aqui, ao contrário da loja: um VIP vitalício
 * como recompensa de quest é o tipo de coisa que se cadastra por
 * engano uma vez e não se desfaz.
 */
const vipRewardSchema = z.object({
  kind: z.literal('vip'),
  tier: z.string().min(1).max(32),
  days: z.number().int().min(1).max(3650),
});

/**
 * A recompensa, achatada.
 *
 * ####  POR QUE `kind` + PAYLOAD, E NÃO UMA COLUNA POR TIPO  ####
 *
 * Cinco tipos com colunas próprias dariam uma tabela de quinze
 * colunas das quais treze são NULL em toda linha, e um tipo novo
 * seria uma migração. O item custom já resolveu isso com `action`
 * em JSON validado por zod (migração 041), e o padrão é o dele.
 *
 * O objeto chega achatado (`{kind:'item', shortname, amount}`)
 * porque é assim que o formulário do painel o produz; quem separa
 * o `kind` do resto para gravar nas duas colunas é o repositório.
 */
export const questRewardSchema = z.discriminatedUnion('kind', [
  itemRewardSchema,
  coinsRewardSchema,
  kitRewardSchema,
  pointsRewardSchema,
  vipRewardSchema,
]);

export type QuestReward = z.infer<typeof questRewardSchema>;

// ####  NÃO HÁ UM ALIAS POR TIPO DE RECOMPENSA  ####
//
// Eles existiram e saíram: `ItemReward`, `CoinsReward` e os outros
// três eram exportados e ninguém os usava. Quem precisa de um deles
// escreve `Extract<QuestReward, { kind: 'item' }>` — que é o que o
// `rewards.ts` já fazia, sem saber que havia um nome pronto.
//
// Um tipo exportado que ninguém importa é uma promessa de contrato
// que não existe: alguém vai supor que ele é usado em algum lugar.

// ------------------------------------------------------------
//  §5  A QUEST
// ------------------------------------------------------------

/**
 * A quest inteira, como o painel a manda.
 *
 * PUT e não PATCH: a tela edita num formulário só e manda tudo.
 * Um merge parcial abriria "o que acontece com os objetivos que
 * não vieram?", e a única resposta segura seria não mexer — o
 * oposto do que espera quem apagou um na tela.
 */
export const questInputSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().default(null),
    /**
     * Texto livre de propósito: a categoria é uma aba na tela e um
     * filtro no painel, e inventar uma nova não pode ser uma
     * migração.
     */
    category: z.string().min(1).max(40).default('geral'),
    enabled: z.boolean().default(true),
    sort: z.number().int().min(0).max(100_000).default(0),

    /** `null` = todo mundo vê. Ver a coluna `requires` da 046. */
    requires: z.string().max(64).nullable().default(null),

    /** `null` = aparece no menu; preenchido = só perto daquele NPC. */
    npcId: z.string().max(64).nullable().default(null),

    repeatMode: z.enum(['once', 'cooldown', 'daily', 'weekly']).default('once'),
    cooldownSeconds: z.number().int().min(0).max(31_536_000).default(0),

    requiresQuest: questIdSchema.nullable().default(null),

    /** Epoch em MILISSEGUNDOS, como o resto do agente. */
    availableFrom: z.number().int().nullable().default(null),
    availableTo: z.number().int().nullable().default(null),

    autoAccept: z.boolean().default(false),
    wipePolicy: z.enum(['reset', 'keep']).default('reset'),

    /** Lista vazia = vale em TODOS os servidores. Ver a 3.6 do plano. */
    servers: z.array(z.string().min(1).max(64)).max(64).default([]),

    objectives: z.array(questObjectiveSchema).min(1).max(8),
    rewards: z.array(questRewardSchema).max(8).default([]),
  })
  .superRefine((value, ctx) => {
    // O cooldown só é lido quando o modo é `cooldown`. Um valor
    // preenchido nos outros modos é uma expectativa que nunca vai
    // se cumprir — e ela ficaria gravada, visível no painel,
    // parecendo que funciona.
    if (value.repeatMode === 'cooldown' && value.cooldownSeconds <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['cooldownSeconds'],
        message: 'o modo "cooldown" precisa de um tempo maior que zero',
      });
    }

    if (
      value.availableFrom !== null &&
      value.availableTo !== null &&
      value.availableFrom >= value.availableTo
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['availableTo'],
        message: 'a janela do evento termina antes de começar',
      });
    }

    // Dois objetivos com o mesmo `seq` colidiriam no UNIQUE da
    // tabela — e a mensagem do SQLite não diz a quem lê o painel
    // qual dos dois estava repetido.
    const seen = new Set<number>();

    for (const objective of value.objectives) {
      if (seen.has(objective.seq)) {
        ctx.addIssue({
          code: 'custom',
          path: ['objectives'],
          message: `dois objetivos com a mesma ordem (${String(objective.seq)})`,
        });
      }

      seen.add(objective.seq);
    }

    // ####  A ENTREGA PRECISA DE ORIGEM  ####
    //
    // O destino é o `target` do objetivo; a origem é o `npcId` da
    // quest. Sem origem, a entrega não teria de onde sair — e a
    // quest apareceria no menu sem que ninguém pudesse concluí-la.
    if (value.objectives.some((item) => item.kind === 'deliver') && value.npcId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['npcId'],
        message: 'uma quest de entrega precisa de um NPC de origem',
      });
    }
  });

export type QuestInput = z.infer<typeof questInputSchema>;

/**
 * A quest como ela CHEGA, antes dos `.default()`.
 *
 * ####  POR QUE OS DOIS TIPOS EXISTEM  ####
 *
 * `QuestInput` é o que sai do `parse`: tudo preenchido, nada
 * opcional — e é o que o repositório grava. `QuestDraft` é o que
 * ENTRA, com os defaults ainda por aplicar, e é o que o formulário
 * do painel monta e o que um teste escreve à mão.
 *
 * Sem a distinção, tipar um corpo de entrada como `QuestInput`
 * obrigaria quem chama a repetir `metric: null, label: null,
 * consume: false` em todo objetivo — exatamente o trabalho que o
 * `.default()` existe para evitar.
 */
export type QuestDraft = z.input<typeof questInputSchema>;

// ------------------------------------------------------------
//  §6  O NPC
// ------------------------------------------------------------

/**
 * Os bonecos que um NPC de missão pode vestir.
 *
 * ####  A LISTA NÃO É DE GOSTO: ELA É MEDIDA  ####
 *
 * Cada linha foi spawnada no server01 em 11/09/2026 e teve o tipo
 * lido de volta. O que decide é uma pergunta só: o boneco é um
 * `NPCTalking`? Se for, o cliente desenha o prompt **TALK** em cima
 * dele sozinho, e o jogo manda o RPC que o plugin intercepta. Se
 * não for, o jogador chega perto e não vê nada — que foi
 * exatamente o que o teste de 11/09 relatou com o
 * `bandit_shopkeeper`, um `NPCShopKeeper` mudo.
 *
 * ####  OS MISSIONPROVIDER FICARAM DE FORA  ####
 *
 * `missionprovider_bandit_a` e irmãos também falam, mas são
 * `IMissionProvider`: o `ServerInit` deles spawna um
 * `MapMarkerMissionProvider` que fica no mapa de todo mundo — e
 * NÃO morre junto com o NPC. Medido: o mundo subiu de 16 para 21
 * marcadores na sondagem. Um NPC nosso não vai sujar o mapa com
 * missão da Facepunch.
 */
export const NPC_PREFABS = [
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/bandit_conversationalist.prefab',
    label: 'Aviador do Bandit',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/boat_shopkeeper.prefab',
    label: 'Barqueiro',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/stables_shopkeeper.prefab',
    label: 'Cavalariço',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/apartment/apartment_vendor.prefab',
    label: 'Porteiro',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/bandit_shopkeeper.prefab',
    label: 'Vendedor do Bandit (mudo)',
    talks: false,
  },
  {
    prefab: 'assets/prefabs/npc/waterwell/waterwell_shopkeeper.prefab',
    label: 'Poceiro (mudo)',
    talks: false,
  },
] as const;

/**
 * O prefab do boneco.
 *
 * O `bandit_conversationalist` é o primeiro `NPCTalking` da lista
 * que não arrasta nada atrás: os outros que falam são vendedores
 * de veículo (o `spawnerRef` deles nasce inválido e a classe não
 * faz nada com isso) ou o porteiro do apartamento.
 *
 * Ele é guardado em coluna, e não fixo no código, porque trocar a
 * aparência é pedido de admin — não release de agente.
 */
export const DEFAULT_NPC_PREFAB = NPC_PREFABS[0].prefab;


export const questNpcInputSchema = z.object({
  serverId: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  kind: z.enum(['quest', 'delivery']).default('quest'),

  /**
   * A posição no mundo. Os limites são generosos de propósito: o
   * maior mapa do Rust tem 6 km de lado, e um número fora disso é
   * dado sujo, não um mapa grande.
   */
  x: z.number().min(-10_000).max(10_000),
  y: z.number().min(-2000).max(5000),
  z: z.number().min(-10_000).max(10_000),
  rotation: z.number().min(0).max(360).default(0),

  prefab: z.string().min(1).max(200).default(DEFAULT_NPC_PREFAB),
  mapMarker: z.boolean().default(true),
  /**
   * O raio, em metros, dentro do qual apertar USE abre a tela.
   *
   * O teto é baixo de propósito: um raio grande faz dois NPCs
   * próximos disputarem o mesmo clique, e quem joga não tem como
   * saber com qual dos dois falou.
   */
  useRadius: z.number().min(0.5).max(20).default(3),

  enabled: z.boolean().default(true),
  wipePolicy: z.enum(['keep', 'remove']).default('keep'),
});

export type QuestNpcInput = z.infer<typeof questNpcInputSchema>;
/** O NPC como ele chega, antes dos `.default()`. Ver `QuestDraft`. */
export type QuestNpcDraft = z.input<typeof questNpcInputSchema>;

// ------------------------------------------------------------
//  §7  A CONFIGURAÇÃO POR SERVIDOR
// ------------------------------------------------------------

export const questSettingsSchema = z.object({
  /** 0 = sem teto. É o `PlayerMaxQuests` do Quests.cs. */
  maxActive: z.number().int().min(0).max(100).default(0),
  enabled: z.boolean().default(true),
  flushSeconds: z.number().int().min(15).max(3600).default(60),
  /**
   * A válvula do hook caro (§5.4 do plano). `false` desliga o
   * `loot` naquele servidor mesmo havendo quest de loot
   * cadastrada — é o que o `origemz.quest.diag` existe para
   * informar.
   */
  lootEnabled: z.boolean().default(true),
  /** A hora da virada da diária, em minutos desde a meia-noite. */
  resetAtMinute: z.number().int().min(0).max(1439).default(0),
});

export type QuestSettingsInput = z.infer<typeof questSettingsSchema>;

/**
 * O que vale num servidor sem linha em `quest_settings`.
 *
 * O padrão mora AQUI, e não numa linha semeada por servidor: um
 * servidor criado depois da migração 046 ficaria sem a linha, e o
 * código precisaria saber o padrão de qualquer jeito. Duas fontes
 * para a mesma resposta é o que o 02-ARQUITETURA proíbe. É a mesma
 * escolha de `DEFAULT_RANKING_SETTINGS`.
 */
export const DEFAULT_QUEST_SETTINGS: QuestSettings = {
  maxActive: 0,
  enabled: true,
  flushSeconds: 60,
  lootEnabled: true,
  resetAtMinute: 0,
  updatedAt: null,
};

export interface QuestSettings extends QuestSettingsInput {
  /** `null` = ninguém nunca configurou; os padrões acima é que valem. */
  readonly updatedAt: number | null;
}

// ------------------------------------------------------------
//  §8  O QUE FICA CONGELADO NO ACEITE
// ------------------------------------------------------------

/**
 * O que a quest EXIGIA e o que ela PROMETIA no instante do aceite.
 *
 * ####  POR QUE ELE É GRAVADO, E NÃO RELIDO DA QUEST  ####
 *
 * Porque o resgate acontece horas depois. Uma quest editada no
 * meio entregaria OUTRA COISA, e uma quest apagada não entregaria
 * nada. É literalmente a mesma razão do `DeliveryPlan` da loja
 * (store/service.ts) — e aqui é pior, porque a compra leva
 * segundos e uma diária aceita às 8h é resgatada às 23h.
 *
 * O `title` viaja junto porque a tela do histórico precisa dizer
 * o nome que a quest tinha quando foi feita, e não o de hoje.
 */
export interface QuestSnapshot {
  readonly title: string;
  readonly objectives: readonly QuestObjective[];
  readonly rewards: readonly QuestReward[];
  /**
   * Onde o contador do jogador ESTAVA quando ele aceitou, por
   * `seq`.
   *
   * ####  SÓ OS OBJETIVOS `metric` E `playtime` TÊM UM  ####
   *
   * Os outros cinco são contados pelo plugin, que zera junto com a
   * tentativa. Estes dois são lidos de `player_stats`, que é um
   * TOTAL acumulado e não sabe que a quest existe: sem a linha de
   * partida, quem já tinha 4.000 abates concluiria "mate 20"
   * instantaneamente.
   *
   * Ele mora no snapshot — e não numa coluna — porque é a mesma
   * coisa que o resto dele: o que ficou congelado no aceite. Uma
   * coluna nova custaria uma migração para guardar um dado que já
   * tem lugar.
   *
   * `playtime` é gravado em SEGUNDOS aqui, que é a unidade de
   * `time.played`; o objetivo é em minutos, e a divisão acontece
   * num lugar só, no serviço.
   */
  readonly baselines?: Readonly<Record<number, number>>;
}
