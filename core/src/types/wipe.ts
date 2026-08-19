// ============================================================
//  wipe.ts  -  O CONTRATO DO WIPE. Só os tipos, e nada mais.
//
//  Este arquivo é o "commit zero" da fase de wipe: nove frentes
//  compilam contra ele ao mesmo tempo, e por isso não há aqui uma
//  linha de implementação, de SQL ou de rota. Quem constrói cada
//  peça está no Docs/17-FRENTES-WIPE-E-MENSAGENS.md; o porquê de
//  cada campo está no Docs/16, §5 (os dois calendários), §7 (o
//  modelo de dados) e §9 (as telas).
//
//  ------------------------------------------------------------
//  ####  ESTES TIPOS NÃO MUDAM DEPOIS DE PUBLICADOS  ####
//
//  Não porque sejam perfeitos, mas porque são o único ponto em
//  que as frentes se encontram antes do merge. Um campo
//  renomeado aqui no meio da fase não quebra um arquivo: quebra
//  nove, em nove árvores diferentes, e o dono de cada uma
//  descobre isso no dia em que for mergear.
//
//  ------------------------------------------------------------
//  ####  TODA DATA É EPOCH MS, EM UTC  ####
//
//  Sem exceção, e é a decisão que impede o wipe de deslizar uma
//  hora sozinho em novembro. Horário local NUNCA é um instante
//  com fuso embutido: ele é um texto `HH:MM` MAIS a zona IANA
//  (`America/Sao_Paulo`), e os dois só viram instante na hora de
//  calcular. Ver Docs/16 §14, decisão 7.
// ============================================================

// ------------------------------------------------------------
//  §1  AS DUAS POLÍTICAS
// ------------------------------------------------------------

/**
 * O que acontece com o que o jogador APRENDEU quando o mundo
 * zera.
 *
 *   keep             ele recomeça sabendo tudo o que já sabia
 *   wipe             todo mundo recomeça sem saber nada
 *   wipe_except_vip  apaga de todos, e devolve a quem tem direito
 *
 * A política é DO WIPE, e não do servidor: o arranjo comum é
 * cadência com `keep` e forçado com `keep` também — o force wipe
 * da Facepunch apaga o mapa, e só leva blueprint quando eles
 * mexem no sistema de itens. Ver Docs/16 §5.
 */
export const BP_POLICIES = ['keep', 'wipe', 'wipe_except_vip'] as const;

/** Qual das três políticas de blueprint vale para um wipe. */
export type BpPolicy = (typeof BP_POLICIES)[number];

/**
 * O que fazer quando o wipe da casa e o da Facepunch caem quase
 * no mesmo dia.
 *
 *   reanchor  o forçado vira o novo marco zero da cadência
 *   absorb    o wipe de cadência perto do forçado é CANCELADO
 *   ignore    os dois acontecem, cada um no seu dia
 *
 * O absorvido continua aparecendo na agenda, marcado: uma lista
 * com um buraco não explica por que terça não vai ter wipe.
 */
export const COLLISION_POLICIES = ['reanchor', 'absorb', 'ignore'] as const;

/** Qual das três saídas o servidor escolheu para a colisão. */
export type CollisionPolicy = (typeof COLLISION_POLICIES)[number];

// ------------------------------------------------------------
//  §2  A CONFIGURAÇÃO DA AGENDA
// ------------------------------------------------------------

/** De quanto em quanto tempo ESTE servidor zera por vontade própria. */
export interface WipeCadenceSettings {
  /** Desligada, só o wipe forçado aparece na agenda. */
  readonly enabled: boolean;
  /** A cada quantos dias de CALENDÁRIO. 7 = semanal, 1 = diário. */
  readonly everyDays: number;
  /**
   * O marco zero da contagem, em epoch ms.
   *
   * Só o DIA dele importa: a hora vem de `timeOfDay`. Guardar o
   * instante inteiro mantém a coluna no mesmo formato de todas as
   * outras datas do banco.
   */
  readonly anchorAt: number;
  /** A hora local do wipe, `HH:MM`, lida no fuso abaixo. */
  readonly timeOfDay: string;
  /** A zona IANA em que aquele `HH:MM` é lido, `America/Sao_Paulo`. */
  readonly timeZone: string;
  /** O que os wipes desta cadência fazem com os blueprints. */
  readonly bpPolicy: BpPolicy;
}

/**
 * Tudo o que o dono do servidor decide sobre QUANDO zerar.
 *
 * ####  O QUE NÃO ESTÁ AQUI  ####
 *
 * Como o agente EXECUTA o wipe — os avisos, o backup, a lista de
 * dados de plugin do full wipe, o que fazer depois de subir — é
 * da Frente D, e mora nas mesmas chaves de `wipe_settings` (que é
 * chave/valor por servidor, e não um objeto único). Este tipo é o
 * recorte de que a AGENDA precisa, e é o que as Frentes A, B e G
 * leem.
 */
export interface WipeSettings {
  readonly cadence: WipeCadenceSettings;
  /**
   * O forçado não tem `enabled`: ele acontece com ou sem nós, e
   * por isso a única escolha nossa é o que ele leva.
   */
  readonly forced: {
    readonly bpPolicy: BpPolicy;
  };
  readonly collision: {
    readonly policy: CollisionPolicy;
    /** A janela do `absorb`, em horas. Ignorada nas outras duas. */
    readonly windowHours: number;
  };
}

// ------------------------------------------------------------
//  §3  O MUNDO QUE ENTRA NO LUGAR
// ------------------------------------------------------------

/**
 * De onde sai o mapa do próximo wipe.
 *
 *   pool    a primeira entrada pronta da fila de mapas
 *   random  o agente sorteia — é o que impede um wipe de ficar
 *           travado esperando curadoria
 *   fixed   uma entrada escolhida a dedo (`mapPoolId`)
 *   keep    o mesmo mapa de novo: mesma seed, mundo novo
 */
export const MAP_SOURCES = ['pool', 'random', 'fixed', 'keep'] as const;

/** Como este wipe decide qual mundo vem depois dele. */
export type MapSource = (typeof MAP_SOURCES)[number];

/**
 * Um mundo gerado pelo jogo, ou um arquivo `.map` de fora.
 *
 * `custom` é o que exige `levelUrl`, e é o que não entra num wipe
 * forçado sem alguém garantir na mão que aquele arquivo serve
 * para a versão nova do jogo.
 */
export const MAP_KINDS = ['procedural', 'custom'] as const;

/** Se o mundo é gerado por seed ou baixado de uma URL. */
export type MapKind = (typeof MAP_KINDS)[number];

/**
 * Os mundos que o Rust carrega sem arquivo externo.
 *
 * `Procedural Map` é o que quase todo servidor usa; os outros
 * três vêm dentro do jogo. `Craggy Island` sobe em segundos, e
 * por isso é o de desenvolvimento (ver Configs/server.example.ini).
 */
export const MAP_LEVELS = ['Procedural Map', 'Barren', 'HapisIsland', 'Craggy Island'] as const;

/** Um dos quatro mundos que o jogo já traz. */
export type MapLevel = (typeof MAP_LEVELS)[number];

/**
 * Em que pé está uma entrada da fila de mapas.
 *
 *   draft       existe, mas ainda não dá para usar
 *   generating  o RustMaps está desenhando a prévia
 *   ready       pode entrar no próximo wipe
 *   used        já foi jogada
 *   failed      a geração ou a validação da URL não deu certo
 *
 * `failed` não trava wipe nenhum: prévia é enfeite, e sem ela o
 * agente usa a seed do mesmo jeito.
 */
export const MAP_POOL_STATUSES = ['draft', 'generating', 'ready', 'used', 'failed'] as const;

/** O estado de uma entrada na fila de mapas. */
export type MapPoolStatus = (typeof MAP_POOL_STATUSES)[number];

/** Um mundo na fila de espera de um servidor: o que vem depois deste. */
export interface MapPoolEntry {
  readonly id: number;
  readonly serverId: string;
  /** A ordem na fila. Entra no próximo wipe o menor `position` pronto. */
  readonly position: number;
  readonly kind: MapKind;
  /**
   * A seed do mundo, como TEXTO.
   *
   * Ela é transportada, comparada e exibida — nunca somada. Como
   * texto ela atravessa o `.ini`, o RCON e a URL do RustMaps sem
   * ganhar um `.0` no caminho. `null` em mapa custom.
   */
  readonly seed: string | null;
  /** O `server.worldsize`, entre 1000 e 6000. `null` em mapa custom. */
  readonly worldSize: number | null;
  /** O `server.level`. Texto livre porque um mapa de fora traz o nome dele. */
  readonly level: string | null;
  /** O `.map` de fora, para `server.levelurl`. `null` em procedural. */
  readonly levelUrl: string | null;
  /** O id no RustMaps, quando a prévia foi pedida lá. */
  readonly rustmapsId: string | null;
  /**
   * A prévia foi pedida no branch STAGING do RustMaps.
   *
   * Staging é gerado contra a versão que ainda VAI entrar, e só
   * serve depois do wipe forçado — é o que faz um mapa pré-gerado
   * não virar um servidor que não sobe na madrugada.
   */
  readonly staging: boolean;
  /** A imagem grande do mapa. `null` = ainda não tem, e isso não impede o wipe. */
  readonly previewUrl: string | null;
  /** A miniatura, para a lista da fila. */
  readonly thumbUrl: string | null;
  /** Os monumentos que o RustMaps achou, pelo nome. `null` = não sabemos. */
  readonly monuments: readonly string[] | null;
  /**
   * "Compatível com a versão nova", marcado na mão pelo admin.
   *
   * Só significa alguma coisa em `custom`: é ela que libera o
   * arquivo `.map` para um wipe FORÇADO. Está no CONTRATO, e não
   * só no registro do banco, porque QUAL mundo entra no próximo
   * wipe depende dela — ver `usableForWipe`, em wipe/map-pool.ts.
   */
  readonly versionOk: boolean;
  readonly status: MapPoolStatus;
  /** Por que a geração ou a validação falhou, na língua de quem lê a tela. */
  readonly lastError: string | null;
  /** Epoch ms de quando este mundo entrou num wipe. `null` = ainda na fila. */
  readonly usedAt: number | null;
  readonly createdAt: number;
}

// ------------------------------------------------------------
//  §4  A AGENDA
// ------------------------------------------------------------

/**
 * Um wipe que a REGRA prevê — o resultado do cálculo puro, antes
 * de virar linha no banco.
 *
 * Não tem `id` de propósito: ele ainda não existe para ninguém
 * editar. É o que a reconciliação compara com o que já está
 * gravado para decidir o que criar e o que reescrever.
 */
export interface PlannedWipe {
  /** Epoch ms. */
  readonly scheduledAt: number;
  readonly kind: 'forced' | 'cadence';
  readonly bpPolicy: BpPolicy;
  /**
   * O INSTANTE do forçado que cancelou este wipe de cadência
   * (política `absorb`), ou `null` se ele acontece.
   *
   * Aqui é o instante, e não um id, porque nesta camada ainda não
   * existe id nenhum — no `WipePlan` gravado o campo de mesmo
   * nome aponta para a linha.
   */
  readonly absorbedBy: number | null;
}

/**
 * De onde veio um wipe da agenda.
 *
 *   cadence  da cadência do servidor
 *   forced   da Facepunch, primeira quinta do mês às 19:00 UTC
 *   manual   alguém marcou na mão
 */
export const WIPE_PLAN_KINDS = ['cadence', 'forced', 'manual'] as const;

/** Quem pediu este wipe: a cadência, a Facepunch ou uma pessoa. */
export type WipePlanKind = (typeof WIPE_PLAN_KINDS)[number];

/**
 * O que já aconteceu com um wipe da agenda.
 *
 *   planned   está marcado e vai acontecer
 *   running   está acontecendo agora
 *   done      aconteceu
 *   skipped   uma pessoa pulou (o forçado NUNCA aceita isto)
 *   failed    tentou e não terminou
 *   absorbed  caiu perto demais de um forçado e foi cancelado
 */
export const WIPE_PLAN_STATUSES = [
  'planned',
  'running',
  'done',
  'skipped',
  'failed',
  'absorbed',
] as const;

/** Em que pé está um wipe marcado. */
export type WipePlanStatus = (typeof WIPE_PLAN_STATUSES)[number];

/**
 * Um wipe MARCADO: a linha da agenda que o admin vê, adia e
 * edita.
 *
 * A agenda é materializada, e não calculada na hora, porque um
 * wipe agendado é algo que se edita — e não dá para editar o
 * resultado de uma função.
 */
export interface WipePlan {
  readonly id: number;
  readonly serverId: string;
  /** Quando ele acontece, em epoch ms UTC. */
  readonly scheduledAt: number;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  readonly mapSource: MapSource;
  /** A entrada da fila escolhida a dedo. `null` = decidir na hora do wipe. */
  readonly mapPoolId: number | null;
  readonly status: WipePlanStatus;
  /** O id do wipe forçado que absorveu este. `null` = ele acontece. */
  readonly absorbedBy: number | null;
  /**
   * O instante que a REGRA teria gerado para esta linha, em epoch
   * ms. `null` = ninguém gerou, foi marcado na mão.
   *
   * ####  É ELE QUE FAZ *ADIAR* SER ADIAR  ####
   *
   * Sem este campo, mover um wipe de quinta para sexta deixaria a
   * quinta vaga, a reconciliação a recriaria, e o servidor teria
   * DOIS wipes naquela semana.
   */
  readonly generatedFor: number | null;
  /** Um humano mexeu nesta linha, e a reconciliação não deve tocá-la. */
  readonly pinned: boolean;
  /** O recado de quem marcou, para quem for ler a agenda depois. */
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  §5  A EXECUÇÃO
// ------------------------------------------------------------

/**
 * Os oito passos de um wipe, na ordem em que acontecem.
 *
 *   avisar      as falas de T-24h até T-1min, pelo Broadcaster
 *   esvaziar    anuncia e espera a saída, com teto em minutos
 *   parar       `quit` pelo RCON, que salva antes de sair
 *   backup      zipa a pasta do save e poda os antigos
 *   apagar      os arquivos da política (mapa / BP / full)
 *   configurar  a seed e o tamanho do mundo novo, pelo supervisor
 *   subir       o servidor de volta ao ar
 *   pos-wipe    ressincroniza, anuncia o mundo novo, registra
 *
 * Sem acento no valor de propósito: ele viaja em chave primária,
 * em JSON de rota e em nome de passo no log.
 */
export const WIPE_RUN_STEPS = [
  'avisar',
  'esvaziar',
  'parar',
  'backup',
  'apagar',
  'configurar',
  'subir',
  'pos-wipe',
] as const;

/** Qual dos oito passos de um wipe. */
export type WipeRunStep = (typeof WIPE_RUN_STEPS)[number];

/**
 * O que aconteceu com UM passo.
 *
 * `skipped` não é falha: apagar num diretório já limpo, ou pular
 * o backup que o operador desligou, é desfecho normal — e é o que
 * torna retomar do meio seguro.
 */
export const WIPE_STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;

/** Em que pé está um passo do wipe. */
export type WipeStepStatus = (typeof WIPE_STEP_STATUSES)[number];

/**
 * O que aconteceu com a execução INTEIRA.
 *
 * `cancelled` com dois eles, como no `OperationStatus` de
 * ops/operations.ts — um wipe é uma operação, e duas grafias para
 * o mesmo desfecho é o tipo de coisa que só aparece num `switch`
 * esquecido meses depois.
 */
export const WIPE_RUN_STATUSES = ['running', 'done', 'failed', 'cancelled'] as const;

/** Em que pé está a execução de um wipe. */
export type WipeRunStatus = (typeof WIPE_RUN_STATUSES)[number];
