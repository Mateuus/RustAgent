// ============================================================
//  help/dungeons.tsx  -  o que cada número faz.
//
//  ####  CADA VERBETE TEM QUATRO PARTES, E NENHUMA É ENFEITE  ####
//
//    o que é             em uma frase, sem jargão
//    um exemplo          com número, aplicado
//    o limite            o que acontece se exagerar
//    com o que conversa  o campo que anda junto
//
//  A terceira é a que falta em toda documentação de plugin de
//  Rust, e é a que o admin precisa às duas da manhã. Um verbete sem
//  ela é o rótulo do campo escrito por extenso.
//
//  ####  E ELES MORAM TODOS AQUI  ####
//
//  Não espalhados pelos componentes. Três razões, e a terceira é a
//  que decide: o mesmo conceito aparece em telas diferentes e tem
//  de dizer a mesma coisa; dá para revisar a redação inteira sem
//  abrir seis arquivos; e é isto que torna possível montar uma
//  página de ajuda sozinha, a partir do registro.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §12.3 e §12.4.
// ============================================================

import { HelpExample, HelpWarn, type HelpTopic } from '@/components/ui/help-tip';

export const DUNGEON_HELP = {
  // ----------------------------------------------------------
  //  O MODELO — o que ninguém adivinha
  // ----------------------------------------------------------

  modelo: {
    title: 'Como uma masmorra funciona',
    short: 'A masmorra fica 90 metros abaixo do mundo, e o alçapão teleporta.',
    body: (
      <>
        <p>
          O que nasce no mapa é só uma <strong>casinha com um alçapão</strong>. A masmorra em si
          fica a 90 metros abaixo do mundo, onde não há terreno, monumento, metrô nem base de
          jogador.
        </p>
        <pre className="overflow-x-auto border border-border bg-background px-3 py-2 text-2xs leading-relaxed text-muted">
          {`     superfície                y ≈ 3
  ┌────────────────┐
  │    ENTRADA     │  a casinha, com o alçapão
  └────────┬───────┘
           │  o alçapão NÃO desce: ele TELEPORTA
           ▼
  ┌────────────────┐
  │   A MASMORRA   │  y = -90, invisível do mapa`}
        </pre>
        <p>
          Três coisas decorrem disso: o mapa não muda para quem sobrevoa, a masmorra pode ter trinta
          salas sem esbarrar em nada, e <strong>fechar o evento é matar um alçapão</strong> — não há
          porta para trancar por fora nem muro para escalar.
        </p>
        <HelpWarn>
          O preço é que o par de alçapões <em>tem</em> de existir: um na planta da entrada, outro que
          o servidor ergue no fundo. Sem os dois, a construção é desfeita e o painel diz{' '}
          <code>no_hatch</code>.
        </HelpWarn>
      </>
    ),
  },

  modo: {
    title: 'Receita ou planta',
    short: 'Receita sorteia um traçado novo a cada vez; planta sai sempre igual.',
    body: (
      <>
        <p>
          <strong>Receita</strong> é um conjunto de regras — de tantas a tantas salas, tanto de cada
          cor. O servidor sorteia o traçado na hora, e cada nascimento sai diferente. É o modo que dá
          rejogabilidade sem trabalho.
        </p>
        <p>
          <strong>Planta</strong> é um desenho célula a célula, feito por você. Sai sempre igual, e
          os jogadores decoram o caminho — o que é bom para uma masmorra permanente que vira ponto
          de referência do servidor.
        </p>
        <HelpExample>
          Um evento que nasce de hora em hora pede receita. A masmorra fixa da ilha do meio pede
          planta.
        </HelpExample>
      </>
    ),
  },

  entrada: {
    title: 'A planta da entrada',
    short: 'A casinha que aparece no mapa. É ela que traz o alçapão de descida.',
    body: (
      <>
        <p>
          A entrada é a única parte que os jogadores veem de fora, e ela vem do{' '}
          <strong>acervo de plantas</strong> — construções prontas, salvas em arquivo.
        </p>
        <p>
          Deixando em branco, o servidor ergue uma entrada mínima gerada por código: uma laje, um
          alçapão e uma luz. Funciona, e não impressiona ninguém.
        </p>
        <HelpWarn>
          A planta precisa ter a <strong>marca do alçapão</strong>, ou a masmorra não abre. O painel
          confere isso no momento em que você sobe o arquivo — a coluna do acervo mostra quais têm.
        </HelpWarn>
      </>
    ),
  },

  plantaPronta: {
    title: 'Começar de uma planta pronta',
    short: 'Um traçado salvo vira o ponto de partida — e o desenho é copiado, não emprestado.',
    body: (
      <>
        <p>
          Uma <strong>planta pronta</strong> é o desenho de uma masmorra guardado por si só: o mapa
          dos corredores e das salas, sem nada dentro. Quatro vêm com o projeto, e todo desenho que
          você fizer pode virar uma pelo botão <strong>Salvar como planta</strong>.
        </p>
        <p>
          Clicar numa delas <strong>copia</strong> o desenho para esta masmorra. A partir daí ele é
          seu: apagar, esticar e repintar aqui não mexe no que está guardado, e apagar o guardado
          não quebra esta masmorra.
        </p>
        <HelpExample>
          Escolha a <em>Serpente</em>, apague o braço da direita e pinte duas salas vermelhas no
          lugar. Salve como &ldquo;Serpente curta&rdquo; e ela passa a estar na faixa da próxima vez.
        </HelpExample>
        <HelpWarn>
          O que uma planta pronta traz é só o traçado. Quantos inimigos, que loot e que porta cada
          cor tem continuam sendo desta masmorra, nos passos seguintes.
        </HelpWarn>
      </>
    ),
  },

  desenho: {
    title: 'Desenhar o traçado',
    short: 'Cada quadradinho é um cômodo de 3 por 3 metros. Arraste para pintar.',
    body: (
      <>
        <p>
          O grid é a masmorra vista de cima. Você pinta com cinco cores: <strong>apagar</strong>,{' '}
          <strong>corredor</strong>, e as três cores de sala — e o que você desenha é exatamente o
          que vai ser construído no jogo.
        </p>
        <p>
          <strong>A porta nasce sozinha</strong> onde uma sala encosta no corredor. Não há
          ferramenta de porta, e isso é de propósito: desenhar um cômodo perfeito e esquecer a porta
          produziria uma sala em que ninguém entra, e o erro só apareceria no jogo.
        </p>
        <HelpExample>
          Pinte um corredor saindo da entrada, depois manchas de cor grudadas nele. Duas manchas
          vermelhas separadas viram duas salas; uma mancha grande vira uma sala grande.
        </HelpExample>
        <HelpWarn>
          A tela avisa embaixo quando algo não fecha: sala que não encosta em corredor, ou pedaço de
          corredor que não chega na entrada. Os dois produzem partes da masmorra que ninguém visita.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  O TAMANHO E O MIX
  // ----------------------------------------------------------

  tamanho: {
    title: 'Quantas salas',
    short: 'O servidor sorteia um número dentro desse intervalo, a cada nascimento.',
    body: (
      <>
        <p>
          A conta é em <strong>salas</strong>, não em metros. Cada sala vira um cômodo de 1 a 9
          quadrados, e o corredor que liga tudo cresce junto — mais ou menos três células de corredor
          por sala.
        </p>
        <HelpExample>
          12 a 18 salas dão uma masmorra de umas 78 células e ~260 blocos, que um grupo de três
          limpa em uns 12 minutos.
        </HelpExample>
        <HelpWarn>
          Acima de 25 salas a limpeza passa de meia hora — e, num evento com duração, os jogadores
          são expulsos pela radiação antes de chegar ao fim. Se for grande, aumente a duração junto.
        </HelpWarn>
      </>
    ),
  },

  pesos: {
    title: 'A mistura de salas',
    short: 'A proporção entre salas verdes, azuis e vermelhas. São pesos, não porcentagens.',
    body: (
      <>
        <p>
          A cor de uma sala é o <strong>nível dela</strong>: quantos inimigos tem dentro, que loot
          cai, e que porta o jogador encontra. É a única linguagem que ele aprende sem ler nada —
          porta vermelha quer dizer “cuidado, e vale a pena”.
        </p>
        <p>
          Os três números são <strong>pesos</strong>: não precisam somar 100. Um mix de 60/30/10 dá o
          mesmo resultado que 6/3/1.
        </p>
        <HelpExample>
          Com 15 salas e pesos 50/35/15, saem ~8 verdes, ~5 azuis e ~2 vermelhas.
        </HelpExample>
        <HelpWarn>
          Vermelho acima de 40% desmancha o significado da cor: se quase toda porta é vermelha, ela
          para de avisar coisa nenhuma.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  O CONTEÚDO
  // ----------------------------------------------------------

  salaNpc: {
    title: 'Inimigos por sala',
    short: 'Quantos NPCs nascem em cada sala daquela cor. O servidor sorteia no intervalo.',
    body: (
      <>
        <p>
          Vale por sala <em>daquela cor</em>. Uma masmorra de 15 salas com 5 vermelhas e “3 a 5” na
          vermelha põe entre 15 e 25 inimigos só nelas.
        </p>
        <HelpExample>
          Verde 0–1, azul 1–2, vermelha 3–5 é a curva das receitas de fábrica: a primeira sala quase
          nunca tem ninguém, e é ela que ensina o jogador a andar.
        </HelpExample>
        <HelpWarn>
          Passando de ~40 NPCs na masmorra inteira, o servidor sente no tick — e o jogador sente
          antes, porque não consegue mais recarregar.
        </HelpWarn>
      </>
    ),
  },

  salaLoot: {
    title: 'Caixas por sala',
    short: 'Quantas caixas de loot nascem em cada sala daquela cor.',
    body: (
      <>
        <p>
          O que vem dentro é o loot padrão do prefab que você escolher — uma{' '}
          <code>crate_elite</code> dá loot de elite, uma <code>crate_normal</code> dá o comum.
        </p>
        <HelpExample>
          Vermelha com 2–3 <code>crate_elite</code> é o prêmio que justifica a porta trancada.
        </HelpExample>
        <HelpWarn>
          Loot demais numa masmorra que nasce de hora em hora derruba a economia do wipe inteiro em
          dois dias. Comece baixo: subir é fácil, descer irrita.
        </HelpWarn>
      </>
    ),
  },

  porta: {
    title: 'A porta da sala',
    short: 'Madeira, metal ou blindada. É o aviso visual do que tem dentro.',
    body: (
      <>
        <p>
          Ela é a promessa que a sala faz antes de o jogador entrar. Manter a correspondência —
          madeira na verde, metal na azul, blindada na vermelha — é o que faz a cor significar
          alguma coisa.
        </p>
        <HelpWarn>
          Uma sala verde com porta blindada não é uma surpresa divertida: é uma mentira, e o jogador
          deixa de confiar nas outras portas.
        </HelpWarn>
      </>
    ),
  },

  trancada: {
    title: 'Porta com código',
    short: 'A porta fica trancada, e o código cai de um inimigo lá dentro.',
    body: (
      <>
        <p>
          Trancar transforma a sala em objetivo: o jogador precisa limpar o resto da masmorra para
          achar quem carrega o código.
        </p>
        <HelpWarn>
          Trancar mais de uma ou duas salas transforma a masmorra numa caçada a bilhetes. E, se o
          inimigo com o código morrer num canto que ninguém revista, a sala fica inalcançável até o
          evento acabar.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  O CORREDOR
  // ----------------------------------------------------------

  corredorNpc: {
    title: 'Inimigos no corredor',
    short: 'De cada 100 células de corredor, quantas ganham um inimigo.',
    body: (
      <>
        <p>
          O corredor é o caminho entre as salas. Vazio, ele é só deslocamento; povoado, ele é
          tensão — e é o que impede o jogador de correr de sala em sala sem olhar para trás.
        </p>
        <HelpExample>20 num corredor de 60 células dá uns 12 inimigos pelo caminho.</HelpExample>
        <HelpWarn>
          Acima de 50, o corredor vira o desafio e as salas viram descanso — o contrário do que a
          cor da porta promete.
        </HelpWarn>
      </>
    ),
  },

  corredorLoot: {
    title: 'Caixas no corredor',
    short: 'De cada 100 células de corredor, quantas ganham uma caixa.',
    body: (
      <>
        <p>
          Caixa no corredor é o prêmio de consolação: mantém o jogador olhando os cantos enquanto
          anda.
        </p>
        <HelpWarn>
          Muito loot solto no caminho tira o motivo de entrar nas salas trancadas — e são elas que
          dão graça à masmorra.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  OS INIMIGOS
  // ----------------------------------------------------------

  npcVida: {
    title: 'Vida dos inimigos',
    short: 'A vida sorteada de cada NPC. Um jogador comum tem 100.',
    body: (
      <>
        <p>
          Cientista padrão do jogo tem 100. Dobrar isso não deixa a masmorra “difícil”: deixa cada
          troca de tiros mais longa, o que gasta munição e paciência.
        </p>
        <HelpExample>
          120–180 é a faixa do nível “difícil” de fábrica: aguenta dois tiros de rifle a mais que o
          normal.
        </HelpExample>
        <HelpWarn>
          Acima de 300, um grupo sem armas boas simplesmente não consegue passar — e desiste no
          primeiro corredor.
        </HelpWarn>
      </>
    ),
  },

  npcDano: {
    title: 'Multiplicador de dano',
    short: 'Quanto o inimigo machuca, em relação ao normal. 1 = padrão do jogo.',
    body: (
      <>
        <p>
          Este é o número que decide se a masmorra é justa. Ele multiplica o dano da arma que o NPC
          carrega.
        </p>
        <HelpExample>
          0,5 deixa a masmorra ensinável para quem chegou agora; 2 mata um jogador de armadura em
          poucos tiros.
        </HelpExample>
        <HelpWarn>
          Acima de 2, com AK na mão do inimigo, não há armadura no jogo que sustente — e a masmorra
          vira uma loteria de quem viu primeiro.
        </HelpWarn>
      </>
    ),
  },

  npcArmas: {
    title: 'Armas dos inimigos',
    short: 'O sorteio escolhe uma desta lista para cada inimigo.',
    body: (
      <>
        <p>
          Use o nome curto do item, como <code>rifle.ak</code> ou <code>smg.mp5</code>. Uma lista
          variada faz a masmorra parecer habitada por gente diferente.
        </p>
        <HelpWarn>
          A arma manda mais que a vida e o dano juntos. Uma <code>minigun</code> numa masmorra
          apertada não é difícil: é impossível.
        </HelpWarn>
      </>
    ),
  },

  horaDoDia: {
    title: 'A hora lá dentro',
    short: 'Que horas são para quem está na masmorra. 0 = meia-noite.',
    body: (
      <>
        <p>
          A masmorra fica abaixo do mundo, e a luz do dia ainda a alcança. Fixar a meia-noite é o que
          a deixa escura de verdade e dá sentido às luminárias.
        </p>
        <HelpExample>
          0 deixa tudo no breu, e o jogador precisa de lanterna. −1 não mexe, e ele entra numa
          masmorra iluminada às três da tarde.
        </HelpExample>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  O COMANDO
  // ----------------------------------------------------------

  comando: {
    title: 'Por que preciso digitar no jogo',
    short: 'Só quem está de pé no mapa sabe que aquele lugar é bom.',
    body: (
      <>
        <p>
          O painel sabe tudo sobre a masmorra, menos uma coisa: <strong>onde ela deve nascer</strong>.
          Aquela encosta com vista, longe das bases mas perto da estrada, não está em nenhum banco de
          dados.
        </p>
        <p>
          Então o último passo é no jogo: você vai até o lugar, olha para a direção em que a masmorra
          deve crescer, e cola o comando. Esta tela fica <strong>esperando</strong> — e se resolve
          sozinha assim que a construção terminar.
        </p>
        <HelpExample>
          A direção importa: a masmorra cresce para onde você estiver olhando. Num mapa apertado, isso
          decide se ela cabe.
        </HelpExample>
      </>
    ),
  },
} as const satisfies Record<string, HelpTopic>;
