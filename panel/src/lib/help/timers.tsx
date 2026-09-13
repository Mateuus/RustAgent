// ============================================================
//  help/timers.tsx  -  o que cada timer da aba Player faz.
//
//  Mesmas quatro partes do help/dungeons.tsx: o que é, um exemplo
//  com número, o limite, e com o que conversa. O texto descreve o
//  que o OrigemZPlayer faz de verdade (seção OS TIMERS) — se o
//  plugin mudar, é aqui que a tela para de mentir.
// ============================================================

import { HelpExample, HelpWarn, type HelpTopic } from '@/components/ui/help-tip';

export const TIMERS_HELP = {
  nivel: {
    title: 'Qual grupo vale para cada jogador',
    short: 'Admin, depois o VIP, depois o normal. Campo em branco desce para o seguinte.',
    body: (
      <>
        <p>
          O plugin procura cada timer <strong>separadamente</strong>, nesta ordem: o grupo{' '}
          <strong>admin</strong> (só para quem tem auth level no Rust), o grupo do{' '}
          <strong>VIP</strong> do jogador, e o <strong>default</strong> — que é o nível normal, de
          todo mundo. O primeiro que define aquele timer ganha; se nenhum define, vale o tempo do
          Rust (×1).
        </p>
        <HelpExample>
          com <strong>default: craft ×2</strong> e <strong>gold: fornalha ×3</strong>, o jogador
          gold tem fornalha ×3 e craft ×2 — o craft ele herda do default. Deixar o craft do gold em
          branco é o que evita o VIP craftar mais devagar que todo mundo.
        </HelpExample>
        <HelpWarn>
          grupo que não é nível — um grupo de evento, por exemplo — aparece como{' '}
          <strong>sem nível</strong> e não vale no jogo: o plugin só pergunta por admin, pelos
          níveis de VIP e pelo normal.
        </HelpWarn>
      </>
    ),
  },

  smelt: {
    title: 'Fornalha',
    short: 'Fornalha, fornalha grande, elétrica e refinaria. Vale a melhor entre o dono e quem acendeu.',
    body: (
      <>
        <p>
          Acelera o que <strong>funde ou refina</strong>: fornalha, fornalha grande, fornalha
          elétrica e refinaria de óleo. O plugin roda o próprio forno do Rust mais vezes, então a{' '}
          <strong>lenha queima junto</strong>: o combustível por minério é o mesmo do jogo, só que
          em menos tempo.
        </p>
        <HelpExample>
          com ×3, o que levava 1 min fica pronto em 20 s — e a lenha que durava 1 min acaba em 20 s.
        </HelpExample>
        <p>
          Vale a <strong>melhor</strong> velocidade entre o <strong>dono</strong> da fornalha (quem a
          colocou) e <strong>quem a acendeu</strong>. Fornalha do VIP é rápida para o time inteiro,
          e o VIP que acende a de um amigo leva a dele. Fornalha acesa pega a velocidade nova em até
          30 segundos.
        </p>
        <HelpWarn>
          acima de ×9 o forno passa a andar em passos maiores, para não pesar no servidor, e o
          combustível por minério fica um pouco menor que o do jogo. Fogueira, churrasqueira e
          lanterna não entram — acelerar a lanterna seria só queimar o óleo mais rápido.
        </HelpWarn>
      </>
    ),
  },

  craft: {
    title: 'Craft',
    short: 'A fila de fabricação do jogador — na mão ou na bancada.',
    body: (
      <>
        <p>
          Divide o tempo de <strong>cada item</strong> da fila de fabricação do jogador. A barra de
          progresso no jogo já mostra o tempo novo: a duração é encurtada antes de chegar ao
          cliente.
        </p>
        <HelpExample>com ×2, um item de 30 s sai em 15 s.</HelpExample>
        <HelpWarn>
          soma com o desconto da bancada: craftar numa bancada de nível acima continua cortando o
          tempo como no Rust, e o timer corta por cima. Vale no próximo item da fila — o que já
          está sendo feito termina no tempo antigo.
        </HelpWarn>
      </>
    ),
  },

  research: {
    title: 'Pesquisa',
    short: 'A espera da mesa de pesquisa, pelo jogador que apertou "pesquisar".',
    body: (
      <>
        <p>
          Encurta a <strong>espera da mesa de pesquisa</strong>. Vale a velocidade de quem apertou o
          botão — o relógio que aparece no jogo já sai com o tempo novo.
        </p>
        <HelpExample>com ×2, a espera da mesa cai pela metade.</HelpExample>
        <HelpWarn>
          não mexe no custo em sucata, e não vale para o &quot;experimentar&quot; da bancada.
        </HelpWarn>
      </>
    ),
  },

  recycle: {
    title: 'Reciclador',
    short: 'O intervalo entre um ciclo e o seguinte, pelo jogador que ligou.',
    body: (
      <>
        <p>
          Encurta o <strong>intervalo entre os ciclos</strong> do reciclador. O que sai de cada
          ciclo — sucata e material — é o mesmo do jogo; só sai mais vezes por minuto.
        </p>
        <HelpExample>
          com ×2, o reciclador faz em 1 min o que faria em 2 — e cada ciclo rende o mesmo.
        </HelpExample>
        <HelpWarn>
          vale a velocidade de quem <strong>ligou</strong>, até o reciclador desligar. Quem liga o
          reciclador depois leva a velocidade dele.
        </HelpWarn>
      </>
    ),
  },
} as const satisfies Record<string, HelpTopic>;
