// ============================================================
//  messages.ts  -  O CONTRATO DAS MENSAGENS AGENDADAS.
//
//  O que o servidor fala sozinho: avisos, convites e lembretes.
//  Aqui só os tipos — o motor de 30 segundos, o repositório, as
//  rotas e a tela são da Frente E (Docs/17), e o desenho está no
//  Docs/16 §9.2 (a tela) e §10 (as regras do motor).
//
//  ------------------------------------------------------------
//  ####  A MENSAGEM É DE REDE, COMO VIP, KIT E LOJA  ####
//
//  Escreve-se uma vez e escolhe-se em quais servidores ela sai.
//  Por isso não há `serverId` na mensagem: há uma LISTA de alvos,
//  e lista vazia quer dizer TODOS. Cinco cópias do mesmo aviso é
//  como a sexta correção entra em quatro delas.
//
//  ------------------------------------------------------------
//  ####  O RITMO É DE CADA MENSAGEM, E NÃO DO SERVIDOR  ####
//
//  O agente antigo tinha UM intervalo e um rodízio de frases.
//  Aqui cada mensagem sabe quando é a próxima dela — é o que
//  permite o convite do Discord de meia em meia hora conviver com
//  o aviso de manutenção de uma vez só, na terça de madrugada.
//
//  ------------------------------------------------------------
//  ####  HORÁRIO É `HH:MM` MAIS A ZONA IANA  ####
//
//  Nunca um instante com fuso embutido, exatamente como no wipe
//  (types/wipe.ts). "A cada 7 dias" conta dias de CALENDÁRIO, e a
//  diferença aparece na semana em que o fuso muda de offset.
//  Instante mesmo — `runAt`, `lastSentAt`, `nextAt` — é sempre
//  epoch ms UTC.
// ============================================================

// ------------------------------------------------------------
//  §1  QUANDO A MENSAGEM SAI
// ------------------------------------------------------------

/**
 * Os quatro ritmos que uma mensagem pode ter.
 *
 *   interval  de N em N segundos (`everySeconds`)
 *   daily     todo dia no mesmo horário (`timeOfDay`)
 *   weekly    nos dias da semana escolhidos (`weekdays` + `timeOfDay`)
 *   once      uma vez só, num instante marcado (`runAt`)
 *
 * Depois de sair, a `once` se desliga sozinha: uma mensagem de
 * "manutenção às 03:00" que continua ligada é a que reaparece no
 * mês seguinte, sozinha, sem manutenção nenhuma.
 */
export const SCHEDULE_KINDS = ['interval', 'daily', 'weekly', 'once'] as const;

/** Qual dos quatro ritmos esta mensagem segue. */
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

// ------------------------------------------------------------
//  §1.5  O QUE FAZ A MENSAGEM SAIR
//
//  ####  O GATILHO É EXCLUSIVO  ####
//
//  Uma mensagem tem UM motivo para sair, e só um:
//
//      schedule  o relógio dela (`scheduleKind`)
//      rotation  a vez dela no rodízio de um grupo
//      command   um jogador digitou o comando dela
//
//  Não é limitação: é a única forma de a tela responder "por que
//  isso apareceu?" com uma frase. Uma mensagem que fosse agendada
//  E de rodízio teria dois horários concorrendo, e o admin
//  desligaria um deles sem saber qual.
//
//  Quem quer a mesma frase nos dois lugares escreve duas: são dois
//  comportamentos diferentes com o mesmo texto, e não um só.
// ------------------------------------------------------------

/** Os três motivos de uma mensagem sair. Ver o bloco acima. */
export const MESSAGE_TRIGGERS = ['schedule', 'rotation', 'command'] as const;

/** Qual dos três faz esta mensagem sair. */
export type MessageTrigger = (typeof MESSAGE_TRIGGERS)[number];

// ------------------------------------------------------------
//  §2  A MENSAGEM
// ------------------------------------------------------------

/**
 * Uma mensagem como a tela a mostra: o que o admin escreveu mais
 * o que o agente já fez com ela.
 */
export interface MessageView {
  readonly id: number;
  /** O nome na lista. É de quem administra; o jogador nunca o vê. */
  readonly name: string;
  /**
   * O que sai no chat, com as variáveis ainda por resolver —
   * `{servidor}`, `{online}`, `{wipe.faltam}`.
   *
   * Variável desconhecida fica LITERAL no chat, e não vira vazio:
   * `{wipe.faltan}` é feio e se conserta em dez segundos; uma
   * frase que perde metade em silêncio ninguém descobre.
   */
  readonly text: string;
  /** Desligada, ela fica na lista e não sai. */
  readonly enabled: boolean;
  /** A ordem na tela, de 10 em 10 para caber alguém no meio. */
  readonly position: number;
  /**
   * O que faz esta mensagem sair. Ver §1.5.
   *
   * Fora do `schedule`, o `scheduleKind` e os campos de ritmo
   * continuam gravados e NÃO valem: quem manda no rodízio é o
   * grupo, e no comando é o jogador. Eles ficam para a mensagem
   * poder voltar a ser agendada sem o admin redigitar o ritmo.
   */
  readonly trigger: MessageTrigger;
  /**
   * O grupo de rodízio a que ela pertence. `null` fora do
   * `rotation`.
   */
  readonly groupId: number | null;
  /**
   * O comando que a dispara, SEM a barra e em minúsculas: `pop`.
   *
   * `null` fora do `command`. A barra não é guardada porque ela é
   * do jogo, e não do comando: o Oxide aceita `/pop` e `\pop`, e
   * gravar uma delas faria a outra parecer desconhecida.
   */
  readonly command: string | null;
  /**
   * Quantos segundos um jogador espera para repetir o comando.
   * `0` = sem espera.
   */
  readonly cooldownSeconds: number;
  readonly scheduleKind: ScheduleKind;
  /** De quantos em quantos segundos, no ritmo `interval`. `null` nos outros. */
  readonly everySeconds: number | null;
  /** A hora local `HH:MM` do `daily` e do `weekly`. `null` nos outros. */
  readonly timeOfDay: string | null;
  /**
   * Os dias do `weekly`, com 0 = domingo. Vazio fora dele.
   *
   * Lista de números, e não a string `'1,4'` do banco: a
   * serialização é problema do repositório, e não de quem lê.
   */
  readonly weekdays: readonly number[];
  /** O instante do `once`, em epoch ms UTC. `null` nos outros. */
  readonly runAt: number | null;
  /** A zona IANA em que os horários acima são lidos. */
  readonly timeZone: string;
  /**
   * Só sai depois desta hora local `HH:MM`. `null` = a qualquer
   * hora.
   *
   * A janela PODE virar a meia-noite (`22:00`–`02:00`): é pedido
   * normal, e com a comparação ingênua a mensagem nunca sairia —
   * o admin teria escrito o horário certo e nada aconteceria.
   */
  readonly windowFrom: string | null;
  /** Só sai até esta hora local `HH:MM`. `null` = a qualquer hora. */
  readonly windowTo: string | null;
  /** Não fala para servidor vazio: o horário fica de pé até alguém entrar. */
  readonly onlyWithPlayers: boolean;
  /** Quantos jogadores online bastam, quando `onlyWithPlayers`. */
  readonly minPlayers: number;
  /** O `[AVISO]` na frente da frase. `null` = sem tag. */
  readonly tag: string | null;
  /** A cor da tag, em hexadecimal. `null` = o padrão do plugin de chat. */
  readonly tagColor: string | null;
  /** A cor do texto, em hexadecimal. `null` = o padrão do plugin de chat. */
  readonly color: string | null;
  /** O tamanho da fonte no chat. `null` = o padrão do plugin de chat. */
  readonly size: number | null;
  /**
   * Quando ela saiu de verdade pela última vez, em epoch ms.
   *
   * Gravado DEPOIS da entrega, nunca antes: uma mensagem que o
   * RCON recusou não pode aparecer na tela como enviada.
   */
  readonly lastSentAt: number | null;
  /** Quando ela sai de novo, em epoch ms. `null` = não há próxima. */
  readonly nextAt: number | null;
  /** Quantas vezes ela já saiu. É a resposta de "isso está funcionando?". */
  readonly sentCount: number;
  /**
   * Em quais servidores ela sai. VAZIO = em TODOS.
   *
   * Vazio quer dizer todos porque é o que o admin espera de uma
   * mensagem de rede recém-criada — e porque a alternativa seria
   * marcar servidor por servidor toda vez que um entra na frota.
   */
  readonly targets: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * O que a tela manda ao criar ou editar uma mensagem.
 *
 * Os campos de ritmo vêm todos, com `null` no que não se aplica
 * àquele `scheduleKind` — assim trocar de `interval` para `weekly`
 * é uma gravação só, e não um estado meio antigo meio novo.
 */
export interface MessageInput {
  readonly name: string;
  readonly text: string;
  readonly enabled: boolean;
  /** Ver §1.5: `schedule`, `rotation` ou `command`. */
  readonly trigger: MessageTrigger;
  /** O grupo do rodízio. `null` fora do `rotation`. */
  readonly groupId: number | null;
  /** O comando, sem barra. `null` fora do `command`. */
  readonly command: string | null;
  readonly cooldownSeconds: number;
  readonly scheduleKind: ScheduleKind;
  readonly everySeconds: number | null;
  readonly timeOfDay: string | null;
  readonly weekdays: readonly number[];
  readonly runAt: number | null;
  readonly timeZone: string;
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
  readonly onlyWithPlayers: boolean;
  readonly minPlayers: number;
  readonly tag: string | null;
  readonly tagColor: string | null;
  readonly color: string | null;
  readonly size: number | null;
  /** Os servidores em que ela sai. Lista vazia = todos. */
  readonly targets: readonly string[];
}

// ------------------------------------------------------------
//  §2.5  O GRUPO DE RODÍZIO
//
//  ####  UM INTERVALO, VÁRIAS FRASES, UMA POR VEZ  ####
//
//  É o ritmo que o agente antigo tinha e este não: "de 5 em 5
//  minutos, uma frase diferente". A diferença é que aqui ele é
//  UM grupo entre vários, e não o ritmo do servidor inteiro — o
//  rodízio de dicas de 5 em 5 minutos convive com o convite do
//  Discord de meia em meia hora.
//
//  ####  O RITMO É DO GRUPO, E O TEXTO É DA MENSAGEM  ####
//
//  Quem decide QUANDO sair, EM QUAIS servidores e COM QUANTA
//  gente online é o grupo. Quem decide O QUE sai — texto, tag,
//  cor, tamanho — é a mensagem da vez. Duas verdades sobre o
//  mesmo assunto (o grupo manda "só com 5 online" e a mensagem
//  manda "com 1") é o defeito que faz o admin desligar as duas
//  para descobrir qual valeu.
//
//  ####  A ORDEM ALEATÓRIA É UM BARALHO, E NÃO UM DADO  ####
//
//  Sortear a cada volta repetiria a mesma frase duas vezes
//  seguidas com frequência constrangedora (1 em 5, num grupo de
//  cinco) e deixaria uma delas sem sair por meia hora. O baralho
//  embaralha UMA vez, distribui todas, e só então embaralha de
//  novo — e o embaralhamento novo nunca começa pela carta que
//  acabou de sair.
// ------------------------------------------------------------

/**
 * Em que ordem o rodízio distribui as mensagens.
 *
 *   fixed   na ordem da lista, reiniciando o ciclo no fim
 *   random  embaralhado, todas antes de repetir
 */
export const ROTATION_ORDERS = ['fixed', 'random'] as const;

/** Qual das duas ordens este grupo segue. */
export type RotationOrder = (typeof ROTATION_ORDERS)[number];

/** Um grupo de rodízio como a tela o mostra. */
export interface MessageGroupView {
  readonly id: number;
  /** O nome na lista. É de quem administra; o jogador nunca o vê. */
  readonly name: string;
  /** Desligado, ele fica na lista e nenhuma mensagem dele sai. */
  readonly enabled: boolean;
  /** A ordem na tela, de 10 em 10. */
  readonly position: number;
  /** De quantos em quantos segundos UMA mensagem do grupo sai. */
  readonly everySeconds: number;
  readonly order: RotationOrder;
  /** A zona IANA em que a janela de horário é lida. */
  readonly timeZone: string;
  /** Só sai depois desta hora local `HH:MM`. `null` = a qualquer hora. */
  readonly windowFrom: string | null;
  /** Só sai até esta hora local `HH:MM`. `null` = a qualquer hora. */
  readonly windowTo: string | null;
  /** Não fala para servidor vazio: o horário fica de pé. */
  readonly onlyWithPlayers: boolean;
  /** Quantos jogadores online bastam, quando `onlyWithPlayers`. */
  readonly minPlayers: number;
  /**
   * A última que saiu. É o que faz a ordem fixa saber de onde
   * continuar, e a aleatória não repetir duas vezes seguidas.
   */
  readonly lastMessageId: number | null;
  /**
   * As mensagens que ainda não saíram no ciclo aleatório.
   *
   * Vazio = o ciclo acabou, e o próximo envio embaralha tudo de
   * novo. Ele é ESTADO, e não configuração: sobreviver a um
   * reinício do agente é o que impede o ciclo de recomeçar toda
   * vez que alguém edita um plugin.
   */
  readonly deck: readonly number[];
  readonly lastSentAt: number | null;
  /** Quando o grupo fala de novo, em epoch ms. `null` = não há. */
  readonly nextAt: number | null;
  /** Quantas mensagens o grupo já mandou, somando todas. */
  readonly sentCount: number;
  /** Em quais servidores ele sai. VAZIO = em TODOS. */
  readonly targets: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** O que a tela manda ao criar ou editar um grupo. */
export interface MessageGroupInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly everySeconds: number;
  readonly order: RotationOrder;
  readonly timeZone: string;
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
  readonly onlyWithPlayers: boolean;
  readonly minPlayers: number;
  /** Os servidores em que ele sai. Lista vazia = todos. */
  readonly targets: readonly string[];
}

/** Um servidor em que uma mensagem sai — uma linha de `message_targets`. */
export interface MessageTarget {
  readonly messageId: number;
  readonly serverId: string;
}

// ------------------------------------------------------------
//  §3  O TRANSPORTE
//
//  A interface `Broadcaster` que consome estes dois tipos está em
//  game/broadcast.ts, junto do resto do que fala com o jogo. Os
//  tipos moram aqui porque quem os preenche é o módulo de
//  mensagens — e porque a Frente D e a Frente F também mandam
//  fala sem serem "mensagens".
// ------------------------------------------------------------

/** Uma fala do servidor, pronta para sair no chat do jogo. */
export interface BroadcastInput {
  /** Em qual servidor ela sai. Uma fala é sempre de um servidor só. */
  readonly serverId: string;
  /** O texto JÁ com as variáveis resolvidas. */
  readonly text: string;
  /** O `[AVISO]` na frente. Ausente = sem tag. */
  readonly tag?: string | undefined;
  /** A cor da tag, em hexadecimal. */
  readonly tagColor?: string | undefined;
  /** A cor do texto, em hexadecimal. */
  readonly color?: string | undefined;
  /** O tamanho da fonte no chat. */
  readonly size?: number | undefined;
  /** Só para este jogador. Ausente = para todo mundo que está online. */
  readonly steamId?: string | undefined;
}

/**
 * Por onde a fala saiu.
 *
 *   plugin  pelo `OrigemZChat`, com tag, cor e tamanho
 *   say     pelo `say` do próprio jogo, sem cor nenhuma
 *
 * O fallback existe porque nem todo servidor terá o plugin
 * carregado, e uma mensagem sem cor é melhor que silêncio.
 */
export const BROADCAST_VIAS = ['plugin', 'say'] as const;

/** Qual dos dois caminhos levou a fala até o chat. */
export type BroadcastVia = (typeof BROADCAST_VIAS)[number];

/** O que aconteceu com uma fala: para quantos foi, e por onde. */
export interface BroadcastResult {
  /**
   * Para quantos jogadores ela foi.
   *
   * Pelo `say` é sempre `0`, e ali `0` quer dizer DESCONHECIDO: o
   * jogo não devolve esse número. Inventar um palpite faria o log
   * afirmar uma coisa que ninguém mediu — quem lê usa o `via`
   * para saber se o número vale.
   */
  readonly sent: number;
  readonly via: BroadcastVia;
}
