// ============================================================
//  OrigemZItems.cs
//
//  Da identidade e acao a itens que o jogo nao tem. Um "item
//  custom" aqui e um item NATIVO do Rust carregando uma MARCA
//  nossa - o par (item base, skinId) - e, por causa dela, um nome
//  nosso, um icone nosso e um comportamento nosso.
//
//  ESTE PLUGIN NAO GUARDA CADASTRO. A fonte da verdade e o SQLite
//  do RustAgent; o painel cadastra e o agente empurra para ca por
//  RCON. Nada de definicao vai para oxide\data - cadastro
//  duplicado em dois lugares diverge, e o lugar que diverge sempre
//  e o que ninguem olha. O que este plugin guarda em memoria e uma
//  COPIA de trabalho, descartavel, que ele PEDE de volta quando
//  esquece (ver o pedido de sincronizacao mais abaixo).
//
//  ####  A UNICA EXCECAO, E ELA E DELIBERADA  ####
//
//  A FILA DE PONTOS (oxide\data\OrigemZItems\pending) grava em
//  disco, e isso contradiz o paragrafo acima de proposito.
//
//  A diferenca esta no que se perde: cadastro perdido o agente
//  remanda, e ninguem fica sabendo porque nada quebrou. Ponto
//  perdido nao volta - o item que o originou JA FOI DESTRUIDO, e o
//  jogador perdeu a conquista sem que nem ele nem o log saibam.
//
//  Ver Docs\CustomItem-ACAO-PONTOS-DE-RANKING.md §7.2.
//
//  Pesquisa e decisoes: Docs\CustomItem\01-PESQUISA-ITEM-CUSTOM.md
//  Estudo do 3D:        Docs\CustomItem\02-ESTUDO-MODELO-3D.md
//
//  ------------------------------------------------------------
//  ####  POR QUE A MARCA E O skinId, E POR QUE ELE NUNCA E ZERO ####
//
//  MEDIDO no binario do jogo: um itemid que o cliente nao conhece
//  e DESCARTADO - "Load invalid item id {0} from item {1} (no
//  ItemDefinition found)". Nao ha como inventar item novo sem
//  modificar o cliente de cada jogador.
//
//  O que existe e o campo `skin` (UInt64), que viaja na rede e e
//  aceito sem consulta local. Ele e a unica marca que o proprio
//  jogo carrega por nos: sobrevive a drop, a wipe, a restart e a
//  `oxide.reload` - porque quem a guarda e o item, nao este
//  plugin.
//
//  E ela NUNCA e zero, por dois motivos independentes:
//
//   1. skin 0 e indistinguivel de item comum. Um trofeu Bleik com
//      skin 0 faria o servidor premiar o trofeu do Twitch que o
//      jogador ja tinha no bau;
//
//   2. skin 0 num item SEM skins DERRUBA O JOGADOR do servidor
//      pelo caminho do CUI - o FirstOrDefault do cliente devolve o
//      default do struct, cujo id tambem e 0, o `if` passa e o
//      invItem nulo estoura. Ver Docs\TrofeuBleik §2.6 e
//      core\src\game\ui-cui.ts:309-330.
//
//  ------------------------------------------------------------
//  ####  O PLUGIN NAO ALTERA NENHUMA ItemDefinition  ####
//
//  E a regra que mais importa neste arquivo. A ItemDefinition e do
//  JOGO, nao do item: mexer no ItemModConsumable do `bandage`
//  mudaria TODA bandagem do servidor, nao so a nossa. O mesmo vale
//  para maxStack e para o world model.
//
//  Entao o desenho e sempre o mesmo: INTERCEPTA o uso, decide pelo
//  skinId, e aplica o nosso efeito no lugar do original. Quem nao
//  tem a marca segue o jogo, intocado.
//
//  ------------------------------------------------------------
//  ####  O QUE ESTA VERSAO NAO FAZ  ####
//
//  Nao registra ItemDefinition propria: categoria propria e stack
//  por item exigiriam a biblioteca CustomItemDefinitions, e a
//  decisao registrada foi nao depender dela.
//
//  E, o que mais morde este arquivo: ele nao consegue CRIAR uma
//  opcao no menu do botao direito. O menu e montado pelo CLIENTE
//  a partir da ItemDefinition, e o hook OnItemUse so dispara em
//  quem tem ItemModConsumable. Por isso um item custom que
//  converta em ponto "so ao usar" precisa de um item base
//  consumivel - sem ele o item fica INERTE, em silencio. O
//  cadastro no agente recusa a combinacao, e o origemz.item.set
//  aqui avisa no log quando ela chega assim mesmo.
//
//  ------------------------------------------------------------
//  Cinco regras valem para o arquivo inteiro:
//
//   1. Nada de sintaxe acima de C# 6. O compilador em tempo de
//      execucao do Oxide para nesse teto - sem "out var", sem
//      tupla, sem funcao local, sem pattern matching.
//
//   2. Texto que o jogador le sai do lang, nunca do codigo. O
//      identificador do item e protocolo; o nome e tela.
//
//   3. Toda resposta de comando e JSON de uma linha, com "ok".
//      Quem le e o agente, e ele le linha a linha.
//
//   4. Nenhuma excecao escapa de um hook. Um hook que estoura por
//      causa de UM item marcado derrubaria o inventario de quem
//      nao tem marca nenhuma.
//
//   5. Item sem marca custa uma consulta de dicionario e nada
//      mais. Este plugin roda no OnItemAddedToContainer, que e um
//      dos hooks mais quentes do jogo.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
// Encoding.UTF8, que mede a pagina do origemz.item.pending em
// BYTES - e nao em caracteres: o teto do frame do RCON e de bytes,
// e um nome de jogador com acento ocupa dois.
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
// Interface.Oxide.DataFileSystem, que guarda a fila de pontos.
using Oxide.Core;

namespace Oxide.Plugins
{
    // O nome em [Info], o nome da classe e o nome do arquivo tem de
    // ser identicos, senao o Oxide recusa carregar.
    [Info("OrigemZItems", "OrigemZ", "0.1.0")]
    [Description("Da nome, icone e acao a itens custom. O cadastro mora no RustAgent")]
    public class OrigemZItems : RustPlugin
    {
        // ========================================================
        //  COMANDOS
        //
        //  Prefixo "origemz." porque comando de console no Oxide e
        //  global: sem namespace, dois plugins com um comando
        //  "items" colidiriam.
        //
        //  Todos sao digitaveis a mao no console do servidor, e
        //  isso e proposital: e assim que se testa este plugin sem
        //  o painel, e e assim que se descobre se um defeito e daqui
        //  ou do agente.
        // ========================================================
        private const string SetCommand = "origemz.item.set";
        private const string RemoveCommand = "origemz.item.remove";
        private const string ClearCommand = "origemz.item.clear";
        private const string ListCommand = "origemz.item.list";
        private const string IconCommand = "origemz.item.icon";
        private const string IconBeginCommand = "origemz.item.icon.begin";
        private const string IconPartCommand = "origemz.item.icon.part";
        private const string IconEndCommand = "origemz.item.icon.end";
        private const string DiagCommand = "origemz.item.diag";
        private const string InspectCommand = "origemz.item.inspect";
        private const string AckCommand = "origemz.item.ack";
        private const string PendingCommand = "origemz.item.pending";

        // ========================================================
        //  A REGRA DE LOOT
        //
        //  ####  COMPLEMENTAR, NUNCA SUBSTITUIR  ####
        //
        //  O jogo popula o container normalmente e nos
        //  acrescentamos por cima. Nada aqui reimplementa FillLoot,
        //  PopulateLoot ou GenerateScrap - e o motivo decisivo nao e
        //  seguranca, e o update: a tabela do Rust sao 1.396
        //  entradas que a Facepunch mantem de graca, com filtro de
        //  era e conteudo sazonal. Ver Docs/CustomItem/05 §4.
        //
        //  ####  E POR QUE ISTO PRECISA SER CODIGO, E NAO TABELA  ####
        //
        //  MEDIDO em Docs/CustomItem/04 §4.1: LootSpawn.SpawnIntoContainer
        //  chama ItemManager.Create com `0uL` LITERAL no parametro
        //  da skin, e ItemAmount nao tem campo de skin para
        //  preencher. Um item nascido da tabela nativa sai SEM
        //  marca; o Match() aqui em cima sai em `item.skin == 0UL`;
        //  o item fica com o nome do corpo emprestado e o jogador o
        //  le como lixo.
        //
        //  So o nosso codigo carimba skin. E e por isso que a regra
        //  carrega `base` e `skin` junto - ver ParseLootRule.
        // ========================================================
        private const string LootSetCommand = "origemz.loot.set";
        private const string LootClearCommand = "origemz.loot.clear";
        private const string LootStatsCommand = "origemz.loot.stats";

        // ========================================================
        //  CODIGOS DE ERRO
        //
        //  SCREAMING_SNAKE_CASE, nunca frase para o jogador: quem
        //  traduz e o site. O agente repassa o codigo como veio.
        // ========================================================
        private const string ErrorInvalidArgs = "INVALID_ARGS";
        private const string ErrorInvalidJson = "INVALID_JSON";
        private const string ErrorUnknownBase = "UNKNOWN_BASE_ITEM";
        private const string ErrorZeroSkin = "SKIN_ID_ZERO";
        private const string ErrorDuplicateMark = "DUPLICATE_MARK";
        private const string ErrorUnknownItem = "UNKNOWN_ITEM";
        private const string ErrorServerNotReady = "SERVER_NOT_READY";
        private const string ErrorImageTooLarge = "IMAGE_TOO_LARGE";
        private const string ErrorMissingParts = "MISSING_PARTS";
        private const string ErrorPlayerNotFound = "PLAYER_NOT_FOUND";
        private const string ErrorInternal = "INTERNAL_ERROR";

        // A pagina montada passou do teto do frame. RECUSADA
        // INTEIRA, nunca cortada - o mesmo codigo e o mesmo motivo
        // do origemz.bp.export (OrigemZAgent.cs:3553): resposta
        // truncada chega ao agente como JSON invalido, e uma fila
        // pela metade PARECE ter funcionado. O agente reduz o limit
        // e pede de novo.
        private const string ErrorPayloadTooLarge = "PAYLOAD_TOO_LARGE";

        // ========================================================
        //  O PEDIDO DE SINCRONIZACAO
        //
        //  Mesmo mecanismo do OrigemZAgent (ver o cabecalho dele,
        //  linhas 174-193), pelo mesmo motivo MEDIDO: um
        //  `oxide.reload` esvazia o cache deste plugin sem derrubar
        //  o RCON. Para o agente nada aconteceu - ele nao tem como
        //  saber que o outro lado esqueceu tudo.
        //
        //  Sem isto, o sintoma seria silencioso e tardio: os itens
        //  custom voltariam a ser trofeus comuns, sem nome e sem
        //  efeito, e ninguem descobriria ate um jogador reclamar de
        //  uma bandagem que parou de curar direito.
        // ========================================================
        private const string RequestMarker = "#OZAREQ#";
        private const string RequestItems = "items";

        // ========================================================
        //  O EVENTO DE PONTO
        //
        //  ####  O ITEM E UM RECIBO  ####
        //
        //  Ele nasce, e visto por alguns segundos e morre, deixando
        //  atras de si um numero que so cresce. O plugin CONVERTE; o
        //  agente SOMA. Sao coisas diferentes, e o intervalo entre
        //  elas e onde os pontos se perdem:
        //
        //      t0  o item entra no inventario
        //      t1  o plugin destroi o item          <- irreversivel
        //      t2  o plugin emite o evento
        //      t3  o agente recebe e soma           <- pode falhar
        //
        //  Entre t1 e t3 o ponto nao existe em lugar nenhum. Se o
        //  RCON estiver fora em t2, o jogador perdeu a conquista e
        //  NAO HA COMO SABER.
        //
        //  Dai a ordem deste plugin ser sempre a mesma: ele
        //  REGISTRA NA FILA, so entao destroi, e por ultimo tenta
        //  emitir. Uma queda entre a fila e a emissao e recuperavel;
        //  uma queda depois de destruir sem fila, nao.
        //
        //  Ver Docs\TrofeuBleik\TROFEU_BLEIK_STORE.md §3.5.
        //
        //  ####  O MARCADOR E FEIO DE PROPOSITO  ####
        //
        //  Como o #OZPEVT# do OrigemZPlayer: "#OZSTAT#" nao aparece
        //  em log de servidor, de plugin nem de chat. Um prefixo
        //  bonito seria ambiguo com o que outro plugin imprime.
        // ========================================================
        private const string EventMarker = "#OZSTAT#";

        // ========================================================
        //  ####  O SEGREDO, E POR QUE ELE E OBRIGATORIO  ####
        //
        //  MEDIDO: o gancho onConsoleLine do agente recebe TODA
        //  linha do console, e o chat esta entre elas. Um jogador
        //  que digitasse
        //
        //    #OZSTAT#{"contract":1,"kind":"points","steamId":"<o dele>",
        //             "metric":"trofeu.bleik","amount":9999,...}
        //
        //  estaria mandando um evento de pontuacao direto ao agente.
        //  A ancora do lado de la (PLUGIN_LINE, em
        //  core\src\rankings\stat-events.ts) exige o marcador no
        //  COMECO da linha e barra o chat NATIVO do Rust - mas nao
        //  barra um plugin de chat que imprima a mensagem crua com
        //  Puts, porque ai a linha vira "[AlgumPlugin] #OZSTAT#{...}"
        //  e o carimbo do Oxide e justamente o que a ancora permite.
        //
        //  Num ranking cujo primeiro lugar ganha premio real, isso
        //  nao pode ficar aberto. O desenho e o MESMO do OrigemZUI
        //  (_storeSecret, la em OrigemZUI.cs:166): o agente empurra
        //  um segredo, o plugin o inclui em toda linha marcada, e o
        //  agente descarta em silencio o que nao bate. Quem digita
        //  no chat nao tem o segredo, e nao tem como advinha-lo: ele
        //  e sorteado a cada subida do agente.
        //
        //  ####  E ELE CHEGA PELO origemz.item.clear  ####
        //
        //  Nao por um comando proprio, e nao no set: o `clear` e o
        //  PRIMEIRO comando de toda sincronizacao e o UNICO que sai
        //  mesmo quando o servidor nao tem item custom nenhum
        //  cadastrado. Poe-lo no `set` deixaria um servidor de lista
        //  vazia sem segredo para sempre - e a fila de pontos dele
        //  presa, esperando uma emissao que nunca sairia.
        //
        //  Vazio = nunca recebemos segredo. Neste estado o plugin
        //  NAO EMITE, mas continua enfileirando e destruindo o item:
        //  o evento sai depois, quando o segredo chegar, e o
        //  origemz.item.pending o entrega de qualquer forma. Emitir
        //  sem segredo seria emitir para o agente descartar.
        // ========================================================
        private string _statSecret = "";

        /// <summary>
        /// Ja avisamos que a emissao esta represada?
        ///
        /// Um aviso por CONVERSAO viraria uma enxurrada no log de um
        /// servidor cujo agente esta fora - e log que sempre toca e
        /// log que se aprende a ignorar. O aviso volta a valer
        /// quando o segredo chega e some de novo.
        /// </summary>
        private bool _warnedMissingSecret;

        /// <summary>
        /// O arquivo da fila, em oxide\data.
        ///
        /// ####  ESTE E O UNICO ESTADO QUE O PLUGIN GUARDA  ####
        ///
        /// E ele nao contradiz a regra do cabecalho ("este plugin
        /// nao guarda cadastro"): cadastro e do agente, e some no
        /// reload sem prejuizo. Isto aqui e o contrario - sao
        /// conversoes que JA ACONTECERAM, cujo item ja foi
        /// destruido, e que o agente ainda nao confirmou. Perde-las
        /// e perder ponto de jogador.
        /// </summary>
        private const string QueueFile = "OrigemZItems/pending";

        /// <summary>
        /// Teto da fila.
        ///
        /// Se ela passar disto, o agente esta fora ha muito tempo e
        /// o problema e outro. O teto evita que um servidor sem
        /// agente encha o disco - e o descarte e do MAIS ANTIGO,
        /// avisado no log, porque perder em silencio e o que este
        /// arquivo inteiro existe para impedir.
        /// </summary>
        private const int MaxPending = 5000;

        // ========================================================
        //  A PAGINACAO DA FILA
        //
        //  ####  A FILA INTEIRA NAO CABE NUMA RESPOSTA  ####
        //
        //  Um evento serializado pesa ~200 bytes (eventId de 30,
        //  steamId de 17, nome, metrica, procedencia). Com o teto
        //  de 5.000 da fila, devolve-la inteira daria ~1 MB numa
        //  linha - e ~250 eventos ja enchem o frame do WebRCON. A
        //  resposta truncada nao chega pela metade: ela chega como
        //  JSON invalido e e DESCARTADA, e com ela some o unico
        //  caminho de recuperacao dos pontos ja convertidos.
        //
        //  O molde e o do origemz.bp.export
        //  (OrigemZAgent.cs:3564-3570), copiado de proposito: o
        //  agente ja sabe consumir esta forma (offset/limit
        //  devolvidos, count como TOTAL, recusa inteira por bytes).
        //
        //  100 x ~200 bytes = ~20 KB, com folga de 3x sobre o teto.
        //  O teto de 250 e ~50 KB - ainda abaixo dos 60.000 bytes,
        //  e quem pedir mais leva o limite normalizado de volta na
        //  resposta.
        // ========================================================
        private const int DefaultPendingLimit = 100;
        private const int MaxPendingLimit = 250;

        /// <summary>
        /// Teto de bytes da resposta do `origemz.item.pending`.
        ///
        /// O mesmo numero do origemz.bp.export, pela mesma medida: o
        /// frame do WebRCON aguenta ~70 KB neste projeto, e 60 KB
        /// deixa margem para o servidor sob carga.
        /// </summary>
        private const int MaxPendingBytes = 60000;

        // ========================================================
        //  TETOS
        // ========================================================

        /// <summary>
        /// Teto do icone numa linha so, em bytes de PNG.
        ///
        /// O frame do WebRCON aguenta ~50 KB e base64 infla 4/3 -
        /// medido em OrigemZUI.cs:2513. 33 KB de PNG dao ~45.000
        /// caracteres, que e o mesmo teto que o
        /// UI_IMAGE_MAX_BYTES do agente ja aplica.
        ///
        /// Um icone de 128x128 pesa ~17 KB: o teto tem folga de
        /// sobra, e quem passar dele esta mandando uma foto onde
        /// cabia um icone. Acima disso existe o caminho fatiado.
        /// </summary>
        private const int MaxIconBytes = 33000;

        /// <summary>
        /// Quantos pedacos um icone fatiado pode ter.
        ///
        /// 32 pedacos de ~24 KB dao ~780 KB, muito acima de
        /// qualquer icone honesto. O limite existe para um `begin`
        /// com numero absurdo nao alocar um array gigante antes de
        /// um byte sequer chegar.
        /// </summary>
        private const int MaxIconParts = 32;

        // ========================================================
        //  ESTADO
        //
        //  Tudo aqui e COPIA DE TRABALHO. Some no reload, e e o
        //  pedido de sincronizacao que o traz de volta.
        // ========================================================

        /// <summary>As definicoes, por id do agente.</summary>
        private readonly Dictionary<string, CustomItem> _items =
            new Dictionary<string, CustomItem>();

        /// <summary>
        /// O indice que os hooks consultam: marca -> definicao.
        ///
        /// ####  POR QUE UM INDICE SEPARADO  ####
        ///
        /// O OnItemAddedToContainer dispara para TODO item que
        /// entra em TODO container do servidor - baus, fornalhas,
        /// caixas de loot, o inventario de cada jogador. Varrer a
        /// lista de definicoes a cada disparo seria pagar o custo
        /// do nosso sistema em cima de quem nao usa nada dele.
        ///
        /// Com o indice, item sem marca custa UMA consulta de
        /// dicionario e volta.
        /// </summary>
        private readonly Dictionary<string, CustomItem> _byMark =
            new Dictionary<string, CustomItem>();

        /// <summary>
        /// A imagem de cada item: id -> CRC do FileStorage.
        ///
        /// So o MAPA: os bytes ficam no FileStorage do servidor. E
        /// o CRC nasce dos BYTES, entao reenviar a mesma imagem
        /// devolve o mesmo numero e nao acumula lixo.
        /// </summary>
        private readonly Dictionary<string, uint> _icons =
            new Dictionary<string, uint>();

        /// <summary>
        /// Icones chegando em pedacos, ate o `end`.
        ///
        /// Meio arquivo nunca vira imagem: o `end` confere a
        /// contagem antes de guardar. Um PNG cortado no meio e um
        /// arquivo invalido, e o sintoma seria um quadrado vazio
        /// sem nada dizendo por que.
        /// </summary>
        private readonly Dictionary<string, byte[][]> _iconParts =
            new Dictionary<string, byte[][]>();

        // ========================================================
        //  O ESTADO DA REGRA DE LOOT
        //
        //  ####  ELE GRAVA EM DISCO, E ESTA E A SEGUNDA EXCECAO  ####
        //
        //  O cabecalho deste arquivo diz que o plugin nao guarda
        //  cadastro, e a fila de pontos ja abriu uma excecao a isso.
        //  Esta e a segunda, e as duas tem o mesmo formato de
        //  argumento: o que se guarda AQUI nao pode ser
        //  reconstruido a tempo.
        //
        //  Tres coisas moram neste arquivo, e cada uma tem uma razao
        //  propria:
        //
        //   1. AS REGRAS. Decisao do dono, Q1 do Docs/CustomItem/05:
        //      a configuracao vale desde a PRIMEIRA caixa do boot. E
        //      o mapa nasce antes de o agente mandar qualquer coisa
        //      - MEDIDO: BaseNetworkable.Spawn chama ServerInit()
        //      (que popula o loot) muito antes de qualquer
        //      OnServerInitialized. Uma regra que chegue depois nao
        //      volta atras: as caixas ja nasceram;
        //
        //   2. OS CONTADORES. Sao a MEDICAO, e ela e o ponto inteiro
        //      do modo `measuring`. Um `oxide.reload` no meio do dia
        //      zeraria a contagem e o teto diario viraria "teto por
        //      carga do plugin" - numa madrugada de tres reloads, o
        //      dia renderia tres vezes o teto, e ninguem perceberia
        //      porque nada quebrou. Ver Docs/CustomItem/04 §5.1;
        //
        //   3. OS COOLDOWNS. Mesma coisa, do lado do jogador: um
        //      reload devolveria o direito a quem acabou de levar.
        //
        //  ####  E O AGENTE NAO E A FONTE DA VERDADE DOS DOIS
        //        ULTIMOS  ####
        //
        //  Ele COPIA os contadores (ver origemz.loot.stats), e a
        //  copia e por sobrescrita: ler nao consome, e o numero
        //  continua aqui. Uma leitura perdida se conserta sozinha na
        //  volta seguinte.
        // ========================================================

        /// <summary>Onde as regras, os contadores e os cooldowns moram.</summary>
        private const string LootFile = "OrigemZItems/loot";

        /// <summary>
        /// Quantos dias de contagem ficam guardados.
        ///
        /// O agente le de minuto em minuto, entao uma semana e folga
        /// larga: ela cobre um agente parado o fim de semana inteiro.
        /// Guardar para sempre faria o arquivo crescer sem teto por
        /// causa de um numero que ja foi copiado.
        /// </summary>
        private const int LootCounterDays = 7;

        /// <summary>
        /// De quanto em quanto tempo o estado vai para o disco.
        ///
        /// ####  GRAVAR A CADA SORTEIO SERIA GRAVAR MILHARES DE
        ///       VEZES POR DIA  ####
        ///
        /// MEDIDO em Docs/CustomItem/05 §2.6: 71 dos 105 containers
        /// tem refresh de 1 a 2 h, e so os barris de mundo aberto
        /// dao da ordem de 6.400 populacoes por dia. O contador sobe
        /// nesse ritmo.
        ///
        /// O preco desta escolha e claro e pequeno: uma queda do
        /// servidor perde ate um minuto de CONTAGEM. Nao perde item,
        /// nao perde ponto e nao perde regra - a regra so muda
        /// quando o agente manda, e ai a gravacao e imediata.
        /// </summary>
        private const float LootSaveEverySeconds = 60f;

        /// <summary>As regras, por id do agente.</summary>
        private readonly Dictionary<string, LootRule> _lootRules =
            new Dictionary<string, LootRule>();

        /// <summary>
        /// O indice que o OnLootSpawn consulta: prefab -> regras.
        ///
        /// ####  ELE E O QUE TORNA O HOOK BARATO  ####
        ///
        /// O OnLootSpawn dispara para todo container que nasce E a
        /// cada refresh dele. Varrer a lista de regras a cada
        /// disparo seria pagar o custo do nosso sistema em cima de
        /// um servidor que talvez nao tenha regra nenhuma. Com o
        /// indice, um container sem regra custa UMA consulta de
        /// dicionario e volta - a mesma regra 5 do cabecalho.
        /// </summary>
        private readonly Dictionary<string, List<LootRule>> _lootByContainer =
            new Dictionary<string, List<LootRule>>();

        /// <summary>
        /// O indice do PORTAO: marca (baseItemId:skin) -> regras.
        ///
        /// O CanAcceptItem precisa responder "este item veio de uma
        /// regra com cooldown?" olhando so para o item que tem na
        /// mao. A marca e a unica coisa que o item carrega.
        /// </summary>
        private readonly Dictionary<string, List<LootRule>> _lootByMark =
            new Dictionary<string, List<LootRule>>();

        /// <summary>
        /// Os contadores, por "regra|dia|modo".
        ///
        /// O MODO entra na chave de proposito: o dia em que alguem
        /// virou a chave de `measuring` para `live` tem duas linhas,
        /// e e isso que permite dizer "com esta chance, teria dado
        /// tantos" ao lado de "deu tantos".
        /// </summary>
        private Dictionary<string, LootCounter> _lootCounters =
            new Dictionary<string, LootCounter>();

        /// <summary>
        /// Quando cada jogador levou o item de cada regra.
        ///
        /// Chave "regra|steamId", valor em epoch de SEGUNDOS. E o
        /// que o portao do OnLootEntity consulta.
        /// </summary>
        private Dictionary<string, long> _lootCooldowns =
            new Dictionary<string, long>();

        /// <summary>Ha coisa nova para gravar? Ver LootSaveEverySeconds.</summary>
        private bool _lootDirty;

        /// <summary>
        /// A quem ja avisamos, nesta abertura, que o portao barrou.
        ///
        /// Sem isto, o RefreshLoot que roda a cada abertura mandaria
        /// a mesma frase de novo a cada vez que o jogador reabrisse
        /// a caixa - e a frase e um aviso, nao um alarme.
        /// </summary>
        private readonly Dictionary<string, double> _lootWarned =
            new Dictionary<string, double>();

        /// <summary>Quanto tempo o aviso do portao fica quieto, em segundos.</summary>
        private const double LootWarnQuietSeconds = 60.0;

        // ========================================================
        //  CICLO DE VIDA
        // ========================================================

        /// <summary>
        /// Roda no CARREGAMENTO do plugin, antes de o mundo nascer.
        ///
        /// ####  E E POR ISSO QUE A REGRA DE LOOT E LIDA AQUI  ####
        ///
        /// MEDIDO: BaseNetworkable.Spawn chama ServerInit(), que e
        /// quem popula o loot, muito ANTES de qualquer
        /// OnServerInitialized. Ler as regras la seria ler depois de
        /// o mapa inteiro de barris ja ter nascido - e uma regra que
        /// chega tarde nao volta atras.
        ///
        /// E a decisao do dono na Q1 do Docs/CustomItem/05: a
        /// configuracao vale desde a primeira caixa do boot.
        /// </summary>
        private void Init()
        {
            LoadLoot();
        }

        private void OnServerInitialized()
        {
            LoadQueue();

            // ####  OS INDICES SAO REFEITOS AGORA  ####
            //
            // As regras vieram do disco no Init(), quando o
            // ItemManager ainda podia nao estar montado - e sem ele
            // o shortname do item base nao vira itemid, que e a
            // metade da marca de que o portao precisa.
            //
            // Refazer aqui custa uma varredura de algumas dezenas de
            // regras, uma vez por boot.
            RebuildLootIndexes();

            // O contador sobe milhares de vezes por dia; gravar a
            // cada sorteio seria gravar disco no caminho quente. Ver
            // LootSaveEverySeconds para o que se perde numa queda.
            timer.Every(LootSaveEverySeconds, delegate { SaveLootIfDirty(); });

            // O pedido vai DEPOIS de o servidor subir: em Init() o
            // console ainda nao e lido de forma confiavel, e um
            // pedido perdido e um plugin que fica vazio para sempre.
            RequestSync();

            // E o que ficou pendente de antes sai agora. Ver o
            // cabecalho do EventMarker: sao conversoes cujo item JA
            // FOI DESTRUIDO e que o agente nunca confirmou - se elas
            // nao forem reenviadas, o jogador perdeu a conquista.
            //
            // ####  E AQUI ELA AINDA NAO EMITE NADA  ####
            //
            // O segredo mora em memoria e nasce vazio a cada carga
            // do plugin, entao neste ponto a fila esta represada por
            // definicao. Quem a solta e o `clear` que o agente manda
            // logo em seguida - o RequestSync acima e o pedido, e o
            // segredo vem junto da resposta. A chamada fica porque
            // ela custa uma comparacao e porque e ela que garante o
            // reenvio no dia em que a emissao nao depender de
            // segredo.
            FlushQueueSafe();
        }

        private void Unload()
        {
            // Os itens ja entregues nao mudam: a marca esta gravada
            // neles, no jogo. O que se perde e a identidade aplicada
            // (nome e icone) e o efeito - e os dois voltam quando o
            // plugin recarrega e o agente reenvia.
            _items.Clear();
            _byMark.Clear();
            _icons.Clear();
            _iconParts.Clear();

            // ####  A MEDICAO NAO PODE MORRER NO RELOAD  ####
            //
            // O relogio de um minuto pode nao ter passado desde o
            // ultimo sorteio, e um `oxide.reload` no meio do dia
            // levaria a contagem e as carencias junto. As REGRAS nao
            // sao limpas aqui de proposito: elas moram no disco, e
            // e delas que o proximo Init() parte.
            SaveLootIfDirty();

            _lootRules.Clear();
            _lootByContainer.Clear();
            _lootByMark.Clear();
            _lootWarned.Clear();

            // Os relogios do agrupamento morrem com o plugin (o
            // Oxide os cancela), mas os baldes nao: deixa-los
            // faria a proxima carga achar que ja ha uma mensagem
            // armada para aquele jogador, e a dele nunca sairia.
            _pendingChat.Clear();
        }

        /// <summary>
        /// Pede ao agente a lista de itens custom.
        ///
        /// Uma linha marcada no console, que o agente ja le inteiro.
        /// E o mesmo canal dos eventos de jogador, com o mesmo
        /// marcador.
        /// </summary>
        private void RequestSync()
        {
            Puts(RequestMarker + RequestItems);
        }

        // ========================================================
        //  origemz.item.set <json>
        //
        //  Cadastra ou atualiza UMA definicao. O agente manda uma
        //  por linha, e nao um lote: um lote de 40 itens estouraria
        //  o frame do RCON, e o erro apareceria como "o item 37 nao
        //  existe" sem ninguem entender por que.
        //
        //  {"id":"trofeu-bleik","name":"Trofeu Bleik Store",
        //   "base":"trophy","skin":"3000000001",
        //   "action":{"kind":"consume","consumes":1,
        //             "effects":[{"type":"Health","amount":40}]}}
        // ========================================================
        [ConsoleCommand(SetCommand)]
        private void CommandSet(ConsoleSystem.Arg arg)
        {
            // arg.Connection != null quer dizer que veio de um
            // jogador no F1, e nao do RCON. Cadastro e do agente.
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                if (!arg.HasArgs(1))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                // O JSON vem inteiro, e nao fatiado por espaco: um
                // nome de item com espaco ("Trofeu Bleik Store") e o
                // caso normal, nao a excecao.
                //
                // O ToString e obrigatorio: FullString e um
                // Facepunch.StringView, e nao uma string - ele nao
                // converte sozinho.
                string raw = arg.FullString.ToString();

                JObject body;

                try
                {
                    body = JObject.Parse(raw);
                }
                catch (Exception)
                {
                    arg.ReplyWith(BuildError(ErrorInvalidJson));
                    return;
                }

                CustomItem item = ParseItem(body);

                if (item == null)
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                // O item base tem de existir NESTA versao do jogo.
                // Conferir aqui e conferir no cadastro; nao conferir
                // seria descobrir dias depois, na entrega, com o
                // jogador esperando.
                ItemDefinition definition = ItemManager.FindItemDefinition(item.Base);

                if (definition == null)
                {
                    arg.ReplyWith(BuildError(ErrorUnknownBase));
                    return;
                }

                item.BaseItemId = definition.itemid;

                // ####  A COMBINACAO QUE NASCE INERTE  ####
                //
                // "converte quando o jogador USAR" em cima de um
                // item base que nao e consumivel produz um item
                // que nao faz nada: o OnItemUse do Oxide so
                // dispara em quem tem ItemModConsumable, e o menu
                // do botao direito e montado pelo CLIENTE a partir
                // da ItemDefinition - nao ha como acrescentar
                // opcao nela.
                //
                // A rota do agente ja recusa isto no cadastro. O
                // aviso aqui e para o que ela nao alcanca: um
                // cadastro gravado por uma versao anterior, ou um
                // origemz.item.set digitado a mao no console.
                //
                // AVISA E ACEITA, e nao recusa: o item continua
                // valendo pelo nome e pelo icone, e recusar a
                // definicao inteira o deixaria sem os dois
                // tambem.
                if (!item.ConsumeOnPickup &&
                    item.Action != null &&
                    item.Action.Kind == "points" &&
                    !DefinitionIsConsumable(definition))
                {
                    string inert = "o item custom " + item.Id + " converte em ponto SO AO USAR, mas o " +
                                   "item base " + item.Base + " nao e consumivel - o jogador nao tem como " +
                                   "usa-lo, e o item vai ficar no inventario sem virar ponto. Troque o modo " +
                                   "para \"assim que cair no inventario\" ou escolha um item base consumivel.";

                    // Adiado pelo mesmo motivo do Puts do Emit:
                    // este metodo responde a um comando, e um
                    // aviso sincrono aqui pode virar A RESPOSTA
                    // dele - e o agente leria o aviso no lugar do
                    // JSON de confirmacao.
                    timer.Once(0f, delegate { PrintWarning(inert); });
                }

                // Ver o cabecalho: skin 0 e indistinguivel de item
                // comum E derruba o jogador pelo caminho do CUI.
                if (item.Skin == 0UL)
                {
                    arg.ReplyWith(BuildError(ErrorZeroSkin));
                    return;
                }

                string mark = MarkOf(item.BaseItemId, item.Skin);

                // Duas definicoes com a mesma marca deixariam os
                // hooks sem criterio para escolher. O agente ja
                // impede isso com um indice unico, mas o plugin
                // tambem pode receber comando digitado a mao.
                CustomItem existing;

                if (_byMark.TryGetValue(mark, out existing) && existing.Id != item.Id)
                {
                    arg.ReplyWith(BuildError(ErrorDuplicateMark));
                    return;
                }

                // Atualizar e substituir: se a marca mudou, o indice
                // velho tem de sair, senao o item antigo continuaria
                // sendo reconhecido por uma definicao que ja nao
                // existe.
                Forget(item.Id);

                _items[item.Id] = item;
                _byMark[mark] = item;

                arg.ReplyWith("{\"ok\":true,\"id\":" + JsonConvert.ToString(item.Id) +
                              ",\"mark\":" + JsonConvert.ToString(mark) + "}");
            }
            catch (Exception ex)
            {
                PrintError(SetCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        [ConsoleCommand(RemoveCommand)]
        private void CommandRemove(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                if (!arg.HasArgs(1))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                string id = arg.GetString(0, "");

                if (!_items.ContainsKey(id))
                {
                    arg.ReplyWith(BuildError(ErrorUnknownItem));
                    return;
                }

                Forget(id);

                // O icone NAO e apagado do FileStorage: outro item
                // pode estar usando a mesma imagem, e o CRC e o
                // mesmo para bytes iguais. Lixo de imagem e barato;
                // apagar a imagem de quem ainda a usa nao e.
                _icons.Remove(id);

                arg.ReplyWith("{\"ok\":true}");
            }
            catch (Exception ex)
            {
                PrintError(RemoveCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        /// <summary>
        /// Esquece TUDO, e recebe o segredo da rodada.
        ///
        /// O agente manda isto antes de reenviar a lista, para que
        /// um item apagado no painel nao continue vivo aqui.
        ///
        ///     origemz.item.clear [&lt;segredo&gt;]
        ///
        /// ####  POR QUE O SEGREDO VIAJA JUNTO DESTE COMANDO  ####
        ///
        /// Ver o cabecalho do _statSecret: este e o unico comando da
        /// sincronizacao que sai SEMPRE, inclusive num servidor sem
        /// item custom nenhum - e e o primeiro deles, entao quando o
        /// primeiro `set` chegar o segredo ja esta aqui.
        ///
        /// ####  E O ARGUMENTO E OPCIONAL DE PROPOSITO  ####
        ///
        /// `origemz.item.clear` digitado a mao no console (que e
        /// como se testa este plugin, ver o cabecalho dos comandos)
        /// NAO pode desarmar a emissao de pontos: sem argumento, o
        /// segredo que ja temos fica. Zerar ali deixaria o servidor
        /// mudo ate a proxima sincronizacao, e ninguem ligaria uma
        /// coisa a outra.
        /// </summary>
        [ConsoleCommand(ClearCommand)]
        private void CommandClear(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                int had = _items.Count;

                _items.Clear();
                _byMark.Clear();

                string secret = arg.HasArgs(1) ? arg.GetString(0, "").Trim() : "";
                bool arrived = secret.Length > 0 && secret != _statSecret;

                if (arrived)
                {
                    _statSecret = secret;

                    // O aviso de "emissao represada" volta a valer:
                    // se este segredo tambem for recusado la, quem
                    // olhar o log vai ver de novo.
                    _warnedMissingSecret = false;
                }

                if (arrived && _pending.Count > 0)
                {
                    // ####  O QUE FICOU REPRESADO SAI AGORA  ####
                    //
                    // Sem esta linha, uma conversao que aconteceu
                    // antes do primeiro `clear` (item destruido,
                    // ponto na fila, nada emitido) so sairia na
                    // proxima conversao ou na varredura de cinco
                    // minutos do agente. Ela nao se PERDERIA - o
                    // origemz.item.pending a entrega -, mas esperar
                    // por acaso o que se pode resolver agora e
                    // deixar o jogador olhando um numero parado.
                    //
                    // O aviso vai adiado um frame pelo mesmo motivo
                    // do FlushQueue (ver la): um Puts dentro de um
                    // ConsoleCommand vira A RESPOSTA do comando, e
                    // este comando ja tem a dele.
                    string released = "segredo recebido: soltando " +
                                      _pending.Count.ToString(CultureInfo.InvariantCulture) +
                                      " conversao(oes) que estavam represadas.";

                    timer.Once(0f, delegate { Puts(released); });

                    FlushQueueSafe();
                }

                // Os icones ficam: os bytes continuam no FileStorage do
                // servidor e o CRC nao muda. Reenviar todos a cada
                // sincronizacao seria pagar megabytes para chegar aos
                // mesmos numeros.
                //
                // O `hasSecret` e diagnostico: e a resposta de "por
                // que este servidor nao emite #OZSTAT#?" sem ter de
                // ler o codigo.
                arg.ReplyWith("{\"ok\":true,\"forgotten\":" + had.ToString(CultureInfo.InvariantCulture) +
                              ",\"hasSecret\":" + (_statSecret.Length > 0 ? "true" : "false") + "}");
            }
            catch (Exception ex)
            {
                PrintError(ClearCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        /// <summary>
        /// O que o plugin conhece agora.
        ///
        /// Existe para o diagnostico humano: e a diferenca entre "o
        /// agente nao mandou" e "o agente mandou e o plugin recusou".
        /// </summary>
        [ConsoleCommand(ListCommand)]
        private void CommandList(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                List<ItemSummary> list = new List<ItemSummary>();

                foreach (KeyValuePair<string, CustomItem> entry in _items)
                {
                    CustomItem item = entry.Value;

                    uint crc;
                    bool hasIcon = _icons.TryGetValue(item.Id, out crc);

                    ItemSummary summary = new ItemSummary();
                    summary.Id = item.Id;
                    summary.Name = item.Name;
                    summary.Base = item.Base;
                    summary.BaseItemId = item.BaseItemId;
                    summary.Skin = item.Skin.ToString(CultureInfo.InvariantCulture);
                    summary.Action = item.Action == null ? "none" : item.Action.Kind;
                    summary.IconCrc = hasIcon ? crc : 0U;

                    list.Add(summary);
                }

                arg.ReplyWith(JsonConvert.SerializeObject(new ListResponse
                {
                    Ok = true,
                    Count = list.Count,
                    Items = list
                }));
            }
            catch (Exception ex)
            {
                PrintError(ListCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // ========================================================
        //  A IMAGEM DO ITEM
        //
        //  ####  O CLIENTE BAIXA UMA VEZ  ####
        //
        //  Os bytes vao para o FileStorage do SERVIDOR, que devolve
        //  um CRC. O que viaja para o cliente dentro do item sao os
        //  QUATRO BYTES do CRC - nunca o PNG. O cliente pede a
        //  imagem so na primeira vez que encontra um CRC que nao
        //  conhece, e a guarda.
        //
        //  E o CRC nasce do CONTEUDO. Imagem igual -> mesmo numero
        //  -> o cliente reusa. Imagem trocada -> numero novo -> ele
        //  baixa a nova. Nao ha versao a incrementar nem cache a
        //  limpar: trocar a arte de um item e substituir o PNG.
        // ========================================================
        [ConsoleCommand(IconCommand)]
        private void CommandIcon(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                if (!arg.HasArgs(2))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                string id = arg.GetString(0, "");
                byte[] bytes = DecodeBase64(arg.GetString(1, ""));

                if (string.IsNullOrEmpty(id) || bytes == null || bytes.Length == 0)
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                if (bytes.Length > MaxIconBytes)
                {
                    // Recusado, e nao cortado: meio PNG e um arquivo
                    // invalido, e o sintoma seria um quadrado vazio.
                    arg.ReplyWith(BuildError(ErrorImageTooLarge));
                    return;
                }

                StoreIcon(arg, id, bytes);
            }
            catch (Exception ex)
            {
                PrintError(IconCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        [ConsoleCommand(IconBeginCommand)]
        private void CommandIconBegin(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(2))
            {
                return;
            }

            string id = arg.GetString(0, "");
            int parts = arg.GetInt(1, 0);

            if (string.IsNullOrEmpty(id) || parts <= 0 || parts > MaxIconParts)
            {
                arg.ReplyWith(BuildError(ErrorInvalidArgs));
                return;
            }

            _iconParts[id] = new byte[parts][];
            arg.ReplyWith("{\"ok\":true}");
        }

        [ConsoleCommand(IconPartCommand)]
        private void CommandIconPart(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(3))
            {
                return;
            }

            string id = arg.GetString(0, "");
            int index = arg.GetInt(1, -1);

            byte[][] parts;

            if (!_iconParts.TryGetValue(id, out parts) || index < 0 || index >= parts.Length)
            {
                arg.ReplyWith(BuildError(ErrorInvalidArgs));
                return;
            }

            byte[] chunk = DecodeBase64(arg.GetString(2, ""));

            if (chunk == null)
            {
                arg.ReplyWith(BuildError(ErrorInvalidArgs));
                return;
            }

            parts[index] = chunk;
            arg.ReplyWith("{\"ok\":true}");
        }

        [ConsoleCommand(IconEndCommand)]
        private void CommandIconEnd(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(1))
            {
                return;
            }

            try
            {
                string id = arg.GetString(0, "");

                byte[][] parts;

                if (!_iconParts.TryGetValue(id, out parts))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                _iconParts.Remove(id);

                // A contagem e conferida ANTES de guardar. Um pedaco
                // que se perdeu no caminho viraria um PNG cortado, e
                // guardar um PNG cortado daria um CRC valido para um
                // arquivo invalido - o pior desfecho possivel,
                // porque parece que deu certo.
                int total = 0;

                for (int i = 0; i < parts.Length; i++)
                {
                    if (parts[i] == null)
                    {
                        arg.ReplyWith(BuildError(ErrorMissingParts));
                        return;
                    }

                    total += parts[i].Length;
                }

                byte[] bytes = new byte[total];
                int offset = 0;

                for (int i = 0; i < parts.Length; i++)
                {
                    Buffer.BlockCopy(parts[i], 0, bytes, offset, parts[i].Length);
                    offset += parts[i].Length;
                }

                StoreIcon(arg, id, bytes);
            }
            catch (Exception ex)
            {
                PrintError(IconEndCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        /// <summary>
        /// Guarda os bytes no FileStorage e anota o CRC.
        ///
        /// O terceiro argumento do Store e a entidade dona do
        /// arquivo. Usamos a CommunityEntity - a mesma que o
        /// OrigemZUI ja usa para as imagens do menu - porque ela
        /// existe enquanto o servidor existir. Amarrar a imagem de
        /// um item a uma entidade que pode ser destruida faria a
        /// arte sumir junto com ela.
        /// </summary>
        private void StoreIcon(ConsoleSystem.Arg arg, string id, byte[] bytes)
        {
            if (CommunityEntity.ServerInstance == null)
            {
                // O servidor ainda nao terminou de subir. O agente
                // reenvia na proxima sincronizacao, entao isto se
                // resolve sozinho.
                arg.ReplyWith(BuildError(ErrorServerNotReady));
                return;
            }

            uint crc = FileStorage.server.Store(
                bytes,
                FileStorage.Type.png,
                CommunityEntity.ServerInstance.net.ID);

            _icons[id] = crc;

            Puts("icone " + id + ": " + bytes.Length.ToString(CultureInfo.InvariantCulture) +
                 " bytes, crc " + crc.ToString(CultureInfo.InvariantCulture));

            arg.ReplyWith("{\"ok\":true,\"crc\":" + crc.ToString(CultureInfo.InvariantCulture) + "}");
        }

        // ========================================================
        //  RECONHECIMENTO E IDENTIDADE
        // ========================================================

        /// <summary>
        /// A chave do indice: item base e skin, juntos.
        ///
        /// String, e nao um numero combinado: o itemid e int (pode
        /// ser negativo) e a skin e ulong. Nao ha inteiro que
        /// carregue os dois sem truque, e um truque aqui seria uma
        /// colisao silenciosa entre dois itens diferentes.
        /// </summary>
        private static string MarkOf(int baseItemId, ulong skin)
        {
            return baseItemId.ToString(CultureInfo.InvariantCulture) + ":" +
                   skin.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// Este item e nosso? Devolve null quando nao e.
        ///
        /// E o caminho quente do plugin: chamado para todo item que
        /// entra em qualquer container do servidor. Por isso ele sai
        /// cedo e faz uma consulta so.
        /// </summary>
        private CustomItem Match(Item item)
        {
            if (item == null || item.info == null)
            {
                return null;
            }

            // Sem skin nao ha marca, e a esmagadora maioria dos
            // itens do servidor cai aqui. E a saida mais barata.
            if (item.skin == 0UL)
            {
                return null;
            }

            CustomItem found;

            return _byMark.TryGetValue(MarkOf(item.info.itemid, item.skin), out found) ? found : null;
        }

        /// <summary>
        /// Poe o nome e o icone nossos no item.
        ///
        /// ####  POR QUE ISTO E APLICADO E NAO CONFIGURADO  ####
        ///
        /// Nome e icone sao campos da INSTANCIA (Item.name,
        /// Item.iconImageId), e nao da definicao. Escrever neles
        /// afeta este item e mais nenhum - que e exatamente a
        /// garantia que a regra do cabecalho exige.
        ///
        /// ####  O icone e uma HIPOTESE  ####
        ///
        /// MEDIDO: o campo iconImageId existe na classe Item e no
        /// ProtoBuf.Item, ou seja, ele VIAJA na rede. NAO MEDIDO: se
        /// o Item.Save o copia para o pacote, e se o cliente o
        /// respeita num item comum. O `origemz.item.diag` existe
        /// para responder isso - ver a secao de diagnostico.
        ///
        /// Se a hipotese cair, o item fica com o icone do item base
        /// e todo o resto continua funcionando. E por isso que ela
        /// pode ser testada em producao sem risco.
        /// </summary>
        private void ApplyIdentity(Item item, CustomItem custom)
        {
            bool changed = false;

            if (!string.IsNullOrEmpty(custom.Name) && item.name != custom.Name)
            {
                item.name = custom.Name;
                changed = true;
            }

            uint crc;

            if (_icons.TryGetValue(custom.Id, out crc) && crc != 0U && item.iconImageId != crc)
            {
                item.iconImageId = crc;
                changed = true;
            }

            // ####  O CAMPO `text` E UMA HIPOTESE EM TESTE  ####
            //
            // MEDIDO: ele existe em ProtoBuf.Item e viaja na rede.
            // NAO MEDIDO: onde o cliente o desenha. O item `note` o
            // usa para o texto do bilhete, e ninguem sabe se um item
            // comum o mostra em algum lugar do painel.
            //
            // A CustomItemDefinitions NAO o usa - ela poe a descricao
            // no ownership, que o exemplo oficial dela chama de
            // "ToolTip". Se o `text` funcionar, ele e melhor: texto
            // corrido no painel, e nao frase escondida atras do
            // mouse.
            //
            // Custa uma atribuicao. Se nao aparecer em lugar nenhum,
            // sai daqui e fica so o ownership.
            if (!string.IsNullOrEmpty(custom.Description) && item.text != custom.Description)
            {
                item.text = custom.Description;
                changed = true;
            }

            if (ApplyDescription(item, custom))
            {
                changed = true;
            }

            if (changed)
            {
                // Sem o MarkDirty o cliente continua vendo o que
                // tinha: a alteracao fica so no servidor ate algo
                // mais forcar a atualizacao daquele slot.
                item.MarkDirty();
            }
        }

        /// <summary>
        /// A descricao nossa, no painel do item.
        ///
        /// ####  POR QUE ELA VAI NO LUGAR DA PROCEDENCIA  ####
        ///
        /// Porque NAO EXISTE campo de descricao no protocolo. O
        /// ProtoBuf.Item carrega itemid, name, text, skinid,
        /// iconImageId e ownership - e mais nada que sirva. A
        /// descricao que o jogador le vem da ItemDefinition, que e
        /// do jogo: sem ela, um trofeu nosso continua dizendo "Um
        /// trofeu dedicado aos sobreviventes do Rust Twitch Rivals",
        /// que e a descricao do item que emprestou o corpo.
        ///
        /// O `ownership` e a lista de "quem te deu isto e por que" -
        /// linhas de rotulo e texto que o cliente ja desenha no
        /// painel do item. Escrever a descricao ali e o mesmo desvio
        /// que a CustomItemDefinitions faz (AddOwnership, no
        /// Mutate.Item.Description dela), e pelo mesmo motivo.
        ///
        /// E um DESVIO, e vale dizer: a descricao original continua
        /// aparecendo acima. Nao ha como apaga-la sem trocar a
        /// ItemDefinition, e trocar a ItemDefinition e o que este
        /// plugin nao faz.
        /// </summary>
        private static bool ApplyDescription(Item item, CustomItem custom)
        {
            if (string.IsNullOrEmpty(custom.Description))
            {
                return false;
            }

            if (item.ownershipShares == null)
            {
                item.ownershipShares = new List<ItemOwnershipShare>();
            }

            // Reaplicar a cada entrada em container empilharia a
            // mesma frase dezenas de vezes no painel. O rotulo e a
            // marca de que ela ja esta la.
            //
            // ItemOwnershipShare e STRUCT, e nao classe: nao ha o
            // que comparar com null aqui, e o compilador recusa se
            // tentarmos.
            for (int i = 0; i < item.ownershipShares.Count; i++)
            {
                if (item.ownershipShares[i].username == DescriptionLabel)
                {
                    return false;
                }
            }

            ItemOwnershipShare share = new ItemOwnershipShare();
            share.username = DescriptionLabel;
            share.reason = custom.Description;
            share.amount = item.amount;

            item.ownershipShares.Add(share);
            return true;
        }

        /// <summary>
        /// O rotulo da linha de descricao no painel do item.
        ///
        /// Ele e o que distingue a NOSSA linha das outras que o jogo
        /// possa escrever ali - e e por ele que ApplyDescription
        /// sabe que nao precisa escrever de novo.
        /// </summary>
        private const string DescriptionLabel = "SOBRE O ITEM";

        // ========================================================
        //  HOOKS
        //
        //  Nenhum deles faz trabalho quando o item nao tem marca.
        //  Ver a regra 5 do cabecalho.
        // ========================================================

        /// <summary>
        /// O item entrou num container: e a hora de vesti-lo.
        ///
        /// Este hook pega TODOS os caminhos de entrada de uma vez -
        /// o `origemz.give` da loja, o kit do respawn, o item pego
        /// do chao, o que veio de um bau ou de um corpo. Um hook por
        /// caminho deixaria buracos, e o buraco apareceria como "o
        /// troféu que veio da loja tem nome e o que veio do bau nao".
        /// </summary>
        private void OnItemAddedToContainer(ItemContainer container, Item item)
        {
            try
            {
                CustomItem custom = Match(item);

                if (custom == null)
                {
                    return;
                }

                ApplyIdentity(item, custom);

                if (!custom.ConsumeOnPickup)
                {
                    return;
                }

                // ####  SO CONVERTE NA MAO DE UM JOGADOR  ####
                //
                // O hook dispara para TODO container do servidor -
                // baus, fornalhas, caixas de loot. Converter na caixa
                // faria o trofeu virar ponto de ninguem, e sumir
                // antes de o jogador chegar nele.
                BasePlayer owner = container == null ? null : container.playerOwner;

                if (owner == null || owner.IsNpc)
                {
                    return;
                }

                // ####  A CONVERSAO E ADIADA UM TICK  ####
                //
                // Destruir o item DENTRO do hook de adicao mexe na
                // colecao que o jogo esta percorrendo neste instante.
                // Um NextTick custa ~16 ms e evita comportamento
                // indefinido.
                //
                // A quantidade e lida AGORA: depois do NextTick o
                // item pode ter sido movido, e ler la daria o numero
                // errado. Ver Docs\TrofeuBleik §3.3.
                int amount = item.amount;
                CustomItem captured = custom;
                BasePlayer player = owner;

                NextTick(delegate { ConsumeOnPickup(player, item, captured, amount); });
            }
            catch (Exception ex)
            {
                // Ver a regra 4 do cabecalho: um item marcado com
                // defeito nao pode derrubar o inventario de quem nao
                // tem marca nenhuma.
                PrintError("OnItemAddedToContainer falhou: " + ex);
            }
        }

        /// <summary>
        /// O item foi largado no chao: veste-o ali tambem.
        ///
        /// ####  POR QUE ELE FALTAVA  ####
        ///
        /// O OnItemAddedToContainer pega o item que ENTRA num
        /// container, e o item entregue direto no chao nunca entra
        /// em nenhum. O sintoma que o dono viu no jogo foi o trofeu
        /// dado pelo painel no modo "No chao" aparecendo com o nome
        /// do corpo emprestado - "TROFEU DISCORD" - em vez do nosso.
        ///
        /// ####  O QUE FOI MEDIDO NO ASSEMBLY DO SERVIDOR  ####
        ///
        /// Item.Save copia Item.name para ProtoBuf.Item.name;
        /// WorldItem.Save poe o Item INTEIRO em
        /// ProtoBuf.WorldItem.item; e do outro lado o
        /// WorldItem.Load reconstroi o Item pelo ItemManager.Load,
        /// que devolve o name ao campo. Ou seja: o nome VIAJA no
        /// pacote do item que esta no chao, e o cliente tem uma
        /// copia viva do NOSSO Item, e nao so a ItemDefinition.
        ///
        /// O que o cliente DESENHA com esse campo nao da para medir
        /// daqui: o Assembly-CSharp do servidor vem com os corpos
        /// da UI vazios - o ItemIcon.OnPointerEnter e um `ret`
        /// pelado. Esta e a unica peca que falta confirmar, e quem
        /// confirma e o dono olhando o item no chao.
        ///
        /// ####  DEPOIS DO SPAWN AINDA DA TEMPO  ####
        ///
        /// O hook dispara no fim do Item.Drop, com a entidade ja
        /// nascida. A mudanca nao se perde: o
        /// WorldItem.InitializeItem assina o Item.OnDirty, e o
        /// MarkDirty que o ApplyIdentity faz cai no
        /// WorldItem.OnItemDirty, que manda um ClientRPC
        /// "UpdateItem" com o item reserializado.
        ///
        /// ####  AQUI NAO SE CONVERTE EM PONTO  ####
        ///
        /// Um trofeu no chao nao e de ninguem. Converter aqui daria
        /// ponto ao ar - ou ao ultimo que passou por perto. A
        /// conversao continua morando so no caminho do container de
        /// um jogador de verdade.
        /// </summary>
        private void OnItemDropped(Item item, BaseEntity entity)
        {
            try
            {
                CustomItem custom = Match(item);

                if (custom == null)
                {
                    return;
                }

                // MEDIDO: o `entity` chega nulo quando o Item.Drop
                // desistiu de criar a entidade - posicao zero, ou
                // item com a flag de nao-dropavel - e removeu o item
                // em vez de solta-lo. Vestir o que ja nao existe nao
                // quebra nada, mas tambem nao serve para nada.
                if (entity == null)
                {
                    return;
                }

                ApplyIdentity(item, custom);
            }
            catch (Exception ex)
            {
                PrintError("OnItemDropped falhou: " + ex);
            }
        }

        /// <summary>
        /// Uma entidade nasceu. So interessa quando ela e um item
        /// no chao que ninguem largou.
        ///
        /// ####  POR QUE UM SEGUNDO HOOK, SE JA HA O OnItemDropped  ####
        ///
        /// Porque nem todo item que aparece no mundo passa pelo
        /// Item.Drop. MEDIDO no assembly: o DropUtil.DropItems - o
        /// que espalha o conteudo de um barril ou de uma caixa
        /// DESTRUIDA - chama Item.CreateWorldObject direto, sem
        /// passar pelo Drop e portanto sem disparar o
        /// OnItemDropped. O mesmo vale para Pinata.OnDied, para o
        /// LargeShredder e para o `spawnitem` do console.
        ///
        /// Em teoria o item do barril ja estaria vestido: ele
        /// esteve num container antes, e o OnItemAddedToContainer
        /// teria passado por ele. Na pratica NAO esta, e a razao e
        /// esta: o cadastro so chega ao plugin depois do
        /// OnServerInitialized (ver RequestSync), e todo o loot que
        /// nasceu ate la - o mapa inteiro de barris - entrou nos
        /// containers com o _byMark ainda vazio. Um `oxide.reload`
        /// recria a mesma situacao, porque o Unload limpa o indice.
        ///
        /// Este hook e a rede que pega esse item no instante em que
        /// ele vira coisa do mundo. E ele roda ANTES do
        /// SendNetworkUpdateImmediate do BaseNetworkable.Spawn: o
        /// nome ja sai no PRIMEIRO pacote, sem piscar.
        ///
        /// ####  O CUSTO, QUE AQUI E O ASSUNTO  ####
        ///
        /// Este e o hook mais quente que este plugin toca: dispara
        /// para toda entidade que nasce - cada barril, cada arvore,
        /// cada projetil. Por isso as saidas vem em ordem de preco,
        /// e a primeira e a que cobre o servidor inteiro:
        ///
        ///   1. _byMark.Count == 0 - leitura de um int. Enquanto o
        ///      cadastro nao chegou, tudo sai por aqui;
        ///   2. `as WorldItem` - um isinst, o teste de tipo mais
        ///      barato do CLR, e descarta tudo que nao e item no
        ///      chao;
        ///   3. o item nulo - o ItemPickup.Spawn (item de mapa)
        ///      nasce assim, com o Item preenchido so depois;
        ///   4. o Match, que ja sai em `skin == 0` para qualquer
        ///      item do jogo base.
        ///
        /// Nenhuma das quatro aloca.
        /// </summary>
        private void OnEntitySpawned(BaseNetworkable entity)
        {
            try
            {
                if (_byMark.Count == 0)
                {
                    return;
                }

                WorldItem worldItem = entity as WorldItem;

                if (worldItem == null || worldItem.item == null)
                {
                    return;
                }

                CustomItem custom = Match(worldItem.item);

                if (custom == null)
                {
                    return;
                }

                // Mesma regra do OnItemDropped: veste, e so. Um item
                // que nasce no chao nao e de jogador nenhum, e o
                // ConvertToPoints nao pode ser chamado daqui.
                ApplyIdentity(worldItem.item, custom);
            }
            catch (Exception ex)
            {
                PrintError("OnEntitySpawned falhou: " + ex);
            }
        }

        /// <summary>
        /// Alguem abriu uma caixa, um airdrop ou um corpo: veste o
        /// que estiver la dentro.
        ///
        /// ####  POR QUE ISTO E PRECISO SE HA O HOOK DE ENTRADA  ####
        ///
        /// Pela mesma razao do OnEntitySpawned: o hook de entrada
        /// so veste o item que entra DEPOIS de o cadastro chegar. O
        /// trofeu que ja estava no bau, no airdrop ou no corpo desde
        /// antes do sync nunca passou por ele - e um item parado num
        /// container nao dispara mais nada sozinho.
        ///
        /// Aqui o preco e desprezivel: o hook so dispara quando um
        /// jogador abre alguma coisa, e o que se varre e um
        /// container de dezenas de slots, nao o mapa.
        ///
        /// ####  AQUI TAMBEM NAO SE CONVERTE  ####
        ///
        /// Abrir um bau nao e receber o item. Quem converte e o
        /// OnItemAddedToContainer, quando o item entra no
        /// inventario de quem abriu.
        /// </summary>
        private void OnLootEntity(BasePlayer player, BaseEntity entity)
        {
            try
            {
                if (_byMark.Count == 0 || player == null)
                {
                    return;
                }

                // ####  POR QUE UM TICK DEPOIS  ####
                //
                // MEDIDO: o PlayerLoot.StartLootingEntity chama este
                // hook ANTES de o AddContainer entrar na lista. No
                // instante do disparo a lista `containers` ainda
                // esta vazia, e ler ali nao acharia nada.
                BasePlayer looter = player;

                NextTick(delegate { RefreshLoot(looter); });
            }
            catch (Exception ex)
            {
                PrintError("OnLootEntity falhou: " + ex);
            }
        }

        /// <summary>
        /// Veste o que estiver aberto na frente do jogador.
        ///
        /// Roda um tick depois do OnLootEntity, quando a lista de
        /// containers do PlayerLoot ja esta montada. Vale para
        /// qualquer coisa que se abre - bau, forno, airdrop, corpo,
        /// mochila de morte - sem precisar conhecer o tipo de
        /// nenhuma delas.
        /// </summary>
        private void RefreshLoot(BasePlayer player)
        {
            try
            {
                if (player == null || player.inventory == null ||
                    player.inventory.loot == null)
                {
                    return;
                }

                List<ItemContainer> containers = player.inventory.loot.containers;

                if (containers == null)
                {
                    return;
                }

                for (int i = 0; i < containers.Count; i++)
                {
                    RefreshContainer(containers[i]);
                }
            }
            catch (Exception ex)
            {
                // O NextTick tirou este codigo de dentro do try do
                // hook: sem este catch a excecao subiria para o laco
                // do Oxide, e nao para o nosso log.
                PrintError("RefreshLoot falhou: " + ex);
            }
        }

        /// <summary>
        /// Gasta o item assim que ele chega, e executa a acao.
        ///
        /// ####  A ORDEM AQUI E A REGRA MAIS IMPORTANTE  ####
        ///
        ///   1. REGISTRA na fila (em disco, antes de tudo);
        ///   2. destroi o item;
        ///   3. tenta emitir.
        ///
        /// Trocar 1 e 2 de lugar abre a janela em que o item ja nao
        /// existe e o ponto ainda nao foi anotado em lugar nenhum -
        /// e uma queda ali perde a conquista sem deixar rastro.
        /// </summary>
        private void ConsumeOnPickup(BasePlayer player, Item item, CustomItem custom, int amount)
        {
            try
            {
                // O item pode ter sido consumido ou movido entre o
                // hook e este tick.
                if (item == null || Match(item) == null)
                {
                    return;
                }

                // ####  amount <= 0 E RECUSADO EXPLICITAMENTE  ####
                //
                // O Rust concede 1 unidade para um item com amount 0
                // - ou seja, confiar no jogo aqui daria um ponto de
                // graca. Ver Docs\CustomItem §11, armadilha 7.
                if (amount <= 0 || item.amount <= 0)
                {
                    return;
                }

                if (player == null || !player.IsConnected)
                {
                    return;
                }

                if (custom.Action != null && custom.Action.Kind == "points")
                {
                    // A sequencia inteira - fila, destruicao, recibo
                    // e emissao - mora no ConvertToPoints, que e o
                    // MESMO metodo que o caminho do USO chama. Ver o
                    // remarks de la para por que a ordem importa, e
                    // por que os dois momentos nao podem divergir.
                    ConvertToPoints(player, item, custom, amount);
                    return;
                }

                if (custom.Action != null && custom.Action.Kind == "consume")
                {
                    ApplyEffects(player, custom.Action);
                }

                // Aqui nao havia ponto a registrar, entao nao ha
                // janela nenhuma a proteger: o item so some.
                Consume(item, amount);

                if (!string.IsNullOrEmpty(custom.Message))
                {
                    // Com os marcadores resolvidos: mandar a
                    // mensagem crua faria o jogador ler "{pontos}"
                    // na tela, que e o defeito que o cadastro do
                    // painel convida a cometer.
                    player.ChatMessage(FormatMessage(custom, 0, player.UserIDString));
                }
            }
            catch (Exception ex)
            {
                PrintError("ConsumeOnPickup falhou: " + ex);
            }
        }

        // ========================================================
        //  A FILA
        // ========================================================

        /// <summary>As conversoes que o agente ainda nao confirmou.</summary>
        private List<StatEvent> _pending = new List<StatEvent>();

        /// <summary>
        /// Quantas conversoes ja sairam desta carga do plugin.
        /// </summary>
        /// <remarks>
        /// ####  ELE SUBSTITUIU UM SORTEIO, E O MOTIVO E MEDIDO  ####
        ///
        /// A versao anterior fechava o eventId com
        /// Random.Range(1000, 9999). Quatro conversoes no MESMO
        /// milissegundo - que e exatamente o que dar quatro
        /// trofeus de uma vez produz - tinham chance real de
        /// sortear o mesmo numero, e duas conversoes com o mesmo
        /// id fazem o agente descartar a segunda como duplicata.
        /// O jogador perderia um ponto, e nada no log diria isso.
        ///
        /// Um contador nao sorteia: dentro de uma carga ele nunca
        /// repete. Entre cargas quem separa e o milissegundo, e
        /// duas cargas do plugin no mesmo ms nao acontecem.
        /// </remarks>
        private int _eventCounter;

        /// <summary>
        /// Um identificador unico da conversao.
        ///
        /// ####  ELE E O QUE IMPEDE PONTO DOBRADO  ####
        ///
        /// A fila reenvia no boot e a cada conversao nova. Sem um
        /// id estavel por conversao, um ACK perdido faria o MESMO
        /// evento entrar duas vezes e dobrar o ponto de alguem,
        /// sem nada no log. Quem deduplica e o agente, e este id e
        /// a chave dele.
        ///
        /// O formato e o do contrato: steamId-epoch-contador. Ver
        /// Docs/CustomItem/03 §8.1.
        /// </summary>
        private string NewEventId(BasePlayer player)
        {
            _eventCounter++;

            return player.UserIDString + "-" +
                   DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) +
                   "-" + _eventCounter.ToString(CultureInfo.InvariantCulture);
        }

        private void Enqueue(StatEvent pending)
        {
            _pending.Add(pending);

            // Ver MaxPending: descarte do MAIS ANTIGO, e avisado.
            // Perder em silencio e o que este arquivo existe para
            // impedir.
            while (_pending.Count > MaxPending)
            {
                PrintWarning("fila de pontos cheia (" + MaxPending +
                             "): descartando a conversao mais antiga. O agente esta fora ha muito tempo?");
                _pending.RemoveAt(0);
            }

            SaveQueue();
        }

        /// <summary>
        /// Manda o que esta pendente, e NAO limpa.
        ///
        /// Quem limpa e o `origemz.item.ack`, quando o agente
        /// confirma que gravou. Limpar aqui seria confiar que a
        /// linha chegou - e a linha some quando o RCON cai, que e
        /// justamente o caso que a fila existe para cobrir.
        /// </summary>
        private void FlushQueue()
        {
            // ####  SEM SEGREDO, NAO SE EMITE - E ISSO NAO PERDE PONTO  ####
            //
            // Ver o cabecalho do _statSecret. Uma linha sem segredo
            // e descartada pelo agente, entao emiti-la seria so
            // gastar frame do RCON. O que NAO acontece aqui e
            // parar de enfileirar: a conversao ja esta em disco, o
            // item ja morreu, e ela sai por um dos dois caminhos -
            // o `clear` seguinte, que traz o segredo e chama este
            // metodo de novo, ou o origemz.item.pending, que
            // entrega a fila sem depender de segredo nenhum (a
            // resposta e do comando DELE, e nao uma linha solta no
            // console).
            if (_statSecret.Length == 0)
            {
                if (_pending.Count > 0 && !_warnedMissingSecret)
                {
                    _warnedMissingSecret = true;

                    string held = "fila de pontos SEGURA: " +
                                  _pending.Count.ToString(CultureInfo.InvariantCulture) +
                                  " conversao(oes) esperando o segredo do agente (ele chega no " +
                                  ClearCommand + "). Nada foi perdido - o " + PendingCommand +
                                  " as entrega assim mesmo.";

                    // Adiado pelo mesmo motivo do Puts la embaixo:
                    // este metodo e chamado de dentro do
                    // ConsumeOnPickup, que roda num hook disparado
                    // pelo origemz.give - e um aviso sincrono ali
                    // viraria A RESPOSTA do give.
                    timer.Once(0f, delegate { PrintWarning(held); });
                }

                return;
            }

            for (int i = 0; i < _pending.Count; i++)
            {
                Emit(_pending[i]);
            }
        }

        /// <summary>
        /// Manda UM evento pelo console.
        ///
        /// Extraido do FlushQueue para que o caminho normal de uma
        /// conversao emita SO o evento novo.
        ///
        /// ####  MEDIDO EM 06/09/2026, NO SERVIDOR  ####
        ///
        /// Tres trofeus entregues de uma vez produziram SEIS linhas
        /// no console: a cada conversao, a fila inteira saia de
        /// novo. Dez conversoes dariam 55 linhas para 10 pontos - e
        /// o frame do RCON e justamente o recurso escasso deste
        /// caminho.
        ///
        /// O reenvio em lote continua existindo para o que FICOU
        /// para tras (boot, RCON que voltou, segredo que chegou
        /// atrasado). Ele so nao e mais o caminho normal.
        /// </summary>
        private void Emit(StatEvent pending)
        {
            if (_statSecret.Length == 0)
            {
                // Ver o FlushQueue: sem segredo a linha seria
                // descartada pelo agente. A conversao ja esta em
                // disco e sai pelo `clear` seguinte.
                return;
            }

            {
                // ####  O SEGREDO ENTRA NA LINHA, E NAO NO EVENTO  ####
                //
                // O StatEvent e serializado em dois lugares: aqui e
                // no arquivo da fila (e, dele, na resposta do
                // origemz.item.pending). Um campo Secret na classe
                // apareceria nos tres - ou seja, o segredo iria
                // parar em oxide\data, sobrevivendo ao restart que
                // justamente o sorteia de novo, e viajaria de volta
                // ao agente numa resposta que nao precisa dele.
                //
                // Injetar no JObject custa uma copia por evento, num
                // caminho que roda por CONVERSAO, e mantem o disco
                // limpo.
                JObject payload = JObject.FromObject(pending);
                payload["secret"] = _statSecret;

                string line = EventMarker + payload.ToString(Formatting.None);

                // ####  O ADIAMENTO NAO E ESTILO  ####
                //
                // E a correcao de um bug JA MEDIDO neste projeto,
                // em OrigemZPlayer.cs:463-484: um Puts disparado
                // dentro de um hook que veio de um COMANDO sai com o
                // mesmo Identifier e vira A RESPOSTA daquele comando.
                //
                // E o caminho que ativa isso aqui e o mais comum de
                // todos:
                //
                //   origemz.give -> item entra -> hook converte -> Puts
                //
                // Sem o timer, o `give` morre com
                // PLUGIN_INVALID_RESPONSE *e* o ponto nunca chega -
                // os dois de uma vez. Ver Docs\CustomItem §8.3.
                timer.Once(0f, delegate { Puts(line); });
            }
        }

        /// <summary>
        /// Um evento, sem deixar excecao escapar do hook.
        ///
        /// O `null` sai calado: o ConsumeOnPickup passa null quando
        /// a acao nao era `points`, e reclamar disso seria reclamar
        /// do caminho normal de uma bandagem.
        /// </summary>
        private void EmitSafe(StatEvent pending)
        {
            if (pending == null)
            {
                return;
            }

            try
            {
                Emit(pending);
            }
            catch (Exception ex)
            {
                PrintError("nao consegui emitir o ponto: " + ex);
            }
        }

        /// <summary>
        /// O reenvio em lote, sem deixar nada escapar.
        ///
        /// ####  POR QUE ESTA CASCA EXISTE  ####
        ///
        /// O FlushQueue e chamado de OnServerInitialized, que e um
        /// HOOK - e a regra 4 do cabecalho nao admite excecao
        /// escapando de hook nenhum. Uma conversao com um campo
        /// impossivel de serializar derrubaria a subida do plugin
        /// inteiro; assim ela vira uma linha no log, e as outras
        /// saem.
        /// </summary>
        private void FlushQueueSafe()
        {
            try
            {
                FlushQueue();
            }
            catch (Exception ex)
            {
                PrintError("nao consegui emitir a fila de pontos: " + ex);
            }
        }

        private void LoadQueue()
        {
            try
            {
                _pending = Interface.Oxide.DataFileSystem.ReadObject<List<StatEvent>>(QueueFile);

                if (_pending == null)
                {
                    _pending = new List<StatEvent>();
                }

                if (_pending.Count > 0)
                {
                    Puts("fila de pontos: " + _pending.Count + " conversao(oes) esperando o agente.");
                }
            }
            catch (Exception ex)
            {
                // Arquivo ilegivel NAO vira fila vazia gravada por
                // cima: sobrescrever apagaria as conversoes que
                // ninguem conseguiu ler, e com elas os pontos. A
                // fila fica vazia em memoria e o arquivo intacto,
                // para alguem olhar.
                PrintError("fila de pontos ilegivel, seguindo VAZIA sem gravar por cima: " + ex.Message);
                _pending = new List<StatEvent>();
            }
        }

        private void SaveQueue()
        {
            try
            {
                Interface.Oxide.DataFileSystem.WriteObject(QueueFile, _pending);
            }
            catch (Exception ex)
            {
                // O item ja foi (ou esta prestes a ser) destruido, e
                // a fila e o unico registro. Se ela nao grava, o log
                // e a ultima linha de defesa.
                PrintError("NAO CONSEGUI GRAVAR A FILA DE PONTOS: " + ex);
            }
        }

        // ========================================================
        //  origemz.item.ack <id> [<id> ...]
        //
        //  O agente confirma que gravou. So entao a fila esquece.
        // ========================================================
        [ConsoleCommand(AckCommand)]
        private void CommandAck(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                if (!arg.HasArgs(1))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                int before = _pending.Count;

                // `arg.Args` e Facepunch.StringView[] nesta versao do
                // jogo, e nao string[] - o GetString normaliza sem
                // depender do tipo interno, que ja mudou uma vez.
                for (int i = 0; i < arg.Args.Length; i++)
                {
                    string id = arg.GetString(i, "");

                    if (string.IsNullOrEmpty(id))
                    {
                        continue;
                    }

                    for (int j = _pending.Count - 1; j >= 0; j--)
                    {
                        if (_pending[j].EventId == id)
                        {
                            _pending.RemoveAt(j);
                        }
                    }
                }

                if (_pending.Count != before)
                {
                    SaveQueue();
                }

                arg.ReplyWith("{\"ok\":true,\"pending\":" +
                              _pending.Count.ToString(CultureInfo.InvariantCulture) + "}");
            }
            catch (Exception ex)
            {
                PrintError(AckCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // ========================================================
        //  origemz.item.pending [<offset>] [<limit>]
        //
        //  O que ainda nao foi confirmado. Existe para o
        //  diagnostico humano - e a diferenca entre "o agente nao
        //  recebeu" e "o agente recebeu e nao gravou" - e, mais que
        //  isso, e o CAMINHO DE RECUPERACAO do ponto: o item que a
        //  originou ja foi destruido, e esta lista e a unica copia.
        //
        //  ####  ELE E PAGINADO, E A PAGINA SO SABE RECUSAR  ####
        //
        //  Ver o cabecalho de DefaultPendingLimit. A resposta inteira
        //  nao cabe no frame do WebRCON, e uma resposta truncada nao
        //  chega pela metade: chega como JSON invalido e e
        //  descartada. Entao a pagina passou do teto de bytes e ela
        //  e recusada INTEIRA, com PAYLOAD_TOO_LARGE - o agente
        //  reduz o limit e pede de novo, sem avancar o offset.
        //
        //  O contrato e o mesmo do origemz.bp.export
        //  (OrigemZAgent.cs:3632-3762), porque o consumidor do outro
        //  lado e o mesmo laco:
        //
        //    {"ok":true,"count":<TOTAL>,"offset":N,"limit":M,
        //     "pending":[...]}
        //
        //  `count` e o TOTAL da fila, e nao o tamanho da pagina:
        //  quem avanca e o limit DEVOLVIDO, e o fim e o count. Uma
        //  pagina menor que o limit nao quer dizer fim de lista.
        // ========================================================
        [ConsoleCommand(PendingCommand)]
        private void CommandPending(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            // Excecao que sobe de um ConsoleCommand vindo do RCON
            // nao produz resposta nenhuma, e o agente fica pendurado
            // ate o timeout. Todo caminho de saida responde alguma
            // coisa - e este responde a fila que ninguem mais tem.
            try
            {
                arg.ReplyWith(HandlePending(arg));
            }
            catch (Exception ex)
            {
                PrintError(PendingCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandlePending(ConsoleSystem.Arg arg)
        {
            int offset;
            if (!TryReadInt(arg, 0, 0, out offset) || offset < 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            int limit;
            if (!TryReadInt(arg, 1, DefaultPendingLimit, out limit) || limit < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // O teto e aplicado em silencio, e o limit NORMALIZADO
            // volta na resposta: e por ele que o agente avanca. Quem
            // pede 5.000 recebe 250 e anda 250 - avancar 5.000
            // pularia a fila inteira e daria a lista por lida.
            if (limit > MaxPendingLimit)
            {
                limit = MaxPendingLimit;
            }

            // long para nao estourar: offset int.MaxValue com limit
            // 250 dobraria para negativo em int, e a janela passaria
            // a nunca casar - por acidente, e nao por regra.
            long end = (long)offset + limit;

            List<StatEvent> page = new List<StatEvent>();

            for (int i = offset; i < _pending.Count && i < end; i++)
            {
                page.Add(_pending[i]);
            }

            string json = JsonConvert.SerializeObject(new PendingResponse
            {
                Ok = true,
                Count = _pending.Count,
                Offset = offset,
                Limit = limit,
                Pending = page
            });

            // ####  RECUSA INTEIRA, NUNCA CORTE  ####
            //
            // Cortar aqui devolveria uma fila pela metade que o
            // agente aceitaria como completa - e ele CONFIRMA o que
            // recebe. O que ficasse de fora seria esquecido dos dois
            // lados: o item ja foi destruido, e o ponto sumiria sem
            // nada no log.
            if (Encoding.UTF8.GetByteCount(json) > MaxPendingBytes)
            {
                string tooLarge = PendingCommand + ": pagina de " +
                                  page.Count.ToString(CultureInfo.InvariantCulture) +
                                  " evento(s) passou de " +
                                  MaxPendingBytes.ToString(CultureInfo.InvariantCulture) +
                                  " bytes e foi recusada inteira. O agente reduz o limit e pede de novo.";

                // Adiado um frame: o aviso sai de dentro de um
                // ConsoleCommand, e escrever no console daqui
                // disputaria com a resposta que este mesmo comando
                // esta prestes a dar (OrigemZPlayer.cs:463-484).
                timer.Once(0f, delegate { PrintWarning(tooLarge); });

                return BuildError(ErrorPayloadTooLarge);
            }

            return json;
        }

        /// <summary>
        /// Duas pilhas do nosso item tentaram virar uma.
        ///
        /// ####  ISTO SO SABE DIMINUIR  ####
        ///
        /// E a limitacao mais importante deste plugin, e ela e do
        /// jogo, nao nossa. O teto de empilhamento vive no
        /// `stackable` da ItemDefinition - que e do JOGO. Baixar o
        /// teto e facil: o jogo tenta empilhar e nos recusamos.
        /// SUBIR e impossivel daqui, porque a recusa vem antes,
        /// dentro do proprio jogo, e nunca chega a este hook.
        ///
        /// Em numeros: um `trophy` empilha 1 nativamente. Configurar
        /// maxStack 5 nele NAO faz nada - continua 1. Ja um
        /// `xmas.present.medium`, que empilha 5, aceita ser limitado
        /// a 2.
        ///
        /// As duas saidas para quem precisa de MAIS, e nenhuma passa
        /// por aqui:
        ///
        ///   1. escolher um item base que ja empilhe o quanto se
        ///      quer (e a saida barata, e a recomendada);
        ///   2. a biblioteca CustomItemDefinitions, que cria uma
        ///      definicao COPIA e pode mexer no stackable dela sem
        ///      tocar na do jogo. Custa uma dependencia critica -
        ///      ver Docs\CustomItem\01-PESQUISA §3.6.
        ///
        /// Devolver false impede o empilhamento.
        /// </summary>
        private object CanStackItem(Item item, Item targetItem)
        {
            try
            {
                CustomItem custom = Match(item);

                if (custom == null || custom.MaxStack <= 0)
                {
                    return null;
                }

                // So empilha com igual: dois itens custom
                // diferentes, ou um custom com um comum, ja sao
                // recusados pelo jogo por causa da skin.
                if (targetItem == null)
                {
                    return null;
                }

                if (targetItem.amount + item.amount > custom.MaxStack)
                {
                    return false;
                }

                return null;
            }
            catch (Exception ex)
            {
                PrintError("CanStackItem falhou: " + ex);
                return null;
            }
        }

        /// <summary>
        /// O jogador tentou colocar o item no chao.
        ///
        /// ####  POR QUE ISTO PRECISA EXISTIR  ####
        ///
        /// Porque o item custom EMPRESTA o corpo, e o corpo traz os
        /// habitos junto. O `trophy` do jogo e deployable: um Trofeu
        /// Bleik feito em cima dele nasce colocavel no chao, e
        /// vira decoracao de base em vez de premio.
        ///
        /// Nao da para tirar o ItemModDeployable sem mexer na
        /// ItemDefinition - que e do jogo, e que este plugin nao
        /// toca. Entao a recusa acontece aqui, no gesto.
        ///
        /// Devolver nao-nulo cancela a colocacao.
        /// </summary>
        private object CanDeployItem(BasePlayer player, Deployer deployer, NetworkableId entityId)
        {
            try
            {
                if (deployer == null)
                {
                    return null;
                }

                Item item = deployer.GetItem();
                CustomItem custom = Match(item);

                if (custom == null || !custom.BlockDeploy)
                {
                    return null;
                }

                if (player != null)
                {
                    // Recusar em silencio faria o jogador achar que
                    // o servidor travou. A frase e curta e diz o que
                    // aconteceu.
                    player.ChatMessage(Msg(MsgCannotDeploy, player.UserIDString));
                }

                return false;
            }
            catch (Exception ex)
            {
                PrintError("CanDeployItem falhou: " + ex);
                return null;
            }
        }

        // ========================================================
        //  A TRAVA DO ITEM QUE AINDA NAO VIROU PONTO
        //
        //  ####  ELA SO EXISTE NO MODO "AO USAR"  ####
        //
        //  No modo de pegada o item nem chega a existir: ele entra
        //  no inventario e some no mesmo tick, e as tres
        //  proibicoes do briefing (guardar, dropar, transferir) se
        //  resolvem de graca - nao ha o que guardar.
        //
        //  Adiar a conversao para o USO desfaz isso: o trofeu fica
        //  no inventario, e dali ele pode ir para um bau, para o
        //  chao ou para a mao de outro jogador. Estes dois hooks
        //  sao a defesa em profundidade que fecha os dois
        //  primeiros caminhos.
        //
        //  ####  E TRANSFERIR NAO PRECISA SER PERFEITO  ####
        //
        //  De proposito. Transferir nao e exploit: e troca de soma
        //  ZERO. Quem recebe converte, quem deu nao converteu, e o
        //  total da rede nao muda. O que precisa ser perfeito e a
        //  EMISSAO (a fila em disco, o eventId), e nao a
        //  circulacao. Ver Docs\CustomItem\03 §7.4.
        // ========================================================

        /// <summary>
        /// Este item esta esperando o jogador usa-lo?
        ///
        /// `true` so para a combinacao "acao de pontos" +
        /// "converte ao usar". Todo o resto - item comum, item de
        /// cura, trofeu de pegada - sai daqui em duas comparacoes,
        /// que e o que mantem os hooks abaixo baratos.
        /// </summary>
        private static bool AwaitsUse(CustomItem custom)
        {
            return custom != null &&
                   !custom.ConsumeOnPickup &&
                   custom.Action != null &&
                   custom.Action.Kind == "points";
        }

        /// <summary>
        /// O item vai entrar num container: pode?
        /// </summary>
        /// <remarks>
        /// ####  A ASSINATURA TEM QUATRO PARAMETROS, E O JOGADOR E O ULTIMO  ####
        ///
        /// MEDIDO no IL do Assembly-CSharp deste servidor: o Oxide
        /// chama CallHook("CanAcceptItem", this, item, targetPos,
        /// player) de dentro de
        /// ItemContainer.CanAcceptItem(BasePlayer, Item, int).
        /// Declarar com tres parametros nao daria erro nenhum - o
        /// hook simplesmente nunca dispararia, que e o defeito mais
        /// caro possivel aqui: a trava pareceria existir.
        ///
        /// ####  E O RETORNO E O ENUM, NAO UM BOOL  ####
        ///
        /// O jogo faz `unbox.any CanAcceptResult` no que este
        /// metodo devolver. Um `false` aqui estouraria com
        /// InvalidCastException dentro do jogo, em todo container
        /// do servidor.
        /// </remarks>
        private object CanAcceptItem(ItemContainer container, Item item, int targetPos, BasePlayer player)
        {
            try
            {
                CustomItem custom = Match(item);

                if (!AwaitsUse(custom))
                {
                    return null;
                }

                // O inventario de um JOGADOR (mochila, barra,
                // roupa) tem playerOwner. Bau, forno, caixa de
                // loot e o container de dentro de uma mochila nao
                // tem - e sao exatamente esses que "guardar"
                // significa.
                if (container != null && container.playerOwner != null)
                {
                    return null;
                }

                if (player != null)
                {
                    // Recusar em silencio faria o jogador achar
                    // que o servidor travou.
                    player.ChatMessage(Msg(MsgCannotStore, player.UserIDString));
                }

                return ItemContainer.CanAcceptResult.CannotAccept;
            }
            catch (Exception ex)
            {
                // Ver a regra 4 do cabecalho. Devolver null aqui e
                // deixar o jogo decidir, que e o comportamento de
                // sempre para quem nao tem marca.
                PrintError("CanAcceptItem falhou: " + ex);
                return null;
            }
        }

        /// <summary>
        /// O jogador arrastou o item. Nao-nulo CANCELA o gesto.
        /// </summary>
        /// <remarks>
        /// ####  DESTINO QUE NAO EXISTE E O CHAO  ####
        ///
        /// MEDIDO no IL do PlayerInventory.MoveItem: o hook e
        /// CallHook("CanMoveItem", item, this, targetContainer,
        /// targetSlot, amount, modifier) - SEIS parametros nesta
        /// versao do jogo, e o ultimo e novo.
        ///
        /// Arrastar o item para fora da janela do inventario chega
        /// aqui com um targetContainer que o FindContainer nao
        /// acha, e o jogo entao o larga no mundo (Item.Drop, la
        /// dentro do MoveToContainer). E esse o caminho que esta
        /// linha fecha.
        ///
        /// O menu do botao direito ("Largar") NAO passa por aqui:
        /// ele e outra RPC, e quem o pega e o OnItemAction.
        /// </remarks>
        private object CanMoveItem(Item item, PlayerInventory playerLoot, ItemContainerId targetContainer,
                                   int targetSlot, int amount, ItemMoveModifier modifier)
        {
            try
            {
                CustomItem custom = Match(item);

                if (!AwaitsUse(custom) || playerLoot == null)
                {
                    return null;
                }

                if (playerLoot.FindContainer(targetContainer) != null)
                {
                    // Ha um container de destino de verdade. Quem
                    // decide se ele aceita e o CanAcceptItem acima
                    // - repetir a regra aqui daria duas respostas
                    // para a mesma pergunta.
                    return null;
                }

                BasePlayer player = item.GetOwnerPlayer();

                if (player != null)
                {
                    player.ChatMessage(Msg(MsgCannotDrop, player.UserIDString));
                }

                return false;
            }
            catch (Exception ex)
            {
                PrintError("CanMoveItem falhou: " + ex);
                return null;
            }
        }

        /// <summary>
        /// O jogador entrou: veste o que ele ja tinha.
        ///
        /// Necessario porque o OnItemAddedToContainer so dispara na
        /// ENTRADA. Um troféu que ja estava no bau antes deste
        /// plugin carregar nunca passaria por ele - e ficaria sem
        /// nome ate ser movido de slot.
        /// </summary>
        private void OnPlayerConnected(BasePlayer player)
        {
            try
            {
                RefreshInventory(player);
            }
            catch (Exception ex)
            {
                PrintError("OnPlayerConnected falhou: " + ex);
            }
        }

        private void RefreshInventory(BasePlayer player)
        {
            if (player == null || player.inventory == null || _byMark.Count == 0)
            {
                return;
            }

            RefreshContainer(player.inventory.containerMain);
            RefreshContainer(player.inventory.containerBelt);
            RefreshContainer(player.inventory.containerWear);
        }

        private void RefreshContainer(ItemContainer container)
        {
            if (container == null || container.itemList == null)
            {
                return;
            }

            for (int i = 0; i < container.itemList.Count; i++)
            {
                Item item = container.itemList[i];
                CustomItem custom = Match(item);

                if (custom != null)
                {
                    ApplyIdentity(item, custom);
                }
            }
        }

        // ========================================================
        //  A ACAO
        //
        //  ####  DOIS HOOKS, E POR QUE OS DOIS  ####
        //
        //  OnItemAction pega o MENU do botao direito ("Beber
        //  conteudo", "Largar", "Estudar") e traz o jogador junto.
        //  OnItemUse pega o consumo direto, e nao traz - o dono sai
        //  do proprio item.
        //
        //  Nenhum dos dois permite CRIAR uma opcao nova no menu: os
        //  rotulos e icones de la sao Phrase e Sprite, assets do
        //  cliente. O que se faz e trocar o que ACONTECE ao clicar.
        //  Quando a acao merece tela propria, o lugar dela e o CUI,
        //  onde texto e icone ja sao nossos.
        // ========================================================

        /// <summary>
        /// Uma acao do menu do item. Nao-nulo CANCELA a original.
        /// </summary>
        private object OnItemAction(Item item, string action, BasePlayer player)
        {
            try
            {
                CustomItem custom = Match(item);

                // ####  "LARGAR" PELO MENU, NO MODO AO USAR  ####
                //
                // O menu do botao direito nao passa pelo
                // CanMoveItem: ele e outra RPC, e chega aqui com
                // action = "drop". Sem esta recusa a trava teria
                // um buraco do tamanho de dois cliques.
                //
                // Ela vem ANTES da comparacao com o Trigger de
                // proposito: o gesto que dispara a acao do item e
                // "use", e o "drop" nunca casaria com ele.
                if (AwaitsUse(custom) &&
                    (string.Equals(action, "drop", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(action, "drop_item", StringComparison.OrdinalIgnoreCase)))
                {
                    if (player != null)
                    {
                        player.ChatMessage(Msg(MsgCannotDrop, player.UserIDString));
                    }

                    return true;
                }

                if (custom == null || custom.Action == null)
                {
                    return null;
                }

                // A acao configurada tem de ser ESTA. Um item nosso
                // cuja acao e "use" nao pode sequestrar o "drop" do
                // jogador - ele ficaria sem conseguir largar o item.
                if (!string.Equals(custom.Action.Trigger, action, StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }

                if (player == null)
                {
                    return null;
                }

                return RunAction(player, item, custom) ? (object)true : null;
            }
            catch (Exception ex)
            {
                PrintError("OnItemAction falhou: " + ex);
                return null;
            }
        }

        /// <summary>
        /// O consumo direto. Nao-nulo CANCELA o efeito original.
        /// </summary>
        private object OnItemUse(Item item, int amount)
        {
            try
            {
                CustomItem custom = Match(item);

                if (custom == null || custom.Action == null)
                {
                    return null;
                }

                if (!string.Equals(custom.Action.Trigger, "use", StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }

                BasePlayer player = item.GetOwnerPlayer();

                if (player == null)
                {
                    return null;
                }

                return RunAction(player, item, custom) ? (object)true : null;
            }
            catch (Exception ex)
            {
                PrintError("OnItemUse falhou: " + ex);
                return null;
            }
        }

        /// <summary>
        /// Executa a acao. Devolve true quando ela foi nossa.
        /// </summary>
        private bool RunAction(BasePlayer player, Item item, CustomItem custom)
        {
            CustomAction action = custom.Action;

            // ####  A CONVERSAO PELO USO  ####
            //
            // E o segundo momento possivel do item que vira ponto: o
            // cadastro pode dizer "converte assim que cai no
            // inventario" (ConsumeOnPickup, o padrao) ou "espera o
            // jogador USAR". Este ramo e o segundo.
            //
            // E ele SO vale quando o item NAO e de pegada: um item
            // marcado como ConsumeOnPickup ja converteu no
            // OnItemAddedToContainer, e converter de novo aqui
            // daria ponto duas vezes pelo mesmo item.
            if (action.Kind == "points")
            {
                if (custom.ConsumeOnPickup)
                {
                    return false;
                }

                // ####  UMA UNIDADE POR GESTO  ####
                //
                // Usar um item e um gesto que gasta UM - e o mesmo
                // que o jogo faz com uma bandagem. Converter a
                // pilha inteira num clique surpreenderia quem
                // clicou uma vez, e nao ha como desfazer.
                //
                // Quem quer a pilha toda de uma vez usa o modo de
                // pegada, que converte o que entrou.
                return ConvertToPoints(player, item, custom, 1);
            }

            // ####  O QUE ESTE METODO NAO SABE FAZER, ELE DEVOLVE  ####
            //
            // Um kind desconhecido (um agente mais novo que este
            // plugin) sai por esta porta. Devolver false e dizer
            // "nao e comigo" - o jogo segue com o comportamento do
            // item base e, o que mais importa, O ITEM NAO E
            // CONSUMIDO. Consumir sem converter faria o trofeu sumir
            // sem virar ponto nenhum, que e o unico desfecho pior do
            // que nao fazer nada.
            if (action.Kind != "consume")
            {
                return false;
            }

            ApplyEffects(player, action);

            // O consumo vem DEPOIS do efeito, de proposito: se o
            // efeito estourar, o jogador ainda tem o item. O
            // contrario deixaria ele sem o item e sem a cura.
            if (action.Consumes > 0)
            {
                Consume(item, action.Consumes);
            }

            if (!string.IsNullOrEmpty(custom.Message))
            {
                // Pelo FormatMessage, e nao cru: quem escrever
                // "{item} usado!" no cadastro tem de ler o nome do
                // item, e nao o marcador.
                player.ChatMessage(FormatMessage(custom, 0, player.UserIDString));
            }

            return true;
        }

        /// <summary>
        /// Converte N unidades em ponto, na ordem que nao se negocia.
        /// </summary>
        /// <remarks>
        /// ####  A MESMA SEQUENCIA DOS DOIS MOMENTOS  ####
        ///
        ///   1. REGISTRA na fila (que grava em disco);
        ///   2. destroi o item;
        ///   3. avisa o jogador;
        ///   4. tenta emitir.
        ///
        /// Ela existe como metodo justamente para que o caminho do
        /// USO e o da PEGADA nao possam divergir: trocar 1 e 2 de
        /// lugar em um deles abriria, so ali, a janela em que o item
        /// ja nao existe e o ponto ainda nao foi anotado em lugar
        /// nenhum. Ver Docs\CustomItem\03 §7.2.
        ///
        /// Devolve false quando nao havia o que converter - e ai o
        /// item continua na mao do jogador.
        /// </remarks>
        private bool ConvertToPoints(BasePlayer player, Item item, CustomItem custom, int units)
        {
            // Ver a armadilha 7 do §11: o Rust concede 1 unidade
            // para um item com amount 0, entao confiar no jogo aqui
            // daria um ponto de graca.
            if (item == null || item.amount <= 0 || units <= 0)
            {
                return false;
            }

            if (units > item.amount)
            {
                units = item.amount;
            }

            // (1) A FILA VEM PRIMEIRO, e vai para o disco.
            StatEvent pending = NewPointsEvent(player, custom, units);

            Enqueue(pending);

            // (2) Agora o item pode morrer.
            Consume(item, units);

            // (3) O recibo. Ele e AGRUPADO: quatro conversoes
            // seguidas viram uma linha so, com os pontos somados.
            QueueChat(player, custom, pending.Amount);

            // (4) E por ultimo a tentativa de contar ao agente. Se
            // esta linha se perder, a fila do passo 1 garante que
            // ela volte no proximo `clear` ou no boot.
            EmitSafe(pending);

            return true;
        }

        /// <summary>
        /// O evento de ponto, no formato do contrato do ranking.
        ///
        /// Ver Docs\CustomItem\03 §8.1 e
        /// Docs\Ranking\20-PLANO-E-CONTRATOS.md §7.
        /// </summary>
        private StatEvent NewPointsEvent(BasePlayer player, CustomItem custom, int units)
        {
            StatEvent pending = new StatEvent();
            pending.Contract = 1;
            pending.Kind = "points";
            pending.EventId = NewEventId(player);
            pending.SteamId = player.UserIDString;
            pending.Name = player.displayName;
            pending.Metric = custom.Action.Metric;

            // JA MULTIPLICADO. O peso pode mudar amanha; o ponto
            // concedido e fato, e refaze-lo depois com o perUnit
            // novo reescreveria o passado.
            pending.Amount = custom.Action.PerUnit * units;

            // De onde vieram os 400 pontos do primeiro colocado?
            // Esta linha responde, meses depois, sem guardar evento
            // cru de tudo.
            pending.Source = "item:" + custom.Id;
            pending.At = (long)DateTimeOffset.UtcNow.ToUnixTimeSeconds();

            return pending;
        }

        /// <summary>
        /// Tira N unidades do item, na mao.
        ///
        /// ####  POR QUE NAO Item.UseItem  ####
        ///
        /// Porque o hook OnItemUse e disparado DE DENTRO do
        /// Item.UseItem. Chama-lo daqui seria chamar de volta o
        /// mesmo hook que nos trouxe ate esta linha - recursao
        /// infinita, e o servidor cai com StackOverflow, que e o
        /// unico tipo de excecao que nenhum try/catch segura.
        ///
        /// Decrementar na mao faz a mesma coisa sem o laco. O
        /// MarkDirty e obrigatorio: sem ele o cliente continua
        /// mostrando a quantidade antiga.
        /// </summary>
        private static void Consume(Item item, int amount)
        {
            item.amount -= amount;

            if (item.amount <= 0)
            {
                item.RemoveFromContainer();
                item.Remove();
                return;
            }

            item.MarkDirty();
        }

        /// <summary>
        /// Os efeitos, um a um.
        ///
        /// ####  OS OITO TIPOS SAO DO JOGO, NAO NOSSOS  ####
        ///
        /// MEDIDOS no enum MetabolismAttribute.Type do
        /// Assembly-CSharp: Calories, Hydration, Heartrate, Poison,
        /// Radiation, Bleeding, Health e HealthOverTime. Sao os
        /// mesmos oito que a bandagem comum usa - a "super
        /// bandagem" nao e codigo novo, e numero maior nos mesmos
        /// campos.
        ///
        /// Tipo desconhecido e IGNORADO, e nao erro: o agente e uma
        /// versao mais nova poderia mandar um tipo que este plugin
        /// ainda nao conhece, e recusar a acao inteira por causa de
        /// um efeito seria perder os outros sete.
        /// </summary>
        private void ApplyEffects(BasePlayer player, CustomAction action)
        {
            if (action.Effects == null || player.metabolism == null)
            {
                return;
            }

            for (int i = 0; i < action.Effects.Count; i++)
            {
                CustomEffect effect = action.Effects[i];

                if (effect == null || string.IsNullOrEmpty(effect.Type))
                {
                    continue;
                }

                // "so se a vida estiver abaixo de X" - o mesmo
                // onlyIfHealthLessThan que o ConsumableEffect do
                // jogo tem. Zero quer dizer "sempre".
                if (effect.OnlyIfHealthBelow > 0f && player.health >= effect.OnlyIfHealthBelow)
                {
                    continue;
                }

                switch (effect.Type.ToLowerInvariant())
                {
                    case "health":
                        player.Heal(effect.Amount);
                        break;

                    case "healthovertime":
                        player.metabolism.pending_health.value += effect.Amount;
                        break;

                    case "bleeding":
                        player.metabolism.bleeding.value += effect.Amount;
                        break;

                    case "calories":
                        player.metabolism.calories.value += effect.Amount;
                        break;

                    case "hydration":
                        player.metabolism.hydration.value += effect.Amount;
                        break;

                    case "poison":
                        player.metabolism.poison.value += effect.Amount;
                        break;

                    case "radiation":
                        player.metabolism.radiation_level.value += effect.Amount;
                        break;

                    case "heartrate":
                        player.metabolism.heartrate.value += effect.Amount;
                        break;

                    default:
                        // Ver o comentario do metodo: ignorado de
                        // proposito.
                        break;
                }
            }

            // ####  NAO HA CHAMADA DE SINCRONIZACAO AQUI  ####
            //
            // E de proposito, e foi conferido no compilador: o
            // PlayerMetabolism DESTA versao do jogo nao expoe
            // SendChangesToClient. Quem sincroniza e o proprio tick
            // do metabolismo, e a vida ja sai sincronizada do
            // player.Heal.
            //
            // O efeito visivel e um atraso de ate um tick na barra
            // de fome ou sede. Se algum dia isso incomodar, o lugar
            // de consertar e aqui - e nao espalhando MarkDirty pelo
            // codigo.
        }


        // ========================================================
        //  origemz.loot.set <json>
        //
        //  Cadastra ou atualiza UMA regra. O agente manda uma por
        //  linha, pelo mesmo motivo do origemz.item.set: um lote
        //  estouraria o frame do RCON.
        //
        //  {"id":"trofeu-no-elite","item":"trofeu-bleik-store",
        //   "base":"trophy","skin":"3000000001",
        //   "containers":["crate_elite","heli_crate"],
        //   "chance":0.0001,"amountMin":1,"amountMax":1,
        //   "mode":"measuring","dailyCap":3,"playerCooldownHours":24}
        // ========================================================
        [ConsoleCommand(LootSetCommand)]
        private void CommandLootSet(ConsoleSystem.Arg arg)
        {
            // Ver o CommandSet: veio de um jogador no F1, e nao do
            // RCON. Configuracao e do agente.
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                if (!arg.HasArgs(1))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                JObject body;

                try
                {
                    body = JObject.Parse(arg.FullString.ToString());
                }
                catch (Exception)
                {
                    arg.ReplyWith(BuildError(ErrorInvalidJson));
                    return;
                }

                LootRule rule = ParseLootRule(body);

                if (rule == null)
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                // Ver o cabecalho da secao: sem skin o item nasce
                // sendo o do JOGO, e nao o nosso. Recusar aqui e a
                // diferenca entre saber agora e descobrir quando um
                // jogador reclamar de um trofeu sem nome.
                if (rule.Skin == 0UL)
                {
                    arg.ReplyWith(BuildError(ErrorZeroSkin));
                    return;
                }

                ForgetLootRule(rule.Id);
                IndexLootRule(rule);

                // A regra e cadastro que precisa valer no BOOT - ver
                // o cabecalho do estado. Ela vai para o disco agora,
                // e nao no relogio: uma queda entre o `set` e a
                // proxima gravacao faria o boot seguinte rodar com a
                // configuracao de dois ciclos atras.
                SaveLoot();

                arg.ReplyWith("{\"ok\":true,\"id\":" + JsonConvert.ToString(rule.Id) +
                              ",\"containers\":" +
                              rule.Containers.Count.ToString(CultureInfo.InvariantCulture) + "}");
            }
            catch (Exception ex)
            {
                PrintError(LootSetCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        /// <summary>
        /// Esquece TODAS as regras. Os contadores e os cooldowns
        /// FICAM.
        /// </summary>
        /// <remarks>
        /// ####  A DIFERENCA ENTRE CADASTRO E FATO CONSUMADO  ####
        ///
        /// A regra e cadastro: o agente a remanda inteira, e apaga-la
        /// aqui e o que faz uma regra removida no painel parar de
        /// valer no jogo.
        ///
        /// O contador e o cooldown sao o que JA ACONTECEU. Zera-los
        /// a cada sincronizacao daria um teto diario que reinicia a
        /// cada `oxide.reload` do outro lado, e um cooldown que
        /// devolve o direito a quem acabou de levar - e o agente
        /// sincroniza varias vezes por dia.
        /// </remarks>
        [ConsoleCommand(LootClearCommand)]
        private void CommandLootClear(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                int had = _lootRules.Count;

                _lootRules.Clear();
                _lootByContainer.Clear();
                _lootByMark.Clear();

                SaveLoot();

                arg.ReplyWith("{\"ok\":true,\"forgotten\":" +
                              had.ToString(CultureInfo.InvariantCulture) + "}");
            }
            catch (Exception ex)
            {
                PrintError(LootClearCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // ========================================================
        //  origemz.loot.stats
        //
        //  ####  LER NAO CONSOME  ####
        //
        //  O contador NAO e zerado aqui, e o agente SOBRESCREVE a
        //  linha do dia em vez de somar. As duas metades da mesma
        //  escolha: uma leitura perdida se conserta sozinha na volta
        //  seguinte, e duas leituras do mesmo estado dao o mesmo
        //  resultado - que com um relogio de 60 s do outro lado e o
        //  caso NORMAL.
        //
        //  E o oposto do origemz.item.pending, de proposito: la o
        //  item JA FOI DESTRUIDO e o que se perde nao volta.
        //
        //  ####  E O `day` SAI DAQUI, NAO DE LA  ####
        //
        //  Quem aplica o teto diario e este plugin, com o relogio
        //  DESTE servidor. Se o agente recalculasse o dia com o fuso
        //  da maquina dele, o teto viraria a meia-noite de um fuso e
        //  o grafico a de outro - duas verdades sobre o mesmo dia, e
        //  a pergunta "por que o teto de 3 rendeu 4?" sem resposta.
        //
        //  A resposta nao e paginada: sao 7 dias x (regras x modos),
        //  e com 20 regras isso da ~280 linhas de ~90 bytes. Bem
        //  dentro do frame. Se um dia passar, o teto de dias e o que
        //  se ajusta.
        // ========================================================
        [ConsoleCommand(LootStatsCommand)]
        private void CommandLootStats(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                PruneLootCounters();

                List<LootCounter> list = new List<LootCounter>();

                foreach (KeyValuePair<string, LootCounter> entry in _lootCounters)
                {
                    list.Add(entry.Value);
                }

                arg.ReplyWith(JsonConvert.SerializeObject(new LootStatsResponse
                {
                    Ok = true,
                    Count = list.Count,
                    Stats = list
                }));
            }
            catch (Exception ex)
            {
                PrintError(LootStatsCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // ========================================================
        //  A VIA A - O SORTEIO
        //
        //  ####  ELE DECIDE SE NASCE, E E O UNICO QUE CRIA  ####
        //
        //  Decisao do dono (Q1 do Docs/CustomItem/04): a Via A
        //  (OnLootSpawn) decide se o item nasce - probabilidade,
        //  tipo de container, orcamento do dia -, e a Via B
        //  (OnLootEntity) NUNCA cria nada; ela so decide se aquele
        //  jogador pode levar.
        //
        //  A divisao e de RESPONSABILIDADE, e nao de opiniao: se um
        //  dia alguem precisar mudar a raridade, ha um lugar so para
        //  mexer.
        // ========================================================

        /// <summary>
        /// O container vai ser populado. NUNCA cancela.
        /// </summary>
        /// <remarks>
        /// ####  DEVOLVER NAO-NULO AQUI ESVAZIA O CONTAINER  ####
        ///
        /// MEDIDO no IL de LootContainer.SpawnLoot: a ordem e
        /// inventory.Clear() -> DoRemoves() -> ESTE HOOK ->
        /// PopulateLoot(). Um retorno nao-nulo faz o SpawnLoot
        /// RETORNAR, e o PopulateLoot nunca roda - o container fica
        /// com o que nos pusermos e mais NADA.
        ///
        /// O defeito apareceria como "depois do plugin novo os
        /// crates so tem o trofeu", e so quando alguem abrisse um.
        /// Por isso este metodo devolve `null` em todos os caminhos,
        /// inclusive no catch.
        ///
        /// ####  E POR ISSO O TRABALHO VAI PARA O NextTick  ####
        ///
        /// No instante do hook o inventario esta VAZIO - o Clear()
        /// acabou de rodar. Inserir aqui e disputar slot com o
        /// PopulateLoot que vem em seguida. No NextTick o container
        /// ja esta cheio e nos acrescentamos por cima, que e o que
        /// "complementar" quer dizer.
        ///
        /// ####  O CUSTO, QUE AQUI E O ASSUNTO  ####
        ///
        /// MEDIDO em Docs/CustomItem/05 §2.6: 71 dos 105 containers
        /// tem refresh de 1 a 2 h, e so os 400 barris de mundo
        /// aberto dao da ordem de 6.400 populacoes por dia. As
        /// saidas vem em ordem de preco, e a primeira cobre o
        /// servidor inteiro: sem regra nenhuma, isto e a leitura de
        /// um int.
        /// </remarks>
        private object OnLootSpawn(LootContainer container)
        {
            try
            {
                if (_lootByContainer.Count == 0 || container == null)
                {
                    return null;
                }

                List<LootRule> rules;

                if (!_lootByContainer.TryGetValue(container.ShortPrefabName, out rules))
                {
                    // O container nao esta na lista de nenhuma regra.
                    // E o caminho da esmagadora maioria dos
                    // disparos.
                    return null;
                }

                string day = LootDayKey();

                for (int i = 0; i < rules.Count; i++)
                {
                    LootRule rule = rules[i];
                    LootCounter counter = LootCounterOf(rule, day);

                    // O denominador. E o numero que o
                    // Docs/CustomItem/04 §6.3 precisava e nao
                    // conseguiu medir: quantos containers ELEGIVEIS
                    // nascem por dia neste servidor.
                    counter.Rolls++;
                    _lootDirty = true;

                    if (UnityEngine.Random.Range(0f, 1f) >= rule.Chance)
                    {
                        continue;
                    }

                    counter.Hits++;

                    // ####  MEDINDO: CONTA E NAO CRIA  ####
                    //
                    // E o ponto inteiro desta fatia. Ver a Q8 do
                    // Docs/CustomItem/04: mede antes de soltar. A
                    // diferenca entre Hits e Spawned e o que faz o
                    // modo servir para alguma coisa.
                    if (rule.Mode != LootModeLive)
                    {
                        continue;
                    }

                    // ####  O TETO E RESERVADO AGORA, E NAO DEPOIS  ####
                    //
                    // A criacao acontece no NextTick, e no wipe
                    // dezenas de containers nascem no MESMO frame.
                    // Conferir o teto aqui e incrementa-lo la
                    // deixaria todos passarem pela mesma leitura de
                    // "ainda cabe" - e o teto de 1 renderia 20.
                    //
                    // Entao o orcamento e reservado no sorteio e
                    // DEVOLVIDO se a criacao falhar.
                    if (rule.DailyCap > 0 && counter.Spawned >= rule.DailyCap)
                    {
                        continue;
                    }

                    counter.Spawned++;

                    LootRule captured = rule;
                    LootContainer target = container;
                    LootCounter budget = counter;

                    NextTick(delegate { InjectLoot(target, captured, budget); });
                }

                return null;
            }
            catch (Exception ex)
            {
                // Ver a regra 4 do cabecalho, e ver o remarks: o
                // `null` aqui nao e cortesia, e a diferenca entre um
                // erro nosso e um container vazio.
                PrintError("OnLootSpawn falhou: " + ex);
                return null;
            }
        }

        /// <summary>
        /// Cria o item COM A MARCA e o poe no container.
        /// </summary>
        /// <remarks>
        /// ####  A MARCA NASCE COM O ITEM  ####
        ///
        /// Nada de carimbar depois: um `discord.trophy` de skin 0
        /// pode ser o que o proprio jogo distribui em evento, e
        /// reconhece-lo pela AUSENCIA de skin faria o servidor
        /// converter em ponto o trofeu que o jogador ja tinha no
        /// bau. Ver Docs/CustomItem/04 §4.3.
        ///
        /// ####  E O ApplyIdentity E CHAMADO EXPLICITAMENTE  ####
        ///
        /// Em tese ele nao precisaria: MoveToContainer termina em
        /// ItemContainer.Insert, que dispara OnItemAddedToContainer,
        /// que ja veste o item. Na pratica isso so vale se o
        /// CADASTRO ja tiver chegado - e no boot as regras vem do
        /// disco enquanto o _byMark ainda esta vazio.
        ///
        /// A chamada explicita nao substitui aquele caminho: ela e a
        /// segunda rede, e nao custa nada quando a primeira
        /// funcionou (o ApplyIdentity sai sem escrever quando o nome
        /// ja esta certo).
        /// </remarks>
        private void InjectLoot(LootContainer container, LootRule rule, LootCounter budget)
        {
            try
            {
                if (container == null || container.IsDestroyed)
                {
                    LootRefund(budget);
                    return;
                }

                ItemContainer inventory = container.inventory;

                if (inventory == null)
                {
                    LootRefund(budget);
                    return;
                }

                int baseItemId = LootBaseItemId(rule);

                if (baseItemId == 0)
                {
                    // O item base sumiu desta versao do Rust. O
                    // agente ja nao manda a regra nesse caso, mas o
                    // disco pode ter uma de antes do update.
                    LootRefund(budget);
                    return;
                }

                int amount = rule.AmountMax > rule.AmountMin
                    ? UnityEngine.Random.Range(rule.AmountMin, rule.AmountMax + 1)
                    : rule.AmountMin;

                if (amount < 1)
                {
                    amount = 1;
                }

                Item item = ItemManager.CreateByItemID(baseItemId, amount, rule.Skin);

                if (item == null)
                {
                    LootRefund(budget);
                    return;
                }

                if (!item.MoveToContainer(inventory, -1, true, false, null, true))
                {
                    // Container cheio. O item some E o orcamento
                    // volta: gastar o teto do dia com um item que
                    // ninguem vai achar seria o pior dos dois
                    // mundos.
                    item.Remove();
                    LootRefund(budget);
                    return;
                }

                CustomItem custom = Match(item);

                if (custom != null)
                {
                    ApplyIdentity(item, custom);
                }
            }
            catch (Exception ex)
            {
                // O NextTick tirou este codigo de dentro do try do
                // hook: sem este catch a excecao subiria para o laco
                // do Oxide, e nao para o nosso log.
                PrintError("InjectLoot falhou: " + ex);
                LootRefund(budget);
            }
        }

        /// <summary>
        /// Devolve o orcamento do dia que a criacao nao usou.
        ///
        /// Ver o OnLootSpawn: o teto e reservado no sorteio para que
        /// varios containers nascendo no mesmo frame nao leiam todos
        /// o mesmo "ainda cabe".
        /// </summary>
        private void LootRefund(LootCounter budget)
        {
            if (budget == null || budget.Spawned <= 0)
            {
                return;
            }

            budget.Spawned--;
            _lootDirty = true;
        }

        // ========================================================
        //  A VIA B - O PORTAO
        //
        //  ####  ELA NUNCA CRIA NADA  ####
        //
        //  Decisao do dono (Q1 do Docs/CustomItem/04): a Via B e um
        //  FILTRO sobre o que a Via A ja sorteou, e nao uma segunda
        //  chance de sortear.
        //
        //  ####  E BARRAR NAO E DESTRUIR  ####
        //
        //  Quando o jogador nao pode levar, o item PERMANECE no
        //  container para o proximo. Destrui-lo gastaria o orcamento
        //  do dia sem que ninguem tivesse ganhado nada - e o troféu
        //  sumiria da cara de quem o viu, que e a pior coisa que uma
        //  mecanica de raridade pode fazer.
        //
        //  Por isso a recusa mora no CanAcceptItem (o item nao entra
        //  no inventario) e nao numa remocao: o que o jogador ve e
        //  uma caixa com o item dentro que ele nao consegue pegar, e
        //  uma frase dizendo por que.
        // ========================================================

        /// <summary>
        /// Este jogador esta em carencia para esta regra?
        /// </summary>
        private bool LootOnCooldown(LootRule rule, string steamId)
        {
            if (rule.CooldownHours <= 0 || string.IsNullOrEmpty(steamId))
            {
                return false;
            }

            long last;

            if (!_lootCooldowns.TryGetValue(rule.Id + "|" + steamId, out last))
            {
                return false;
            }

            long now = (long)DateTimeOffset.UtcNow.ToUnixTimeSeconds();

            return now - last < (long)rule.CooldownHours * 3600L;
        }

        /// <summary>
        /// A regra que barra este item para este jogador, ou null.
        ///
        /// Uma consulta de dicionario pela MARCA, que e a unica
        /// coisa que o item carrega. Item sem marca nem chega aqui:
        /// quem chama ja passou pelo Match.
        /// </summary>
        private LootRule LootGateOf(Item item, string steamId)
        {
            if (_lootByMark.Count == 0 || item == null || item.info == null)
            {
                return null;
            }

            List<LootRule> rules;

            if (!_lootByMark.TryGetValue(MarkOf(item.info.itemid, item.skin), out rules))
            {
                return null;
            }

            for (int i = 0; i < rules.Count; i++)
            {
                if (LootOnCooldown(rules[i], steamId))
                {
                    return rules[i];
                }
            }

            return null;
        }

        /// <summary>
        /// Conta o que o portao barrou e avisa quem foi barrado.
        ///
        /// Roda um tick depois do OnLootEntity, junto do
        /// RefreshLoot, quando a lista de containers do PlayerLoot
        /// ja esta montada - ver o remarks daquele hook.
        ///
        /// ####  ELE SO CONTA E AVISA; QUEM RECUSA E O
        ///       CanAcceptItem  ####
        ///
        /// Separar as duas coisas e o que garante que o item nao
        /// seja tocado aqui. Um metodo que "barrasse" mexendo no
        /// container seria a tentacao de remover o item - e remover
        /// e exatamente o que a decisao do dono proibe.
        /// </summary>
        private void GateLoot(BasePlayer player)
        {
            try
            {
                if (_lootByMark.Count == 0 || player == null ||
                    player.inventory == null || player.inventory.loot == null)
                {
                    return;
                }

                List<ItemContainer> containers = player.inventory.loot.containers;

                if (containers == null)
                {
                    return;
                }

                string steamId = player.UserIDString;
                LootRule blocked = null;

                for (int i = 0; i < containers.Count && blocked == null; i++)
                {
                    ItemContainer container = containers[i];

                    if (container == null || container.itemList == null)
                    {
                        continue;
                    }

                    for (int j = 0; j < container.itemList.Count; j++)
                    {
                        LootRule rule = LootGateOf(container.itemList[j], steamId);

                        if (rule != null)
                        {
                            blocked = rule;
                            break;
                        }
                    }
                }

                if (blocked == null)
                {
                    return;
                }

                LootCounterOf(blocked, LootDayKey()).Blocked++;
                _lootDirty = true;

                // O aviso e por jogador e por janela: reabrir a
                // mesma caixa nao pode repetir a frase a cada vez.
                string key = blocked.Id + "|" + steamId;
                double now = UnityEngine.Time.realtimeSinceStartup;
                double warned;

                if (_lootWarned.TryGetValue(key, out warned) &&
                    now - warned < LootWarnQuietSeconds)
                {
                    return;
                }

                _lootWarned[key] = now;
                player.ChatMessage(Msg(MsgLootCooldown, steamId));
            }
            catch (Exception ex)
            {
                PrintError("GateLoot falhou: " + ex);
            }
        }

        /// <summary>
        /// Marca que este jogador levou o item desta regra.
        ///
        /// ####  O CARIMBO ACONTECE NA ENTREGA, E NAO NO SORTEIO  ####
        ///
        /// No instante do OnLootSpawn nao existe jogador - o
        /// container e populado pelo mundo, sozinho, muitas vezes
        /// longe de todos. Nao ha a quem aplicar carencia. Ver
        /// Docs/CustomItem/04 §6.5.
        ///
        /// ####  E ELE NAO DISTINGUE DE ONDE O ITEM VEIO  ####
        ///
        /// Um trofeu comprado na loja tambem arma a carencia do
        /// loot, porque a marca e a mesma nos dois casos e a
        /// procedencia nao viaja no item hoje (a linha `ORIGEM` do
        /// §7.2 daquele estudo depende da Q6, que o dono ainda nao
        /// respondeu).
        ///
        /// O efeito de errar assim e o trofeu do loot ficar MAIS
        /// raro para quem acabou de ganhar um - que e o lado seguro
        /// do erro, e o mesmo lado que o §6.3 recomenda.
        /// </summary>
        private void LootStampCooldown(Item item, BasePlayer player)
        {
            if (_lootByMark.Count == 0 || item == null || item.info == null || player == null)
            {
                return;
            }

            List<LootRule> rules;

            if (!_lootByMark.TryGetValue(MarkOf(item.info.itemid, item.skin), out rules))
            {
                return;
            }

            long now = (long)DateTimeOffset.UtcNow.ToUnixTimeSeconds();

            for (int i = 0; i < rules.Count; i++)
            {
                if (rules[i].CooldownHours <= 0)
                {
                    continue;
                }

                _lootCooldowns[rules[i].Id + "|" + player.UserIDString] = now;
                _lootDirty = true;
            }
        }

        // ========================================================
        //  OS AUXILIARES DA REGRA DE LOOT
        // ========================================================

        /// <summary>O modo que CRIA. O outro so conta.</summary>
        private const string LootModeLive = "live";

        /// <summary>
        /// O dia, no relogio DESTE servidor.
        ///
        /// ####  E O FUSO E O LOCAL, DE PROPOSITO  ####
        ///
        /// O teto diario e o que um admin lê como "por dia", e o dia
        /// dele e o do relogio da maquina que roda o servidor - nao
        /// o UTC. Usar UTC faria o teto virar as 21h no Brasil, no
        /// meio do horario de pico, e ninguem ligaria uma coisa a
        /// outra.
        ///
        /// O agente NAO recalcula este valor: ele grava o dia que
        /// vem daqui. Ver o cabecalho do origemz.loot.stats.
        /// </summary>
        private static string LootDayKey()
        {
            return DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// O contador daquela regra, naquele dia, naquele modo.
        /// Cria se ainda nao existe.
        /// </summary>
        private LootCounter LootCounterOf(LootRule rule, string day)
        {
            string key = rule.Id + "|" + day + "|" + rule.Mode;
            LootCounter counter;

            if (_lootCounters.TryGetValue(key, out counter))
            {
                return counter;
            }

            counter = new LootCounter();
            counter.Rule = rule.Id;
            counter.Day = day;
            counter.Mode = rule.Mode;

            _lootCounters[key] = counter;

            return counter;
        }

        /// <summary>
        /// O itemid do item base, resolvido uma vez so.
        ///
        /// Zero = o jogo nao tem este shortname. A resolucao e
        /// preguicosa porque as regras chegam do DISCO no Init(),
        /// quando o ItemManager ainda pode nao estar montado.
        /// </summary>
        private static int LootBaseItemId(LootRule rule)
        {
            if (rule.BaseItemId != 0 || rule.BaseMissing)
            {
                return rule.BaseItemId;
            }

            ItemDefinition definition = ItemManager.FindItemDefinition(rule.Base);

            if (definition == null)
            {
                rule.BaseMissing = true;
                return 0;
            }

            rule.BaseItemId = definition.itemid;

            return rule.BaseItemId;
        }

        /// <summary>Poe a regra nos dois indices.</summary>
        private void IndexLootRule(LootRule rule)
        {
            _lootRules[rule.Id] = rule;

            for (int i = 0; i < rule.Containers.Count; i++)
            {
                string prefab = rule.Containers[i];
                List<LootRule> list;

                if (!_lootByContainer.TryGetValue(prefab, out list))
                {
                    list = new List<LootRule>();
                    _lootByContainer[prefab] = list;
                }

                list.Add(rule);
            }

            // O indice da marca so serve ao portao, e so a regra com
            // cooldown tem portao. Indexar as outras faria o
            // CanAcceptItem varrer lista para sempre devolver null.
            if (rule.CooldownHours <= 0)
            {
                return;
            }

            int baseItemId = LootBaseItemId(rule);

            if (baseItemId == 0)
            {
                // O ItemManager ainda nao esta montado (Init) ou o
                // item sumiu do jogo. No primeiro caso o indice e
                // refeito no OnServerInitialized; no segundo a regra
                // nao teria como criar item nenhum.
                return;
            }

            string mark = MarkOf(baseItemId, rule.Skin);
            List<LootRule> marked;

            if (!_lootByMark.TryGetValue(mark, out marked))
            {
                marked = new List<LootRule>();
                _lootByMark[mark] = marked;
            }

            marked.Add(rule);
        }

        /// <summary>Tira a regra dos dois indices.</summary>
        private void ForgetLootRule(string id)
        {
            LootRule previous;

            if (!_lootRules.TryGetValue(id, out previous))
            {
                return;
            }

            _lootRules.Remove(id);

            // Reconstruir os indices e mais barato de LER do que
            // remover a regra de cada lista - e um `set` acontece
            // algumas dezenas de vezes por sincronizacao, nao
            // milhares por dia como o hook.
            RebuildLootIndexes();
        }

        /// <summary>
        /// Refaz os indices a partir de _lootRules.
        ///
        /// Chamado tambem no OnServerInitialized: as regras que
        /// vieram do disco no Init() podem nao ter resolvido o
        /// itemid, porque o ItemManager ainda nao existia.
        /// </summary>
        private void RebuildLootIndexes()
        {
            _lootByContainer.Clear();
            _lootByMark.Clear();

            List<LootRule> all = new List<LootRule>(_lootRules.Values);

            _lootRules.Clear();

            for (int i = 0; i < all.Count; i++)
            {
                IndexLootRule(all[i]);
            }
        }

        /// <summary>
        /// Joga fora a contagem velha e a carencia vencida.
        ///
        /// Sem isto o arquivo cresceria para sempre por causa de
        /// numeros que o agente ja copiou e de carencias que ja
        /// passaram.
        /// </summary>
        private void PruneLootCounters()
        {
            string oldest = DateTime.Now.AddDays(-LootCounterDays)
                .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

            List<string> drop = new List<string>();

            foreach (KeyValuePair<string, LootCounter> entry in _lootCounters)
            {
                if (string.CompareOrdinal(entry.Value.Day, oldest) < 0)
                {
                    drop.Add(entry.Key);
                }
            }

            for (int i = 0; i < drop.Count; i++)
            {
                _lootCounters.Remove(drop[i]);
            }

            // A carencia mais longa que o agente aceita e um ano;
            // usar esse teto aqui evita ter de olhar regra por regra
            // para saber se uma linha ainda importa.
            long floor = (long)DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 366L * 24L * 3600L;
            List<string> stale = new List<string>();

            foreach (KeyValuePair<string, long> entry in _lootCooldowns)
            {
                if (entry.Value < floor)
                {
                    stale.Add(entry.Key);
                }
            }

            for (int i = 0; i < stale.Count; i++)
            {
                _lootCooldowns.Remove(stale[i]);
            }

            if (drop.Count > 0 || stale.Count > 0)
            {
                _lootDirty = true;
            }
        }

        /// <summary>
        /// O JSON vira regra. Devolve null quando falta o essencial.
        /// </summary>
        /// <remarks>
        /// Os nomes sao os do `toLootPluginBody` em
        /// core/src/game/custom-items-sync.ts. OS DOIS LADOS MUDAM
        /// JUNTOS: um campo acrescentado la e ignorado aqui em
        /// silencio, e a tela do painel mostraria uma configuracao
        /// que o jogo nao obedece.
        ///
        /// Todo campo opcional passa pelo Missing(): um `null` no
        /// JSON NAO devolve null do C#, devolve um JValue de tipo
        /// Null que passa no `!= null` e estoura no cast. Ver o
        /// remarks do Missing.
        /// </remarks>
        private static LootRule ParseLootRule(JObject body)
        {
            string id = (string)body["id"];
            string baseName = (string)body["base"];

            if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(baseName))
            {
                return null;
            }

            JArray containers = body["containers"] as JArray;

            if (containers == null || containers.Count == 0)
            {
                // Regra sem container nao dispara em lugar nenhum.
                // Recusar e melhor que aceitar uma regra inerte que
                // a tela mostra como ligada.
                return null;
            }

            LootRule rule = new LootRule();
            rule.Id = id;
            rule.ItemId = (string)body["item"];
            rule.Base = baseName;
            rule.Containers = new List<string>();

            for (int i = 0; i < containers.Count; i++)
            {
                string prefab = (string)containers[i];

                if (!string.IsNullOrEmpty(prefab))
                {
                    rule.Containers.Add(prefab);
                }
            }

            if (rule.Containers.Count == 0)
            {
                return null;
            }

            // A skin vem como STRING, e nao como numero: ela e um
            // UInt64, e um JSON com numero de 20 digitos passa por
            // double em bibliotecas que nao esperam por isso -
            // perdendo precisao em silencio. Mesma escolha do
            // ParseItem.
            string skinText = (string)body["skin"];
            ulong skin;

            if (!string.IsNullOrEmpty(skinText) &&
                ulong.TryParse(skinText, NumberStyles.None, CultureInfo.InvariantCulture, out skin))
            {
                rule.Skin = skin;
            }

            JToken chance = body["chance"];
            rule.Chance = Missing(chance) ? 0f : (float)chance;

            JToken amountMin = body["amountMin"];
            rule.AmountMin = Missing(amountMin) ? 1 : (int)amountMin;

            JToken amountMax = body["amountMax"];
            rule.AmountMax = Missing(amountMax) ? rule.AmountMin : (int)amountMax;

            // ####  O MODO DESCONHECIDO MEDE, E NAO CRIA  ####
            //
            // Um agente antigo, que nao mande o campo, faz a regra
            // CONTAR - nunca soltar item no mundo. Errar para
            // "conta" e barato; errar para "solta" nao e.
            string mode = (string)body["mode"];
            rule.Mode = mode == LootModeLive ? LootModeLive : "measuring";

            JToken dailyCap = body["dailyCap"];
            rule.DailyCap = Missing(dailyCap) ? 0 : (int)dailyCap;

            JToken cooldown = body["playerCooldownHours"];
            rule.CooldownHours = Missing(cooldown) ? 0 : (int)cooldown;

            return rule;
        }

        /// <summary>
        /// Le as regras, os contadores e as carencias do disco.
        ///
        /// Chamado no Init(), que roda ANTES de o mundo nascer - e e
        /// isso que faz a configuracao valer desde a primeira caixa
        /// do boot (Q1 do Docs/CustomItem/05).
        /// </summary>
        private void LoadLoot()
        {
            try
            {
                LootState state = Interface.Oxide.DataFileSystem.ReadObject<LootState>(LootFile);

                if (state == null)
                {
                    return;
                }

                if (state.Rules != null)
                {
                    for (int i = 0; i < state.Rules.Count; i++)
                    {
                        LootRule rule = state.Rules[i];

                        if (rule != null && !string.IsNullOrEmpty(rule.Id) && rule.Containers != null)
                        {
                            IndexLootRule(rule);
                        }
                    }
                }

                if (state.Counters != null)
                {
                    for (int i = 0; i < state.Counters.Count; i++)
                    {
                        LootCounter counter = state.Counters[i];

                        if (counter != null && !string.IsNullOrEmpty(counter.Rule))
                        {
                            _lootCounters[counter.Rule + "|" + counter.Day + "|" + counter.Mode] = counter;
                        }
                    }
                }

                if (state.Cooldowns != null)
                {
                    _lootCooldowns = state.Cooldowns;
                }

                if (_lootRules.Count > 0)
                {
                    Puts("regras de loot: " + _lootRules.Count +
                         " carregada(s) do disco, valendo desde a primeira caixa.");
                }
            }
            catch (Exception ex)
            {
                // Arquivo ilegivel NAO vira estado vazio gravado por
                // cima: sobrescrever apagaria a medicao que ninguem
                // conseguiu ler. Mesma escolha do LoadQueue.
                PrintError("estado de loot ilegivel, seguindo VAZIO sem gravar por cima: " + ex.Message);
            }
        }

        private void SaveLoot()
        {
            try
            {
                LootState state = new LootState();
                state.Rules = new List<LootRule>(_lootRules.Values);
                state.Counters = new List<LootCounter>(_lootCounters.Values);
                state.Cooldowns = _lootCooldowns;

                Interface.Oxide.DataFileSystem.WriteObject(LootFile, state);

                _lootDirty = false;
            }
            catch (Exception ex)
            {
                PrintError("nao consegui gravar o estado de loot: " + ex);
            }
        }

        /// <summary>
        /// Grava se houver coisa nova. E o que o relogio chama.
        /// </summary>
        private void SaveLootIfDirty()
        {
            if (!_lootDirty)
            {
                return;
            }

            PruneLootCounters();
            SaveLoot();
        }

        // ========================================================
        //  DIAGNOSTICO
        //
        //  ####  POR QUE UM COMANDO SO PARA ISTO  ####
        //
        //  Duas coisas deste plugin sao HIPOTESE, e nao medida:
        //
        //   1. o skinId sobrevive num item cujo HasSkins e false?
        //      MEDIDO: 104 dos 1266 itens do jogo aceitam skin, e
        //      NENHUM dos trofeus nativos esta entre eles. Se o jogo
        //      zerar a skin desses itens, a marca inteira cai;
        //
        //   2. o iconImageId escrito na instancia chega ao cliente?
        //      O campo existe e viaja na rede, mas nao foi medido se
        //      o Item.Save o copia.
        //
        //  As duas se respondem em minutos com um item na mao. Sem
        //  este comando, elas se responderiam em producao, com o
        //  admin achando que cadastrou errado.
        // ========================================================
        [ConsoleCommand(DiagCommand)]
        private void CommandDiag(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                if (!arg.HasArgs(2))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                string steamId = arg.GetString(0, "");
                string id = arg.GetString(1, "");

                // ####  O TRACO E "SEM ENTREGAR A NINGUEM"  ####
                //
                // As duas hipoteses mais importantes - a skin
                // sobrevive? o icone gruda? - se respondem na
                // CRIACAO do item, antes de ele chegar a qualquer
                // inventario. Exigir um jogador online para descobrir
                // isso deixaria o teste impossivel no servidor de
                // testes, que e justamente onde ele deve rodar.
                //
                // Com "-", o item e criado, medido e destruido.
                bool dryRun = steamId == "-";
                BasePlayer player = null;

                if (!dryRun)
                {
                    player = FindConnectedPlayer(steamId);

                    if (player == null)
                    {
                        arg.ReplyWith(BuildError(ErrorPlayerNotFound));
                        return;
                    }
                }

                CustomItem custom;

                if (!_items.TryGetValue(id, out custom))
                {
                    arg.ReplyWith(BuildError(ErrorUnknownItem));
                    return;
                }

                ItemDefinition definition = ItemManager.FindItemDefinition(custom.BaseItemId);

                if (definition == null)
                {
                    arg.ReplyWith(BuildError(ErrorUnknownBase));
                    return;
                }

                Item item = ItemManager.Create(definition, 1, custom.Skin);

                if (item == null)
                {
                    arg.ReplyWith(BuildError(ErrorInternal));
                    return;
                }

                // A skin PEDIDA e a que o ItemManager.Create
                // recebeu; a skin GRAVADA e a que o item ficou. As
                // duas divergirem e a resposta da hipotese 1, e ela
                // aparece aqui antes de o item chegar a qualquer
                // inventario.
                ulong skinAfterCreate = item.skin;

                uint crc;
                bool hasIcon = _icons.TryGetValue(custom.Id, out crc);

                if (hasIcon)
                {
                    item.iconImageId = crc;
                }

                item.name = custom.Name;
                item.MarkDirty();

                // A leitura acontece ANTES de entregar: depois do
                // GiveItem o item pode ter sido empilhado com outro e
                // deixado de existir como esta instancia.
                ulong skinFinal = item.skin;
                uint iconFinal = item.iconImageId;
                string nameFinal = item.name;

                if (dryRun)
                {
                    // Item criado e nao entregue fica pendurado na
                    // memoria do servidor - por isso o Remove
                    // explicito. Um teste que vaza item e um teste
                    // que suja o servidor a cada execucao.
                    item.Remove();
                }
                else if (!player.inventory.GiveItem(item))
                {
                    // Nao coube: vai para os pes do jogador, como o
                    // modo `auto` do origemz.give ja faz.
                    item.Drop(player.GetDropPosition(), player.GetDropVelocity());
                }

                DiagResponse response = new DiagResponse();
                response.Ok = true;
                response.Id = custom.Id;
                response.Base = custom.Base;
                response.BaseItemId = custom.BaseItemId;
                response.DefinitionHasSkins = DefinitionHasSkins(definition);
                response.DryRun = dryRun;
                response.SkinRequested = custom.Skin.ToString(CultureInfo.InvariantCulture);
                response.SkinAfterCreate = skinAfterCreate.ToString(CultureInfo.InvariantCulture);
                response.SkinFinal = skinFinal.ToString(CultureInfo.InvariantCulture);
                response.SkinSurvived = skinFinal == custom.Skin;
                response.IconCrc = hasIcon ? crc : 0U;
                response.IconApplied = hasIcon && iconFinal == crc;
                response.NameApplied = nameFinal == custom.Name;

                Puts("diag " + custom.Id + ": skin pedida " + custom.Skin +
                     ", gravada " + skinAfterCreate +
                     ", icone crc " + (hasIcon ? crc.ToString(CultureInfo.InvariantCulture) : "nenhum"));

                arg.ReplyWith(JsonConvert.SerializeObject(response));
            }
            catch (Exception ex)
            {
                PrintError(DiagCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // ========================================================
        //  origemz.item.inspect <shortname>
        //
        //  ####  O CORPO EMPRESTADO TRAZ OS HABITOS JUNTO  ####
        //
        //  E o painel nao tem como saber quais. MEDIDO: a ficha que
        //  o servidor guarda em Bundles\items\*.json NAO distingue
        //  um item deployable de um que nao e - `trophy` e `bandage`
        //  tem exatamente os mesmos campos.
        //
        //  Quem sabe e a ItemDefinition, aqui dentro. Foi por nao
        //  saber disso que o primeiro Trofeu Bleik nasceu COLOCAVEL
        //  no chao, e que a sacola padrao pode nascer com uma acao
        //  de ABRIR que ninguem pediu.
        //
        //  Este comando responde antes de o item existir: e o que
        //  permite a tela avisar no cadastro, em vez de o admin
        //  descobrir no jogo.
        // ========================================================
        [ConsoleCommand(InspectCommand)]
        private void CommandInspect(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                if (!arg.HasArgs(1))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                string shortname = arg.GetString(0, "");
                ItemDefinition definition = ItemManager.FindItemDefinition(shortname);

                if (definition == null)
                {
                    arg.ReplyWith(BuildError(ErrorUnknownBase));
                    return;
                }

                InspectResponse response = new InspectResponse();
                response.Ok = true;
                response.Shortname = definition.shortname;
                response.ItemId = definition.itemid;
                response.MaxStack = definition.stackable;
                response.Category = definition.category.ToString();
                response.HasSkins = DefinitionHasSkins(definition);

                List<string> mods = new List<string>();

                // Os ItemMod sao componentes pendurados na definicao.
                // O NOME de cada um e o que interessa: e por ele que
                // se sabe que o item vira entidade no chao
                // (ItemModDeployable), abre e sorteia
                // (ItemModOpenLootBag), veste (ItemModWearable) ou
                // cura (ItemModConsumable).
                ItemMod[] itemMods = definition.itemMods;

                if (itemMods != null)
                {
                    for (int i = 0; i < itemMods.Length; i++)
                    {
                        if (itemMods[i] != null)
                        {
                            mods.Add(itemMods[i].GetType().Name);
                        }
                    }
                }

                response.Mods = mods;

                // ####  O MODELO NO CHAO  ####
                //
                // MEDIDO no binario: worldModelPrefab e um
                // GameObjectRef, e GameObjectRef tem DOIS campos -
                // um guid (string) e um cache. Ou seja: o modelo do
                // item largado e um PONTEIRO para dentro do bundle
                // do jogador.
                //
                // Item que nao tem modelo proprio aponta para o
                // generico - a sacola de pano que o jogo desenha
                // para larva, tecido e afins. Dois itens com o MESMO
                // guid caem no chao com a MESMA cara.
                //
                // E por isso que este campo esta aqui: e a unica
                // forma de saber, ANTES de cadastrar, se o item
                // custom vai virar sacola no chao ou o objeto do
                // corpo emprestado.
                if (definition.worldModelPrefab != null)
                {
                    response.WorldModelGuid = definition.worldModelPrefab.guid;
                }

                // Os tres habitos que MORDEM um item custom, ja
                // resolvidos para quem le - o painel nao precisa
                // conhecer o nome das classes do jogo.
                response.Deployable = mods.Contains("ItemModDeployable");
                response.Wearable = mods.Contains("ItemModWearable");
                response.OpensLoot = mods.Contains("ItemModOpenLootBag") ||
                                     mods.Contains("ItemModUnwrap");

                arg.ReplyWith(JsonConvert.SerializeObject(response));
            }
            catch (Exception ex)
            {
                PrintError(InspectCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        /// <summary>
        /// A definicao tem ItemModConsumable?
        /// </summary>
        /// <remarks>
        /// ####  E O QUE DIZ SE "USAR" EXISTE NESTE ITEM  ####
        ///
        /// O hook OnItemUse so dispara em quem tem esse mod, e o
        /// menu do botao direito e montado pelo CLIENTE a partir
        /// da ItemDefinition. Um item custom que so converta AO
        /// USAR, em cima de um base sem este mod, fica inerte: o
        /// jogador pega, clica, e nada acontece.
        ///
        /// ####  PELO NOME, E NAO PELO TIPO  ####
        ///
        /// Um `is ItemModConsumable` amarraria a compilacao deste
        /// arquivo a uma classe do Assembly-CSharp - e uma
        /// assinatura do jogo ja mudou uma vez, em 04/09/2026, e
        /// derrubou a compilacao de quatro plugins juntos. E o
        /// mesmo criterio do origemz.item.inspect logo acima.
        /// </remarks>
        private static bool DefinitionIsConsumable(ItemDefinition definition)
        {
            if (definition == null || definition.itemMods == null)
            {
                return false;
            }

            ItemMod[] mods = definition.itemMods;

            for (int i = 0; i < mods.Length; i++)
            {
                if (mods[i] != null && mods[i].GetType().Name == "ItemModConsumable")
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// A definicao tem skins registradas?
        ///
        /// E o campo que separa os 104 itens skinaveis dos outros
        /// 1162, e ele decide se a arte de workshop e sequer
        /// possivel naquele item. Nao decide se a MARCA funciona -
        /// isso e a hipotese 1, e quem responde e o teste.
        /// </summary>
        private static bool DefinitionHasSkins(ItemDefinition definition)
        {
            if (definition.skins != null && definition.skins.Length > 0)
            {
                return true;
            }

            return definition.skins2 != null && definition.skins2.Length > 0;
        }

        // ========================================================
        //  TEXTO PARA O JOGADOR
        //
        //  Ver a regra 2 do cabecalho: o identificador do item e
        //  protocolo e viaja entre site, banco, agente e plugin; o
        //  que o jogador le e tela, e sai daqui.
        // ========================================================
        private const string MsgCannotDeploy = "CannotDeploy";

        /// <summary>
        /// O que entra no lugar do `{total}` da mensagem do item.
        ///
        /// Ver FormatMessage: o plugin nao conhece o total, e este
        /// texto e a resposta honesta a quem perguntou por ele.
        /// </summary>
        private const string MsgPointsTotalHint = "PointsTotalHint";

        /// <summary>
        /// O que entra no lugar do `{ranking}` quando ninguem
        /// mandou o rotulo E a acao nao tem metrica.
        ///
        /// So acontece com o marcador escrito num item que nao da
        /// ponto nenhum. Deixar o marcador cru na tela seria pior.
        /// </summary>
        private const string MsgRankingFallback = "RankingFallback";

        /// <summary>
        /// A recusa de guardar o item em bau, forno ou mochila.
        ///
        /// So existe no modo "converte ao USAR": no modo de pegada
        /// o item nem chega a existir para ser guardado.
        /// </summary>
        private const string MsgCannotStore = "CannotStore";

        /// <summary>A recusa de largar no chao. Ver a de cima.</summary>
        private const string MsgCannotDrop = "CannotDrop";

        /// <summary>
        /// O portao da Via B barrou este jogador.
        ///
        /// A frase NAO diz quanto falta nem qual e a regra: dizer
        /// transformaria a carencia num relogio que o jogador
        /// otimiza, e o valor de "raro" e nao ser agendavel. Ver a
        /// Q5 do Docs/CustomItem/04 - o dono recusou o piso pelo
        /// mesmo motivo.
        /// </summary>
        private const string MsgLootCooldown = "LootCooldown";

        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>
            {
                { MsgCannotDeploy, "This item cannot be placed on the ground." },
                { MsgPointsTotalHint, "check your total in /menu" },
                { MsgRankingFallback, "the ranking" },
                { MsgCannotStore, "This item cannot be stored: use it to claim your points." },
                { MsgCannotDrop, "This item cannot be dropped: use it to claim your points." },
                { MsgLootCooldown, "You found one of these recently. Leave it for someone else." }
            }, this);

            lang.RegisterMessages(new Dictionary<string, string>
            {
                // Rende: Este item nao pode ser colocado no chao.
                { MsgCannotDeploy, "Este item n\u00e3o pode ser colocado no ch\u00e3o." },
                // Rende: veja o total no /menu
                { MsgPointsTotalHint, "veja o total no /menu" },
                // Rende: o ranking
                { MsgRankingFallback, "o ranking" },
                // Rende: Este item nao pode ser guardado: use-o
                // para receber os seus pontos.
                { MsgCannotStore, "Este item n\u00e3o pode ser guardado: use-o para receber os seus pontos." },
                // Rende: Este item nao pode ser largado no chao:
                // use-o para receber os seus pontos.
                { MsgCannotDrop, "Este item n\u00e3o pode ser largado no ch\u00e3o: use-o para receber os seus pontos." },
                // Rende: Voce ja encontrou um destes ha pouco.
                // Deixe para o proximo.
                { MsgLootCooldown, "Voc\u00ea j\u00e1 encontrou um destes h\u00e1 pouco. Deixe para o pr\u00f3ximo." }
            }, this, "pt-BR");
        }

        private string Msg(string key, string userId)
        {
            return lang.GetMessage(key, this, userId);
        }

        /// <summary>
        /// Resolve os marcadores da mensagem do item custom.
        /// </summary>
        /// <remarks>
        /// ####  O JOGADOR NAO PODE LER UM MARCADOR  ####
        ///
        /// O `message` e do CADASTRO: o admin escreve no painel e
        /// ele viaja no origemz.item.set. Sao QUATRO marcadores, e
        /// o que este metodo garante e que nenhum deles chegue cru
        /// a tela de quem joga.
        ///
        /// ####  {pontos} E {item}: O PLUGIN SABE  ####
        ///
        /// O primeiro e o amount JA MULTIPLICADO pelo perUnit - o
        /// mesmo numero que foi para a fila, e nao o que o admin
        /// configurou por unidade. E, com o agrupamento, e a SOMA
        /// das conversoes da janela: quatro trofeus dao "4".
        ///
        /// O segundo e o nome do CADASTRO ("Trofeu Bleik Store"),
        /// que e o mesmo que o ApplyIdentity poe no inventario.
        ///
        /// ####  {ranking}: ELE VEM PRONTO DO AGENTE  ####
        ///
        /// O plugin conhece a METRICA (protocolo); o rotulo que um
        /// jogador le mora na tabela `rankings`, do outro lado, e
        /// viaja junto da definicao. Ver RankingNameOf para as
        /// duas quedas quando ele nao veio.
        ///
        /// ####  {total}: ELE NAO SABE, E NAO VAI PERGUNTAR  ####
        ///
        /// Quem soma e o agente, e o total so existe la. As duas
        /// saidas estao no §9 do Docs/CustomItem/03: (a) mostrar so
        /// o que entrou agora e deixar o total para a tela do menu;
        /// (b) o agente devolver o total no `ack`, e a mensagem
        /// sair depois.
        ///
        /// A DECISAO REGISTRADA E (a), e este metodo a cumpre: o
        /// {total} vira a dica do lang. Fazer (b) poria uma ida e
        /// volta de RCON no caminho critico da conversao - o mesmo
        /// caminho onde o item ja foi destruido e o ponto ainda nao
        /// chegou a lugar nenhum - para escrever um numero que a
        /// tela do menu mostra sempre certo.
        ///
        /// Consequencia que o painel precisa contar a quem
        /// cadastra: o {total} vira uma FRASE, e nao um numero.
        /// "Voce tem {total} pontos" sai torto; o marcador serve
        /// para o FIM da mensagem ("...pontos! {total}").
        /// </remarks>
        private string FormatMessage(CustomItem custom, int points, string userId)
        {
            string message = custom.Message;

            // A esmagadora maioria das mensagens nao tem marcador
            // nenhum, e esta comparacao as devolve sem alocar nada.
            if (string.IsNullOrEmpty(message) || message.IndexOf('{') < 0)
            {
                return message;
            }

            string result = message.Replace("{pontos}", points.ToString(CultureInfo.InvariantCulture));

            // O nome do item vem do CADASTRO, e nao da
            // ItemDefinition: o que o jogador ve no inventario e
            // o NOSSO nome, aplicado pelo ApplyIdentity.
            result = result.Replace("{item}", custom.Name == null ? "" : custom.Name);

            result = result.Replace("{ranking}", RankingNameOf(custom, userId));

            return result.Replace("{total}", Msg(MsgPointsTotalHint, userId));
        }

        /// <summary>
        /// O nome do ranking, com as duas quedas documentadas.
        /// </summary>
        /// <remarks>
        /// ####  A ESCOLHA, QUANDO O ROTULO NAO VEIO  ####
        ///
        /// O rotulo viaja no origemz.item.set (campo `ranking`) e
        /// o agente o le da tabela `rankings`. Ele pode faltar em
        /// dois casos, e nenhum dos dois pode virar um marcador
        /// cru na tela do jogador:
        ///
        ///   1. cadastro empurrado por um agente ANTERIOR a este
        ///      campo. Cai na METRICA - "trophy.bleik" nao e
        ///      bonito, mas diz QUAL ranking, e o proximo
        ///      origemz.item.set conserta sozinho: o agente
        ///      remanda a lista inteira no boot e a cada edicao;
        ///
        ///   2. marcador escrito num item que nao da ponto
        ///      nenhum, onde nao ha nem rotulo nem metrica. Cai
        ///      na frase generica do lang.
        /// </remarks>
        private string RankingNameOf(CustomItem custom, string userId)
        {
            CustomAction action = custom.Action;

            if (action != null && !string.IsNullOrEmpty(action.RankingLabel))
            {
                return action.RankingLabel;
            }

            if (action != null && !string.IsNullOrEmpty(action.Metric))
            {
                return action.Metric;
            }

            return Msg(MsgRankingFallback, userId);
        }

        // ========================================================
        //  O RECIBO, AGRUPADO
        //
        //  ####  QUATRO CONVERSOES, UMA LINHA  ####
        //
        //  MEDIDO em 06/09/2026, na tela do jogo: dar quatro
        //  trofeus pelo painel produzia QUATRO linhas identicas no
        //  chat. O motivo nao e defeito de ninguem - o trofeu
        //  empilha 1, entao sao quatro itens, quatro entradas no
        //  inventario e quatro hooks.
        //
        //  Aqui o TEXTO espera 1,5 s antes de sair, e o que chegar
        //  nesse intervalo soma no mesmo balde: "Voce ganhou 4
        //  Trofeu Bleik Store!".
        //
        //  ####  E SO O TEXTO ESPERA  ####
        //
        //  A fila, a destruicao do item e a emissao do #OZSTAT#
        //  acontecem na hora, dentro do ConvertToPoints. Cada
        //  conversao continua sendo seu proprio evento, com seu
        //  proprio eventId: juntar EVENTOS quebraria a auditoria
        //  ("de onde vieram estes 400 pontos?") e a idempotencia
        //  do agente, que deduplica por esse id.
        //
        //  O que se agrupa e a frase. O numero nela e a SOMA dos
        //  eventos daquele balde, e nao um evento a mais.
        // ========================================================

        /// <summary>A janela do agrupamento, em segundos.</summary>
        /// <remarks>
        /// 1,5 s cobre a rajada de um `origemz.give 4` e a de um
        /// jogador clicando depressa, e ainda e curto o bastante
        /// para o recibo parecer imediato. Acima de ~3 s o jogador
        /// ja desistiu de esperar e conclui que nao ganhou nada.
        /// </remarks>
        private const float MessageGroupSeconds = 1.5f;

        /// <summary>Um balde de mensagem esperando a hora de sair.</summary>
        private class PendingChat
        {
            /// <summary>Quem recebe. Guardado como ID, e nao como
            /// BasePlayer: a referencia pode estar destruida quando
            /// o relogio disparar, e tocar nela derrubaria o hook.</summary>
            public string SteamId;

            /// <summary>Qual item. E dele que sai o {item} e o nome
            /// do ranking.</summary>
            public CustomItem Custom;

            /// <summary>A soma dos pontos das conversoes do balde.</summary>
            public int Points;
        }

        /// <summary>
        /// Os baldes abertos, por jogador E por item.
        /// </summary>
        /// <remarks>
        /// A chave inclui o item porque a frase o NOMEIA: somar um
        /// trofeu com uma medalha daria "Voce ganhou 2 Trofeu Bleik
        /// Store" para quem ganhou um de cada.
        /// </remarks>
        private readonly Dictionary<string, PendingChat> _pendingChat =
            new Dictionary<string, PendingChat>();

        /// <summary>
        /// Anota o recibo. A frase sai daqui a MessageGroupSeconds.
        /// </summary>
        private void QueueChat(BasePlayer player, CustomItem custom, int points)
        {
            if (player == null || custom == null || string.IsNullOrEmpty(custom.Message))
            {
                return;
            }

            string steamId = player.UserIDString;
            string key = steamId + "|" + custom.Id;

            PendingChat bucket;

            if (_pendingChat.TryGetValue(key, out bucket))
            {
                // O relogio ja esta armado para este balde: so
                // soma. Rearmar a cada conversao faria a mensagem
                // nunca sair de quem recebe um item por segundo.
                bucket.Points += points;
                return;
            }

            bucket = new PendingChat();
            bucket.SteamId = steamId;
            bucket.Custom = custom;
            bucket.Points = points;

            _pendingChat[key] = bucket;

            timer.Once(MessageGroupSeconds, delegate { FlushChat(key); });
        }

        /// <summary>
        /// A hora chegou: manda a frase e fecha o balde.
        /// </summary>
        /// <remarks>
        /// Nada aqui pode escapar: isto roda dentro de um relogio,
        /// e uma excecao ali nao tem quem a pegue. O jogador que
        /// desconectou no meio da janela e o caso NORMAL, e nao
        /// erro - o balde e descartado em silencio, e os pontos
        /// dele ja foram somados pelo agente ha um segundo e meio.
        /// </remarks>
        private void FlushChat(string key)
        {
            try
            {
                PendingChat bucket;

                if (!_pendingChat.TryGetValue(key, out bucket))
                {
                    return;
                }

                _pendingChat.Remove(key);

                BasePlayer player = FindConnectedPlayer(bucket.SteamId);

                if (player == null)
                {
                    return;
                }

                player.ChatMessage(FormatMessage(bucket.Custom, bucket.Points, bucket.SteamId));
            }
            catch (Exception ex)
            {
                PrintError("nao consegui mandar o recibo da conversao: " + ex);
            }
        }

        // ========================================================
        //  AUXILIARES
        // ========================================================

        private void Forget(string id)
        {
            CustomItem previous;

            if (!_items.TryGetValue(id, out previous))
            {
                return;
            }

            _items.Remove(id);
            _byMark.Remove(MarkOf(previous.BaseItemId, previous.Skin));
        }

        /// <summary>
        /// O JSON vira definicao. Devolve null quando falta o
        /// essencial.
        /// </summary>
        private static CustomItem ParseItem(JObject body)
        {
            string id = (string)body["id"];
            string baseName = (string)body["base"];

            if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(baseName))
            {
                return null;
            }

            CustomItem item = new CustomItem();
            item.Id = id;
            item.Base = baseName;
            item.Name = (string)body["name"];
            item.Description = (string)body["description"];
            item.Message = (string)body["message"];

            // Ausente quer dizer "deixa como o item base e" - e nao
            // "pode". O item base do trofeu, por exemplo, e
            // deployable no jogo: sem dizer nada, ele continua sendo.
            JToken pickup = body["consumeOnPickup"];
            item.ConsumeOnPickup = !Missing(pickup) && (bool)pickup;

            JToken deployable = body["deployable"];
            item.BlockDeploy = !Missing(deployable) && !(bool)deployable;

            // Zero ou ausente = herda o do item base. Ver
            // CanStackItem para por que isto so sabe DIMINUIR.
            JToken maxStack = body["maxStack"];
            item.MaxStack = Missing(maxStack) ? 0 : (int)maxStack;

            // A skin vem como STRING no JSON, e nao como numero: ela
            // e um UInt64, e um JSON com numero de 20 digitos passa
            // por double em bibliotecas que nao esperam por isso -
            // perdendo precisao em silencio. E a mesma escolha que a
            // tabela do agente faz ao guardar skin_id como TEXT.
            string skinText = (string)body["skin"];
            ulong skin;

            if (!string.IsNullOrEmpty(skinText) &&
                ulong.TryParse(skinText, NumberStyles.None, CultureInfo.InvariantCulture, out skin))
            {
                item.Skin = skin;
            }

            JObject action = body["action"] as JObject;

            if (action != null)
            {
                item.Action = ParseAction(action);
            }

            return item;
        }

        private static CustomAction ParseAction(JObject body)
        {
            CustomAction action = new CustomAction();
            action.Kind = (string)body["kind"];

            if (string.IsNullOrEmpty(action.Kind))
            {
                action.Kind = "none";
            }

            // Qual gesto do jogador dispara a acao. "use" e o padrao
            // porque e o unico que existe em todo item consumivel; o
            // agente pode mandar "drop", "unwrap" ou outro nome que
            // o menu do jogo use.
            action.Trigger = (string)body["trigger"];

            if (string.IsNullOrEmpty(action.Trigger))
            {
                action.Trigger = "use";
            }

            JToken consumes = body["consumes"];
            action.Consumes = Missing(consumes) ? 1 : (int)consumes;

            // ---- kind == "points" ----
            //
            // A metrica e o PROTOCOLO: e ela que vai no evento
            // #OZSTAT# e e por ela que o agente acha o ranking. O
            // perUnit e o peso configurado no item.
            action.Metric = (string)body["metric"];

            JToken perUnit = body["perUnit"];
            action.PerUnit = Missing(perUnit) ? 1 : (int)perUnit;

            // ####  E O ROTULO E SO PARA A TELA  ####
            //
            // Ausente = agente anterior a este campo, ou ranking que
            // sumiu depois do cadastro. Nos dois casos o item
            // continua convertendo: o que muda e o {ranking} da
            // mensagem, que cai na metrica. Ver RankingNameOf.
            action.RankingLabel = (string)body["ranking"];

            JArray effects = body["effects"] as JArray;

            if (effects != null)
            {
                action.Effects = new List<CustomEffect>();

                for (int i = 0; i < effects.Count; i++)
                {
                    JObject entry = effects[i] as JObject;

                    if (entry == null)
                    {
                        continue;
                    }

                    CustomEffect effect = new CustomEffect();
                    effect.Type = (string)entry["type"];
                    effect.Amount = Missing(entry["amount"]) ? 0f : (float)entry["amount"];
                    effect.OnlyIfHealthBelow = Missing(entry["onlyIfHealthBelow"])
                        ? 0f
                        : (float)entry["onlyIfHealthBelow"];

                    action.Effects.Add(effect);
                }
            }

            return action;
        }

        /// <summary>
        /// O campo nao veio, ou veio `null`?
        /// </summary>
        /// <remarks>
        /// ####  NULL NAO E AUSENTE, E ESSA DIFERENCA DERRUBAVA O ITEM  ####
        ///
        /// MEDIDO no servidor de teste em 05/09/2026, mandando
        ///
        ///     origemz.item.set {"id":"x","base":"...","maxStack":null}
        ///
        /// e recebendo
        ///
        ///     System.ArgumentException: Can not convert Null to Int32
        ///     at Oxide.Plugins.OrigemZItems.ParseItem
        ///
        /// O `body["maxStack"]` de um JSON com `null` NAO devolve
        /// null do C#: devolve um JValue de tipo Null, que passa no
        /// `!= null` e estoura no cast. E `max_stack` e nulo na
        /// maioria dos cadastros - "herda o do item base" e o padrao
        /// da tabela -, entao a comparacao antiga recusava, com
        /// INTERNAL_ERROR, quase todo item que o agente mandasse.
        ///
        /// O agente hoje omite o campo nulo (ver toPluginBody, em
        /// core/src/game/custom-items-sync.ts), mas quem digita o
        /// comando na mao nao sabe disso - e o plugin nao pode
        /// depender de o outro lado ser educado.
        /// </remarks>
        private static bool Missing(JToken token)
        {
            return token == null || token.Type == JTokenType.Null;
        }

        /// <summary>
        /// Le um inteiro da linha de comando. `false` = nao e numero.
        /// </summary>
        /// <remarks>
        /// ####  "abc" NAO PODE VALER ZERO  ####
        ///
        /// Copiado do OrigemZAgent.cs:698, e o motivo e o mesmo: um
        /// argumento nao-numerico aceito como 0 viraria "primeira
        /// pagina" em silencio, e o agente leria a mesma pagina para
        /// sempre achando que avancou. Ausente e diferente de
        /// invalido - ausente usa o padrao e devolve `true`.
        ///
        /// O `arg.Args` e null quando o comando vem sem argumento
        /// nenhum, que aqui e o caso comum (`origemz.item.pending`
        /// digitado a mao).
        /// </remarks>
        private static bool TryReadInt(ConsoleSystem.Arg arg, int index, int fallback, out int value)
        {
            value = fallback;

            if (arg.Args == null || index >= arg.Args.Length)
            {
                return true;
            }

            string raw = arg.GetString(index, "").Trim();

            if (raw.Length == 0)
            {
                return true;
            }

            return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
        }

        private static byte[] DecodeBase64(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return null;
            }

            try
            {
                return Convert.FromBase64String(value);
            }
            catch (Exception)
            {
                // Base64 quebrado e recusa, nao excecao: o agente
                // pode ter cortado a linha no meio, e isso e um
                // INVALID_ARGS legivel, nao um erro interno.
                return null;
            }
        }

        /// <summary>
        /// Acha o jogador conectado pelo SteamID.
        ///
        /// Compara STRING com STRING, copiando o
        /// FindConnectedPlayer do OrigemZAgent - e nao por acaso: o
        /// `userID` mudou de tipo em versoes recentes do jogo e nao
        /// aceita mais comparacao com ulong. O UserIDString atravessa
        /// isso sem tocar em conversao nenhuma.
        /// </summary>
        private static BasePlayer FindConnectedPlayer(string steamId)
        {
            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                if (player != null && player.IsConnected && player.UserIDString == steamId)
                {
                    return player;
                }
            }

            return null;
        }

        private static string BuildError(string code)
        {
            return "{\"ok\":false,\"error\":" + JsonConvert.ToString(code) + "}";
        }

        // ========================================================
        //  OS TIPOS
        // ========================================================

        /// <summary>
        /// Uma regra de loot: o que acrescentar, onde e com que
        /// chance.
        ///
        /// ####  ELA CARREGA A MARCA JUNTO  ####
        ///
        /// `Base` e `Skin` tambem estao no cadastro do item custom,
        /// e a duplicacao e deliberada: com eles aqui, o
        /// OnLootSpawn cria o item sem uma segunda consulta no
        /// caminho quente - que dispara milhares de vezes por dia.
        ///
        /// E e ela que faz o item ser o NOSSO: a tabela de loot do
        /// Rust cria tudo com skin 0, e o Match() sai em
        /// `item.skin == 0UL`.
        ///
        /// Os nomes de JSON sao os do `toLootPluginBody` do agente.
        /// Os dois lados mudam juntos.
        /// </summary>
        private class LootRule
        {
            [JsonProperty("id")]
            public string Id;

            /// <summary>O id do item custom. Diagnostico e log.</summary>
            [JsonProperty("item")]
            public string ItemId;

            [JsonProperty("base")]
            public string Base;

            /// <summary>
            /// A skin, como TEXTO no arquivo.
            ///
            /// UInt64 num JSON de 20 digitos passa por double em
            /// bibliotecas que nao esperam por isso, e perde
            /// precisao em silencio. E aqui isso seria fatal: a
            /// skin E a marca.
            /// </summary>
            [JsonProperty("skin")]
            public string SkinText
            {
                get { return Skin.ToString(CultureInfo.InvariantCulture); }
                set
                {
                    ulong parsed;

                    Skin = !string.IsNullOrEmpty(value) &&
                           ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed)
                        ? parsed
                        : 0UL;
                }
            }

            [JsonIgnore]
            public ulong Skin;

            [JsonProperty("containers")]
            public List<string> Containers;

            [JsonProperty("chance")]
            public float Chance;

            [JsonProperty("amountMin")]
            public int AmountMin;

            [JsonProperty("amountMax")]
            public int AmountMax;

            /// <summary>"measuring" conta e nao cria; "live" cria.</summary>
            [JsonProperty("mode")]
            public string Mode;

            /// <summary>Teto por dia. Zero = sem teto.</summary>
            [JsonProperty("dailyCap")]
            public int DailyCap;

            /// <summary>A carencia do portao. Zero = sem carencia.</summary>
            [JsonProperty("playerCooldownHours")]
            public int CooldownHours;

            /// <summary>
            /// Resolvido do Base no primeiro uso, nunca vindo do
            /// JSON: o itemid e do JOGO, e ele muda entre versoes.
            /// </summary>
            [JsonIgnore]
            public int BaseItemId;

            /// <summary>Ja procuramos e este jogo nao tem o item base.</summary>
            [JsonIgnore]
            public bool BaseMissing;
        }

        /// <summary>
        /// A contagem de uma regra num dia, num modo.
        ///
        /// Os quatro numeros respondem perguntas diferentes, e por
        /// isso sao quatro:
        ///
        ///   Rolls    containers ELEGIVEIS que passaram pelo
        ///            sorteio. E o `N` que o Docs/CustomItem/04 §6.3
        ///            precisava e nao conseguiu medir;
        ///   Hits     sorteios que deram positivo;
        ///   Spawned  itens que de fato nasceram. Em "measuring" e
        ///            sempre zero - e essa diferenca e o que faz o
        ///            modo servir para alguma coisa;
        ///   Blocked  jogadores que o portao barrou. O item
        ///            continuou no container.
        ///
        /// Sem Spawned separado de Hits, "nao saiu trofeu" nao teria
        /// como distinguir sorte ruim de teto batendo.
        /// </summary>
        private class LootCounter
        {
            [JsonProperty("rule")]
            public string Rule;

            /// <summary>"yyyy-MM-dd", no relogio DESTE servidor.</summary>
            [JsonProperty("day")]
            public string Day;

            [JsonProperty("mode")]
            public string Mode;

            [JsonProperty("rolls")]
            public int Rolls;

            [JsonProperty("hits")]
            public int Hits;

            [JsonProperty("spawned")]
            public int Spawned;

            [JsonProperty("blocked")]
            public int Blocked;
        }

        /// <summary>O arquivo em oxide/data. Ver o cabecalho do estado.</summary>
        private class LootState
        {
            [JsonProperty("rules")]
            public List<LootRule> Rules;

            [JsonProperty("counters")]
            public List<LootCounter> Counters;

            /// <summary>"regra|steamId" -> epoch em segundos.</summary>
            [JsonProperty("cooldowns")]
            public Dictionary<string, long> Cooldowns;
        }

        private class LootStatsResponse
        {
            [JsonProperty("ok")]
            public bool Ok;

            [JsonProperty("count")]
            public int Count;

            [JsonProperty("stats")]
            public List<LootCounter> Stats;
        }

        private class CustomItem
        {
            public string Id;
            public string Name;
            public string Base;

            /// <summary>Vai no painel do item. Ver ApplyDescription.</summary>
            public string Description;

            /// <summary>
            /// Recusar a colocacao no chao?
            ///
            /// Existe porque o corpo emprestado traz os habitos dele
            /// junto: o `trophy` e deployable no jogo, e um trofeu
            /// nosso nasce colocavel sem ninguem ter pedido.
            /// </summary>
            public bool BlockDeploy;

            /// <summary>
            /// Teto de empilhamento. Zero = o do item base.
            ///
            /// SO DIMINUI. Ver CanStackItem para o porque.
            /// </summary>
            public int MaxStack;

            /// <summary>Resolvido do Base no cadastro, nunca vindo do JSON.</summary>
            public int BaseItemId;

            public ulong Skin;

            /// <summary>Frase no chat ao usar. Opcional.</summary>
            public string Message;

            /// <summary>
            /// Gasta o item assim que ele cai no inventario?
            ///
            /// E o que faz dele um RECIBO em vez de uma coisa para
            /// guardar - e o que resolve as tres proibicoes do
            /// briefing de graca: nao ha o que dropar.
            /// </summary>
            public bool ConsumeOnPickup;

            public CustomAction Action;
        }

        private class CustomAction
        {
            public string Kind;
            public string Trigger;
            public int Consumes;
            public List<CustomEffect> Effects;

            // ---- kind == "points" ----

            /// <summary>Qual ranking recebe (`trophy.bleik`).</summary>
            public string Metric;

            public int PerUnit;

            /// <summary>
            /// O nome do ranking como o JOGADOR o le.
            ///
            /// ####  ELE VEM PRONTO, E NAO E CALCULADO AQUI  ####
            ///
            /// A Metric acima e protocolo ("trophy.bleik"); o
            /// rotulo ("Trofeu Bleik Store") mora na tabela
            /// `rankings` do agente, e este plugin nao a tem. Ele
            /// viaja no origemz.item.set so por causa do marcador
            /// {ranking} da mensagem de chat.
            ///
            /// Vazio quando o cadastro foi gravado por um agente
            /// anterior a este campo - e ai o {ranking} cai na
            /// metrica. Ver FormatMessage.
            /// </summary>
            public string RankingLabel;
        }

        private class CustomEffect
        {
            public string Type;
            public float Amount;
            public float OnlyIfHealthBelow;
        }

        private class ItemSummary
        {
            [JsonProperty("id")]
            public string Id;

            [JsonProperty("name")]
            public string Name;

            [JsonProperty("base")]
            public string Base;

            [JsonProperty("baseItemId")]
            public int BaseItemId;

            [JsonProperty("skin")]
            public string Skin;

            [JsonProperty("action")]
            public string Action;

            [JsonProperty("iconCrc")]
            public uint IconCrc;
        }

        private class ListResponse
        {
            [JsonProperty("ok")]
            public bool Ok;

            [JsonProperty("count")]
            public int Count;

            [JsonProperty("items")]
            public List<ItemSummary> Items;
        }

        /// <summary>
        /// Um evento de estatistica, no formato do RANKING.
        ///
        /// ####  ELE NAO E NOSSO  ####
        ///
        /// O formato e do contrato em Docs\Ranking\20-PLANO-E-CONTRATOS.md
        /// §7, e este plugin e so um dos emissores. Mudar um nome de
        /// campo aqui quebra o agente do outro lado - e o outro lado
        /// tem mais de um emissor.
        /// </summary>
        private class StatEvent
        {
            [JsonProperty("contract")]
            public int Contract;

            [JsonProperty("kind")]
            public string Kind;

            /// <summary>
            /// A chave da IDEMPOTENCIA.
            ///
            /// A fila reenvia no boot e a cada conversao nova. Sem um
            /// id estavel, um ack perdido faria o MESMO evento entrar
            /// duas vezes e DOBRAR o ponto de alguem, sem nada no
            /// log. Quem deduplica e o agente; este id e a chave.
            /// </summary>
            [JsonProperty("eventId")]
            public string EventId;

            [JsonProperty("steamId")]
            public string SteamId;

            [JsonProperty("name")]
            public string Name;

            [JsonProperty("metric")]
            public string Metric;

            /// <summary>Ja multiplicado pelo perUnit do item.</summary>
            [JsonProperty("amount")]
            public int Amount;

            /// <summary>`item:&lt;id do item custom&gt;`.</summary>
            [JsonProperty("source")]
            public string Source;

            /// <summary>Epoch em SEGUNDOS, do relogio do servidor.</summary>
            [JsonProperty("at")]
            public long At;
        }

        private class PendingResponse
        {
            [JsonProperty("ok")]
            public bool Ok;

            /// <summary>
            /// O TOTAL da fila, e nao o tamanho desta pagina.
            ///
            /// E por ele que o agente sabe quando parou de andar: a
            /// pagina pode vir menor que o `limit` (o teto de bytes
            /// nao corta, mas o fim da fila sim) e isso NAO e fim de
            /// lista.
            /// </summary>
            [JsonProperty("count")]
            public int Count;

            /// <summary>O offset pedido, ja normalizado.</summary>
            [JsonProperty("offset")]
            public int Offset;

            /// <summary>
            /// O limit APLICADO, que pode ser menor que o pedido.
            ///
            /// E ele que o agente soma ao offset. Devolver o pedido
            /// faria quem pede 5.000 andar 5.000 e pular a fila
            /// inteira.
            /// </summary>
            [JsonProperty("limit")]
            public int Limit;

            [JsonProperty("pending")]
            public List<StatEvent> Pending;
        }

        private class InspectResponse
        {
            [JsonProperty("ok")]
            public bool Ok;

            [JsonProperty("shortname")]
            public string Shortname;

            [JsonProperty("itemId")]
            public int ItemId;

            [JsonProperty("maxStack")]
            public int MaxStack;

            [JsonProperty("category")]
            public string Category;

            [JsonProperty("hasSkins")]
            public bool HasSkins;

            /// <summary>Vira entidade no chao ao ser colocado.</summary>
            [JsonProperty("deployable")]
            public bool Deployable;

            /// <summary>E vestivel.</summary>
            [JsonProperty("wearable")]
            public bool Wearable;

            /// <summary>Abre e sorteia conteudo (sacola, presente).</summary>
            [JsonProperty("opensLoot")]
            public bool OpensLoot;

            /// <summary>Os nomes crus, para quem for investigar.</summary>
            [JsonProperty("mods")]
            public List<string> Mods;

            /// <summary>
            /// O GUID do modelo que aparece no CHAO.
            ///
            /// Itens sem modelo proprio compartilham o guid do
            /// generico - a sacola. Comparar dois guids e como se
            /// descobre isso.
            /// </summary>
            [JsonProperty("worldModelGuid")]
            public string WorldModelGuid;
        }

        private class DiagResponse
        {
            [JsonProperty("ok")]
            public bool Ok;

            [JsonProperty("id")]
            public string Id;

            [JsonProperty("base")]
            public string Base;

            [JsonProperty("baseItemId")]
            public int BaseItemId;

            [JsonProperty("definitionHasSkins")]
            public bool DefinitionHasSkins;

            [JsonProperty("dryRun")]
            public bool DryRun;

            [JsonProperty("skinRequested")]
            public string SkinRequested;

            [JsonProperty("skinAfterCreate")]
            public string SkinAfterCreate;

            [JsonProperty("skinFinal")]
            public string SkinFinal;

            [JsonProperty("skinSurvived")]
            public bool SkinSurvived;

            [JsonProperty("iconCrc")]
            public uint IconCrc;

            [JsonProperty("iconApplied")]
            public bool IconApplied;

            [JsonProperty("nameApplied")]
            public bool NameApplied;
        }
    }
}
