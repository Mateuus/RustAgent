// ============================================================
//  help/battlepass.tsx  -  o que o admin precisa saber antes de
//  ligar uma fonte de XP ou de publicar um mês.
//
//  As mesmas quatro partes do help/workshop.tsx: o que é, um
//  exemplo com número, o limite, e com o que conversa.
//
//  ####  POR QUE O TEXTO MORA AQUI  ####
//
//  Os mesmos conceitos aparecem em três abas — o teto diário é da
//  aba XP e volta na estimativa da Trilha; o retroativo é da
//  Configuração e explica a coluna "pago" dos Jogadores. Se cada
//  aba explicasse com palavras próprias, duas delas ensinariam
//  coisas diferentes sobre a mesma regra.
//
//  ####  A PEGADINHA DA FONTE NÃO É UM VERBETE FIXO  ####
//
//  O cardápio de fontes é do AGENTE (05 §3), e o aviso de cada uma
//  vem junto. `caveatTopic` embrulha esse texto no mesmo (?) das
//  outras telas — assim uma fonte nova que a frente B acrescente
//  amanhã já chega avisando, sem precisar de um verbete escrito
//  aqui.
// ============================================================

import { HelpExample, HelpWarn, type HelpTopic } from '@/components/ui/help-tip';

export const BATTLEPASS_HELP: {
  readonly catalog: HelpTopic;
  readonly dailyCap: HelpTopic;
  readonly xpCurve: HelpTopic;
  readonly retroactive: HelpTopic;
  readonly milestone: HelpTopic;
  readonly estimate: HelpTopic;
} = {
  /** O (?) do cabeçalho da aba XP. */
  catalog: {
    title: 'O cardápio de fontes',
    short: 'A lista do que o agente sabe medir. O painel não inventa fonte.',
    body: (
      <>
        <p>
          Cada linha desta aba é uma <strong>fonte</strong> que o agente mede de verdade. A lista
          vem dele, e não de uma constante escrita no painel — senão daria para configurar XP por
          “saquear caixa”, <strong>nada aconteceria</strong>, e nada avisaria.
        </p>
        <HelpExample>
          uma temporada com <strong>missão concluída = 800 XP</strong> e{' '}
          <strong>matar jogador = 50 XP, teto de 500 por dia</strong> paga no máximo 500 XP de PvP
          num dia, por mais que o jogador mate.
        </HelpExample>
        <p>
          Desligar uma fonte <strong>não apaga</strong> o XP que ela já pagou. A trilha é histórico,
          não saldo: quem subiu de nível ontem continua no nível.
        </p>
        <HelpWarn>
          com o agente desta versão sem a rota do cardápio, esta aba mostra só as fontes que já
          foram gravadas e não oferece nenhuma nova. É a recusa aparecendo na tela, e não um menu
          vazio fingindo que não há o que ligar.
        </HelpWarn>
      </>
    ),
  },

  /** O (?) da coluna "teto diário". */
  dailyCap: {
    title: 'Teto diário',
    short: 'O máximo que ESSA fonte rende por dia. Vazio = sem teto.',
    body: (
      <>
        <p>
          O teto é <strong>por fonte</strong>, e não um teto único somando tudo. É o que permite
          deixar a missão generosa e o farm contido sem escolher entre as duas coisas.
        </p>
        <HelpExample>
          farm com teto de <strong>100 XP por dia</strong> e caça com teto de{' '}
          <strong>100 XP por dia</strong> são 200 XP por dia no total — e a missão, sem teto,
          continua pagando por cima disso.
        </HelpExample>
        <p>
          O XP que passa do teto <strong>não é guardado para amanhã</strong>: ele simplesmente não
          acontece. Guardar transformaria o teto numa fila, que é exatamente o que ele existe para
          evitar.
        </p>
        <HelpWarn>
          o “dia” é o do agente — a mesma virada das missões diárias, contada em dias de calendário
          e não de 24 em 24 horas. Num servidor com jogadores de outro fuso, a virada é a do
          servidor.
        </HelpWarn>
      </>
    ),
  },

  /** O (?) da curva, na aba Configuração. */
  xpCurve: {
    title: 'A curva de XP',
    short: 'Quanto custa cada degrau. O nível 1 é de graça: quem entra já está nele.',
    body: (
      <>
        <p>
          <strong>Tudo igual</strong>: todo degrau custa o mesmo. <strong>Crescente</strong>: o
          primeiro custa o valor de base, e cada seguinte soma o passo.{' '}
          <strong>Desenhada à mão</strong>: um número por degrau.
        </p>
        <HelpExample>
          crescente com base <strong>500</strong> e passo <strong>100</strong>: o nível 2 custa 500,
          o 3 custa 600, o 4 custa 700. Uma trilha de 30 níveis assim custa{' '}
          <strong>58.000 XP</strong> do começo ao fim.
        </HelpExample>
        <HelpWarn>
          a curva desenhada à mão precisa de <strong>um valor por degrau</strong> — um a menos que o
          número de níveis. Sobrando ou faltando, o agente recusa a gravação e diz quantos esperava.
        </HelpWarn>
      </>
    ),
  },

  /** O (?) da chave do retroativo. */
  retroactive: {
    title: 'A compra olha para trás',
    short: 'Ligado, quem compra no nível 17 leva os 17 de uma vez.',
    body: (
      <>
        <p>
          Comprado o passe, <strong>toda recompensa paga de todo nível já alcançado</strong> fica
          disponível na hora. É o principal motivo de alguém comprar um passe no meio do mês.
        </p>
        <HelpExample>
          com o retroativo <strong>desligado</strong>, quem comprar no nível 17 só começa a receber
          a faixa paga do <strong>18</strong> em diante — os 17 níveis que ele já subiu ficam
          trancados para sempre.
        </HelpExample>
        <HelpWarn>
          desligar é uma escolha legítima de quem opera o servidor, e uma venda pior. A frustração é
          previsível: o jogador vê 17 cadeados que nunca vão abrir.
        </HelpWarn>
      </>
    ),
  },

  /** O (?) do selo de marco, no editor da casa. */
  milestone: {
    title: 'Marco',
    short: 'Marca de TELA: o card fica maior no menu do jogo. Não muda regra nenhuma.',
    body: (
      <>
        <p>
          Um marco se resgata como qualquer outro nível, exige o mesmo XP e não trava nada. A única
          diferença é o <strong>destaque de tamanho</strong> no card do jogo e o selo aqui no
          painel.
        </p>
        <HelpExample>
          marcar os níveis <strong>10, 20 e 30</strong> de uma trilha de 30 dá três paradas
          visíveis, que é o que faz o jogador enxergar para onde está indo.
        </HelpExample>
        <HelpWarn>
          marcar tudo é o mesmo que não marcar nada: se todo card é grande, nenhum se destaca.
        </HelpWarn>
      </>
    ),
  },

  /** O (?) da linha de estimativa, no topo da aba Trilha. */
  estimate: {
    title: 'Quanto tempo leva a trilha',
    short: 'A conta dos tetos diários contra o XP total. É o erro nº 1 dos passes.',
    body: (
      <>
        <p>
          A conta soma os <strong>tetos diários</strong> das fontes ligadas — o ritmo de quem esgota
          o dia — e divide o XP total da trilha por ele. Fonte <strong>sem teto</strong> é torneira
          aberta: ela só encurta o prazo, e por isso aparece contada à parte em vez de entrar na
          divisão.
        </p>
        <HelpExample>
          trilha de <strong>30.000 XP</strong> com tetos somando <strong>1.000 XP/dia</strong> leva{' '}
          <strong>30 dias</strong> — ou seja, termina no último dia do mês. O alvo é terminar cerca
          de <strong>uma semana antes</strong>.
        </HelpExample>
        <HelpWarn>
          a temporada que <strong>não dá para terminar</strong> é a falha mais comum dos passes nos
          sete jogos que a pesquisa mediu. Quem chega no dia 28 faltando oito níveis não compra o
          próximo.
        </HelpWarn>
      </>
    ),
  },
};

/**
 * O (?) de uma fonte com pegadinha.
 *
 * O texto vem do agente (o `warning` do cardápio) ou da lista que o
 * painel já conhece — ver `caveatOf` no normalize.ts. Ele é montado
 * aqui para ter a mesma forma dos outros verbetes: a frase curta na
 * bolha, o texto inteiro no modal.
 */
export function caveatTopic(label: string, warning: string): HelpTopic {
  return {
    title: `Cuidado com "${label}"`,
    short: warning,
    body: (
      <>
        <p>{warning}</p>
        <HelpWarn>
          a fonte continua valendo enquanto estiver ligada. Desligá-la depois <strong>não</strong>{' '}
          tira o XP que ela já pagou — quem subiu de nível continua no nível.
        </HelpWarn>
      </>
    ),
  };
}
