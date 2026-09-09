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
    short: 'Onze folhas, de madeira a portão de garagem. É o aviso visual do que tem dentro.',
    body: (
      <>
        <p>
          Ela é a promessa que a sala faz antes de o jogador entrar. Manter a correspondência de{' '}
          <strong>material</strong> — madeira na verde, metal na azul, blindada na vermelha — é o
          que faz a cor significar alguma coisa.
        </p>
        <p>
          As quatro primeiras (madeira, metal, blindada, fábrica) têm{' '}
          <strong>um metro de passagem</strong> e nascem num vão de porta comum. As seis seguintes
          têm <strong>dois metros</strong> e precisam de um quadro no lugar do vão — o construtor
          troca a peça sozinho.
        </p>
        <HelpExample>
          Grade de cela numa sala vermelha não é erro: é desenho. O jogador vê o que tem dentro
          antes de conseguir entrar, e isso é uma promessa melhor que qualquer porta fechada.
        </HelpExample>
        <HelpWarn>
          Uma sala verde com porta blindada não é uma surpresa divertida: é uma mentira, e o jogador
          deixa de confiar nas outras portas. E <code>nenhuma</code> deixa o vão aberto — a sala
          deixa de ter porta, e com ela some o aviso da cor.
        </HelpWarn>
      </>
    ),
  },

  portaLarga: {
    title: 'A porta da sala grande',
    short: 'Uma folha diferente quando o cômodo é grande demais para uma porta só.',
    body: (
      <>
        <p>
          Um salão de nove células com <strong>uma</strong> entrada afunila o grupo inteiro numa
          passagem de um metro: quem entra primeiro leva a rajada, e os outros esperam na fila.
        </p>
        <p>
          A porta larga resolve isso sem mexer no desenho: quando a sala passa do limite abaixo, ela
          nasce com a folha de dois metros que você escolher aqui. Deixando em branco, toda sala
          daquela cor usa a porta normal.
        </p>
        <HelpExample>
          Vermelha com porta blindada normal e <em>dupla blindada</em> como larga: as salinhas de
          uma célula continuam apertadas, e o salão do fundo abre de verdade.
        </HelpExample>
      </>
    ),
  },

  portaLargaLimite: {
    title: 'A partir de quantas células',
    short: 'A conta é células ÷ portas, e não células.',
    body: (
      <>
        <p>
          Um salão de nove células com <strong>quatro</strong> entradas não afunila ninguém — quatro
          grupos entram por quatro lados. O funil é nove células com <strong>uma</strong> entrada.
        </p>
        <HelpExample>
          Com o limite em 4: uma sala de 3×3 com uma porta recebe a folha larga (9 ÷ 1 = 9); a mesma
          sala com três portas fica com a normal (9 ÷ 3 = 3).
        </HelpExample>
        <HelpWarn>
          Baixar para 1 põe folha larga em toda sala, inclusive nas de uma célula — e aí ela deixa
          de querer dizer &ldquo;aqui é grande&rdquo;.
        </HelpWarn>
      </>
    ),
  },

  trancada: {
    title: 'Porta com código',
    short: 'A porta fica trancada, e o código cai de um inimigo lá fora.',
    body: (
      <>
        <p>
          Trancar transforma a sala em objetivo: o jogador precisa limpar o resto da masmorra para
          achar quem carrega o código.
        </p>
        <p>
          <strong>O portador nunca está dentro da sala que ele abre</strong> — isso não é opção, é
          regra do construtor. O código da sala vermelha guardado dentro dela seria uma porta que só
          abre para quem já entrou.
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
  //  O NÍVEL DE CONSTRUÇÃO
  // ----------------------------------------------------------

  grauConstrucao: {
    title: 'O material da masmorra',
    short: 'Piso, parede e teto de toda célula que não é sala. Pedra é o de sempre.',
    body: (
      <>
        <p>
          São os cinco níveis do jogo — palha, madeira, pedra, metal e blindado —, e eles decidem
          quanto explosivo o jogador precisa para <strong>entrar por onde não é a porta</strong>.
        </p>
        <p>
          Este bloco vale para o corredor, para a entrada e para toda célula sem dono de sala. As
          salas podem ter o próprio, no passo das salas.
        </p>
        <HelpExample>
          Pedra aguenta 2 C4 por parede; blindado aguenta 4 e é imune a foguete comum. Numa masmorra
          de evento de 40 minutos, blindado quer dizer &ldquo;ninguém vai furar parede&rdquo;.
        </HelpExample>
        <HelpWarn>
          Palha desmonta com machado. Se a masmorra inteira for palha, a porta trancada deixa de ser
          um obstáculo — o jogador entra pela parede em quinze segundos.
        </HelpWarn>
      </>
    ),
  },

  grauDaSala: {
    title: 'O material desta cor',
    short: 'Sobrescreve o da masmorra, só para as salas desta cor.',
    body: (
      <>
        <p>
          Deixando desligado, a sala usa o material da masmorra. Ligando, ela ganha o próprio — e é
          assim que a sala vermelha fica blindada num corredor de pedra.
        </p>
        <p>
          <strong>A parede entre duas salas tem dois donos, e vence o mais forte.</strong> Uma sala
          blindada encostada numa de madeira não ganha parede de madeira: o invasor entraria pelo
          lado barato e a sua escolha viraria decoração.
        </p>
        <HelpWarn>
          Blindado numa sala que também tem porta trancada faz dela um cofre de verdade. É bom uma
          vez por masmorra; em três salas, o jogador desiste.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  A FECHADURA
  // ----------------------------------------------------------

  fechadura: {
    title: 'Como a masmorra tranca',
    short: 'Vale para todas as salas marcadas como trancadas. Desligar aqui abre todas.',
    body: (
      <>
        <p>
          O código é sempre de <strong>quatro dígitos</strong>, e isso não é configurável: o teclado
          do cliente do Rust tem quatro casas, e um código de cinco não pode ser digitado — a sala
          ficaria lacrada sem nada na tela explicando por quê.
        </p>
        <p>
          É <strong>um código por sala</strong>, não por porta. Um cômodo com três entradas tem um
          código só — o contrário faria o jogador achar o papel da porta norte e continuar trancado
          do lado sul.
        </p>
        <HelpExample>
          Desligar a fechadura é o jeito de testar a masmorra sem caçar papel nenhum: as salas
          marcadas continuam marcadas, e nascem abertas.
        </HelpExample>
      </>
    ),
  },

  portador: {
    title: 'De onde o código sai',
    short: 'Um inimigo, uma caixa, ou ninguém.',
    body: (
      <>
        <p>
          O papel com o código entra no inventário de um <strong>inimigo</strong> (e vai para o
          corpo dele quando morre) ou de uma <strong>caixa</strong>. &ldquo;Ninguém&rdquo; existe
          para o evento em que o admin abre a porta na mão.
        </p>
        <p>
          O alcance diz onde o portador pode estar: <strong>corredor</strong> é o padrão, e{' '}
          <strong>em qualquer lugar</strong> permite que o código da vermelha esteja dentro da azul.
          Nunca dentro da própria sala trancada.
        </p>
        <HelpWarn>
          Escolhendo &ldquo;ninguém&rdquo; com salas trancadas, o painel recusa salvar. E se o
          corredor não tiver inimigo nenhum, o código não tem em quem entrar — o construtor
          destranca a sala e grita no console, mas ninguém lê o console.
        </HelpWarn>
      </>
    ),
  },

  codigoUnico: {
    title: 'Um código para a masmorra inteira',
    short: 'Ligado, o mesmo número abre todas as salas trancadas.',
    body: (
      <>
        <p>
          Com um código só, o primeiro papel encontrado abre tudo. É o modo &ldquo;chave
          mestra&rdquo;: mais rápido, e transforma a caçada num único achado.
        </p>
        <HelpExample>
          Numa masmorra de evento curto, um código só evita que o grupo perca dez dos quarenta
          minutos revistando corpos.
        </HelpExample>
        <HelpWarn>
          Numa masmorra grande, isso apaga a progressão: a última sala abre com o papel da primeira,
          e o resto do caminho deixa de ter recompensa própria.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  O LOOT
  // ----------------------------------------------------------

  tabelaDeLoot: {
    title: 'O que cai dentro',
    short: 'A do servidor, acrescentar por cima, ou substituir tudo.',
    body: (
      <>
        <p>
          <strong>A do servidor</strong> é o padrão e o que acontece hoje: a caixa se enche sozinha
          pela tabela de loot do servidor, e o BetterLoot continua valendo dentro da masmorra.
        </p>
        <p>
          <strong>Acrescenta</strong> deixa o Rust encher e põe os seus itens por cima —
          é o modo para &ldquo;além do normal, cai isto&rdquo;. <strong>Substitui</strong> limpa e
          usa só a sua lista.
        </p>
        <HelpExample>
          Vermelha em &ldquo;acrescenta&rdquo; com 100 de scrap marcado como <em>Sempre</em>: o
          jogador leva o loot de elite habitual e mais o scrap que justifica a porta trancada.
        </HelpExample>
        <HelpWarn>
          Uma tabela pesa. Com oito itens por cor e mais uma no corredor, cabem sete masmorras no
          comando que o agente manda ao servidor — contra mais de trinta sem tabela nenhuma. Passou
          do teto, o envio inteiro é recusado e o jogo fica com o estado anterior.
        </HelpWarn>
      </>
    ),
  },

  sorteios: {
    title: 'Sorteios por caixa',
    short: 'Quantos itens da lista caem, por peso. Os marcados “Sempre” não contam aqui.',
    body: (
      <>
        <p>
          O servidor sorteia um número dentro do intervalo e tira essa quantidade de itens da lista,
          onde <strong>peso maior sai mais vezes</strong>. Um item de peso 40 numa lista que soma
          100 sai em cerca de 40% dos sorteios.
        </p>
        <HelpExample>
          Dois sorteios numa lista de oito itens dão caixas diferentes a cada vez — que é o que faz
          o jogador abrir a próxima.
        </HelpExample>
        <HelpWarn>
          Zero sorteios com nenhum item &ldquo;Sempre&rdquo; é uma caixa vazia, e nada no jogo diz
          por quê.
        </HelpWarn>
      </>
    ),
  },

  dropDoInimigo: {
    title: 'O que o corpo carrega',
    short: 'A tabela do corpo de todo inimigo da masmorra.',
    body: (
      <>
        <p>
          Vale para o corpo de qualquer inimigo, em qualquer sala. É o prêmio de matar, e é o que
          mantém o jogador limpando a masmorra em vez de correr para as caixas.
        </p>
        <HelpWarn>
          Substituir apaga o que o cientista traz de fábrica — inclusive a arma dele. Se você quer
          somar, use &ldquo;acrescenta&rdquo;. O papel do código nunca é apagado por nenhum dos
          modos.
        </HelpWarn>
      </>
    ),
  },

  respawn: {
    title: 'Quando o loot volta',
    short: 'Desligado é o certo no modo evento.',
    body: (
      <>
        <p>
          Ligado, as caixas se enchem de novo de tantos em tantos minutos, e as destruídas podem ser
          reconstruídas. Serve para a masmorra <strong>permanente</strong>, que fica de pé o wipe
          inteiro.
        </p>
        <HelpWarn>
          Numa masmorra de evento de 40 minutos, um ciclo de 30 é loot dobrado: o grupo limpa,
          espera na porta e limpa de novo. É por isso que o padrão é desligado.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  QUEM ENTRA, E O QUE NINGUÉM TIRA DO LUGAR
  // ----------------------------------------------------------

  quemEntra: {
    title: 'Quem pode entrar',
    short: 'Todo o servidor, ou só quem tem uma permissão do Oxide.',
    body: (
      <>
        <p>
          O padrão é <strong>todo o servidor</strong>: quem achar a casinha desce pelo alçapão. Não
          existe dono de masmorra neste plugin — ninguém a &ldquo;reivindica&rdquo;, e ela não
          pertence a quem a encontrou primeiro.
        </p>
        <p>
          No outro modo, o alçapão só leva quem tem a <strong>permissão</strong> que você nomear ao
          lado. Quem não tem recebe uma linha explicando, e continua de pé na superfície.
        </p>
        <HelpExample>
          Um evento de fim de semana só para VIP: escolha &ldquo;só quem tem a permissão&rdquo; e
          aponte para a permissão do seu plugin de VIP. Os outros jogadores continuam vendo a
          casinha no mapa — e não descem.
        </HelpExample>
        <HelpWarn>
          <strong>Subir nunca é barrado.</strong> Quem perdeu a permissão enquanto estava lá embaixo
          ficaria preso a 90 metros abaixo do mundo, sem porta e sem mapa — então o alçapão de volta
          leva qualquer um.
        </HelpWarn>
      </>
    ),
  },

  permissaoDeEntrada: {
    title: 'O nome da permissão',
    short: 'Em branco usa a do plugin. Uma que não existe deixa todo mundo entrar.',
    body: (
      <>
        <p>
          É um nome de permissão do <strong>Oxide</strong>, do tipo{' '}
          <code>origemzdungeon.enter</code> ou <code>vip.diamante</code>. Deixando em branco, vale a
          do próprio plugin — e você a concede pelo console, com{' '}
          <code>oxide.grant user &lt;jogador&gt; origemzdungeon.enter</code>.
        </p>
        <p>
          Pode ser a permissão de <em>outro</em> plugin, desde que aquele plugin esteja no servidor
          e a registre. É assim que a masmorra vira &ldquo;só para VIP&rdquo; sem duplicar lista
          nenhuma.
        </p>
        <HelpWarn>
          Um nome digitado errado — ou o plugin de VIP que saiu do servidor — faria o jogo recusar{' '}
          <strong>todo mundo</strong>: o alçapão abriria sem levar ninguém, e nada na tela diria por
          quê. Então uma permissão que não existe em plugin nenhum{' '}
          <strong>deixa entrar</strong>, e o servidor avisa no console. Abrir por engano devolve a
          masmorra ao que ela já era; trancar por engano ninguém descobre de dentro do jogo.
        </HelpWarn>
      </>
    ),
  },

  protecao: {
    title: 'Proteger a entrada',
    short: 'Impede martelo, ferramenta de remoção e “segurar E” na masmorra inteira.',
    body: (
      <>
        <p>
          A masmorra já não recebia <strong>dano</strong>. Mas remover não é dano: o martelo, a
          ferramenta de remoção e o &ldquo;segurar E&rdquo; destroem a peça por caminhos que nunca
          passam por um tiro. Ligada, esta proteção fecha todos eles:
        </p>
        <ul className="ml-4 list-disc space-y-0.5 text-xs">
          <li>bater com o martelo, e o menu radial dele: demolir, melhorar, girar e reparar;</li>
          <li>a ferramenta de remoção, nos dois modos — inclusive o de administrador;</li>
          <li>segurar E na luz, na caixa e no armário;</li>
          <li>tirar a fechadura da porta.</li>
        </ul>
        <p>
          <strong>Saquear continua funcionando.</strong> O jogador abre a caixa e leva o conteúdo; o
          que ele não faz é levar a caixa.
        </p>
        <p>
          O aviso a quem tentou sai <strong>no máximo uma vez a cada três segundos</strong> por
          jogador. Segurar o botão do martelo dispara a checagem várias vezes por segundo, e uma
          linha de chat por batida encheria a tela — escondendo inclusive o aviso da porta que
          acabou de abrir.
        </p>
        <HelpExample>
          Uma parede da casinha da entrada custa um martelo e dez segundos. Sem esta proteção, o
          primeiro jogador que passar pode fechar a masmorra para todos os outros — sem invadir
          nada, e sem que ninguém veja quem foi.
        </HelpExample>
        <HelpWarn>
          O <strong>apodrecimento</strong> não obedece a este botão: a masmorra não cai sozinha nem
          com a proteção desligada. Ver a entrada apodrecer três horas depois seria uma surpresa que
          ninguém ligaria ao botão que apertou.
        </HelpWarn>
      </>
    ),
  },

  protecaoAdmin: {
    title: 'Quem administra passa',
    short: 'Sem isso, nem você tira do mapa uma masmorra que emperrou.',
    body: (
      <>
        <p>
          Quem tem <code>origemzdungeon.admin</code> continua podendo remover as peças. É a saída de
          emergência: o comando de parar a masmorra é justamente o que não funciona quando alguma
          coisa já deu errado.
        </p>
        <HelpWarn>
          Desligando, uma masmorra que não encerrar sozinha vira construção permanente no mapa até o
          próximo wipe. Só desligue se a proteção contra o próprio administrador for o ponto — um
          servidor com muitos administradores, por exemplo.
        </HelpWarn>
      </>
    ),
  },

  // ----------------------------------------------------------
  //  A IA
  // ----------------------------------------------------------

  iaHeranca: {
    title: 'O comportamento, e de onde ele vem',
    short: 'Vazio quer dizer “herda”, e nunca zero.',
    body: (
      <>
        <p>
          O comportamento é definido em três camadas, e a de baixo sobrescreve a de cima{' '}
          <strong>campo a campo</strong>:
        </p>
        <pre className="overflow-x-auto border border-border bg-background px-3 py-2 text-2xs leading-relaxed text-muted">
          {`  o padrão desta masmorra
        ↓
  a cor da sala  (ou)  o corredor`}
        </pre>
        <p>
          Um campo em branco na sala vermelha não é &ldquo;zero&rdquo;: é &ldquo;não falei
          disso&rdquo;, e o número do padrão fica de pé. O que a caixa mostra em cinza é justamente
          o valor que ela vai herdar.
        </p>
        <HelpExample>
          Mude só <em>Entre tentativas</em> na vermelha: os inimigos dela atiram mais rápido, e todo
          o resto continua igual ao das outras salas.
        </HelpExample>
      </>
    ),
  },

  iaPercepcao: {
    title: 'Como o inimigo percebe',
    short: 'Até onde ele enxerga, se a parede segura, e quanto tempo ele lembra.',
    body: (
      <>
        <p>
          <strong>Alcance de visão</strong> é a distância em que ele passa a te perseguir. Com 0 ele
          só reage a tiro — o que faz dele uma sentinela de emboscada.
        </p>
        <p>
          <strong>Precisa enxergar</strong> desligado é o inimigo que atira através da parede. Isso
          não é dificuldade, é o defeito mais feio que uma masmorra pode ter.
        </p>
        <p>
          <strong>Diferença de altura</strong> é o que impede o inimigo do fundo de perseguir quem
          está na superfície, 90 metros acima. Abaixo de 3 ele desiste de quem subiu um degrau.
        </p>
        <HelpWarn>
          Alcance acima de 40 numa masmorra apertada faz a sala inteira acordar de uma vez, e o
          jogador enfrenta oito inimigos em vez de dois.
        </HelpWarn>
      </>
    ),
  },

  iaMovimento: {
    title: 'Como o inimigo anda',
    short: 'Velocidade, a coleira do posto, e o que ele faz quando te perde.',
    body: (
      <>
        <p>
          <strong>A coleira</strong> é o campo que mantém a masmorra funcionando: ela é a distância
          máxima do lugar onde o inimigo nasceu. Sem ela, uma perseguição levaria o cientista para
          fora do que foi construído.
        </p>
        <p>
          <strong>Fica no posto</strong> é a sentinela: mira e atira, e nunca sai do lugar. É o que
          transforma um cômodo numa torre de guarda.
        </p>
        <p>
          <strong>Preso por</strong> é a saída de emergência: preso numa quina por esse tempo, ele
          reaparece no posto. É feio de propósito — melhor que um inimigo dançando contra a parede.
          Zero desliga.
        </p>
        <HelpExample>
          2,8 m/s é a velocidade de quem anda; um jogador correndo faz 5,5. Acima de 5, o inimigo
          alcança qualquer um e a fuga deixa de existir.
        </HelpExample>
      </>
    ),
  },

  iaCombate: {
    title: 'Como o inimigo atira',
    short: 'Alcance, cadência e a distância em que ele para de andar.',
    body: (
      <>
        <p>
          <strong>Entre tentativas</strong> é o intervalo entre puxadas do gatilho. A rajada e a
          cadência continuam sendo da arma — este número só pode deixar mais <em>lento</em>.
        </p>
        <p>
          <strong>Para de andar a</strong> é o &ldquo;não me abrace&rdquo;: chegou a essa distância,
          ele fica onde está e atira. Zero faz o inimigo colar no jogador.
        </p>
        <HelpWarn>
          Alcance de tiro maior que o de visão não serve para nada: ele atira no que vê. E abaixar o
          intervalo para 0,2 com AK na mão mata um jogador de armadura em menos de dois segundos.
        </HelpWarn>
      </>
    ),
  },

  iaDispersao: {
    title: 'A dispersão do tiro',
    short: 'Multiplicador do cone da arma. Menor = mais certeiro. Vazio = o do jogo.',
    body: (
      <>
        <p>
          O jogo calcula a precisão do inimigo como{' '}
          <strong>este número × o cone da arma dele</strong>. Menor deixa mais certeiro; maior
          espalha o tiro.
        </p>
        <p>
          Deixando em branco, o valor do próprio cientista fica de pé — e é o certo enquanto ninguém
          reclamar da dificuldade.
        </p>
        <HelpWarn>
          O cone de cada arma é diferente, então 0,8 não quer dizer a mesma coisa na AK e na
          spas12. Ajuste com uma arma só na lista, ou você estará mirando no escuro.
        </HelpWarn>
      </>
    ),
  },

  iaRitmo: {
    title: 'De quanto em quanto ele pensa',
    short: 'Existe para o servidor cheio, não para o jogo.',
    body: (
      <>
        <p>
          São os dois relógios de cada inimigo: um procura alvo, o outro dá o passo. Trinta
          cientistas com o relógio em 0,1 s são trezentas decisões por segundo.
        </p>
        <HelpWarn>
          Baixar isso não deixa a masmorra mais difícil — deixa o servidor mais lento, e o jogador
          sente como travamento, não como desafio. Só mexa se o inimigo estiver visivelmente
          atrasado.
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
