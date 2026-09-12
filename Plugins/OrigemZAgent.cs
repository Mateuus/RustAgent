// ============================================================
//  OrigemZAgent.cs
//
//  A ponta dentro do jogo do RustAgent. O servico Node.js manda
//  comandos de console por WebRCON e le a resposta; este plugin
//  e quem responde.
//
//  Contrato (fonte da verdade do outro lado):
//      RustAgent\core\src\types\plugin-contract.ts
//
//  Quatro regras valem para o arquivo inteiro:
//
//   1. A resposta e SEMPRE um JSON de UMA LINHA, devolvido por
//      arg.ReplyWith. Puts() e broadcast para todos os clientes
//      RCON conectados e nao tem correlacao com quem pediu -
//      aqui ele serve so para diagnostico.
//
//   2. Resposta que nao bate com o contrato o agente recusa
//      (PLUGIN_INVALID_RESPONSE). Nunca reporte ok:true sem ter
//      entregue: "sucesso" aqui significa item na mao do
//      jogador.
//
//   3. Nada de sintaxe acima de C# 6. O compilador em tempo de
//      execucao do Oxide para nesse teto, e codigo mais novo
//      compila no Visual Studio e e recusado no servidor - com
//      erro longe da causa. Sem "out var", sem tupla, sem funcao
//      local, sem pattern matching.
//
//   4. Resposta longa nao atravessa o RCON inteira. O frame do
//      WebRCON nao negocia tamanho, e a unica medida que este
//      projeto tem esta em DefaultItemsLimit. Por isso TODO
//      comando que devolve lista de tamanho aberto e PAGINADO -
//      origemz.items e origemz.players. Resposta truncada chega
//      ao agente como JSON invalido, que e o pior jeito de
//      falhar: parece bug do plugin, e nao limite de transporte.
//
//   5. A superficie de [HookMethod] existe para os OUTROS
//      plugins (OrigemZVip, OrigemZQueue), nao para o agente
//      Node. O Oxide compila cada .cs num assembly separado,
//      entao tipo declarado aqui NAO atravessa a fronteira:
//      atravessam primitivos, Dictionary<string, object> e JSON
//      em string. Contrato em Docs\OrigemZAgent\HOOKS.md.
//
//  ------------------------------------------------------------
//  #### PONTO DE INCERTEZA ####
//
//  Nao esta oficialmente confirmado que arg.ReplyWith preserva o
//  Identifier do frame WebRCON que originou o comando. Se nao
//  preservar, o agente nao consegue casar resposta com pedido
//  por esse campo - ele tem estrategia alternativa de
//  correlacao pronta. Nao havia servidor disponivel para
//  verificar isso durante a escrita deste plugin.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Newtonsoft.Json;

// JObject/JArray, para ler os payloads em base64 que o agente
// manda nas missoes. Ver a regiao Quests, no fim do arquivo.
using Newtonsoft.Json.Linq;

// Interface.Oxide.DataFileSystem mora em Oxide.Core: e por ele que
// o buffer de estatistica sobrevive a um oxide.reload. Ver a secao
// A COLETA DE ESTATISTICA, no fim do arquivo.
using Oxide.Core;

// [HookMethod] mora em Oxide.Core.Plugins, e nao em Oxide.Plugins
// (onde estao [Info], [Description] e [ConsoleCommand], vindos do
// Oxide.CSharp). Sao namespaces diferentes e nao ha nome repetido
// entre os dois, entao este using nao cria ambiguidade.
using Oxide.Core.Plugins;
using UnityEngine;

namespace Oxide.Plugins
{
    // O nome em [Info], o nome da classe e o nome do arquivo tem
    // de ser identicos, senao o Oxide recusa carregar.
    // 0.4.0: o origemz.items passou a responder "displayNamePtBr".
    // O campo e OPCIONAL, entao o agente antigo continua lendo este
    // plugin, e este plugin continua servindo o agente antigo.
    // 0.5.0: o origemz.timers.sync e o hook GetTimers - a velocidade
    // de fornalha, craft, pesquisa e reciclador por nivel, que quem
    // aplica e o OrigemZPlayer. Um agente antigo nunca manda o
    // comando, e o hook responde null: todo mundo fica no x1.
    [Info("OrigemZAgent", "OrigemZ", "0.5.0")]
    [Description("Ponta no jogo do RustAgent: lista jogadores, publica o catalogo de itens, entrega itens via RCON e expoe o estado de VIP por hook")]
    public class OrigemZAgent : RustPlugin
    {
        // ========================================================
        //  CODIGOS DE ERRO
        //
        //  SCREAMING_SNAKE_CASE, nunca frase para o jogador: quem
        //  traduz e o site. O agente repassa o codigo como veio.
        // ========================================================
        private const string ErrorInvalidArgs = "INVALID_ARGS";
        private const string ErrorInvalidAmount = "INVALID_AMOUNT";

        // Irmao do INVALID_AMOUNT: o numero e legivel e esta dentro
        // do MaxGiveAmount, mas para ESTE item ele exigiria mais
        // pilhas do que MaxStackPieces permite - ver a guarda em
        // HandleGive. Codigo separado de proposito: "pediu demais
        // para este item" e um diagnostico diferente de "pediu um
        // numero invalido", e quem le o log precisa saber qual dos
        // dois foi.
        private const string ErrorTooManyStacks = "TOO_MANY_STACKS";

        private const string ErrorPlayerNotFound = "PLAYER_NOT_FOUND";
        private const string ErrorPlayerDead = "PLAYER_DEAD";
        private const string ErrorPlayerSleeping = "PLAYER_SLEEPING";
        private const string ErrorItemNotFound = "ITEM_NOT_FOUND";
        private const string ErrorItemCreateFailed = "ITEM_CREATE_FAILED";
        private const string ErrorInventoryFull = "INVENTORY_FULL";
        private const string ErrorDropFailed = "DROP_FAILED";
        private const string ErrorInternal = "INTERNAL_ERROR";

        // O que o chamador PEDE (5o argumento do give).
        private const string ModeInventory = "inventory";
        private const string ModeDrop = "drop";
        private const string ModeAuto = "auto";

        // O que ACONTECEU (campo "delivered" da resposta). Sao
        // conjuntos diferentes de proposito: "mixed" so existe
        // como resultado, nunca como pedido.
        private const string DeliveredInventory = "inventory";
        private const string DeliveredDrop = "drop";
        private const string DeliveredMixed = "mixed";

        // Mesmo teto do lado Node (MAX_GIVE_AMOUNT em
        // http\schemas.ts). Duplicado de proposito: o plugin nao
        // pode depender de quem chama, porque o mesmo comando
        // pode ser digitado a mao no console do servidor.
        private const int MaxGiveAmount = 100000;

        // Teto de PEDACOS por chamada do give.
        //
        // A entrega fatia a quantidade em pilhas do tamanho maximo
        // do item (ver HandleGive). Sem teto, "origemz.give <id>
        // rifle.ak 100000 0 auto" - numero que o MaxGiveAmount
        // aceita - criaria 100 mil objetos Item num laco so,
        // porque a AK empilha em 1. Isso trava o servidor.
        //
        // 100 casa com o MaxGiveAmount pela pilha dos recursos:
        // wood/stone/metal empilham em 1000, e 100 pedacos cobrem
        // exatamente os 100000 permitidos. Ou seja, NENHUMA entrega
        // legitima de recurso esbarra nesta guarda.
        //
        // O efeito colateral, honesto e documentado: o limite real
        // por chamada passa a ser min(MaxGiveAmount, 100 * pilha
        // maxima do item). Flecha (pilha 64) fica em 6400 por
        // chamada; AK (pilha 1) fica em 100. Pedido acima disso e
        // recusado com TOO_MANY_STACKS, sem entregar nada - quem
        // precisa de mais divide em chamadas.
        private const int MaxStackPieces = 100;

        private const int GiveArgCount = 5;
        private const int SteamId64Length = 17;

        // Prefixo "origemz." porque comando de console no Oxide e
        // global: sem namespace, dois plugins com um comando
        // "players" colidiriam.
        private const string PlayersCommand = "origemz.players";
        private const string GiveCommand = "origemz.give";
        private const string ItemsCommand = "origemz.items";
        private const string VipSyncCommand = "origemz.vip.sync";
        private const string LoadoutSyncCommand = "origemz.loadout.sync";
        private const string SpawnStatusSyncCommand = "origemz.status.sync";
        private const string TimersSyncCommand = "origemz.timers.sync";

        /// <summary>
        /// `origemz.vehicle.spawn <steamId> <prefab> [combustivel]`
        ///
        /// Poe um veiculo no chao perto do jogador. Ver
        /// HandleVehicleSpawn para o que "perto" e "no chao"
        /// significam aqui.
        /// </summary>
        private const string VehicleSpawnCommand = "origemz.vehicle.spawn";

        /// <summary>
        /// `origemz.vehicle.space <steamId>`
        ///
        /// Ha lugar para um veiculo perto deste jogador? Existe
        /// para a LOJA poder avisar ANTES da compra, em vez de
        /// cobrar e falhar na entrega.
        /// </summary>
        private const string VehicleSpaceCommand = "origemz.vehicle.space";

        // ========================================================
        //  O PEDIDO DE SINCRONIZACAO
        //
        //  #### POR QUE ISTO EXISTE ####
        //
        //  MEDIDO, e custou um jogador nascendo sem nada: um
        //  `oxide.reload` (ou o watcher recompilando o plugin)
        //  ESVAZIA o cache deste plugin sem derrubar o RCON. Para o
        //  RustAgent nada aconteceu - ele nao tem como saber que o
        //  outro lado esqueceu tudo.
        //
        //  O resultado foi silencioso: o cache de kits ficou vazio,
        //  o GetLoadout passou a devolver "[]" para todo nivel, e o
        //  jogador que nasceu depois disso nasceu de maos vazias -
        //  sem erro em log nenhum, porque "nivel sem kit" e um
        //  estado legitimo.
        //
        //  Entao o plugin PEDE. Uma linha marcada no console, que o
        //  agente ja le inteiro, e ele responde empurrando o estado
        //  na hora. E o mesmo canal dos eventos de jogador, com um
        //  marcador proprio.
        //
        //  O agente tambem tem uma rede de seguranca periodica -
        //  mas ela e de minutos, e quem nasce nesse meio-tempo
        //  nasce sem kit. O pedido resolve em segundos.
        // ========================================================
        private const string RequestMarker = "#OZAREQ#";
        private const string RequestLoadouts = "loadouts";
        private const string RequestVips = "vips";

        // ####  AS MISSOES PRECISAM DISSO MAIS QUE O RESTO  ####
        //
        // Um oxide.reload esvazia o catalogo E as atribuicoes.
        // Sem o pedido, o plugin ficaria sem saber o que contar
        // ate o jogador aceitar uma missao nova - e o cache do
        // AGENTE continuaria achando que ja mandou.
        private const string RequestQuests = "quests";
        private const string RequestSpawnStatus = "status";
        private const string RequestTimers = "timers";

        // Paginacao do origemz.items.
        //
        // MEDIDO em servidor real (catalogo de 1243 itens):
        //     limit 250 -> 35.011 bytes, resposta integra
        //     limit 500 -> 70.348 bytes, resposta integra
        //
        // Ou seja, o WebRCON entrega 70 KB num frame sem truncar.
        // O teto continua em 500 nao por medo, mas porque o agente
        // pagina de qualquer jeito e resposta menor volta mais
        // rapido - nao ha ganho em empurrar o limite.
        //
        // O catalogo inteiro numa resposta so passaria de 150 KB, e
        // esse ponto continua NAO medido.
        private const int DefaultItemsLimit = 250;
        private const int MaxItemsLimit = 500;

        // Paginacao do origemz.players - mesma medida, mesmo teto.
        //
        // O origemz.players nasceu devolvendo a lista inteira, o que
        // so nao quebrou porque servidor de teste tem poucos
        // jogadores. O Rust suporta centenas, e a lista completa e
        // exatamente o caminho que trunca o frame.
        //
        // Os numeros vem da mesma medicao do catalogo de itens
        // (250 -> 35.011 bytes; 500 -> 70.348 bytes, ambos
        // integros). Um jogador em JSON nao tem o mesmo tamanho de
        // um item - tem posicao, nome de tamanho livre - entao a
        // medida vale como ordem de grandeza, nao como byte exato.
        // Ficar no mesmo 250/500 mantem a margem que ja se mostrou
        // segura em vez de inventar um teto novo sem medir.
        private const int DefaultPlayersLimit = 250;
        private const int MaxPlayersLimit = 500;

        // ========================================================
        //  VIP - CONTRATO DE HOOK
        //
        //  Ver Docs\OrigemZAgent\HOOKS.md.
        //
        //  ApiVersion incrementa so quando algo muda de forma
        //  INCOMPATIVEL. Como toda chamada entre plugins e por
        //  string, renomear um metodo daqui so falha em runtime -
        //  esta versao e o unico aviso antecipado que o consumidor
        //  tem, e por isso ele deve le-la no boot.
        // ========================================================
        private const int ApiVersion = 1;

        private const string TierBronze = "bronze";
        private const string TierSilver = "silver";
        private const string TierGold = "gold";

        // A HIERARQUIA MORA AQUI, numa tabela, e nao numa sequencia
        // de if: um quarto nivel entra acrescentando uma linha
        // nesta lista, sem tocar em GetVipTier nem em HasVipTier.
        // Numero maior e nivel mais alto; os valores sao ordem
        // relativa, nao tem significado proprio - e por isso podem
        // ser reespacados para encaixar um nivel no meio.
        //
        // OrdinalIgnoreCase por causa da CONSULTA: quem chama
        // HasVipTier de outro plugin pode mandar "Gold". O que ENTRA
        // no cache e sempre normalizado para minusculo (ver
        // BuildVipGrant), entao a resposta tem grafia unica.
        private static readonly Dictionary<string, int> TierRanks =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
            {
                { TierBronze, 1 },
                { TierSilver, 2 },
                { TierGold, 3 }
            };

        // Distancias do raycast que acha o chao para o drop.
        private const float DropRayHeight = 2f;
        private const float DropRayLength = 5f;
        private const float DropGroundOffset = 0.25f;

        // Camadas solidas onde um item pode pousar. Sem mascara o
        // raycast pegaria o collider do proprio jogador e o item
        // cairia num ponto sem sentido.
        private static readonly int GroundMask = LayerMask.GetMask("Terrain", "World", "Construction");

        // Quantos jogadores a ultima chamada de origemz.players
        // teve de descartar por nao terem SteamID64. Guardado so
        // para nao repetir a mesma linha de log a cada consulta do
        // painel - ver HandlePlayers.
        private int _lastInvalidIdCount;

        // O catalogo de itens, ja no formato da resposta. A lista
        // do jogo nao muda enquanto o servidor esta no ar, entao
        // varrer ItemManager.itemList a cada consulta do painel
        // seria trabalho jogado fora. null = ainda nao montado (ou
        // a ultima tentativa falhou), e a proxima chamada tenta de
        // novo - ver EnsureItemCatalog.
        private List<ItemInfo> _itemCatalog;

        // Estado de VIP empurrado pelo RustAgent, por SetVipCache ou
        // por origemz.vip.sync.
        //
        // Em memoria e DESCARTAVEL de proposito: a fonte da verdade
        // e o SQLite do agente, e o plugin reconstroi o cache a cada
        // carga. Nada disso vai para oxide\data nem para o config -
        // estado de VIP duplicado em dois lugares diverge, e o lugar
        // que diverge sempre e o que ninguem olha.
        //
        // O campo e TROCADO inteiro, nunca editado no lugar. Quem le
        // e o GetVipTier, no caminho de conexao do jogador: pegando
        // a referencia uma vez, ele trabalha sobre um dicionario que
        // ninguem mais altera. Nao existe sincronizacao pela metade
        // - ou o JSON inteiro foi lido, ou o cache anterior continua
        // valendo inteiro.
        private Dictionary<string, List<VipGrant>> _vipCache =
            new Dictionary<string, List<VipGrant>>(StringComparer.Ordinal);

        // Os KITS, por nivel, JA SERIALIZADOS em JSON.
        //
        // Guardar a string pronta em vez dos objetos e proposital: o
        // que atravessa a fronteira de assembly ate o OrigemZPlayer e
        // string, e serializar uma vez por sincronizacao e melhor do
        // que uma vez por respawn de jogador - o respawn e caminho
        // quente, a sincronizacao acontece quando um admin edita a
        // tela.
        //
        // OrdinalIgnoreCase na CONSULTA: quem chama GetLoadout de
        // outro plugin pode mandar "Gold". O que ENTRA e sempre
        // normalizado para minusculo.
        private Dictionary<string, string> _loadoutCache =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // VIDA, FOME E SEDE ao nascer, por nivel, JA SERIALIZADAS.
        //
        // Mesmo desenho do _loadoutCache e pelos mesmos motivos: o
        // que atravessa a fronteira de assembly ate o OrigemZPlayer e
        // string, e o consumo acontece no caminho do respawn.
        //
        // Cache SEPARADO do de kits, e nao um campo a mais no mesmo
        // objeto: sao dois recursos com dois ciclos de edicao (duas
        // abas da mesma tela), e um so cache faria salvar um numero
        // de vida invalidar os kits dos cinco niveis.
        private Dictionary<string, string> _spawnStatusCache =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // A VELOCIDADE das coisas, por nivel, JA SERIALIZADA: fornalha,
        // craft, pesquisa e reciclador.
        //
        // Quarto cache, e separado pelo mesmo motivo do de status: e
        // outra aba da tela, com outro ciclo de edicao. Quem consome e
        // o OrigemZPlayer, pelo hook GetTimers.
        private Dictionary<string, string> _timersCache =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // ========================================================
        //  CICLO DE VIDA
        // ========================================================
        private void Init()
        {
            Puts("Init() - comandos: " + PlayersCommand + ", " + ItemsCommand + ", " +
                 GiveCommand + ", " + VipSyncCommand + ". API de hook v" + ApiVersion + ".");
        }

        // Montar o catalogo aqui, e nao na primeira consulta, tira
        // a varredura do caminho da requisicao e faz um erro nela
        // aparecer no boot, em vez de virar um INTERNAL_ERROR
        // solto na cara do admin. Falhar aqui nao e fatal: o
        // catalogo continua null e a primeira consulta remonta.
        private void OnServerInitialized()
        {
            // O cache e volatil e o plugin acabou de (re)carregar:
            // pedimos o estado de volta em vez de esperar a rede de
            // seguranca do agente. Ver RequestMarker.
            //
            // No frame seguinte, e nao agora: durante o boot do
            // plugin o console ainda esta cuspindo as linhas de
            // carga, e uma linha marcada no meio disso e mais facil
            // de se perder.
            timer.Once(1f, delegate
            {
                RequestSync(RequestVips);
                RequestSync(RequestLoadouts);
                RequestSync(RequestSpawnStatus);
                RequestSync(RequestTimers);
                RequestSync(RequestQuests);
            });

            try
            {
                EnsureItemCatalog();
            }
            catch (Exception ex)
            {
                PrintError("Catalogo de itens nao montou no boot: " + ex);
            }

            // ####  O HOOK DE LOOT NASCE DESLIGADO  ####
            //
            // O Oxide registra TODO hook cujo metodo existe na
            // classe. Sem este Unsubscribe, o OnItemAddedToContainer
            // rodaria desde o boot em todo servidor - inclusive nos
            // que nao tem missao de loot nenhuma, que e o caso que a
            // contencao existe para proteger.
            //
            // Quem o liga e o catalogo, no QuestSyncLootHook.
            Unsubscribe("OnItemAddedToContainer");
            _questLootHooked = false;

            // Mesma razao, e este e o mais caro de todos: o
            // OnPlayerInput dispara a cada QUADRO, para cada
            // jogador. Quem o liga e o primeiro NPC.
            //
            // O de conversa vai junto pelo mesmo motivo de higiene -
            // ele e barato (so dispara quando alguem aperta TALK),
            // mas um servidor sem NPC nao tem por que ouvi-lo.
            Unsubscribe("OnPlayerInput");
            Unsubscribe("OnNpcConversationStart");
            _questNpcInputHooked = false;

            // E o lote que o oxide.reload deixou no disco.
            QuestLoad();

            // O SEQ do explosivo sai da recursao sobre os
            // blueprints, e ela NAO pode acontecer dentro do hook de
            // craft: a regra da coleta e que hook so soma em
            // memoria. Aqui ela roda uma vez, com o jogo ja
            // carregado. Falhar nao e fatal - ver BuildSeqCache.
            try
            {
                BuildSeqCache();
            }
            catch (Exception ex)
            {
                PrintError("A tabela de enxofre equivalente nao montou no boot; o primeiro craft " +
                           "de cada item paga a conta: " + ex);
            }
        }

        // ========================================================
        //  origemz.players [offset] [limit]
        //
        //  Resposta de sucesso (uma linha so, quebrada aqui para
        //  caber no comentario):
        //
        //  {"ok":true,"count":143,"offset":0,"limit":250,
        //   "players":[{"steamId":"7656...","name":"Fulano",
        //               "health":100.0,"isAlive":true,
        //               "isSleeping":false,"ping":42,
        //               "connectedSeconds":900,
        //               "position":{"x":0.0,"y":0.0,"z":0.0}}]}
        //
        //  Mesmo padrao do origemz.items, de proposito: "count" e o
        //  TOTAL de jogadores elegiveis, nao o tamanho da pagina, e
        //  e por ele que o painel sabe quantas paginas pedir;
        //  "offset" e "limit" voltam JA NORMALIZADOS, entao quem
        //  pede limit=5000 recebe limit=500 e ve na resposta que
        //  foi limitado, em vez de achar que o resto sumiu; offset
        //  alem do fim devolve players vazio com ok:true, que e
        //  como o painel sabe que acabou. O array "players" nao
        //  mudou de formato.
        //
        //  COMPATIBILIDADE: os dois argumentos sao opcionais e
        //  posicionais. Sem nenhum, e a primeira pagina de
        //  DefaultPlayersLimit - que e o que o lado Node ja chama
        //  hoje, sem argumento nenhum, e continua funcionando.
        //
        //  A PAGINACAO NAO E UM SNAPSHOT: a lista sai de
        //  BasePlayer.activePlayerList, que muda quando alguem
        //  entra ou sai. Entre a pagina 1 e a pagina 2 um jogador
        //  pode ter saido e deslocado o resto, e ai ele aparece
        //  duas vezes ou nenhuma. Congelar isso exigiria guardar o
        //  resultado por sessao de paginacao, com expiracao - custo
        //  que nao se paga para uma lista que o painel reconsulta
        //  em laco de poucos segundos.
        // ========================================================
        [ConsoleCommand(PlayersCommand)]
        private void CommandPlayers(ConsoleSystem.Arg arg)
        {
            // Excecao que sobe de um ConsoleCommand vindo do RCON
            // nao produz resposta nenhuma, e o agente fica
            // pendurado ate estourar o timeout. Por isso todo
            // caminho de saida daqui responde alguma coisa.
            try
            {
                arg.ReplyWith(HandlePlayers(arg));
            }
            catch (Exception ex)
            {
                PrintError("origemz.players falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandlePlayers(ConsoleSystem.Arg arg)
        {
            int offset;
            if (!TryReadInt(arg, 0, 0, out offset) || offset < 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // limit ausente vira o padrao; limit presente e <= 0 e
            // erro de quem chamou, nao pedido de pagina vazia.
            int limit;
            if (!TryReadInt(arg, 1, DefaultPlayersLimit, out limit) || limit < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // Teto silencioso e seguro aqui, como no origemz.items:
            // isto e leitura, e o limit normalizado volta na
            // resposta, entao o chamador ve o que aconteceu.
            if (limit > MaxPlayersLimit)
            {
                limit = MaxPlayersLimit;
            }

            // long para nao estourar: offset e int.MaxValue com
            // limit 500 dobraria para negativo em int, e a janela
            // "total < end" passaria a nunca casar por acidente em
            // vez de por regra. O resultado seria o mesmo, mas por
            // motivo errado - e um dia o motivo errado troca de
            // sinal.
            long end = (long)offset + limit;

            List<PlayerInfo> page = new List<PlayerInfo>();
            int total = 0;
            int invalidIds = 0;

            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                // activePlayerList pode conter entrada morta logo
                // apos uma desconexao.
                if (player == null || !player.IsConnected)
                {
                    continue;
                }

                // O contrato exige SteamID64 de 17 digitos. Bot
                // criado por plugin costuma ter id curto e faria o
                // zod do agente recusar a LISTA INTEIRA - um
                // fantasma derrubaria o painel. Descartar so ele e
                // o mal menor, ja que o contrato nao consegue
                // representa-lo mesmo.
                //
                // Descartado antes de contar: quem nao pode aparecer
                // na lista tambem nao pode entrar no "count", senao
                // o painel pediria uma pagina que nunca enche.
                if (!IsSteamId64(player.UserIDString))
                {
                    invalidIds++;
                    continue;
                }

                // O DTO so e montado DENTRO da janela pedida. O
                // BuildPlayerInfo consulta rede e transform de cada
                // jogador; monta-lo para todos e devolver 250 seria
                // trabalho jogado fora a cada consulta do painel.
                if (total >= offset && total < end)
                {
                    page.Add(BuildPlayerInfo(player));
                }

                total++;
            }

            // Log so quando o cenario muda: o painel consulta em
            // laco e uma linha por consulta viraria spam.
            if (invalidIds != _lastInvalidIdCount)
            {
                _lastInvalidIdCount = invalidIds;
                if (invalidIds > 0)
                {
                    Puts(invalidIds + " jogador(es) fora da lista: id nao e SteamID64.");
                }
            }

            return JsonConvert.SerializeObject(new PlayersOkResponse
            {
                Count = total,
                Offset = offset,
                Limit = limit,
                Players = page
            });
        }

        private static PlayerInfo BuildPlayerInfo(BasePlayer player)
        {
            // net/connection ficam nulos numa janela curta durante
            // a entrada e a saida do jogador.
            // GetAveragePing NAO e membro de Connection. Ele vive no
            // servidor de rede (Net.sv) e recebe a Connection como
            // argumento. Confirmado em Facepunch.Network.dll.
            //
            // GetSecondsConnected devolve float, nao int - o cast e
            // obrigatorio, senao da CS0266.
            int ping = 0;
            int connectedSeconds = 0;

            if (player.net != null && player.net.connection != null)
            {
                if (Network.Net.sv != null)
                {
                    ping = (int)Network.Net.sv.GetAveragePing(player.net.connection);
                }

                connectedSeconds = (int)player.net.connection.GetSecondsConnected();
            }

            // connectedSeconds e nonnegative no schema, entao um
            // valor negativo (relogio do servidor ajustado para
            // tras) invalidaria a resposta inteira. O ping segue a
            // mesma regra por coerencia - ping negativo nao
            // significa nada para quem le o painel.
            if (ping < 0)
            {
                ping = 0;
            }

            if (connectedSeconds < 0)
            {
                connectedSeconds = 0;
            }

            Vector3 position = player.transform != null ? player.transform.position : Vector3.zero;

            return new PlayerInfo
            {
                SteamId = player.UserIDString,
                Name = player.displayName ?? string.Empty,
                Health = SafeFloat(player.health),
                IsAlive = player.IsAlive(),
                IsSleeping = player.IsSleeping(),
                Ping = ping,
                ConnectedSeconds = connectedSeconds,
                Position = new PositionInfo
                {
                    X = SafeFloat(position.x),
                    Y = SafeFloat(position.y),
                    Z = SafeFloat(position.z)
                }
            };
        }

        // ========================================================
        //  origemz.items [offset] [limit]
        //
        //  O catalogo de itens do servidor, para o painel oferecer
        //  busca por nome em vez de exigir o shortname decorado.
        //
        //  Resposta de sucesso (uma linha so, quebrada aqui para
        //  caber no comentario):
        //
        //  {"ok":true,"count":1234,"offset":0,"limit":250,
        //   "items":[{"shortname":"rifle.ak",
        //             "displayName":"Assault Rifle",
        //             "displayNamePtBr":"Rifle de Assalto",
        //             "itemId":1545779598,
        //             "category":"Weapon",
        //             "maxStack":1,
        //             "hasCondition":true,
        //             "consumable":false,
        //             "rarity":2}]}
        //
        //  "count" e o TOTAL do catalogo, nao o tamanho da pagina:
        //  e por ele que o painel sabe quantas paginas pedir.
        //  "offset" e "limit" voltam JA NORMALIZADOS - quem pede
        //  limit=5000 recebe limit=500 e 500 itens, e a resposta
        //  diz isso em vez de deixar o painel achar que o resto
        //  sumiu. offset alem do fim devolve items vazio com
        //  ok:true, que e como o painel sabe que acabou.
        //
        //  POR QUE PAGINADO, E POR QUE NAO EXISTE "all":
        //  sao ~1300 definicoes de item, e o JSON inteiro passa de
        //  150 KB numa unica linha. Isso viaja num frame de
        //  WebRCON e ninguem mediu, neste projeto, o teto desse
        //  frame - oferecer o despejo completo seria oferecer
        //  justamente o caminho nao verificado. Enquanto a medida
        //  nao existir, o padrao e 250 e o teto e 500
        //  (DefaultItemsLimit / MaxItemsLimit).
        //
        //  Os dois argumentos sao opcionais e posicionais. Sem
        //  nenhum, e a primeira pagina.
        //
        //  "displayNamePtBr" SO APARECE quando o jogo tem o nome
        //  traduzido - 1.255 de 1.259 itens, MEDIDO em producao.
        //  Ausente e nulo sao a mesma coisa para quem le: use o
        //  "displayName".
        // ========================================================
        [ConsoleCommand(ItemsCommand)]
        private void CommandItems(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleItems(arg));
            }
            catch (Exception ex)
            {
                PrintError("origemz.items falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleItems(ConsoleSystem.Arg arg)
        {
            List<ItemInfo> catalog = EnsureItemCatalog();
            if (catalog == null)
            {
                PrintError("origemz.items: ItemManager.itemList indisponivel, catalogo nao montado.");
                return BuildError(ErrorInternal);
            }

            int offset;
            if (!TryReadInt(arg, 0, 0, out offset) || offset < 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // limit ausente vira o padrao; limit presente e <= 0 e
            // erro de quem chamou, nao pedido de pagina vazia.
            int limit;
            if (!TryReadInt(arg, 1, DefaultItemsLimit, out limit) || limit < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // Teto silencioso e seguro aqui, ao contrario do give:
            // isto e leitura, e o limit normalizado volta na
            // resposta, entao o chamador ve o que aconteceu.
            if (limit > MaxItemsLimit)
            {
                limit = MaxItemsLimit;
            }

            int available = catalog.Count - offset;
            if (available < 0)
            {
                available = 0;
            }

            int take = available < limit ? available : limit;

            return JsonConvert.SerializeObject(new ItemsOkResponse
            {
                Count = catalog.Count,
                Offset = offset,
                Limit = limit,
                Items = take > 0 ? catalog.GetRange(offset, take) : new List<ItemInfo>()
            });
        }

        // Argumento que nao veio vale o padrao; argumento que veio
        // e nao e numero e erro. Aceitar "abc" como 0 faria um
        // erro de digitacao do painel virar "primeira pagina", e
        // ninguem descobriria.
        private static bool TryReadInt(ConsoleSystem.Arg arg, int index, int fallback, out int value)
        {
            value = fallback;

            // Mesmo cuidado do give: arg.Args e null quando o
            // comando veio sem argumento nenhum. Aqui e o caso
            // comum, nao a excecao.
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

        // ========================================================
        //  MONTAGEM DO CATALOGO
        //
        //  Roda uma vez por carga do plugin. Devolve null quando o
        //  jogo ainda nao tem a lista de itens - null NAO e
        //  cacheado, entao a consulta seguinte tenta de novo.
        // ========================================================
        private List<ItemInfo> EnsureItemCatalog()
        {
            if (_itemCatalog == null)
            {
                _itemCatalog = BuildItemCatalog();
            }

            return _itemCatalog;
        }

        private List<ItemInfo> BuildItemCatalog()
        {
            if (ItemManager.itemList == null)
            {
                return null;
            }

            List<ItemInfo> catalog = new List<ItemInfo>();
            HashSet<string> seen = new HashSet<string>();
            int unusable = 0;
            int duplicated = 0;

            translationMissing = 0;
            translationFailed = 0;

            // Sem declarar o tipo da colecao: ItemManager.itemList
            // ja mudou entre lista e array em versoes do jogo, e o
            // foreach compila com os dois.
            foreach (ItemDefinition definition in ItemManager.itemList)
            {
                if (definition == null || string.IsNullOrEmpty(definition.shortname) || definition.itemid == 0)
                {
                    unusable++;
                    continue;
                }

                string key = definition.shortname.ToLowerInvariant();

                // Este e o unico criterio de filtro que nao e
                // palpite: o catalogo so promete shortname que o
                // origemz.give consegue entregar, e o give resolve
                // por FindItemDefinition. Definicao que nao volta
                // por ai e interna - oferece-la no painel daria um
                // ITEM_NOT_FOUND na hora da entrega.
                //
                // De proposito NAO filtramos por definition.hidden
                // nem por categoria: "escondido" no jogo quer dizer
                // fora da lista do cliente, nao inentregavel. Item
                // a mais e ruido no painel; item a menos e recurso
                // faltando sem ninguem avisar.
                if (ItemManager.FindItemDefinition(key) == null)
                {
                    unusable++;
                    continue;
                }

                // Duas definicoes com o mesmo shortname: o
                // dicionario do jogo so guarda uma, entao a segunda
                // seria uma linha que o painel oferece e o give
                // entrega diferente.
                if (!seen.Add(key))
                {
                    duplicated++;
                    continue;
                }

                catalog.Add(BuildItemInfo(definition));
            }

            Puts("Catalogo de itens: " + catalog.Count + " item(ns). Fora dele: " +
                 unusable + " sem shortname/itemid utilizavel, " +
                 duplicated + " com shortname repetido.");

            // A cobertura da traducao numa linha, para que uma queda
            // dela apareca no console em vez de virar tela em ingles
            // sem explicacao. MEDIDO em producao: 1255 de 1259.
            Puts("Nome em portugues: " + (catalog.Count - translationMissing - translationFailed) +
                 " de " + catalog.Count + " item(ns). Sem traducao no jogo: " + translationMissing +
                 (translationFailed > 0
                     ? ". FALHARAM na leitura: " + translationFailed +
                       " - Translate.GetServerTranslation lancou, e esses itens vao aparecer em ingles."
                     : "."));

            return catalog;
        }

        private ItemInfo BuildItemInfo(ItemDefinition definition)
        {
            return new ItemInfo
            {
                Shortname = definition.shortname,
                DisplayName = ReadDisplayName(definition),
                DisplayNamePtBr = ReadDisplayNamePtBr(definition),
                ItemId = definition.itemid,

                // ItemCategory e enum: ToString() da o nome do
                // membro ("Weapon", "Resources"). Mandar o numero
                // obrigaria o painel a manter uma tabela paralela,
                // que envelhece a cada categoria nova do jogo.
                Category = definition.category.ToString(),

                // Mesma normalizacao do ResolveMaxStackable: existe
                // definicao com stackable 0, e um maxStack 0 faria
                // o painel travar o campo de quantidade num item
                // que o servidor entrega sem reclamar.
                //
                // ATENCAO: aqui o valor vem da DEFINICAO, enquanto a
                // entrega usa Item.MaxStackable() (que passa pelo
                // hook OnMaxStackable). Num servidor com plugin de
                // stack multiplier os dois numeros divergem: o
                // painel mostra a pilha vanilla e a entrega usa a
                // multiplicada. O catalogo e montado uma vez por
                // carga do plugin, fora de qualquer pedido, e nao ha
                // item para sondar aqui - resolver isso e mudanca do
                // catalogo, nao da entrega, e esta fora do escopo
                // desta correcao.
                MaxStack = definition.stackable < 1 ? 1 : definition.stackable,

                HasCondition = definition.condition.enabled,

                Consumable = DefinitionIsConsumable(definition),

                // O cast e direto porque Rarity e um enum de valores
                // pequenos e contiguos, e o que o BetterLoot usa e
                // exatamente este numero - ele faz o mesmo cast em
                // (int)def.rarity antes de escolher o balde.
                Rarity = (int)definition.rarity
            };
        }

        // ========================================================
        //  A definicao tem ItemModConsumable?
        //
        //  ####  PELO NOME, E NAO PELO TIPO  ####
        //
        //  Um `is ItemModConsumable` amarraria a compilacao deste
        //  plugin a uma classe do Assembly-CSharp - e este arquivo
        //  ja parou de compilar uma vez, em 04/09/2026, porque uma
        //  assinatura do jogo mudou e levou junto os tres plugins
        //  que dependem dele. O nome do componente e estavel ha
        //  anos; a comparacao por nome custa uma string e nao
        //  derruba nada quando o jogo mexe na hierarquia.
        //
        //  E o mesmo criterio que o origemz.item.inspect do
        //  OrigemZItems ja usa para responder deployable/wearable.
        // ========================================================
        private static bool DefinitionIsConsumable(ItemDefinition definition)
        {
            ItemMod[] mods = definition.itemMods;

            if (mods == null)
            {
                return false;
            }

            for (int i = 0; i < mods.Length; i++)
            {
                // ####  E `ItemModConsume`, NAO `ItemModConsumable`  ####
                //
                // MEDIDO em 06/09/2026, por `origemz.item.inspect`
                // contra o server01: a maca responde
                // "ItemModConsume, ItemModMenuOption, ..." e a agua
                // "ItemModConsume". O `ItemModConsumable` existe no
                // jogo, mas e o componente que guarda os EFEITOS, e
                // ele nao entra no array `itemMods` da definicao.
                //
                // A versao anterior procurava pelo nome errado e
                // marcava os 1259 itens como nao-consumiveis - o que
                // fazia a trava do cadastro recusar ate uma maca.
                if (mods[i] != null && mods[i].GetType().Name == "ItemModConsume")
                {
                    return true;
                }
            }

            return false;
        }

        // displayName NAO e string: e um objeto de traducao
        // (Translate.Phrase). ToString() nele devolveria o nome do
        // tipo, e o painel mostraria isso em todos os itens.
        //
        // .english e o texto cru da definicao e e a fonte
        // preferida: nao depende do idioma configurado no servidor,
        // entao o mesmo item tem o mesmo rotulo em toda instalacao.
        // .translated so entra quando o ingles vem vazio. Sem
        // nenhum dos dois, o shortname e rotulo feio, mas honesto -
        // melhor do que uma linha em branco no painel.
        private static string ReadDisplayName(ItemDefinition definition)
        {
            string label = null;

            if (definition.displayName != null)
            {
                label = definition.displayName.english;

                if (string.IsNullOrEmpty(label))
                {
                    label = definition.displayName.translated;
                }
            }

            return string.IsNullOrEmpty(label) ? definition.shortname : label;
        }

        // ####  O NOME EM PORTUGUES VEM DO PROPRIO JOGO  ####
        //
        // O CUI so imprime a string que o servidor mandar - nao ha
        // token de traducao numa tela desenhada por plugin. Entao
        // quem escreve "Rifle de Assalto" na tela de kits e AQUI.
        //
        // E a traducao nao precisa ser inventada: ela ja esta no
        // servidor. MEDIDO no server01, dentro de
        // Bundles/shared/content.bundle, em
        // assets/localization/pt-br/engine.json (7.512 chaves).
        // MEDIDO em producao: 1.255 dos 1.259 itens do catalogo.
        //
        // Translate.GetServerTranslation(token, lang) e o que le
        // esse arquivo; "pt-BR" esta na lista allServerLanguages do
        // proprio jogo.
        //
        // ####  E POR QUE NAO displayName.translated  ####
        //
        // Porque ele resolve pelo idioma CORRENTE do servidor, que
        // e "en" - Translate.Phrase.translated chama Translate.Get,
        // MEDIDO no IL de Rust.Localization.dll. Num servidor
        // dedicado ele devolve o ingles em todos os itens, que e
        // exatamente o defeito que esta linha existe para corrigir.
        //
        // ####  O TOKEN NAO E O SHORTNAME  ####
        //
        // Uns coincidem ("wood", "stones", "burlap.headwrap"),
        // outros nao ("scrap" e "scrap.name", "gears" e
        // "gears.name"). Por isso a chave sai de
        // displayName.token, que e o que o jogo usa - montar a
        // chave a partir do shortname derrubaria a cobertura de
        // 1.255 para 1.058 itens - 197 a menos, quase todos os que
        // usam a forma "<shortname>.name".
        //
        // Vazio quando o item nao tem traducao (veiculos e itens
        // internos, na maioria). O agente cai no ingles, que e o
        // que a tela ja mostrava - item sem traducao nao regride.
        // Quantos itens a ultima montagem do catalogo deixou sem
        // nome em portugues, e quantos ficaram assim por EXCECAO.
        // Sao coisas diferentes: item sem traducao e o normal (o
        // jogo nao traduz veiculo), excecao e a API de traducao
        // fora do ar. Os dois viram uma linha so no fim do
        // BuildItemCatalog - avisar por item seriam 1.259 linhas.
        private int translationMissing;
        private int translationFailed;

        private string ReadDisplayNamePtBr(ItemDefinition definition)
        {
            if (definition.displayName == null || string.IsNullOrEmpty(definition.displayName.token))
            {
                translationMissing++;
                return null;
            }

            string translated;

            // Um try aqui, e nao uma checagem: este e o unico ponto
            // do catalogo que chama uma API de outra assembly do
            // jogo, e a leitura e TUDO OU NADA (ver
            // game/item-catalog.ts no agente). Uma excecao aqui
            // derrubaria a rodada inteira e deixaria a rede sem
            // catalogo por causa de um nome bonito.
            try
            {
                translated = Translate.GetServerTranslation(definition.displayName.token, "pt-BR");
            }
            catch (Exception)
            {
                translationFailed++;
                return null;
            }

            if (string.IsNullOrEmpty(translated))
            {
                translationMissing++;
                return null;
            }

            // O arquivo do jogo tem nome com espaco sobrando
            // ("Balaclava de Pano ", "Motocicleta ") - MEDIDO. Na
            // tela isso desloca o texto do icone.
            translated = translated.Trim();

            if (translated.Length == 0)
            {
                translationMissing++;
                return null;
            }

            // De proposito NAO descartamos a traducao igual ao
            // ingles: "Fogger-3000" sai igual nos dois idiomas
            // porque o nome nao muda, e trata-la como ausente faria
            // a tela cair no ingles por um caminho diferente para
            // chegar no mesmo texto.
            return translated;
        }

        // ========================================================
        //  origemz.give <steamId> <shortname> <amount> <skinId> <mode>
        //
        //  Cinco argumentos posicionais, todos obrigatorios.
        //  Resposta de sucesso:
        //  {"ok":true,"delivered":"inventory","given":500,"dropped":0}
        //
        //  ENTREGA EM PILHAS - o ponto delicado deste comando.
        //
        //  O Rust aceita, sem reclamar, um Item com quantidade
        //  acima do limite de pilha: "inventory.give wood 100000"
        //  no vanilla rende UM quadrado com 100000 unidades. Criar
        //  um Item unico com o total pedido, como este plugin fazia
        //  ate a 0.2.0, produzia exatamente isso - MEDIDO: give de
        //  3500 wood (pilha maxima 1000) virava um slot com 3500 em
        //  vez de 1000+1000+1000+500 em quatro slots; give de 5
        //  rifle.ak (pilha maxima 1) virava uma pilha de 5 AKs em
        //  vez de cinco rifles.
        //
        //  Entao a entrega FATIA: enquanto sobra quantidade, cria
        //  um Item de no maximo uma pilha e entrega pelo modo
        //  pedido, somando given/dropped. O JSON e montado uma vez
        //  so, no fim, com os totais.
        //
        //  Consequencias que valem registrar:
        //   - o numero de pedacos tem teto (MaxStackPieces), e o
        //     pedido que passar dele e recusado com TOO_MANY_STACKS
        //     ANTES de qualquer item existir;
        //   - "mixed" passa a poder acontecer ENTRE pedacos (os
        //     tres primeiros mil couberam, os ultimos 500 nao). O
        //     contrato ja preve isso e a invariante
        //     given + dropped == amount continua valendo.
        // ========================================================
        // ========================================================
        //  VEICULOS
        //
        //  ####  O CHAO E O PROBLEMA, NAO O SPAWN  ####
        //
        //  Criar a entidade e uma linha. Achar ONDE poe-la e o
        //  trabalho: um minicopter dentro de uma base, num telhado
        //  ou meio enterrado numa pedra e pior que nao entregar —
        //  ele fica preso, o jogador pagou, e tirar de la exige
        //  admin.
        //
        //  A busca abaixo testa posicoes em circulo ao redor do
        //  jogador e exige de cada uma:
        //
        //    1. chao solido logo abaixo (raycast para baixo);
        //    2. inclinacao suave — em ladeira o veiculo escorrega;
        //    3. espaco livre no raio do veiculo (nada de
        //       construcao, arvore, pedra ou outro veiculo);
        //    4. nao estar dentro de agua, para o que nao flutua.
        //
        //  Nenhuma posicao passar e um desfecho NORMAL: o jogador
        //  esta dentro da base, ou num penhasco. Quem chama trata
        //  isso como recusa, nao como erro.
        // ========================================================

        /// <summary>Distancia do jogador onde o veiculo nasce.</summary>
        private const float VehicleSpawnRadius = 6f;

        /// <summary>Quantas direcoes testar ao redor do jogador.</summary>
        private const int VehicleSpawnTries = 12;

        /// <summary>
        /// Espaco livre exigido em volta.
        ///
        /// 3,5 m cobre o minicopter com folga e ainda deixa um
        /// rowboat nascer numa praia estreita. Maior que isso e
        /// quase nenhum lugar de base serve.
        /// </summary>
        private const float VehicleClearance = 3.5f;

        // O chao usa o GroundMask que este plugin ja declara la em
        // cima, para a entrega de item por drop: e a mesma
        // pergunta ("onde e o solido aqui?"), e duas mascaras com
        // o mesmo nome divergiriam no dia em que alguem ajustasse
        // uma delas.

        /// <summary>
        /// O que IMPEDE o veiculo de nascer ali.
        ///
        /// Construcao e a base do jogador; Deployed sao caixas e
        /// fornalhas; Tree e World pegam arvore e pedra. Sem esta
        /// checagem o veiculo nasce dentro de uma parede.
        /// </summary>
        private static readonly int BlockingMask =
            LayerMask.GetMask("Construction", "Deployed", "Tree", "World", "Vehicle_Large");

        [ConsoleCommand(VehicleSpaceCommand)]
        private void CommandVehicleSpace(ConsoleSystem.Arg arg)
        {
            try
            {
                BasePlayer player = FindConnectedPlayer(arg.GetString(0, ""));

                if (player == null)
                {
                    arg.ReplyWith(BuildError(ErrorPlayerNotFound));
                    return;
                }

                Vector3 spot;
                bool ok = FindVehicleSpot(player, out spot);

                arg.ReplyWith("{\"ok\":true,\"space\":" + (ok ? "true" : "false") + "}");
            }
            catch (Exception ex)
            {
                PrintError(VehicleSpaceCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        /// <summary>
        /// `origemz.vehicle.resolve <nome>` — o que este nome vira.
        ///
        /// #### POR QUE ISTO EXISTE ####
        ///
        /// "sedan" resolveu para `sedanrail.entity` — o vagao de
        /// TRILHO — e o jogador pagou por um carro que nasceu e
        /// nao servia para nada. O nome parecia obvio e nao era.
        ///
        /// Este comando mostra TODOS os candidatos, para quem
        /// monta a oferta escolher pelo nome exato em vez de
        /// torcer para o mais curto ganhar.
        /// </summary>
        [ConsoleCommand("origemz.vehicle.resolve")]
        private void CommandVehicleResolve(ConsoleSystem.Arg arg)
        {
            string needle = arg.GetString(0, "").ToLowerInvariant().Trim();
            if (string.IsNullOrEmpty(needle))
            {
                arg.ReplyWith(BuildError(ErrorInvalidArgs));
                return;
            }

            StringBuilder found = new StringBuilder();
            int count = 0;

            foreach (string path in GameManifest.Current.entities)
            {
                string lower = path.ToLowerInvariant();
                if (!lower.EndsWith(".prefab"))
                {
                    continue;
                }

                int slash = lower.LastIndexOf('/');
                string file = slash < 0 ? lower : lower.Substring(slash + 1);
                file = file.Substring(0, file.Length - ".prefab".Length);

                if (!file.Contains(needle))
                {
                    continue;
                }

                if (count > 0)
                {
                    found.Append(", ");
                }
                found.Append(file);
                count++;

                if (count >= 20)
                {
                    break;
                }
            }

            string chosen = ResolveVehiclePrefab(needle);

            arg.ReplyWith("escolhido: " + (chosen ?? "NENHUM") +
                          "\ncandidatos: " + (count == 0 ? "nenhum" : found.ToString()));
        }

        [ConsoleCommand(VehicleSpawnCommand)]
        private void CommandVehicleSpawn(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleVehicleSpawn(arg));
            }
            catch (Exception ex)
            {
                PrintError(VehicleSpawnCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleVehicleSpawn(ConsoleSystem.Arg arg)
        {
            if (arg.Args == null || arg.Args.Length < 2)
            {
                return BuildError(ErrorInvalidArgs);
            }

            BasePlayer player = FindConnectedPlayer(arg.GetString(0, ""));
            if (player == null)
            {
                return BuildError(ErrorPlayerNotFound);
            }

            string wanted = arg.GetString(1, "");
            if (string.IsNullOrEmpty(wanted))
            {
                return BuildError(ErrorInvalidArgs);
            }

            // ####  O NOME CURTO E RESOLVIDO PELO JOGO  ####
            //
            // MEDIDO no console deste servidor: `spawn sedan`
            // responde "sedantest.entity". Guardar o caminho
            // completo na loja seria guardar algo que muda quando
            // a Facepunch move um arquivo — o nome curto nao.
            string prefab = ResolveVehiclePrefab(wanted);
            if (prefab == null)
            {
                return BuildError("VEHICLE_NOT_FOUND");
            }

            Vector3 spot;
            if (!FindVehicleSpot(player, out spot))
            {
                // Nao e erro: e o jogador estar num lugar sem
                // espaco. Quem chama devolve o dinheiro.
                return BuildError("NO_SPACE");
            }

            // De costas para o jogador, para ele ver a frente do
            // veiculo ao virar.
            Quaternion rotation = Quaternion.LookRotation(
                (spot - player.transform.position).WithY(0f).normalized);

            BaseEntity entity = GameManager.server.CreateEntity(prefab, spot, rotation);
            if (entity == null)
            {
                return BuildError("VEHICLE_NOT_FOUND");
            }

            entity.Spawn();

            int fuel = arg.Args.Length > 2 ? arg.GetInt(2, 0) : 0;
            int fueled = fuel > 0 ? FuelVehicle(entity, fuel) : 0;

            // ####  NADA DE Puts AQUI  ####
            //
            // ISTO CUSTOU UM CARRO DE GRACA. O `Puts` que existia
            // nesta linha, para logar a posicao, foi lido pelo
            // agente como se FOSSE a resposta do comando: o RCON
            // devolve o que sai no console durante a execucao.
            //
            // O JSON nao parseou, a entrega virou VEHICLE_FAILED,
            // o valor foi estornado — e o veiculo estava no chao,
            // porque tinha nascido mesmo.
            //
            // A posicao vai na RESPOSTA, e quem a registra e o
            // agente, do lado dele.
            Vector3 final = entity.transform.position;

            return "{\"ok\":true,\"prefab\":\"" + prefab + "\",\"fuel\":" + fueled +
                   ",\"x\":" + final.x.ToString("0.0") +
                   ",\"y\":" + final.y.ToString("0.0") +
                   ",\"z\":" + final.z.ToString("0.0") + "}";
        }

        /// <summary>
        /// O caminho do prefab a partir do nome curto.
        ///
        /// Usa o mesmo indice que o comando `spawn` do console:
        /// assim "minicopter" continua valendo quando a Facepunch
        /// mover o arquivo de lugar.
        /// </summary>
        private string ResolveVehiclePrefab(string wanted)
        {
            string needle = wanted.ToLowerInvariant().Trim();

            // ####  EXATO PRIMEIRO, DEPOIS PREFIXO  ####
            //
            // ISTO FALHOU DE VERDADE: a oferta dizia "sedan" e o
            // arquivo se chama "sedantest.entity". So o casamento
            // exato nao achava, a compra ia ate o fim, e o jogador
            // era cobrado e estornado por um carro que nunca
            // nasceu.
            //
            // O comando `spawn` do console faz busca parcial — por
            // isso `spawn sedan` responde "sedantest.entity". Aqui
            // vale o mesmo, MAS em duas passadas: um nome que bate
            // exato nunca pode perder para um que so comeca igual.
            string byPrefix = null;

            foreach (string path in GameManifest.Current.entities)
            {
                string lower = path.ToLowerInvariant();
                if (!lower.EndsWith(".prefab"))
                {
                    continue;
                }

                // O nome do arquivo, sem pasta nem extensao.
                int slash = lower.LastIndexOf('/');
                string file = slash < 0 ? lower : lower.Substring(slash + 1);
                file = file.Substring(0, file.Length - ".prefab".Length);

                if (file == needle || file == needle + ".entity")
                {
                    return path;
                }

                // Guarda o PRIMEIRO que comeca igual, e segue
                // procurando um exato.
                if (byPrefix == null && file.StartsWith(needle))
                {
                    byPrefix = path;
                }
            }

            return byPrefix;
        }

        /// <summary>
        /// Um lugar onde o veiculo cabe. Ver o cabecalho da secao.
        /// </summary>
        private bool FindVehicleSpot(BasePlayer player, out Vector3 spot)
        {
            spot = Vector3.zero;

            Vector3 origin = player.transform.position;

            for (int i = 0; i < VehicleSpawnTries; i++)
            {
                float angle = (360f / VehicleSpawnTries) * i;
                Vector3 direction = Quaternion.Euler(0f, angle, 0f) * Vector3.forward;
                Vector3 candidate = origin + direction * VehicleSpawnRadius;

                RaycastHit hit;
                // De 5 m acima para baixo: se o candidato caiu
                // dentro de uma rocha, o raio pega o topo dela e a
                // checagem de espaco livre reprova em seguida.
                // LayerMask.GetMask e da API do UNITY, e nao do
                // jogo: a classe Layers do Rust nao existe neste
                // build, e depender dela amarraria o plugin a uma
                // versao especifica.
                if (!Physics.Raycast(candidate + Vector3.up * 5f, Vector3.down, out hit, 15f,
                        GroundMask, QueryTriggerInteraction.Ignore))
                {
                    continue;
                }

                // Ladeira: o veiculo escorregaria ou capotaria.
                if (Vector3.Angle(hit.normal, Vector3.up) > 20f)
                {
                    continue;
                }

                Vector3 ground = hit.point + Vector3.up * 0.5f;

                // ####  A ESFERA NAO PODE TOCAR O CHAO  ####
                //
                // ISTO REPROVOU O MEIO DE UMA ESTRADA: a camada
                // "World" contem estrada, rocha e monumento — e a
                // esfera, centrada logo acima do solo, encostava
                // no proprio piso em que o carro ia pousar.
                //
                // Centrada MAIS ALTO que o raio, ela cobre so o
                // que esta ACIMA do chao: parede, arvore, outro
                // veiculo. O que impede o pouso ja foi checado
                // pelo raycast e pela inclinacao.
                Vector3 volume = hit.point + Vector3.up * (VehicleClearance + 0.5f);

                if (Physics.CheckSphere(volume, VehicleClearance, BlockingMask,
                        QueryTriggerInteraction.Ignore))
                {
                    continue;
                }

                spot = ground;
                return true;
            }

            return false;
        }

        /// <summary>
        /// Enche o tanque.
        ///
        /// Sem isto o veiculo nasce seco e o jogador que pagou por
        /// um minicopter recebe um enfeite: sem combustivel ele
        /// nao sai do lugar, e a primeira reacao e achar que a
        /// compra falhou.
        ///
        /// Devolve quanto entrou — zero quando o veiculo nao tem
        /// tanque (um barco a remo, um cavalo).
        /// </summary>
        private int FuelVehicle(BaseEntity entity, int amount)
        {
            BaseVehicle vehicle = entity as BaseVehicle;
            if (vehicle == null)
            {
                return 0;
            }

            // ####  O CAST E NECESSARIO  ####
            //
            // `GetFuelSystem()` devolve a INTERFACE `IFuelSystem`,
            // que nao declara `GetFuelContainer` — quem o tem e a
            // classe concreta. Sem o cast, o compilador do Oxide
            // recusa com "does not contain a definition for".
            //
            // `as` e nao um cast direto: um veiculo com outro tipo
            // de sistema (ou nenhum) devolve null e sai limpo, em
            // vez de lancar dentro de uma entrega ja paga.
            EntityFuelSystem fuelSystem = vehicle.GetFuelSystem() as EntityFuelSystem;
            if (fuelSystem == null)
            {
                return 0;
            }

            StorageContainer container = fuelSystem.GetFuelContainer();
            if (container == null || container.inventory == null)
            {
                return 0;
            }

            ItemDefinition definition = ItemManager.FindItemDefinition("lowgradefuel");
            if (definition == null)
            {
                return 0;
            }

            Item item = ItemManager.Create(definition, amount, 0UL);
            if (item == null)
            {
                return 0;
            }

            if (!item.MoveToContainer(container.inventory))
            {
                item.Remove();
                return 0;
            }

            return amount;
        }

        [ConsoleCommand(GiveCommand)]
        private void CommandGive(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleGive(arg));
            }
            catch (Exception ex)
            {
                PrintError("origemz.give falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleGive(ConsoleSystem.Arg arg)
        {
            // arg.Args e null quando o comando veio sem nenhum
            // argumento - indexar antes de checar seria NRE.
            if (arg.Args == null || arg.Args.Length < GiveArgCount)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // NAO indexe arg.Args diretamente: no Rust atual ele e
            // Facepunch.StringView[], nao string[], e StringView nao
            // converte implicitamente para string nem tem os metodos
            // de string (Trim, ToLowerInvariant). Isso rende uma
            // sequencia de CS0266/CS1503 confusos.
            //
            // arg.GetString(indice, padrao) devolve string de fato e
            // e a API estavel para ler argumento de console.
            string steamId = arg.GetString(0, "").Trim();
            string shortname = arg.GetString(1, "").Trim();
            string mode = arg.GetString(4, "").Trim().ToLowerInvariant();

            // Cultura invariante porque isto e protocolo, nao
            // texto de tela: o servidor pode estar em pt-BR e nao
            // e o separador local que decide como o numero chega.
            int amount;
            if (!int.TryParse(arg.GetString(2, ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out amount))
            {
                return BuildError(ErrorInvalidArgs);
            }

            ulong skinId;
            if (!ulong.TryParse(arg.GetString(3, ""), NumberStyles.None, CultureInfo.InvariantCulture, out skinId))
            {
                return BuildError(ErrorInvalidArgs);
            }

            if (shortname.Length == 0 || !IsSteamId64(steamId) || !IsKnownMode(mode))
            {
                return BuildError(ErrorInvalidArgs);
            }

            // Argumento legivel mas fora da faixa e outro
            // diagnostico: o site mandou um numero, so que errado.
            if (amount <= 0 || amount > MaxGiveAmount)
            {
                return BuildError(ErrorInvalidAmount);
            }

            BasePlayer player = FindConnectedPlayer(steamId);
            if (player == null)
            {
                return BuildError(ErrorPlayerNotFound);
            }

            string rejection = CheckDeliveryEligibility(player);
            if (rejection != null)
            {
                return BuildError(rejection);
            }

            ItemDefinition definition = ItemManager.FindItemDefinition(shortname.ToLowerInvariant());
            if (definition == null)
            {
                return BuildError(ErrorItemNotFound);
            }

            int maxStack = ResolveMaxStackable(definition, skinId);

            // Quantos pedacos o pedido daria, arredondando para
            // cima. maxStack e garantidamente >= 1 pelo
            // ResolveMaxStackable, entao nao ha divisao por zero
            // nem laco infinito la embaixo.
            int pieces = amount / maxStack;
            if (amount % maxStack != 0)
            {
                pieces++;
            }

            // A guarda vem ANTES de criar qualquer coisa: recusar
            // depois de meia entrega seria o pior dos dois mundos.
            if (pieces > MaxStackPieces)
            {
                // Os numeros vao para o console, NAO para o JSON: o
                // campo "error" do contrato e um CODIGO, nunca uma
                // frase. Quem precisa dos detalhes e o admin que
                // esta lendo o log, nao o site.
                PrintWarning("origemz.give recusado: " + amount + " de " + shortname +
                             " exigiria " + pieces + " pilha(s) de no maximo " + maxStack +
                             ", acima do teto de " + MaxStackPieces + ". Nada foi entregue.");
                return BuildError(ErrorTooManyStacks);
            }

            // Precheck do mode=inventory: roda UMA vez, sobre o
            // TOTAL, antes do laco. Nao coube -> INVENTORY_FULL sem
            // ter criado nem entregue pedaco nenhum, que e o que o
            // contrato manda. (O item-sonda que a conta usa nasce e
            // morre dentro do FitsEntirely; nao e entrega.)
            if (mode == ModeInventory && !FitsEntirely(player, definition, skinId, amount, maxStack))
            {
                return BuildError(ErrorInventoryFull);
            }

            int totalGiven = 0;
            int totalDropped = 0;
            int remaining = amount;

            while (remaining > 0)
            {
                int piece = remaining < maxStack ? remaining : maxStack;

                Item item = ItemManager.Create(definition, piece, skinId);
                if (item == null || item.amount <= 0)
                {
                    return AbortPartialGive(player, ErrorItemCreateFailed, amount, totalGiven, totalDropped);
                }

                // Recem-criado o item nao precisa de MarkDirty: nao
                // mexemos em condicao nem em blueprint, e as
                // mudancas de container e de quantidade a partir
                // daqui sao feitas pelo proprio jogo, que ja marca o
                // que precisa. A unica excecao esta em DropLeftover.
                GiveOutcome outcome;

                if (mode == ModeDrop)
                {
                    outcome = GiveByDrop(player, item, piece);
                }
                else if (mode == ModeInventory)
                {
                    outcome = GiveToInventoryOnly(player, item, piece);
                }
                else
                {
                    outcome = GiveAuto(player, item, piece);
                }

                if (outcome.Error != null)
                {
                    return AbortPartialGive(player, outcome.Error, amount, totalGiven, totalDropped);
                }

                totalGiven += outcome.Given;
                totalDropped += outcome.Dropped;
                remaining -= piece;
            }

            return BuildGiveOk(amount, ClassifyDelivery(totalGiven, totalDropped), totalGiven, totalDropped);
        }

        // ========================================================
        //  Um pedaco falhou no meio do laco.
        //
        //  Aqui NAO cabe o argumento do "mixed" (ver
        //  GiveToInventoryOnly): la o item chegou ao jogador de um
        //  jeito ou de outro e os numeros fecham. Aqui alguma coisa
        //  se perdeu - o Create devolveu null, ou o Drop nao criou
        //  a entidade no mundo - e a invariante
        //  given + dropped == amount nao tem como fechar. Reportar
        //  ok:true com numeros que nao somam seria mentir para a
        //  loja de um jeito que ninguem detecta.
        //
        //  Entao volta o erro, e o que JA foi entregue vai para o
        //  log com nome e numero, que e a unica forma de reconciliar
        //  a mao depois.
        // ========================================================
        private string AbortPartialGive(BasePlayer player, string code, int amount, int given, int dropped)
        {
            if (given > 0 || dropped > 0)
            {
                PrintError("give abortado com " + code + " para " + player.UserIDString +
                           ": de " + amount + " pedido(s), " + given + " ja entrou(ram) no inventario e " +
                           dropped + " ja caiu(ram) no chao. O resto nao foi entregue.");
            }

            return BuildError(code);
        }

        // ========================================================
        //  TAMANHO MAXIMO DE PILHA - por que um item de mentira.
        //
        //  A fonte obvia seria ItemDefinition.stackable, e ela esta
        //  ERRADA para este uso: quem manda no empilhamento em
        //  servidor com plugin de stack multiplier e o hook
        //  OnMaxStackable do Oxide, e o Oxide so passa por ele
        //  dentro de Item.MaxStackable(). Ler o campo da definicao
        //  entregaria pilha de 1000 num servidor configurado para
        //  10000, e o bug voltaria pela porta dos fundos.
        //
        //  MaxStackable() e metodo de Item, nao de ItemDefinition -
        //  dai a sonda: um Item de quantidade 1 que nasce, responde
        //  a pergunta e morre. Parece desperdicio e nao e; e o unico
        //  jeito de perguntar.
        //
        //  A sonda leva a MESMA skin do pedido de proposito: o hook
        //  recebe o Item inteiro, e plugin que muda pilha por skin
        //  responderia sobre outro item se a sonda fosse generica.
        //
        //  Valor abaixo de 1 (definicao com stackable 0, hook
        //  devolvendo 0) vira 1: zero daria divisao por zero na
        //  conta de pedacos e um laco que nunca anda.
        // ========================================================
        private int ResolveMaxStackable(ItemDefinition definition, ulong skinId)
        {
            Item probe = ItemManager.Create(definition, 1, skinId);

            if (probe == null)
            {
                // Sem sonda nao da para consultar o hook. A
                // definicao e uma resposta pior, mas e melhor do que
                // desistir da entrega por causa da medicao.
                PrintWarning("Sonda de pilha nao pode ser criada para " + definition.shortname +
                             "; usando ItemDefinition.stackable, que ignora OnMaxStackable.");
                return definition.stackable < 1 ? 1 : definition.stackable;
            }

            int maxStack;

            try
            {
                maxStack = probe.MaxStackable();
            }
            finally
            {
                // Sem Remove a sonda fica pendurada no ItemManager -
                // uma por chamada do give.
                probe.Remove();
            }

            return maxStack < 1 ? 1 : maxStack;
        }

        // ========================================================
        //  REGRA DE NEGOCIO: quem pode receber
        //
        //  Metodo separado porque isto muda de opiniao com o
        //  tempo, diferente do resto do fluxo. Hoje recusamos
        //  morto e dormindo: item entregue a quem esta dormindo
        //  ou cai num lugar errado ou se perde junto com o corpo,
        //  e o jogador cobra de volta um item que o sistema jurou
        //  ter entregue.
        //
        //  Vale para os tres modos - inclusive drop, porque
        //  dropar aos pes de um corpo dormindo e a forma mais
        //  facil de o item virar presente para outro jogador.
        //
        //  Devolve o codigo de erro, ou null quando pode receber.
        // ========================================================
        private static string CheckDeliveryEligibility(BasePlayer player)
        {
            if (!player.IsAlive())
            {
                return ErrorPlayerDead;
            }

            if (player.IsSleeping())
            {
                return ErrorPlayerSleeping;
            }

            return null;
        }

        // ========================================================
        //  OS TRES MODOS
        //
        //  Cada um cuida de UM pedaco e devolve o que aconteceu
        //  (GiveOutcome), sem montar resposta: quem soma os totais
        //  e serializa uma unica vez e o HandleGive. Antes do
        //  fatiamento cada modo montava o proprio JSON, o que
        //  deixou de fazer sentido no instante em que a mesma
        //  chamada passou a ter varios pedacos.
        // ========================================================

        // ========================================================
        //  mode=drop - nao encosta no inventario.
        // ========================================================
        private GiveOutcome GiveByDrop(BasePlayer player, Item item, int amount)
        {
            if (!DropAtFeet(player, item))
            {
                return GiveOutcome.Failure(ErrorDropFailed);
            }

            return GiveOutcome.Delivered(0, amount);
        }

        // ========================================================
        //  mode=inventory - tudo ou nada, decidido antes do laco.
        //
        //  O precheck NAO esta aqui: ele roda uma vez so, sobre o
        //  total, no HandleGive. Repeti-lo por pedaco poderia
        //  recusar o quarto pedaco depois de tres entregues, que e
        //  justamente o "tudo ou nada" que o contrato quer evitar.
        //
        //  O que sobra para este metodo e o caso em que o precheck
        //  ERROU - hook de outro plugin, container travado, limite
        //  de pilha mudado entre medir e entregar. Ai o pedaco que
        //  nao coube vai para o chao e a resposta vira "mixed",
        //  NAO erro: parte ja esta com o jogador, e um ok:false
        //  faria a loja entregar de novo, dobrando o item. Perder a
        //  preferencia do modo e melhor do que mentir - e o
        //  PrintWarning existe para o admin saber que a conta
        //  falhou.
        // ========================================================
        private GiveOutcome GiveToInventoryOnly(BasePlayer player, Item item, int amount)
        {
            int given = InsertIntoInventory(player, item);
            int leftover = amount - given;

            if (leftover <= 0)
            {
                return GiveOutcome.Delivered(given, 0);
            }

            PrintWarning("mode=inventory: sobrou " + leftover + " de um pedaco de " + amount +
                         " apos o precheck dizer que cabia. Sobra vai para o chao.");

            return DropLeftover(player, item, given, leftover);
        }

        // ========================================================
        //  mode=auto - o modo da loja.
        //
        //  Tenta o inventario e joga no chao o que nao couber. O
        //  jogador nunca fica sem o que pagou por falta de espaco.
        // ========================================================
        private GiveOutcome GiveAuto(BasePlayer player, Item item, int amount)
        {
            int given = InsertIntoInventory(player, item);
            int leftover = amount - given;

            if (leftover <= 0)
            {
                return GiveOutcome.Delivered(given, 0);
            }

            return DropLeftover(player, item, given, leftover);
        }

        // Sobra de uma entrega parcial: o objeto Item continua
        // vivo com amount ja reduzido para o que nao entrou, entao
        // dropa-lo dropa exatamente a sobra.
        private GiveOutcome DropLeftover(BasePlayer player, Item item, int given, int leftover)
        {
            // Alinha o objeto ao numero que vamos reportar. Em
            // condicao normal os dois ja sao iguais; se algum dia
            // divergirem, quem manda e o que sera reportado - a
            // resposta nao pode dizer "dropped:200" e cair 300 no
            // chao. Este e o unico ponto em que mexemos no item, e
            // por isso o unico MarkDirty do plugin.
            if (item.amount != leftover)
            {
                item.amount = leftover;
                item.MarkDirty();
            }

            if (!DropAtFeet(player, item))
            {
                // Situacao ruim: parte foi entregue e o resto se
                // perdeu. Nao da para reportar sucesso (os numeros
                // nao fecham) nem esconder o que ja entrou - por
                // isso o log detalhado, para reconciliar a mao. O
                // AbortPartialGive completa este log com os totais
                // dos pedacos anteriores.
                PrintError("give: " + given + " entregue(s) e " + leftover +
                           " perdido(s) - o drop falhou para " + player.UserIDString + ".");
                return GiveOutcome.Failure(ErrorDropFailed);
            }

            return GiveOutcome.Delivered(given, leftover);
        }

        // ========================================================
        //  Insere no inventario e devolve QUANTO ENTROU DE FATO.
        //
        //  Este e o coracao do "verificar se a mochila esta
        //  cheia". A entrega pode ser parcial: MoveToContainer
        //  empilha o que cabe nas pilhas existentes e REDUZ
        //  item.amount, deixando o resto no proprio objeto. Quem
        //  so olhar o bool acha que nao entregou nada.
        //
        //  Lemos os dois sinais porque nenhum sozinho basta:
        //
        //   - o bool e a unica fonte confiavel para o caso "coube
        //     inteiro numa pilha que ja existia": ali o jogo faz
        //     Remove() no nosso objeto, e ler item.amount depois
        //     disso da lixo;
        //   - item.amount e a unica fonte para o caso parcial,
        //     onde o bool e false e a diferenca diz o que entrou.
        // ========================================================
        private static int InsertIntoInventory(BasePlayer player, Item item)
        {
            int before = item.amount;

            // GiveItem pode redirecionar para a barra ou para as
            // roupas se o container principal recusar - da no
            // mesmo para nos, o item chegou ao jogador.
            bool acceptedWhole = player.inventory.GiveItem(item, player.inventory.containerMain);
            if (acceptedWhole)
            {
                return before;
            }

            int leftover = item == null ? 0 : item.amount;

            // Cinto de seguranca contra leitura de objeto ja
            // removido: quantidade entregue nunca e negativa nem
            // maior do que a criada.
            if (leftover < 0)
            {
                leftover = 0;
            }

            if (leftover > before)
            {
                leftover = before;
            }

            return before - leftover;
        }

        // ========================================================
        //  Precheck de espaco - usado SO pelo mode=inventory.
        //
        //  Nao serve para decidir entrega nos outros modos: no
        //  auto a resposta certa e tentar e tratar a sobra, que e
        //  sempre exata. Aqui a estimativa e aceitavel porque o
        //  erro dela tem tratamento (ver GiveToInventoryOnly).
        //
        //  ####  A CONTA MUDOU NA 0.2.1 - LEIA ANTES DE MEXER  ####
        //
        //  A versao anterior devolvia true assim que achava UM slot
        //  livre, qualquer que fosse a quantidade. Aquilo era
        //  verdade, mas so PORQUE a entrega enfiava o total inteiro
        //  num Item unico. Com o fatiamento, um slot livre recebe
        //  no maximo UMA pilha - manter a regra antiga faria o
        //  mode=inventory prometer que cabia e derramar as outras
        //  pilhas no chao, que e exatamente o que o modo existe
        //  para nao fazer.
        //
        //  A conta certa e: slots livres * pilha maxima + o espaco
        //  que sobra nas pilhas que ja existem, somando os dois
        //  containers que o GiveItem tenta.
        //
        //  A soma e long, e nao int, por causa do maxStack: ele vem
        //  do hook OnMaxStackable e um plugin de stack multiplier
        //  pode devolver numero absurdo. Em int, 24 slots vezes um
        //  maxStack inflado estoura e vira NEGATIVO - e o precheck
        //  recusaria com INVENTORY_FULL uma entrega que cabia
        //  folgada. Falhar para o lado do "nao cabe" nao e o lado
        //  seguro aqui: e recusar item pago.
        //
        //  A sonda de quantidade 1 existe porque CanAcceptItem e
        //  StacksWith precisam de um Item para responder, e neste
        //  ponto do fluxo nenhum pedaco foi criado ainda - o
        //  precheck nao pode ter efeito colateral de entrega.
        // ========================================================
        private static bool FitsEntirely(BasePlayer player, ItemDefinition definition, ulong skinId, int amount, int maxStack)
        {
            PlayerInventory inventory = player.inventory;
            if (inventory == null)
            {
                return false;
            }

            Item probe = ItemManager.Create(definition, 1, skinId);
            if (probe == null)
            {
                // Sem sonda nao da para medir. Recusar aqui e o
                // lado certo: o mode=inventory promete nao derramar
                // no chao, e entregar as cegas quebraria a promessa.
                return false;
            }

            try
            {
                long room = CountFreeSlotRoom(player, inventory.containerMain, probe, maxStack)
                          + CountFreeSlotRoom(player, inventory.containerBelt, probe, maxStack)
                          + CountStackRoom(player, inventory.containerMain, probe, maxStack)
                          + CountStackRoom(player, inventory.containerBelt, probe, maxStack);

                return room >= amount;
            }
            finally
            {
                probe.Remove();
            }
        }

        // Slot vazio cabe uma pilha cheia - nem mais (o fatiamento
        // nunca cria pedaco maior) nem menos.
        private static long CountFreeSlotRoom(BasePlayer player, ItemContainer container, Item item, int maxStack)
        {
            if (!Accepts(player, container, item))
            {
                return 0;
            }

            int freeSlots = container.capacity - container.itemList.Count;
            if (freeSlots < 0)
            {
                freeSlots = 0;
            }

            return (long)freeSlots * maxStack;
        }

        private static long CountStackRoom(BasePlayer player, ItemContainer container, Item item, int maxStack)
        {
            if (!Accepts(player, container, item))
            {
                return 0;
            }

            long room = 0;
            for (int i = 0; i < container.itemList.Count; i++)
            {
                Item existing = container.itemList[i];
                if (existing == null || !StacksWith(existing, item))
                {
                    continue;
                }

                int free = maxStack - existing.amount;
                if (free > 0)
                {
                    room += free;
                }
            }

            return room;
        }

        // CanAcceptItem cobre o que a aritmetica nao ve: container
        // travado, slot que so aceita roupa, hook de outro plugin
        // recusando o item.
        private static bool Accepts(BasePlayer player, ItemContainer container, Item item)
        {
            if (container == null || container.itemList == null)
            {
                return false;
            }

            return container.CanAcceptItem(player, item, -1) == ItemContainer.CanAcceptResult.CanAccept;
        }

        // Mesma regra que o jogo usa para empilhar: mesmo item,
        // mesma skin e mesmo alvo de blueprint. Ficar mais frouxo
        // aqui superestimaria o espaco.
        private static bool StacksWith(Item existing, Item item)
        {
            return existing.info != null
                && item.info != null
                && existing.info.itemid == item.info.itemid
                && existing.skin == item.skin
                && existing.blueprintTarget == item.blueprintTarget;
        }

        // ========================================================
        //  Dropa o item aos pes do jogador.
        //  Devolve false quando o jogo nao criou a entidade no
        //  mundo - unico caso em que o item se perde de verdade.
        // ========================================================
        private bool DropAtFeet(BasePlayer player, Item item)
        {
            BaseEntity dropped = item.Drop(FindDropPosition(player), Vector3.zero, Quaternion.identity);
            if (dropped == null)
            {
                PrintError("Drop devolveu null para " + item.info?.shortname + " (" +
                           player.UserIDString + ").");
                return false;
            }

            return true;
        }

        // Procura o chao logo abaixo do jogador. Dropar na posicao
        // crua deixaria o item flutuando quando o jogador esta em
        // escada ou plataforma, e afundado no terreno em rampa.
        private static Vector3 FindDropPosition(BasePlayer player)
        {
            Vector3 origin = player.transform.position + Vector3.up * DropRayHeight;

            RaycastHit hit;
            if (Physics.Raycast(origin, Vector3.down, out hit, DropRayLength, GroundMask))
            {
                return hit.point + Vector3.up * DropGroundOffset;
            }

            // Sem chao no alcance (jogador caindo, dentro de
            // agua): os pes dele sao o melhor palpite.
            return player.transform.position + Vector3.up * DropGroundOffset;
        }

        // ========================================================
        //  SUPERFICIE DE HOOK - VIP
        //
        //  Consumida por outro plugin com [PluginReference] +
        //  Call("Nome", ...). Tres regras valem para o bloco todo:
        //
        //   1. NADA AQUI PODE LANCAR. Excecao que sobe de um
        //      HookMethod vira erro no log do Oxide e a chamada
        //      devolve null para quem chamou - que quase nunca
        //      trata isso. Cada hook tem try/catch e um valor de
        //      saida honesto para o caso ruim.
        //
        //   2. NADA AQUI PODE ESPERAR I/O. O consumidor tipico e o
        //      hook de fila, no caminho de conexao do jogador.
        //      Toda leitura sai do cache em memoria; quem alimenta
        //      o cache e o RustAgent EMPURRANDO (SetVipCache /
        //      origemz.vip.sync), nunca este plugin puxando.
        //
        //   3. O nome do hook sai de nameof(...), nao de string
        //      digitada. Com string, renomear o metodo deixaria o
        //      atributo apontando para o nome velho - e como a
        //      chamada e por string dos dois lados, isso so
        //      apareceria em runtime, no servidor.
        // ========================================================

        // Ver ApiVersion: o unico aviso antecipado de mudanca
        // incompativel que o consumidor tem.
        [HookMethod(nameof(GetApiVersion))]
        private int GetApiVersion()
        {
            return ApiVersion;
        }

        // Nivel ativo mais alto ("gold" | "silver" | "bronze"), ou
        // null quando o jogador nao e VIP.
        [HookMethod(nameof(GetVipTier))]
        private string GetVipTier(string steamId)
        {
            try
            {
                VipGrant grant = FindHighestActiveVipGrant(steamId);
                return grant == null ? null : grant.Tier;
            }
            catch (Exception ex)
            {
                PrintError("GetVipTier falhou para " + steamId + ": " + ex);

                // null e "nao e VIP", e e o lado seguro: uma falha
                // aqui nao pode virar beneficio concedido a quem
                // nao tem.
                return null;
            }
        }

        // "tem este nivel OU SUPERIOR", pela tabela TierRanks.
        [HookMethod(nameof(HasVipTier))]
        private bool HasVipTier(string steamId, string tier)
        {
            try
            {
                if (string.IsNullOrEmpty(tier))
                {
                    return false;
                }

                int required;
                if (!TierRanks.TryGetValue(tier.Trim(), out required))
                {
                    // Nivel fora da tabela e defeito de quem chamou,
                    // mas a resposta continua sendo false: o
                    // consumidor esta no caminho de conexao do
                    // jogador e nao tem o que fazer com uma
                    // excecao. O log e para o admin achar o plugin
                    // que esta perguntando errado.
                    PrintWarning("HasVipTier: nivel desconhecido '" + tier + "'. Respondendo false.");
                    return false;
                }

                VipGrant grant = FindHighestActiveVipGrant(steamId);
                return grant != null && grant.Rank >= required;
            }
            catch (Exception ex)
            {
                PrintError("HasVipTier falhou para " + steamId + ": " + ex);
                return false;
            }
        }

        // Detalhe completo em JSON, para a tela de status:
        //
        //  {"steamId":"7656...","tiers":[
        //     {"tier":"gold","expiresAt":"2026-09-04T00:00:00Z"},
        //     {"tier":"bronze","expiresAt":null}]}
        //
        // expiresAt null e vitalicio. Os niveis saem do mais alto
        // para o mais baixo, para a tela nao ter de reordenar.
        //
        // So nivel ATIVO entra. Nivel vencido nao e detalhe, e
        // historico - e historico mora no SQLite do agente. O que
        // esta aqui e o retrato do que vale agora.
        //
        // SteamID desconhecido devolve tiers vazio, e nao erro: "que
        // VIP este jogador tem" tem resposta valida para quem nao
        // tem nenhum, e o formato do contrato nao preve campo de
        // erro.
        [HookMethod(nameof(GetVipInfo))]
        private string GetVipInfo(string steamId)
        {
            string normalized = steamId ?? string.Empty;

            try
            {
                // A lista ja vem copiada do cache; ordenar aqui nao
                // mexe na lista que o cache guarda.
                List<VipGrant> active = CollectActiveVipGrants(normalized);
                active.Sort(CompareVipGrantByRankDesc);

                List<VipTierInfo> tiers = new List<VipTierInfo>();

                for (int i = 0; i < active.Count; i++)
                {
                    tiers.Add(new VipTierInfo
                    {
                        Tier = active[i].Tier,
                        ExpiresAt = active[i].IsLifetime ? null : FormatExpiresAt(active[i].ExpiresAtUtc)
                    });
                }

                return BuildVipInfo(normalized, tiers);
            }
            catch (Exception ex)
            {
                PrintError("GetVipInfo falhou para " + normalized + ": " + ex);

                // Devolver null daria NullReferenceException no
                // consumidor que faz o parse direto. Um JSON valido
                // de lista vazia e a mesma resposta de "nao e VIP",
                // que e o lado seguro.
                return BuildVipInfo(normalized, new List<VipTierInfo>());
            }
        }

        // O RustAgent empurra o estado de VIP por aqui. Formato:
        //
        //  {"players":{"7656...":[{"tier":"gold","expiresAt":"2026-09-04T00:00:00Z"}]}}
        //
        // SUBSTITUI o cache inteiro: quem sumiu do JSON perdeu o
        // VIP. Merge seria pior - um VIP revogado no banco ficaria
        // vivo no plugin ate o proximo restart, e ninguem
        // perceberia, porque o sintoma e beneficio A MAIS.
        [HookMethod(nameof(SetVipCache))]
        private void SetVipCache(string json)
        {
            try
            {
                int players;
                string error = ApplyVipCache(json, out players);

                if (error != null)
                {
                    // O hook e void: nao existe canal de retorno
                    // para o chamador saber que falhou. O log e o
                    // unico aviso, e por isso e erro, nao aviso.
                    PrintError("SetVipCache recusado (" + error +
                               "). O cache anterior continua valendo.");
                    return;
                }

                Puts("SetVipCache: " + players + " jogador(es) no cache de VIP.");
            }
            catch (Exception ex)
            {
                PrintError("SetVipCache falhou: " + ex);
            }
        }

        // Telemetria da fila. Sem retorno de proposito: roda no
        // caminho de conexao do jogador e nao pode somar latencia a
        // entrada de ninguem. "action" e bypass, queued, joined ou
        // left.
        //
        // POR ORA SO LOGA. Guardar os eventos para o agente buscar
        // pediria um comando de console novo para drenar E uma
        // politica de descarte para quando ninguem drena; sem os
        // dois, o buffer cresce sem teto num caminho quente - troca
        // telemetria perdida por memoria vazando. O agente ja le o
        // console pelo RCON, entao a linha abaixo chega nele sem
        // encanamento novo.
        // O kit de um nivel, em JSON, para o OrigemZPlayer montar.
        //
        //     [{"slot":"belt","shortname":"rifle.ak","amount":1,
        //       "skinId":"0","position":0}]
        //
        // Devolve "[]" para nivel sem kit e para nivel desconhecido:
        // os dois significam a mesma coisa para quem vai entregar,
        // que e "nao ha o que dar". Distingui-los exigiria um codigo
        // de erro num hook que roda no caminho do respawn.
        //
        // NUNCA devolve null: null e "o agente nao respondeu", e o
        // consumidor trata isso como falha - o que faria um nivel
        // sem kit parecer erro de comunicacao.
        [HookMethod(nameof(GetLoadout))]
        private string GetLoadout(string tier)
        {
            try
            {
                string normalized = NormalizeLoadoutTier(tier);

                if (normalized == null)
                {
                    return "[]";
                }

                string json;

                if (!_loadoutCache.TryGetValue(normalized, out json) || json == null)
                {
                    return "[]";
                }

                return json;
            }
            catch (Exception ex)
            {
                PrintError("GetLoadout falhou para '" + tier + "': " + ex);
                return "[]";
            }
        }

        [HookMethod(nameof(NotifyQueueEvent))]
        private void NotifyQueueEvent(string steamId, string action, string tier, int queueSize)
        {
            try
            {
                Puts("queue-event action=" + (string.IsNullOrEmpty(action) ? "?" : action) +
                     " steamId=" + (string.IsNullOrEmpty(steamId) ? "?" : steamId) +
                     " tier=" + (string.IsNullOrEmpty(tier) ? "-" : tier) +
                     " queueSize=" + queueSize);
            }
            catch (Exception ex)
            {
                PrintError("NotifyQueueEvent falhou: " + ex);
            }
        }

        // ========================================================
        //  origemz.vip.sync <json>
        //
        //  O caminho do RustAgent para empurrar o estado de VIP:
        //  mesmo codigo do SetVipCache, com resposta.
        //
        //      {"ok":true,"players":12}
        //      {"ok":false,"error":"INVALID_ARGS"}
        //
        //  #### ARGUMENTO COM ESPACO - LEIA A ESCOLHA ####
        //
        //  O console do Rust separa argumentos por espaco, e JSON
        //  costuma ter espaco. A ESCOLHA AQUI e juntar de volta
        //  todos os argumentos com UM espaco entre eles, em vez de
        //  exigir JSON compactado de quem chama. Exigir seria pior:
        //  a falha vira INVALID_ARGS sem dizer que o problema foi
        //  um espaco, e quem digitou no console nao tem como
        //  adivinhar.
        //
        //  O que a juncao NAO preserva: uma sequencia de varios
        //  espacos vira um so. Entre tokens de JSON isso e
        //  irrelevante, porque o parser ignora espaco em branco.
        //  Dentro de uma string seria destrutivo - mas este payload
        //  so carrega SteamID, nome de nivel e data ISO, e nenhum
        //  dos tres tem espaco dentro. Se o formato um dia ganhar
        //  texto livre, ESTA e a linha que quebra.
        //
        //  TAMANHO: vale o mesmo limite de frame do resto do
        //  arquivo. Payload cortado no meio nao parseia e cai em
        //  INVALID_ARGS - e, como o cache so e trocado DEPOIS do
        //  parse completo (ver ApplyVipCache), um envio truncado
        //  nunca deixa o plugin com meia lista de VIP. Ou entra
        //  inteiro, ou nao entra.
        // ========================================================
        // #### O Puts SAI NO PROXIMO FRAME, E ISSO NAO E ESTILO ####
        //
        // MEDIDO neste servidor: um Puts dentro de um ConsoleCommand
        // sai pelo RCON com o MESMO Identifier do pedido e com
        // Type=Generic - ou seja, indistinguivel da resposta. E ele
        // sai ANTES dela mesmo quando esta depois no codigo: o
        // arg.ReplyWith so e transmitido quando o comando TERMINA,
        // enquanto o Puts escreve na hora.
        //
        // O agente casa a primeira mensagem nao-diagnostica com o
        // identifier (rcon/frames.ts, matchPendingIdentifier), entao
        // a linha de log CHEGA NO LUGAR DA RESPOSTA.
        //
        // O sintoma ficou no ar sem ninguem notar: o plugin aplicava
        // o cache com sucesso e o agente registrava
        // PLUGIN_INVALID_RESPONSE em TODA sincronizacao ("no JSON
        // object found in the console output (got: [OrigemZAgent]
        // origemz.vip.sync: 1 jogador(es)...)"). O VIP funcionava; o
        // que nao funcionava era o agente SABER que funcionou - e
        // com isso o unico alarme que existia para esse caminho.
        //
        // O timer.Once(0f) empurra o log para o frame seguinte, com
        // a resposta ja transmitida. PrintWarning e PrintError NAO
        // tem esse problema: saem com Type=Warning/Error e o agente
        // os descarta na correlacao.
        [ConsoleCommand(VipSyncCommand)]
        private void CommandVipSync(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleVipSync(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError("origemz.vip.sync falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // logLine sai por out, e nao por Puts aqui dentro: ver o
        // comentario do CommandVipSync. null = nada a logar.
        private string HandleVipSync(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            if (arg.Args == null || arg.Args.Length == 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // O payload chega em BASE64 - ver DecodeBase64Payload
            // para o motivo (o console do Rust come as aspas do JSON).
            //
            // Aceitamos tambem JSON cru quando ele nao tem aspas para
            // perder, o que na pratica so acontece em teste manual com
            // payload trivial. Nao e o caminho suportado.
            string raw = JoinConsoleArgs(arg);
            string payload = DecodeBase64Payload(raw);

            if (payload == null)
            {
                payload = raw;
            }

            int players;
            string error = ApplyVipCache(payload, out players);

            if (error != null)
            {
                return BuildError(error);
            }

            logLine = VipSyncCommand + ": " + players + " jogador(es) no cache de VIP.";

            return JsonConvert.SerializeObject(new VipSyncOkResponse { Players = players });
        }

        // Remonta o argumento unico que o console fatiou. Usa
        // arg.GetString, e nao arg.Args direto, pela mesma razao do
        // give: no Rust atual arg.Args e Facepunch.StringView[], que
        // nao converte para string.
        private static string JoinConsoleArgs(ConsoleSystem.Arg arg)
        {
            string[] parts = new string[arg.Args.Length];

            for (int i = 0; i < parts.Length; i++)
            {
                parts[i] = arg.GetString(i, "");
            }

            return string.Join(" ", parts);
        }

        // ========================================================
        //  POR QUE O SYNC RECEBE BASE64, E NAO JSON CRU
        //
        //  MEDIDO no servidor real. Mandando por RCON
        //
        //      origemz.vip.sync {"players":{"7656...":[{"tier":"gold"}]}}
        //
        //  o plugin recebe o JSON com as ASPAS COMIDAS: o parser de
        //  console do Rust trata token entre aspas como argumento
        //  citado e as remove. O erro que sai e
        //
        //      Unexpected character encountered while parsing value: g
        //      Path 'players.7656....[0].tier'
        //
        //  ou seja, "gold" chegou como gold. Remontar com
        //  string.Join nao desfaz isso - a informacao ja se perdeu
        //  antes de chegar aqui.
        //
        //  Base64 nao tem aspas, nem espaco, nem chave: atravessa
        //  qualquer parser de console sem perder byte. O custo e 33%
        //  a mais de tamanho, o que importa pouco perto de a
        //  alternativa simplesmente nao funcionar.
        // ========================================================
        private static string DecodeBase64Payload(string encoded)
        {
            if (string.IsNullOrEmpty(encoded))
            {
                return null;
            }

            try
            {
                byte[] bytes = Convert.FromBase64String(encoded.Trim());
                return Encoding.UTF8.GetString(bytes);
            }
            catch (FormatException)
            {
                return null;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        // ========================================================
        //  CACHE DE VIP
        // ========================================================

        // Le o JSON e TROCA o cache. Devolve null quando aplicou, ou
        // o codigo de erro quando nao aplicou - e nesse caso o cache
        // anterior fica intacto.
        //
        // Monta um dicionario novo e so atribui ao campo na ultima
        // linha. Escrever direto no cache faria um payload que
        // falha no meio deixar metade dos jogadores no estado novo e
        // metade no velho, que e o pior estado possivel: parece
        // consistente e nao e.
        private string ApplyVipCache(string json, out int playerCount)
        {
            playerCount = 0;

            if (string.IsNullOrEmpty(json))
            {
                return ErrorInvalidArgs;
            }

            VipSyncPayload payload;

            try
            {
                payload = JsonConvert.DeserializeObject<VipSyncPayload>(json);
            }
            catch (Exception ex)
            {
                // JSON ilegivel e INVALID_ARGS, nao INTERNAL_ERROR:
                // o defeito esta no que chegou, nao aqui dentro. A
                // mensagem da excecao vai para o log porque e a
                // unica pista de ONDE o JSON quebrou - e ela nao
                // entra na resposta, que so leva codigo.
                PrintWarning("Cache de VIP recusado: JSON ilegivel. " + ex.Message);
                return ErrorInvalidArgs;
            }

            if (payload == null || payload.Players == null)
            {
                return ErrorInvalidArgs;
            }

            Dictionary<string, List<VipGrant>> rebuilt =
                new Dictionary<string, List<VipGrant>>(StringComparer.Ordinal);

            int discardedPlayers = 0;
            int discardedGrants = 0;

            foreach (KeyValuePair<string, List<VipTierPayload>> entry in payload.Players)
            {
                // Mesma regra do origemz.players: chave que nao e
                // SteamID64 nao casa com jogador nenhum, entao
                // guarda-la so gastaria memoria.
                if (!IsSteamId64(entry.Key))
                {
                    discardedPlayers++;
                    continue;
                }

                List<VipGrant> grants = new List<VipGrant>();

                if (entry.Value != null)
                {
                    for (int i = 0; i < entry.Value.Count; i++)
                    {
                        VipGrant grant = BuildVipGrant(entry.Value[i]);

                        if (grant == null)
                        {
                            discardedGrants++;
                            continue;
                        }

                        grants.Add(grant);
                    }
                }

                rebuilt[entry.Key] = grants;
            }

            // A troca. Ate esta linha o cache antigo era o que valia.
            _vipCache = rebuilt;
            playerCount = rebuilt.Count;

            if (discardedPlayers > 0 || discardedGrants > 0)
            {
                PrintWarning("Cache de VIP aplicado com descarte: " + discardedPlayers +
                             " chave(s) que nao sao SteamID64 e " + discardedGrants +
                             " concessao(oes) com nivel desconhecido ou data ilegivel.");
            }

            return null;
        }

        // Uma concessao do JSON vira VipGrant, ou null quando nao da
        // para confiar nela.
        //
        // Nivel fora da TierRanks e data que nao parseia sao
        // DESCARTADOS, e nao aceitos com um valor de reserva.
        // Aceitar nivel desconhecido deixaria no cache uma entrada
        // que o HasVipTier nunca consegue ordenar; tratar data
        // ilegivel como vitalicia daria VIP eterno por causa de um
        // erro de digitacao. Descartar erra para o lado de conceder
        // de MENOS - que e o lado de que alguem reclama, e
        // reclamacao e deteccao.
        private static VipGrant BuildVipGrant(VipTierPayload payload)
        {
            if (payload == null || string.IsNullOrEmpty(payload.Tier))
            {
                return null;
            }

            string tier = payload.Tier.Trim().ToLowerInvariant();

            int rank;
            if (!TierRanks.TryGetValue(tier, out rank))
            {
                return null;
            }

            string raw = payload.ExpiresAt == null ? null : payload.ExpiresAt.Trim();

            // Campo ausente, null ou vazio: vitalicio.
            if (string.IsNullOrEmpty(raw))
            {
                return new VipGrant { Tier = tier, Rank = rank, IsLifetime = true };
            }

            // AssumeUniversal + AdjustToUniversal porque o contrato
            // manda ISO 8601 em UTC. Sem AssumeUniversal, uma data
            // que chegasse sem fuso seria lida no fuso do SERVIDOR:
            // num servidor em pt-BR o VIP acabaria tres horas antes
            // ou depois do que o banco gravou, e a diferenca so
            // apareceria na virada.
            DateTime expiresAtUtc;
            if (!DateTime.TryParse(raw, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out expiresAtUtc))
            {
                return null;
            }

            return new VipGrant
            {
                Tier = tier,
                Rank = rank,
                IsLifetime = false,
                ExpiresAtUtc = expiresAtUtc
            };
        }

        // O caminho de leitura mais quente do plugin: e ele que o
        // hook de fila chama quando o jogador esta conectando.
        private VipGrant FindHighestActiveVipGrant(string steamId)
        {
            List<VipGrant> grants = ReadVipGrants(steamId);
            if (grants == null)
            {
                return null;
            }

            DateTime nowUtc = DateTime.UtcNow;
            VipGrant best = null;

            for (int i = 0; i < grants.Count; i++)
            {
                VipGrant grant = grants[i];

                if (grant == null || !grant.IsActive(nowUtc))
                {
                    continue;
                }

                if (best == null || grant.Rank > best.Rank)
                {
                    best = grant;
                }
            }

            return best;
        }

        // Copia: quem chama ordena e filtra a vontade sem tocar na
        // lista que o cache guarda.
        private List<VipGrant> CollectActiveVipGrants(string steamId)
        {
            List<VipGrant> active = new List<VipGrant>();
            List<VipGrant> grants = ReadVipGrants(steamId);

            if (grants == null)
            {
                return active;
            }

            DateTime nowUtc = DateTime.UtcNow;

            for (int i = 0; i < grants.Count; i++)
            {
                VipGrant grant = grants[i];

                if (grant != null && grant.IsActive(nowUtc))
                {
                    active.Add(grant);
                }
            }

            return active;
        }

        // A referencia do campo e lida UMA vez, para uma variavel
        // local. Um SetVipCache concorrente troca o campo inteiro
        // (ver _vipCache); reler o campo no meio de um laco leria
        // dois estados diferentes na mesma resposta.
        private List<VipGrant> ReadVipGrants(string steamId)
        {
            if (string.IsNullOrEmpty(steamId))
            {
                return null;
            }

            Dictionary<string, List<VipGrant>> cache = _vipCache;

            List<VipGrant> grants;
            return cache.TryGetValue(steamId, out grants) ? grants : null;
        }

        // Metodo nomeado, e nao lambda inline: em C# 6 nao ha funcao
        // local, e uma lambda aqui seria recriada a cada chamada do
        // GetVipInfo.
        private static int CompareVipGrantByRankDesc(VipGrant left, VipGrant right)
        {
            return right.Rank.CompareTo(left.Rank);
        }

        // Reemite a data no formato do contrato em vez de ecoar o
        // texto que chegou. A fonte normal e o agente, que ja manda
        // ISO 8601, mas o origemz.vip.sync tambem aceita admin
        // digitando no console - e ali cabe qualquer coisa que o
        // TryParse engula ("2026-09-04"). A tela de status recebe
        // sempre a mesma forma.
        //
        // 'T' e 'Z' entre aspas simples porque nenhum dos dois e
        // especificador de formato: sem as aspas o comportamento
        // depende de o runtime tratar o caractere como literal, e
        // nao ha por que apostar nisso.
        private static string FormatExpiresAt(DateTime expiresAtUtc)
        {
            return expiresAtUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        }

        // ========================================================
        //  AUXILIARES
        // ========================================================
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

        private static bool IsKnownMode(string mode)
        {
            return mode == ModeInventory || mode == ModeDrop || mode == ModeAuto;
        }

        // 17 digitos ASCII. char.IsDigit aceitaria digito de outro
        // alfabeto, que passaria aqui e seria recusado pelo regex
        // do agente.
        private static bool IsSteamId64(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != SteamId64Length)
            {
                return false;
            }

            for (int i = 0; i < value.Length; i++)
            {
                if (value[i] < '0' || value[i] > '9')
                {
                    return false;
                }
            }

            return true;
        }

        // NaN e Infinity viram a string "NaN" no Newtonsoft, e o
        // zod do agente recusa a resposta inteira por causa de um
        // campo so.
        private static float SafeFloat(float value)
        {
            return float.IsNaN(value) || float.IsInfinity(value) ? 0f : value;
        }

        private static string ClassifyDelivery(int given, int dropped)
        {
            if (dropped <= 0)
            {
                return DeliveredInventory;
            }

            if (given <= 0)
            {
                return DeliveredDrop;
            }

            return DeliveredMixed;
        }

        // ========================================================
        //  RESPOSTAS
        //
        //  JsonConvert.SerializeObject sem Formatting.Indented: o
        //  agente separa as respostas por linha, e um JSON
        //  quebrado em varias linhas viraria varios fragmentos
        //  invalidos.
        // ========================================================
        private static string BuildError(string code)
        {
            return JsonConvert.SerializeObject(new ErrorResponse { Error = code });
        }

        // A resposta do GetVipInfo NAO tem "ok": ela atravessa a
        // fronteira de plugin, e nao o RCON, e o contrato de hook
        // (Docs\OrigemZAgent\HOOKS.md) descreve exatamente
        // {"steamId":...,"tiers":[...]}. Acrescentar campo aqui
        // quebraria quem le pelo formato.
        private static string BuildVipInfo(string steamId, List<VipTierInfo> tiers)
        {
            return JsonConvert.SerializeObject(new VipInfoResponse
            {
                SteamId = steamId,
                Tiers = tiers
            });
        }

        private string BuildGiveOk(int requestedAmount, string delivered, int given, int dropped)
        {
            // given + dropped == amount pedido, SEMPRE. Se nao
            // fecha, o bug e daqui - e devolver numero errado para
            // a loja e pior do que devolver erro, porque ninguem
            // desconfia de uma resposta ok.
            if (given + dropped != requestedAmount)
            {
                PrintError("Invariante quebrada no give: pedido " + requestedAmount +
                           ", given " + given + ", dropped " + dropped + ".");
                return BuildError(ErrorInternal);
            }

            return JsonConvert.SerializeObject(new GiveOkResponse
            {
                Delivered = delivered,
                Given = given,
                Dropped = dropped
            });
        }

        // --------------------------------------------------------
        //  Resultado da entrega de UM pedaco.
        //
        //  Nao e DTO: nunca vira JSON. Existe so para os tres modos
        //  devolverem numeros em vez de resposta pronta, ja que
        //  agora sao chamados varias vezes por comando.
        //
        //  CLASSE, e nao struct, de proposito. Struct e copiada em
        //  cada atribuicao e em cada passagem de parametro; um
        //  "outcome.Given += x" acabaria somando numa copia e o
        //  total sairia errado sem nenhum aviso do compilador. Em
        //  C# 6 nao existe readonly struct para fechar essa porta,
        //  entao a porta certa e nao ser struct.
        //
        //  Error != null significa que este pedaco falhou; nesse
        //  caso Given/Dropped nao valem nada e o laco para.
        // --------------------------------------------------------
        private class GiveOutcome
        {
            public string Error { get; set; }

            public int Given { get; set; }

            public int Dropped { get; set; }

            public static GiveOutcome Failure(string code)
            {
                return new GiveOutcome { Error = code };
            }

            public static GiveOutcome Delivered(int given, int dropped)
            {
                return new GiveOutcome { Given = given, Dropped = dropped };
            }
        }

        // --------------------------------------------------------
        //  Uma concessao de VIP dentro do cache.
        //
        //  Nao e DTO: nunca vira JSON. O que sai no GetVipInfo e o
        //  VipTierInfo, montado a partir daqui - e essa separacao e
        //  proposital, porque o cache guarda coisa que a resposta
        //  nao mostra (o Rank).
        //
        //  Rank ja vem resolvido da TierRanks no momento em que o
        //  cache e montado, e nao a cada leitura: montar acontece
        //  uma vez por sincronizacao, ler acontece no caminho de
        //  conexao do jogador.
        //
        //  IsLifetime em vez de DateTime? de proposito: vitalicio e
        //  um estado do negocio, e um nullable obrigaria todo ponto
        //  de leitura a lembrar que null quer dizer "para sempre" -
        //  o oposto do que null costuma significar. Quem esquecesse
        //  teria um VIP vitalicio tratado como expirado.
        // --------------------------------------------------------
        private class VipGrant
        {
            public string Tier { get; set; }

            public int Rank { get; set; }

            public bool IsLifetime { get; set; }

            // So tem significado quando IsLifetime e false. Sempre
            // em UTC - ver BuildVipGrant.
            public DateTime ExpiresAtUtc { get; set; }

            public bool IsActive(DateTime nowUtc)
            {
                return IsLifetime || ExpiresAtUtc > nowUtc;
            }
        }

        // --------------------------------------------------------
        //  DTOs do contrato.
        //
        //  Cada campo tem [JsonProperty] com o nome exato: sem
        //  isso o Newtonsoft usaria o nome do membro em PascalCase
        //  e o zod do outro lado recusaria tudo.
        //
        //  "ok" e propriedade so de leitura com valor fixo: assim
        //  nao existe caminho de codigo capaz de mandar um erro
        //  com ok:true, ou vice-versa.
        // --------------------------------------------------------
        private class ErrorResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return false; } }

            [JsonProperty("error")]
            public string Error { get; set; }
        }

        private class PlayersOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            // Total de jogadores elegiveis, nao o tamanho da
            // pagina. Players.Count e o tamanho da pagina e sai do
            // proprio array.
            [JsonProperty("count")]
            public int Count { get; set; }

            [JsonProperty("offset")]
            public int Offset { get; set; }

            [JsonProperty("limit")]
            public int Limit { get; set; }

            [JsonProperty("players")]
            public List<PlayerInfo> Players { get; set; }
        }

        private class VipSyncOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            // Quantos jogadores ficaram no cache depois da troca -
            // e nao quantos vieram no JSON. A diferenca entre os
            // dois numeros e o que foi descartado, e o motivo esta
            // no PrintWarning do ApplyVipCache.
            [JsonProperty("players")]
            public int Players { get; set; }
        }

        private class ItemsOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            // Total do catalogo, nao da pagina. Items.Count e o
            // tamanho da pagina e sai do proprio array.
            [JsonProperty("count")]
            public int Count { get; set; }

            [JsonProperty("offset")]
            public int Offset { get; set; }

            [JsonProperty("limit")]
            public int Limit { get; set; }

            [JsonProperty("items")]
            public List<ItemInfo> Items { get; set; }
        }

        private class GiveOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("delivered")]
            public string Delivered { get; set; }

            [JsonProperty("given")]
            public int Given { get; set; }

            [JsonProperty("dropped")]
            public int Dropped { get; set; }
        }

        private class PlayerInfo
        {
            // String, nunca numero: SteamID64 tem 17 digitos e
            // passa de 2^53, ou seja, nao sobrevive a um number de
            // JavaScript sem perder precisao.
            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            [JsonProperty("health")]
            public float Health { get; set; }

            [JsonProperty("isAlive")]
            public bool IsAlive { get; set; }

            [JsonProperty("isSleeping")]
            public bool IsSleeping { get; set; }

            [JsonProperty("ping")]
            public int Ping { get; set; }

            [JsonProperty("connectedSeconds")]
            public int ConnectedSeconds { get; set; }

            [JsonProperty("position")]
            public PositionInfo Position { get; set; }
        }

        private class ItemInfo
        {
            // A chave do origemz.give. E por este campo que o
            // painel casa o que o admin escolheu com o que o
            // plugin sabe entregar.
            [JsonProperty("shortname")]
            public string Shortname { get; set; }

            [JsonProperty("displayName")]
            public string DisplayName { get; set; }

            // ####  O NOME QUE O JOGADOR LE NA TELA DO JOGO  ####
            //
            // O DisplayName acima e a IDENTIDADE do item: e por ele
            // que o admin procura no painel, e ele casa com o
            // shortname. Este aqui e o rotulo, e so a tela do jogo
            // usa - ver ReadDisplayNamePtBr.
            //
            // NullValueHandling.Ignore: item sem traducao nao gasta
            // bytes no JSON. Sao ~1.250 itens numa resposta que ja
            // passa de 150 KB e viaja num frame de WebRCON, e o
            // agente trata ausente e nulo do mesmo jeito.
            [JsonProperty("displayNamePtBr", NullValueHandling = NullValueHandling.Ignore)]
            public string DisplayNamePtBr { get; set; }

            // int, e nao string: itemid do Rust cabe folgado num
            // number de JavaScript - o problema de precisao do
            // steamId nao existe aqui.
            [JsonProperty("itemId")]
            public int ItemId { get; set; }

            [JsonProperty("category")]
            public string Category { get; set; }

            [JsonProperty("maxStack")]
            public int MaxStack { get; set; }

            [JsonProperty("hasCondition")]
            public bool HasCondition { get; set; }

            // ####  E ELE DIZ SE "USAR" EXISTE NESTE ITEM  ####
            //
            // O hook OnItemUse do Oxide so dispara em quem tem
            // ItemModConsumable, e o menu de contexto do item e
            // montado pelo CLIENTE a partir da ItemDefinition - nao
            // ha como criar opcao nova nele.
            //
            // Quem le e o cadastro de item custom do painel: ele
            // oferece "converter so quando o jogador usar", e essa
            // escolha em cima de um item nao-consumivel produz um
            // item INERTE, em silencio - o jogador pega, nada
            // acontece, e nada no log explica. Recusar no cadastro
            // depende deste campo.
            [JsonProperty("consumable")]
            public bool Consumable { get; set; }

            // ####  E ELE E QUEM DECIDE A CHANCE NO LOOT  ####
            //
            // A raridade da ItemDefinition, como INDICE: 0 e o mais
            // comum e 4 o mais raro. O editor de loot do painel
            // precisa dela porque o BetterLoot nao guarda
            // probabilidade nenhuma nas entradas dele - ele separa
            // os itens da caixa em cinco baldes por
            // (int)definition.rarity e pesa cada balde com
            // 2^(4-i)*1000. Sem este numero a tela nao consegue
            // mostrar porcentagem alguma, e o certo ali e o
            // travessao, nunca um zero.
            //
            // Vai como int, e nao como o nome do enum, porque o que
            // pesa e o INDICE. Mandar "Common" obrigaria os dois
            // lados a manter a mesma tabela de nomes, e ela
            // envelheceria calada no dia em que o jogo criasse uma
            // raridade nova.
            [JsonProperty("rarity")]
            public int Rarity { get; set; }
        }

        private class PositionInfo
        {
            [JsonProperty("x")]
            public float X { get; set; }

            [JsonProperty("y")]
            public float Y { get; set; }

            [JsonProperty("z")]
            public float Z { get; set; }
        }

        // --------------------------------------------------------
        //  DTOs do VIP.
        //
        //  Os dois de ENTRADA (VipSyncPayload / VipTierPayload)
        //  descrevem o que o RustAgent manda; os dois de SAIDA
        //  (VipInfoResponse / VipTierInfo), o que o GetVipInfo
        //  devolve. Sao pares parecidos e de proposito separados: o
        //  que entra pode vir malformado e passa por validacao (ver
        //  BuildVipGrant), o que sai e sempre canonico.
        // --------------------------------------------------------
        // ========================================================
        //  origemz.loadout.sync <base64>
        //
        //  Os KITS que o agente empurra. Mesmo desenho do
        //  origemz.vip.sync, e pelos mesmos dois motivos:
        //
        //   - o payload e o estado COMPLETO, nunca um delta.
        //     Nivel que sumiu fica sem kit, e e assim que
        //     "apaguei o kit" chega ao jogo;
        //
        //   - base64 porque o parser de console do Rust COME AS
        //     ASPAS de um JSON cru, e o shortname chegaria sem
        //     elas. Ver DecodeBase64Payload.
        //
        //  Quem consome nao e este plugin: e o OrigemZPlayer, pelo
        //  hook GetLoadout. O agente e so o hub - guarda o cache e
        //  responde a quem perguntar.
        //
        //      {"ok":true,"tiers":5,"items":23}
        //      {"ok":false,"error":"INVALID_ARGS"}
        // ========================================================
        // O log adiado um frame pelo mesmo motivo medido no
        // CommandVipSync: o Puts sai antes da resposta e seria
        // casado como se FOSSE a resposta.
        [ConsoleCommand(LoadoutSyncCommand)]
        private void CommandLoadoutSync(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleLoadoutSync(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError(LoadoutSyncCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleLoadoutSync(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            if (arg.Args == null || arg.Args.Length == 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            string raw = JoinConsoleArgs(arg);
            string payload = DecodeBase64Payload(raw);

            if (payload == null)
            {
                payload = raw;
            }

            int tiers;
            int items;
            string error = ApplyLoadoutCache(payload, out tiers, out items);

            if (error != null)
            {
                return BuildError(error);
            }

            logLine = LoadoutSyncCommand + ": " + tiers + " nivel(is) e " + items +
                      " item(ns) no cache de kits.";

            return JsonConvert.SerializeObject(new LoadoutSyncOkResponse
            {
                Tiers = tiers,
                Items = items
            });
        }

        // Le o JSON e TROCA o cache. Devolve null quando aplicou, ou
        // o codigo de erro quando nao aplicou - e nesse caso o cache
        // anterior fica intacto.
        //
        // Mesma regra do ApplyVipCache: monta um dicionario novo e so
        // atribui ao campo na ultima linha. Um payload que falha no
        // meio nao pode deixar metade dos niveis no estado novo e
        // metade no velho.
        private string ApplyLoadoutCache(string json, out int tierCount, out int itemCount)
        {
            tierCount = 0;
            itemCount = 0;

            if (string.IsNullOrEmpty(json))
            {
                return ErrorInvalidArgs;
            }

            LoadoutSyncPayload payload;

            try
            {
                payload = JsonConvert.DeserializeObject<LoadoutSyncPayload>(json);
            }
            catch (Exception ex)
            {
                PrintWarning("Cache de kits recusado: JSON ilegivel. " + ex.Message);
                return ErrorInvalidArgs;
            }

            if (payload == null || payload.Tiers == null)
            {
                return ErrorInvalidArgs;
            }

            Dictionary<string, string> rebuilt =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            int discarded = 0;
            int total = 0;

            foreach (KeyValuePair<string, List<LoadoutItemPayload>> entry in payload.Tiers)
            {
                string tier = NormalizeLoadoutTier(entry.Key);

                if (tier == null || entry.Value == null)
                {
                    discarded++;
                    continue;
                }

                List<LoadoutItemPayload> valid = new List<LoadoutItemPayload>();

                for (int i = 0; i < entry.Value.Count; i++)
                {
                    LoadoutItemPayload item = entry.Value[i];

                    // Item sem shortname nao vira item nenhum no
                    // jogo, e guarda-lo faria o OrigemZPlayer contar
                    // como "entregue" algo que nunca existiu.
                    if (item == null || string.IsNullOrEmpty(item.Shortname))
                    {
                        discarded++;
                        continue;
                    }

                    valid.Add(item);
                }

                // O cache guarda o JVIP JA SERIALIZADO, e nao os
                // objetos. O motivo e a fronteira de assembly: o
                // OrigemZPlayer nao consegue receber um tipo
                // declarado aqui, entao o que atravessa o hook e
                // string. Serializar uma vez por sincronizacao e
                // melhor do que uma vez por respawn de jogador.
                rebuilt[tier] = JsonConvert.SerializeObject(valid);
                total += valid.Count;
            }

            _loadoutCache = rebuilt;
            tierCount = rebuilt.Count;
            itemCount = total;

            if (discarded > 0)
            {
                PrintWarning("Cache de kits: " + discarded + " entrada(s) descartada(s) por " +
                             "nivel vazio ou item sem shortname.");
            }

            return null;
        }

        // ========================================================
        //  origemz.status.sync <base64>
        //
        //  VIDA, FOME E SEDE AO NASCER, por nivel. Terceiro membro
        //  da familia empurrada, com o mesmo desenho dos outros
        //  dois: base64, estado COMPLETO, cache trocado inteiro.
        //
        //  Nivel que sumiu do payload volta ao padrao do jogo, e e
        //  assim que "desconfigurei este nivel" chega ate aqui.
        //
        //  Quem consome nao e este plugin: e o OrigemZPlayer, pelo
        //  hook GetSpawnStatus.
        //
        //      {"ok":true,"tiers":3}
        //      {"ok":false,"error":"INVALID_ARGS"}
        // ========================================================
        // O log adiado um frame pelo mesmo motivo medido no
        // CommandVipSync: o Puts sai antes da resposta e seria
        // casado como se FOSSE a resposta.
        [ConsoleCommand(SpawnStatusSyncCommand)]
        private void CommandSpawnStatusSync(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleSpawnStatusSync(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError(SpawnStatusSyncCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleSpawnStatusSync(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            if (arg.Args == null || arg.Args.Length == 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            string raw = JoinConsoleArgs(arg);
            string payload = DecodeBase64Payload(raw);

            if (payload == null)
            {
                payload = raw;
            }

            int tiers;
            string error = ApplySpawnStatusCache(payload, out tiers);

            if (error != null)
            {
                return BuildError(error);
            }

            logLine = SpawnStatusSyncCommand + ": " + tiers +
                      " nivel(is) no cache de status de nascimento.";

            return JsonConvert.SerializeObject(new SpawnStatusSyncOkResponse
            {
                Tiers = tiers
            });
        }

        // Le o JSON e TROCA o cache. Devolve null quando aplicou, ou
        // o codigo de erro quando nao aplicou - e nesse caso o cache
        // anterior fica intacto.
        //
        // Mesma regra do ApplyLoadoutCache: monta um dicionario novo
        // e so atribui ao campo na ultima linha.
        //
        // #### PAYLOAD VAZIO E LEGITIMO ####
        //
        // `{"tiers":{}}` quer dizer "nenhum nivel configurado", que e
        // o estado de um servidor recem-instalado. Recusar isso
        // deixaria o cache velho valendo depois de o admin apagar a
        // ultima configuracao - ou seja, desconfigurar nao
        // funcionaria.
        private string ApplySpawnStatusCache(string json, out int tierCount)
        {
            tierCount = 0;

            if (string.IsNullOrEmpty(json))
            {
                return ErrorInvalidArgs;
            }

            SpawnStatusSyncPayload payload;

            try
            {
                payload = JsonConvert.DeserializeObject<SpawnStatusSyncPayload>(json);
            }
            catch (Exception ex)
            {
                PrintWarning("Cache de status recusado: JSON ilegivel. " + ex.Message);
                return ErrorInvalidArgs;
            }

            if (payload == null || payload.Tiers == null)
            {
                return ErrorInvalidArgs;
            }

            Dictionary<string, string> rebuilt =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            int discarded = 0;

            foreach (KeyValuePair<string, SpawnStatusPayload> entry in payload.Tiers)
            {
                string tier = NormalizeLoadoutTier(entry.Key);

                if (tier == null || entry.Value == null)
                {
                    discarded++;
                    continue;
                }

                // Os tres nulos nao viram entrada: e o mesmo que o
                // nivel nao estar no payload, e guardar isso faria o
                // OrigemZPlayer trabalhar para nao mudar nada.
                if (!entry.Value.Health.HasValue &&
                    !entry.Value.Calories.HasValue &&
                    !entry.Value.Hydration.HasValue)
                {
                    discarded++;
                    continue;
                }

                rebuilt[tier] = JsonConvert.SerializeObject(entry.Value);
            }

            _spawnStatusCache = rebuilt;
            tierCount = rebuilt.Count;

            if (discarded > 0)
            {
                PrintWarning("Cache de status: " + discarded + " entrada(s) descartada(s) por " +
                             "nivel invalido ou sem nenhum atributo definido.");
            }

            return null;
        }

        // O status de nascimento de um nivel, em JSON.
        //
        // Devolve null para nivel sem configuracao E para nivel
        // desconhecido: os dois significam "use o padrao do jogo".
        //
        // Aqui null e a resposta CERTA, ao contrario do GetLoadout
        // (que devolve "[]"): la, null seria confundido com "o agente
        // nao respondeu"; aqui, "nao ha nada a aplicar" e justamente
        // o caso comum, e o consumidor so precisa nao mexer no
        // jogador.
        [HookMethod(nameof(GetSpawnStatus))]
        private string GetSpawnStatus(string tier)
        {
            try
            {
                string normalized = NormalizeLoadoutTier(tier);

                if (normalized == null)
                {
                    return null;
                }

                string json;

                if (!_spawnStatusCache.TryGetValue(normalized, out json))
                {
                    return null;
                }

                return json;
            }
            catch (Exception ex)
            {
                PrintError("GetSpawnStatus falhou para '" + tier + "': " + ex);
                return null;
            }
        }

        // ========================================================
        //  origemz.timers.sync <base64>
        //
        //  A VELOCIDADE de fornalha, craft, pesquisa e reciclador,
        //  por nivel. Quarto membro da familia empurrada, e com o
        //  mesmo desenho: base64, estado COMPLETO, cache trocado
        //  inteiro. Nivel que sumiu do payload volta ao x1.
        //
        //      {"tiers":{"gold":{"smelt":3,"craft":2}}}
        //
        //  Campo ausente e x1 NAQUELE nivel - e quem decide o que
        //  isso vira no jogador e o OrigemZPlayer, que cai para o
        //  nivel de baixo antes de cair para o x1. Este plugin so
        //  guarda e repassa.
        //
        //      {"ok":true,"tiers":3}
        //      {"ok":false,"error":"INVALID_ARGS"}
        // ========================================================
        // O log adiado um frame pelo mesmo motivo medido no
        // CommandVipSync: o Puts sai antes da resposta e seria
        // casado como se FOSSE a resposta.
        [ConsoleCommand(TimersSyncCommand)]
        private void CommandTimersSync(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleTimersSync(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError(TimersSyncCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleTimersSync(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            if (arg.Args == null || arg.Args.Length == 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            string raw = JoinConsoleArgs(arg);
            string payload = DecodeBase64Payload(raw);

            if (payload == null)
            {
                payload = raw;
            }

            int tiers;
            string error = ApplyTimersCache(payload, out tiers);

            if (error != null)
            {
                return BuildError(error);
            }

            logLine = TimersSyncCommand + ": " + tiers + " nivel(is) no cache de timers.";

            return JsonConvert.SerializeObject(new TimersSyncOkResponse
            {
                Tiers = tiers
            });
        }

        // Le o JSON e TROCA o cache - mesma regra do
        // ApplySpawnStatusCache: dicionario novo, atribuido ao campo
        // so na ultima linha. Payload vazio e legitimo, e e assim que
        // "apaguei o ultimo timer" chega aqui.
        private string ApplyTimersCache(string json, out int tierCount)
        {
            tierCount = 0;

            if (string.IsNullOrEmpty(json))
            {
                return ErrorInvalidArgs;
            }

            TimersSyncPayload payload;

            try
            {
                payload = JsonConvert.DeserializeObject<TimersSyncPayload>(json);
            }
            catch (Exception ex)
            {
                PrintWarning("Cache de timers recusado: JSON ilegivel. " + ex.Message);
                return ErrorInvalidArgs;
            }

            if (payload == null || payload.Tiers == null)
            {
                return ErrorInvalidArgs;
            }

            Dictionary<string, string> rebuilt =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            int discarded = 0;

            foreach (KeyValuePair<string, TimersPayload> entry in payload.Tiers)
            {
                string tier = NormalizeLoadoutTier(entry.Key);

                if (tier == null || entry.Value == null)
                {
                    discarded++;
                    continue;
                }

                // Os quatro ausentes nao viram entrada: e o mesmo que o
                // nivel nao estar no payload.
                if (!entry.Value.Smelt.HasValue &&
                    !entry.Value.Craft.HasValue &&
                    !entry.Value.Research.HasValue &&
                    !entry.Value.Recycle.HasValue)
                {
                    discarded++;
                    continue;
                }

                rebuilt[tier] = JsonConvert.SerializeObject(entry.Value);
            }

            _timersCache = rebuilt;
            tierCount = rebuilt.Count;

            if (discarded > 0)
            {
                PrintWarning("Cache de timers: " + discarded + " entrada(s) descartada(s) por " +
                             "nivel invalido ou sem nenhum timer definido.");
            }

            return null;
        }

        // Os timers de um nivel, em JSON, ou null quando o nivel nao
        // tem configuracao. null e a resposta comum, como no
        // GetSpawnStatus: nivel sem timers e o estado de todo
        // servidor recem-instalado.
        [HookMethod(nameof(GetTimers))]
        private string GetTimers(string tier)
        {
            try
            {
                string normalized = NormalizeLoadoutTier(tier);

                if (normalized == null)
                {
                    return null;
                }

                string json;

                if (!_timersCache.TryGetValue(normalized, out json))
                {
                    return null;
                }

                return json;
            }
            catch (Exception ex)
            {
                PrintError("GetTimers falhou para '" + tier + "': " + ex);
                return null;
            }
        }

        // Pede ao RustAgent que reenvie um estado.
        //
        // Nao ha resposta a esperar: o agente reage empurrando o
        // comando de sincronizacao correspondente, que chega aqui
        // pelo caminho normal. Se ninguem estiver ouvindo, isto e
        // uma linha de log inofensiva.
        private void RequestSync(string what)
        {
            try
            {
                Puts(RequestMarker + "{\"want\":\"" + what + "\"}");
            }
            catch (Exception ex)
            {
                PrintError("Nao deu para pedir a sincronizacao de '" + what + "': " + ex);
            }
        }

        // Identificador de nivel e SEMPRE ingles minusculo, em toda
        // a cadeia - site, banco, agente e plugin.
        private static string NormalizeLoadoutTier(string tier)
        {
            if (string.IsNullOrEmpty(tier))
            {
                return null;
            }

            string normalized = tier.Trim().ToLowerInvariant();
            return normalized.Length == 0 ? null : normalized;
        }

        private class VipSyncPayload
        {
            // Chave e SteamID64 em string, pelo mesmo motivo do
            // PlayerInfo.SteamId: 17 digitos nao cabem num number
            // de JavaScript sem perder precisao.
            [JsonProperty("players")]
            public Dictionary<string, List<VipTierPayload>> Players { get; set; }
        }

        private class VipTierPayload
        {
            [JsonProperty("tier")]
            public string Tier { get; set; }

            // string, e nao DateTime: o parse e feito a mao no
            // BuildVipGrant, com fuso explicito. Deixar o Newtonsoft
            // converter usaria o fuso do servidor por padrao, que e
            // exatamente o erro que o BuildVipGrant evita.
            [JsonProperty("expiresAt")]
            public string ExpiresAt { get; set; }
        }

        private class VipInfoResponse
        {
            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("tiers")]
            public List<VipTierInfo> Tiers { get; set; }
        }

        private class VipTierInfo
        {
            [JsonProperty("tier")]
            public string Tier { get; set; }

            // null e vitalicio, e precisa SAIR no JSON como null. O
            // padrao do Newtonsoft ja inclui nulo; omitir o campo
            // faria "vitalicio" e "campo ausente" virarem a mesma
            // coisa para quem le.
            [JsonProperty("expiresAt")]
            public string ExpiresAt { get; set; }
        }

        private class LoadoutSyncPayload
        {
            [JsonProperty("tiers")]
            public Dictionary<string, List<LoadoutItemPayload>> Tiers { get; set; }
        }

        // Repassado ADIANTE como veio, e nao remontado: este plugin
        // e o hub, nao o consumidor. Quem entende de slot e posicao
        // e o OrigemZPlayer, e reescrever o formato aqui criaria um
        // segundo lugar para o contrato divergir.
        private class LoadoutItemPayload
        {
            [JsonProperty("slot")]
            public string Slot { get; set; }

            [JsonProperty("shortname")]
            public string Shortname { get; set; }

            [JsonProperty("amount")]
            public int Amount { get; set; }

            // string, e nao ulong: skin do workshop passa de 2^53 e
            // o JSON do agente ja manda como string por isso.
            [JsonProperty("skinId")]
            public string SkinId { get; set; }

            [JsonProperty("position")]
            public int Position { get; set; }
        }

        private class LoadoutSyncOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("tiers")]
            public int Tiers { get; set; }

            [JsonProperty("items")]
            public int Items { get; set; }
        }

        private class SpawnStatusSyncPayload
        {
            [JsonProperty("tiers")]
            public Dictionary<string, SpawnStatusPayload> Tiers { get; set; }
        }

        // Repassado ADIANTE como veio, e nao remontado - mesma regra
        // do LoadoutItemPayload: este plugin e o hub, e quem entende
        // de metabolismo e o OrigemZPlayer.
        //
        // float? e nao float: null quer dizer "o jogo decide este
        // atributo", e e diferente de zero (que para fome e sede e
        // nascer morrendo). Um float sem nullable transformaria os
        // dois casos em 0 na desserializacao.
        private class SpawnStatusPayload
        {
            [JsonProperty("health")]
            public float? Health { get; set; }

            [JsonProperty("calories")]
            public float? Calories { get; set; }

            [JsonProperty("hydration")]
            public float? Hydration { get; set; }
        }

        private class SpawnStatusSyncOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("tiers")]
            public int Tiers { get; set; }
        }

        private class TimersSyncPayload
        {
            [JsonProperty("tiers")]
            public Dictionary<string, TimersPayload> Tiers { get; set; }
        }

        // Repassado ADIANTE como veio - mesma regra do
        // SpawnStatusPayload: este plugin e o hub, e quem entende de
        // fornalha e bancada e o OrigemZPlayer.
        //
        // float? e nao float: ausente quer dizer "este nivel nao
        // decide este timer", e o OrigemZPlayer cai para o nivel de
        // baixo. Um float sem nullable viraria 0 na desserializacao,
        // e 0 aqui nao e x1 - e parar o tempo.
        private class TimersPayload
        {
            [JsonProperty("smelt", NullValueHandling = NullValueHandling.Ignore)]
            public float? Smelt { get; set; }

            [JsonProperty("craft", NullValueHandling = NullValueHandling.Ignore)]
            public float? Craft { get; set; }

            [JsonProperty("research", NullValueHandling = NullValueHandling.Ignore)]
            public float? Research { get; set; }

            [JsonProperty("recycle", NullValueHandling = NullValueHandling.Ignore)]
            public float? Recycle { get; set; }
        }

        private class TimersSyncOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("tiers")]
            public int Tiers { get; set; }
        }

        // ========================================================
        //  BLUEPRINTS QUE SOBREVIVEM AO WIPE
        //
        //      origemz.bp.export [offset] [limit]
        //      origemz.bp.restore <base64>
        //
        //  #### POR QUE ISTO NAO E "PRESERVAR O ARQUIVO" ####
        //
        //  player.blueprints.<n>.db e UM arquivo so, de todos os
        //  jogadores. Nao ha como apagar "os BPs de quem nao e VIP"
        //  recortando arquivo. Pior: quando a Facepunch muda o
        //  formato, o numero do nome muda e o arquivo antigo e
        //  ignorado inteiro - a preservacao por arquivo evapora
        //  justamente no wipe mais importante do ano.
        //
        //  A saida e um snapshot LOGICO: o agente le o que cada
        //  jogador sabe ANTES do wipe, guarda no banco dele, e
        //  devolve depois a quem tem direito.
        //
        //  #### O PLUGIN NAO DECIDE NADA ####
        //
        //  Quem sabe o nivel de VIP, a regua por bancada e o atraso
        //  em horas e o AGENTE. Aqui so entram duas operacoes
        //  burras: "diga o que este jogador sabe" e "ensine esta
        //  lista pronta a este jogador". Decidir dos dois lados
        //  daria duas reguas, e a que ninguem olha e a que fica
        //  errada.
        //
        //  #### AS DUAS APIS DO JOGO, CONFERIDAS ####
        //
        //  Conferidas com o Mono.Cecil contra o Assembly-CSharp.dll
        //  desta instalacao, e nao de memoria - o custo de errar um
        //  nome aqui e o plugin INTEIRO nao compilar, e com ele
        //  somem tambem os jogadores, os itens e o VIP:
        //
        //      ServerMgr.persistance                UserPersistance
        //      UserPersistance.GetAllPlayerIDs()    List<ulong>
        //      UserPersistance.GetPlayerInfo(ulong) PersistantPlayer
        //      PersistantPlayer.unlockedItems       List<int>
        //      PlayerBlueprints.UnlockList(List<ItemDefinition>)
        //      ItemDefinition.Blueprint.GetWorkbenchLevel()
        //
        //  #### O PLANO DIZIA blueprints.Learn(...), E ELE NAO
        //       EXISTE ####
        //
        //  Docs\16 e o PLANO.md do projeto anterior descrevem a
        //  devolucao como `player.blueprints.Learn(itemDefinition)`.
        //  Esse metodo NAO existe no PlayerBlueprints desta versao:
        //  os publicos sao Unlock, UnlockList, IsUnlocked,
        //  HasUnlocked, UnlockAll e Reset. Aqui usamos UnlockList,
        //  que faz o lote inteiro com UM SendNetworkUpdateImmediate
        //  e UM ClientRPC - devolver trezentos blueprints com
        //  trezentas atualizacoes de rede e um engasgo no login.
        // ========================================================

        /// <summary>
        /// `origemz.bp.export [offset] [limit]`
        ///
        /// O que cada jogador APRENDEU, direto do persistance -
        /// funciona com o jogador OFFLINE, que e o caso normal na
        /// hora do wipe (o passo `esvaziar` ja tirou todo mundo).
        /// </summary>
        private const string BpExportCommand = "origemz.bp.export";

        /// <summary>
        /// `origemz.bp.restore &lt;base64&gt;`
        ///
        /// A lista PRONTA, decidida pelo agente. Quem esta com o
        /// BasePlayer carregado recebe na hora; quem nao esta fica
        /// na fila e recebe no OnPlayerConnected.
        /// </summary>
        private const string BpRestoreCommand = "origemz.bp.restore";

        // O persistance nao existe (servidor ainda subindo, ou
        // ServerMgr nao inicializado). E DIFERENTE de "nenhum
        // jogador": o agente precisa saber que nao deu para
        // perguntar, senao ele grava um snapshot vazio e o wipe
        // devolve nada a todo mundo.
        private const string ErrorPersistenceUnavailable = "PERSISTENCE_UNAVAILABLE";

        // A pagina montada passou do teto de frame. RECUSADA
        // INTEIRA, nunca cortada: resposta truncada chega ao agente
        // como JSON invalido, e um BP pela metade PARECE ter
        // funcionado - o pior desfecho possivel. O agente reduz o
        // limit e pede de novo.
        private const string ErrorPayloadTooLarge = "PAYLOAD_TOO_LARGE";

        // Paginacao do export.
        //
        // Um jogador que pesquisou tudo passa de 400 blueprints, e
        // cada itemid ocupa ~11 bytes no JSON - ou seja, ~5 KB por
        // jogador no pior caso, contra os ~140 bytes de um jogador
        // no origemz.players. Por isso o padrao aqui e 25 e nao
        // 250: e a mesma medida de 70 KB por frame (ver
        // DefaultItemsLimit) dividida pelo tamanho de linha DESTA
        // resposta.
        private const int DefaultBpLimit = 25;
        private const int MaxBpLimit = 100;

        // O teto medido do frame do WebRCON neste projeto e ~70 KB
        // (ver o comentario do DefaultItemsLimit). 60 KB deixa
        // margem para o servidor sob carga.
        private const int MaxBpExportBytes = 60000;

        // Quantos steamIds cabem no campo "pending" da resposta.
        //
        // #### ELE E CONTRATO, E NAO SO DIAGNOSTICO ####
        //
        // O agente marca como ENTREGUE quem ficou de FORA desse
        // campo. Se a lista fosse cortada, os nomes que sobrassem
        // apareceriam como entregues sem terem recebido nada - e
        // ninguem descobriria. Por isso o LOTE do outro lado e
        // limitado ao mesmo numero (BP_RESTORE_MAX_PLAYERS, em
        // core\src\wipe\blueprints.ts): com ele, esta lista nunca
        // precisa ser cortada. Os dois numeros mudam juntos.
        private const int MaxBpPendingReported = 50;

        // ========================================================
        //  A FILA DE DEVOLUCAO, DENTRO DO PLUGIN
        //
        //  #### ELA E VOLATIL, E ISSO E DE PROPOSITO ####
        //
        //  A fonte da verdade e o SQLite do agente (bp_restores).
        //  Este dicionario e so o trecho final do caminho: o que
        //  chegou aqui e ainda nao encontrou o jogador carregado.
        //  Um oxide.reload o esvazia, e o agente reenvia - o mesmo
        //  desenho dos caches de VIP e de kits.
        //
        //  Guardamos os IDS, e nao as ItemDefinition: a lista e
        //  pequena, o dicionario fica leve, e resolver de novo no
        //  login custa uma busca por item.
        // ========================================================
        private Dictionary<string, List<int>> _bpPending =
            new Dictionary<string, List<int>>(StringComparer.Ordinal);

        // ========================================================
        //  origemz.bp.export [offset] [limit]
        //
        //  Resposta de sucesso (uma linha so, quebrada aqui para
        //  caber no comentario):
        //
        //  {"ok":true,"count":312,"offset":0,"limit":25,
        //   "players":[{"steamId":"7656...","items":[1234,5678]}],
        //   "benches":{"1234":2}}
        //
        //  "count" e o TOTAL de jogadores conhecidos pelo
        //  persistance, e nao o tamanho da pagina - e por ele que o
        //  agente sabe quantas paginas pedir. "offset" e "limit"
        //  voltam JA NORMALIZADOS.
        //
        //  #### A PAGINA PODE VIR COM MENOS JOGADORES DO QUE O
        //       LIMIT, E ISSO NAO SIGNIFICA FIM DE LISTA ####
        //
        //  Quem nao aprendeu nada nao entra no array "players" -
        //  seria um objeto de trinta bytes para dizer "nada". Quem
        //  avanca a paginacao e o LIMIT, nunca players.Length; o
        //  fim e count. Contar so quem tem item exigiria ler o
        //  persistance da base inteira a cada pagina.
        //
        //  #### "benches" E DADO, E NAO DECISAO ####
        //
        //  E a bancada que o JOGO exige para cada item desta
        //  pagina. Sem ela o agente nao teria como aplicar a regua
        //  ("bronze volta ate a bancada 1"), porque essa informacao
        //  nao existe em lugar nenhum do lado dele - o catalogo do
        //  origemz.items nao a carrega. Item de nivel 0 fica FORA
        //  do mapa: ausente quer dizer zero, e repetir 0 para
        //  centenas de itens so engorda o frame.
        // ========================================================
        [ConsoleCommand(BpExportCommand)]
        private void CommandBpExport(ConsoleSystem.Arg arg)
        {
            // Excecao que sobe de um ConsoleCommand vindo do RCON
            // nao produz resposta nenhuma, e o agente fica
            // pendurado ate o timeout. Todo caminho de saida
            // responde alguma coisa.
            try
            {
                arg.ReplyWith(HandleBpExport(arg));
            }
            catch (Exception ex)
            {
                PrintError(BpExportCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleBpExport(ConsoleSystem.Arg arg)
        {
            int offset;
            if (!TryReadInt(arg, 0, 0, out offset) || offset < 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            int limit;
            if (!TryReadInt(arg, 1, DefaultBpLimit, out limit) || limit < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            if (limit > MaxBpLimit)
            {
                limit = MaxBpLimit;
            }

            UserPersistance persistance = ServerPersistance();

            if (persistance == null)
            {
                return BuildError(ErrorPersistenceUnavailable);
            }

            List<ulong> all = persistance.GetAllPlayerIDs();

            if (all == null)
            {
                return BuildError(ErrorPersistenceUnavailable);
            }

            // Mesma regra do origemz.players: id que nao e
            // SteamID64 nao casa com jogador nenhum. Filtrado ANTES
            // de contar, senao o agente pediria uma pagina que
            // nunca enche.
            List<ulong> known = new List<ulong>();

            for (int i = 0; i < all.Count; i++)
            {
                if (IsSteamId64(all[i].ToString(CultureInfo.InvariantCulture)))
                {
                    known.Add(all[i]);
                }
            }

            // long para nao estourar: offset int.MaxValue com limit
            // 100 dobraria para negativo em int, e a janela passaria
            // a nunca casar por acidente em vez de por regra.
            long end = (long)offset + limit;

            List<BpPlayerInfo> page = new List<BpPlayerInfo>();
            Dictionary<string, int> benches = new Dictionary<string, int>(StringComparer.Ordinal);
            HashSet<int> measured = new HashSet<int>();

            for (int i = offset; i < known.Count && i < end; i++)
            {
                ulong id = known[i];
                ProtoBuf.PersistantPlayer info = persistance.GetPlayerInfo(id);

                if (info == null || info.unlockedItems == null || info.unlockedItems.Count == 0)
                {
                    continue;
                }

                HashSet<int> seen = new HashSet<int>();
                List<int> items = new List<int>();

                for (int k = 0; k < info.unlockedItems.Count; k++)
                {
                    int itemId = info.unlockedItems[k];

                    // O persistance guarda uma lista, e nao um
                    // conjunto. Repetido aqui viraria repetido no
                    // banco do agente e no comando de volta.
                    if (!seen.Add(itemId))
                    {
                        continue;
                    }

                    items.Add(itemId);
                    MeasureBench(itemId, measured, benches);
                }

                page.Add(new BpPlayerInfo { SteamId = id.ToString(CultureInfo.InvariantCulture), Items = items });
            }

            string json = JsonConvert.SerializeObject(new BpExportOkResponse
            {
                Count = known.Count,
                Offset = offset,
                Limit = limit,
                Players = page,
                Benches = benches
            });

            // #### RECUSA INTEIRA, NUNCA CORTE ####
            //
            // Cortar a pagina aqui devolveria um snapshot pela
            // metade que o agente aceitaria como completo - e o
            // jogador descobriria a falta no wipe seguinte, sem
            // nada no log dizendo por que.
            if (Encoding.UTF8.GetByteCount(json) > MaxBpExportBytes)
            {
                PrintWarning(BpExportCommand + ": pagina de " + page.Count + " jogador(es) passou de " +
                             MaxBpExportBytes + " bytes e foi recusada inteira. O agente reduz o limit " +
                             "e pede de novo.");

                return BuildError(ErrorPayloadTooLarge);
            }

            return json;
        }

        // A bancada exigida por um item, medida UMA vez por
        // resposta. `measured` guarda quem ja foi olhado - inclusive
        // os de nivel zero, que ficam fora do mapa e sem ele seriam
        // reconsultados por jogador.
        private static void MeasureBench(
            int itemId,
            HashSet<int> measured,
            Dictionary<string, int> benches)
        {
            if (!measured.Add(itemId))
            {
                return;
            }

            ItemDefinition definition = ItemManager.FindItemDefinition(itemId);

            if (definition == null || definition.Blueprint == null)
            {
                return;
            }

            // GetWorkbenchLevel(), e nao o campo
            // workbenchLevelRequired: o metodo respeita o
            // BlueprintOverride, que e como a Facepunch muda a
            // bancada de um item sem mexer no prefab.
            int level = definition.Blueprint.GetWorkbenchLevel();

            if (level > 0)
            {
                benches[itemId.ToString(CultureInfo.InvariantCulture)] = level;
            }
        }

        // ========================================================
        //  origemz.bp.restore <base64>
        //
        //  Payload (base64 de um JSON de uma linha):
        //
        //      {"players":{"7656...":[1234,5678]}}
        //
        //  Resposta:
        //
        //      {"ok":true,"players":3,"applied":2,"queued":1,
        //       "items":140,"dropped":0,"pending":["7656..."]}
        //
        //  #### BASE64 PELO MESMO MOTIVO DO origemz.vip.sync ####
        //
        //  MEDIDO: o parser de console do Rust come as aspas do
        //  JSON cru. Ver DecodeBase64Payload.
        //
        //  #### PAYLOAD ILEGIVEL E RECUSADO INTEIRO ####
        //
        //  Base64 cortado no meio decodifica em JSON quebrado, e a
        //  resposta certa e INVALID_ARGS com nada aplicado. Aplicar
        //  "o que deu" deixaria jogadores com metade do que
        //  aprenderam e o agente marcando a devolucao como
        //  concluida.
        //
        //  #### ITEM QUE SUMIU DO JOGO E OUTRA COISA ####
        //
        //  Um itemid que este servidor nao conhece (a Facepunch
        //  removeu o item entre um wipe e outro) NAO invalida a
        //  carga: ele entra em "dropped", o agente registra, e o
        //  resto e devolvido. Recusar tudo por causa de um item
        //  extinto seria punir o jogador por uma atualizacao do
        //  jogo.
        // ========================================================
        // O log adiado um frame pelo mesmo motivo medido no
        // CommandVipSync: o Puts sai ANTES da resposta e seria
        // casado como se FOSSE a resposta.
        [ConsoleCommand(BpRestoreCommand)]
        private void CommandBpRestore(ConsoleSystem.Arg arg)
        {
            try
            {
                string logLine;
                string response = HandleBpRestore(arg, out logLine);

                arg.ReplyWith(response);

                if (logLine != null)
                {
                    string line = logLine;
                    timer.Once(0f, delegate { Puts(line); });
                }
            }
            catch (Exception ex)
            {
                PrintError(BpRestoreCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleBpRestore(ConsoleSystem.Arg arg, out string logLine)
        {
            logLine = null;

            if (arg.Args == null || arg.Args.Length == 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            string raw = JoinConsoleArgs(arg);
            string payload = DecodeBase64Payload(raw);

            if (payload == null)
            {
                payload = raw;
            }

            BpRestorePayload parsed;

            try
            {
                parsed = JsonConvert.DeserializeObject<BpRestorePayload>(payload);
            }
            catch (Exception ex)
            {
                PrintWarning("Devolucao de blueprints recusada: JSON ilegivel. " + ex.Message);
                return BuildError(ErrorInvalidArgs);
            }

            if (parsed == null || parsed.Players == null)
            {
                return BuildError(ErrorInvalidArgs);
            }

            int applied = 0;
            int queued = 0;
            int items = 0;
            int dropped = 0;
            int failed = 0;
            List<string> pending = new List<string>();

            foreach (KeyValuePair<string, List<int>> entry in parsed.Players)
            {
                if (!IsSteamId64(entry.Key) || entry.Value == null || entry.Value.Count == 0)
                {
                    dropped++;
                    continue;
                }

                List<ItemDefinition> definitions = new List<ItemDefinition>();
                List<int> ids = new List<int>();
                HashSet<int> seen = new HashSet<int>();

                for (int i = 0; i < entry.Value.Count; i++)
                {
                    int itemId = entry.Value[i];

                    if (!seen.Add(itemId))
                    {
                        continue;
                    }

                    ItemDefinition definition = ItemManager.FindItemDefinition(itemId);

                    if (definition == null)
                    {
                        dropped++;
                        continue;
                    }

                    definitions.Add(definition);
                    ids.Add(itemId);
                }

                if (definitions.Count == 0)
                {
                    continue;
                }

                BasePlayer player = FindLoadedPlayer(entry.Key);

                if (player == null)
                {
                    // #### A FILA, E A UNIAO COM O QUE JA ESTAVA
                    //      NELA ####
                    //
                    // Duas cargas para o mesmo jogador offline
                    // acontecem (o agente reenvia depois de um
                    // reinicio). Substituir perderia a primeira.
                    QueueBlueprints(entry.Key, ids);
                    queued++;

                    if (pending.Count < MaxBpPendingReported)
                    {
                        pending.Add(entry.Key);
                    }

                    continue;
                }

                if (!ApplyBlueprints(player, definitions))
                {
                    // Entra em "pending" junto com os da fila, e nao
                    // por descuido: o campo quer dizer "NAO foi
                    // aplicado agora", e o agente marca como
                    // entregue exatamente quem esta FORA dele. Um
                    // jogador que o jogo recusou aparecendo como
                    // entregue e o defeito que ninguem descobre.
                    failed++;

                    if (pending.Count < MaxBpPendingReported)
                    {
                        pending.Add(entry.Key);
                    }

                    continue;
                }

                applied++;
                items += definitions.Count;
            }

            logLine = BpRestoreCommand + ": " + applied + " aplicado(s) na hora, " + queued +
                      " na fila do login, " + items + " blueprint(s) devolvido(s).";

            if (failed > 0)
            {
                PrintWarning(BpRestoreCommand + ": " + failed + " jogador(es) com o BasePlayer " +
                             "carregado nao receberam - ver o erro acima. O agente mantem a " +
                             "devolucao pendente e tenta de novo.");
            }

            return JsonConvert.SerializeObject(new BpRestoreOkResponse
            {
                Players = parsed.Players.Count,
                Applied = applied,
                Queued = queued,
                Items = items,
                Dropped = dropped,
                Pending = pending
            });
        }

        // ========================================================
        //  A DEVOLUCAO NO LOGIN
        //
        //  #### ELA NAO PODE ACONTECER NO BOOT ####
        //
        //  UnlockList mexe no PersistantPlayerInfo do BasePlayer e
        //  manda um ClientRPC: sem o jogador carregado nao ha o que
        //  chamar. Restaurar todo mundo ao subir nao e possivel - e
        //  nem desejavel, porque metade nunca volta.
        // ========================================================
        private void OnPlayerConnected(BasePlayer player)
        {
            // Excecao num hook do Oxide vira linha de erro a cada
            // conexao e, dependendo do hook, derruba a chamada dos
            // outros plugins. Aqui ela nao pode escapar.
            try
            {
                if (player == null)
                {
                    return;
                }

                List<int> ids;

                if (!_bpPending.TryGetValue(player.UserIDString, out ids) || ids == null)
                {
                    return;
                }

                List<ItemDefinition> definitions = new List<ItemDefinition>();

                for (int i = 0; i < ids.Count; i++)
                {
                    ItemDefinition definition = ItemManager.FindItemDefinition(ids[i]);

                    if (definition != null)
                    {
                        definitions.Add(definition);
                    }
                }

                // A entrada sai da fila ANTES de aplicar: se o
                // UnlockList estourar, tentar de novo a cada
                // reconexao repetiria o mesmo erro para sempre. Quem
                // insiste e o agente, que tem o estado no banco.
                _bpPending.Remove(player.UserIDString);

                if (definitions.Count == 0)
                {
                    return;
                }

                if (ApplyBlueprints(player, definitions))
                {
                    Puts("Blueprints devolvidos no login de " + player.UserIDString + ": " +
                         definitions.Count + " item(ns).");
                }
            }
            catch (Exception ex)
            {
                PrintError("Nao deu para devolver os blueprints no login: " + ex);
            }
        }

        // Guarda para o login. Uniao, nunca substituicao - ver o
        // comentario no HandleBpRestore.
        private void QueueBlueprints(string steamId, List<int> ids)
        {
            List<int> current;

            if (!_bpPending.TryGetValue(steamId, out current) || current == null)
            {
                _bpPending[steamId] = new List<int>(ids);
                return;
            }

            HashSet<int> merged = new HashSet<int>(current);

            for (int i = 0; i < ids.Count; i++)
            {
                if (merged.Add(ids[i]))
                {
                    current.Add(ids[i]);
                }
            }
        }

        // UM UnlockList para o lote inteiro: ele monta a lista
        // nova, grava o PersistantPlayerInfo, manda UM
        // SendNetworkUpdateImmediate e UM ClientRPC. Chamar Unlock
        // item a item faria trezentas atualizacoes de rede no
        // segundo em que o jogador entra.
        //
        // Devolve false quando o jogo recusou - e ai quem insiste e
        // o agente.
        private bool ApplyBlueprints(BasePlayer player, List<ItemDefinition> definitions)
        {
            try
            {
                player.blueprints.UnlockList(definitions);
                return true;
            }
            catch (Exception ex)
            {
                PrintError("UnlockList falhou para " + player.UserIDString + ": " + ex);
                return false;
            }
        }

        // O BasePlayer daquele SteamID, conectado OU dormindo.
        //
        // Dormindo tambem serve: o que o UnlockList precisa e do
        // BasePlayer carregado, e um jogador que acabou de sair
        // continua no mundo como sleeper por um bom tempo.
        private static BasePlayer FindLoadedPlayer(string steamId)
        {
            ulong id;

            if (!ulong.TryParse(steamId, NumberStyles.None, CultureInfo.InvariantCulture, out id))
            {
                return null;
            }

            BasePlayer player = BasePlayer.FindByID(id);

            return player != null ? player : BasePlayer.FindSleeping(id);
        }

        // O persistance do servidor, ou null quando ele ainda nao
        // existe (ServerMgr nao inicializado). null NAO e "nenhum
        // jogador": ver ErrorPersistenceUnavailable.
        private static UserPersistance ServerPersistance()
        {
            ServerMgr manager = SingletonComponent<ServerMgr>.Instance;

            return manager == null ? null : manager.persistance;
        }

        private class BpPlayerInfo
        {
            // String, e nao ulong: 17 digitos nao cabem num number
            // de JavaScript sem perder precisao. Mesma regra do
            // PlayerInfo.SteamId.
            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("items")]
            public List<int> Items { get; set; }
        }

        private class BpExportOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("count")]
            public int Count { get; set; }

            [JsonProperty("offset")]
            public int Offset { get; set; }

            [JsonProperty("limit")]
            public int Limit { get; set; }

            [JsonProperty("players")]
            public List<BpPlayerInfo> Players { get; set; }

            [JsonProperty("benches")]
            public Dictionary<string, int> Benches { get; set; }
        }

        private class BpRestorePayload
        {
            [JsonProperty("players")]
            public Dictionary<string, List<int>> Players { get; set; }
        }

        private class BpRestoreOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("players")]
            public int Players { get; set; }

            [JsonProperty("applied")]
            public int Applied { get; set; }

            [JsonProperty("queued")]
            public int Queued { get; set; }

            [JsonProperty("items")]
            public int Items { get; set; }

            [JsonProperty("dropped")]
            public int Dropped { get; set; }

            [JsonProperty("pending")]
            public List<string> Pending { get; set; }
        }

        // ========================================================
        //  A COLETA DE ESTATISTICA  (origemz.stats.flush / ack)
        //
        //  Contrato do outro lado:
        //      core/src/game/stats-contract.ts
        //  Documento:
        //      Docs/Ranking/20-PLANO-E-CONTRATOS.md, secao 6
        //
        //  #### O QUE ESTA SECAO FAZ, EM UMA FRASE ####
        //
        //  Ela CONTA EM MEMORIA o que os jogadores fazem e entrega
        //  o acumulado em lotes paginados quando o agente pede -
        //  descartando o lote so depois de o agente CONFIRMAR que
        //  gravou.
        //
        //  #### POR QUE UM LOTE, E NAO UM EVENTO POR GOLPE ####
        //
        //  OnDispenserGather dispara A CADA GOLPE de picareta: com
        //  cem jogadores minerando sao dezenas de eventos por
        //  segundo. Empurrar cada um pelo console entupiria o RCON e
        //  o log do servidor, e um evento perdido no meio seria
        //  invisivel. Por isso o hook aqui SO SOMA em memoria: nada
        //  de disco, nada de rede, nada de Puts dentro dele.
        //
        //  #### O LOTE CONGELA, E E ISSO QUE IMPEDE O BURACO ####
        //
        //  Um flush com offset=0 FECHA o buffer atual como "lote
        //  pendente" e abre um buffer novo para os golpes que
        //  continuam chegando; as paginas seguintes leem o pendente.
        //
        //  Sem esse congelamento a pagina 2 seria de um conjunto
        //  diferente da pagina 1 e o "count" mentiria - jogadores
        //  entrariam e sairiam do meio da lista enquanto o agente
        //  pagina.
        //
        //  Um flush offset=0 com um pendente AINDA NAO CONFIRMADO
        //  devolve o MESMO lote, com o MESMO batchId. E isso que faz
        //  uma queda de RCON no meio do ciclo nao custar nada: o
        //  agente pede de novo e recebe exatamente o que perdeu.
        //  So o `ack` descarta.
        //
        //  #### E ELE SOBREVIVE A UM oxide.reload ####
        //
        //  O buffer aberto e o lote pendente sao gravados no data
        //  file do Oxide (oxide/data/OrigemZAgentStats.json) de
        //  minuto em minuto, no congelamento e no Unload. Sem isso,
        //  recarregar o plugin jogaria fora o minerio de todo mundo
        //  desde o ultimo flush - e ninguem descobriria, porque nada
        //  falha: o numero so ficaria menor do que devia.
        //
        //  #### O MINERIO, E POR QUE QUARRY FICA DE FORA ####
        //
        //  Contam OnDispenserGather com gatherType == Ore (o golpe),
        //  OnDispenserBonus (o bonus de terminar o no) e
        //  OnCollectiblePickup (o minerio de chao). Quarry e
        //  excavator NAO tem dono - o minerio cai num container, e
        //  atribui-lo a quem ligou a maquina premiaria quem tem
        //  enxofre para queimar, e nao quem minerou. Ver
        //  Docs/Ranking/19-PESQUISA-RANKING.md, 4.4.
        //
        //  A exclusao e por AUSENCIA: os hooks da quarry
        //  (OnQuarryGather, OnExcavatorGather) simplesmente nao
        //  existem aqui.
        //
        //  #### E O QUE MAIS ESTA NESTA SECAO ####
        //
        //  Depois do minerio vem, em ordem:
        //
        //    - a MATRIZ DE ATRIBUICAO DA MORTE (OnPlayerDeath):
        //      nove situacoes, nove contadores, e o cuidado de nao
        //      devolver valor - retorno nao-nulo CANCELA a morte;
        //    - o TIRO MAIS LONGO (shot.distance): fato com
        //      testemunho, e nao contador. Ele viaja em `records`,
        //      e nao em `metrics`;
        //    - o EXPLOSIVO (explosive.seq): o custo em enxofre
        //      equivalente, DERIVADO do blueprint deste servidor;
        //    - o CUSTO DOS HOOKS, exposto no origemz.stats.diag -
        //      porque "cabe no orcamento?" e pergunta de numero, e
        //      nao de opiniao.
        // ========================================================

        /// <summary>
        /// `origemz.stats.flush [offset] [limit]`
        ///
        /// Uma pagina do lote pendente. offset=0 congela o buffer
        /// atual quando nao ha pendente.
        /// </summary>
        private const string StatsFlushCommand = "origemz.stats.flush";

        /// <summary>
        /// `origemz.stats.ack &lt;batchId&gt;`
        ///
        /// O UNICO caminho que descarta um lote.
        /// </summary>
        private const string StatsAckCommand = "origemz.stats.ack";

        /// <summary>
        /// `origemz.stats.diag`
        ///
        /// O custo medido dos hooks de coleta, e o estado do buffer.
        /// Nao muda nada.
        /// </summary>
        private const string StatsDiagCommand = "origemz.stats.diag";

        // A versao do contrato, na resposta. O agente recusa o que
        // nao entende com PLUGIN_INVALID_RESPONSE - nunca com lista
        // vazia, que se disfarcaria de "ninguem minerou".
        private const int StatsContractVersion = 1;

        // Paginacao do flush.
        //
        // Uma linha de jogador com quatro metricas de minerio ocupa
        // ~140 bytes no JSON - mesma ordem de grandeza do
        // origemz.players. 100 por pagina da ~14 KB, bem dentro do
        // frame; o teto de 250 existe para o agente poder pedir
        // paginas maiores num servidor vazio sem passar dos 60 KB.
        private const int DefaultStatsLimit = 100;
        private const int MaxStatsLimit = 250;

        // O mesmo teto do bp.export, e pela mesma medida: o frame do
        // WebRCON deste projeto aguenta ~70 KB, e 60 KB deixa margem
        // para o servidor sob carga.
        private const int MaxStatsFlushBytes = 60000;

        // Ack (ou pagina) de um lote que nao existe mais. NAO e um
        // erro do agente: e um oxide.reload no meio do ciclo, ou uma
        // confirmacao repetida. Quem recebe trata como "ja foi".
        private const string ErrorNoBatch = "NO_BATCH";

        // Onde o buffer dorme entre um oxide.reload e o seguinte.
        private const string StatsDataFile = "OrigemZAgentStats";

        // De quanto em quanto tempo o buffer vai para o disco.
        //
        // Uma volta igual a do coletor do agente: o que se perde num
        // desligamento duro e, no pior caso, um minuto de coleta -
        // e o custo e uma escrita de poucas dezenas de KB por
        // minuto, so quando algo mudou.
        private const float StatsSnapshotSeconds = 60f;

        // Teto de jogadores no buffer aberto.
        //
        // #### ELE EXISTE PARA O CASO EM QUE O AGENTE SOME ####
        //
        // Com o RCON fora por dias, ninguem chama o flush e o buffer
        // so cresce. O teto limita a memoria; passando dele, quem JA
        // esta no buffer continua contando e quem chega novo fica de
        // fora - perder o novato e melhor do que perder o servidor.
        private const int MaxStatsPlayers = 5000;

        // A metrica somada dos quatro minerios. Ela e somada AQUI,
        // e nao na leitura do agente: os quatro numeros ja estao na
        // mao, e soma-los no SQL exigiria quatro consultas e uma
        // conta que o formato (metric, value) nao faz bem.
        private const string MetricOreTotal = "ore.total";

        // shortname do jogo -> metrica do ranking. Fora deste mapa,
        // nada e contado: madeira, tecido e couro nao sao minerio, e
        // um mapa aberto faria a Fatia 1 virar "tudo o que se
        // colhe".
        private static readonly Dictionary<string, string> OreMetrics =
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                { "sulfur.ore", "ore.sulfur" },
                { "metal.ore", "ore.metal" },
                { "stones", "ore.stone" },
                { "hq.metal.ore", "ore.hqm" }
            };

        private static readonly DateTime StatsEpoch =
            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        // O buffer ABERTO: o que esta chegando agora.
        private Dictionary<string, StatsPlayerCounters> _statsOpen =
            new Dictionary<string, StatsPlayerCounters>(StringComparer.Ordinal);

        // O lote PENDENTE: congelado por um flush offset=0 e ainda
        // nao confirmado. Enquanto ele existe, todo flush offset=0
        // devolve ELE.
        private StatsBatch _statsPending;

        // Cresce a cada lote novo, e ATRAVESSA o oxide.reload (vai
        // no data file). E ele que permite o log do agente perceber
        // buraco - "recebi o 41 e o 43". Nao ordena nem descarta
        // nada: quem faz isso e o batchId.
        private int _statsSeq;

        private bool _statsReady;
        private bool _statsDirty;

        // Quantas excecoes ja escaparam de um hook de coleta.
        //
        // O log sai UMA vez. Um hook que dispara dezenas de vezes
        // por segundo transformaria um erro repetido num paredao que
        // esconde todo o resto do log do servidor.
        private int _statsHookErrors;

        // Ja avisamos que o buffer encheu?
        private bool _statsFullWarned;

        // --------------------------------------------------------
        //  OS HOOKS
        //
        //  #### NENHUM DELES DEVOLVE NADA ####
        //
        //  Hook de coleta que devolve valor diferente de null
        //  CANCELA a acao no Rust: o jogador bateria na pedra e nao
        //  receberia minerio nenhum. `void` e o unico retorno
        //  seguro aqui, e nenhum caminho pode escapar por excecao.
        // --------------------------------------------------------

        /// <summary>O golpe de picareta. Dispara uma vez por acerto.</summary>
        private void OnDispenserGather(ResourceDispenser dispenser, BaseEntity entity, Item item)
        {
            long started = StatsHookStart();

            try
            {
                if (dispenser == null || dispenser.gatherType != ResourceDispenser.GatherType.Ore)
                {
                    return;
                }

                AddOreFromItem(entity as BasePlayer, item);
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookDispenserGather, ex);
            }
            finally
            {
                StatsHookStop(HookDispenserGather, started);
            }
        }

        /// <summary>
        /// O bonus de terminar o no.
        ///
        /// Ele NAO passa por OnDispenserGather - o jogo monta o item
        /// dentro do AssignFinishBonus e chama so este hook. Sem ele
        /// faltaria no ranking justamente a parte que premia quem
        /// termina a pedra em vez de abandona-la.
        /// </summary>
        private void OnDispenserBonus(ResourceDispenser dispenser, BasePlayer player, Item item)
        {
            long started = StatsHookStart();

            try
            {
                if (dispenser == null || dispenser.gatherType != ResourceDispenser.GatherType.Ore)
                {
                    return;
                }

                AddOreFromItem(player, item);
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookDispenserBonus, ex);
            }
            finally
            {
                StatsHookStop(HookDispenserBonus, started);
            }
        }

        /// <summary>
        /// O minerio de chao.
        ///
        /// #### A QUANTIDADE AQUI E A DA LISTA, E NAO A ENTREGUE ####
        ///
        /// O hook dispara ANTES de o item existir, entao o unico
        /// numero disponivel e o `itemList` do prefab. A taxa de
        /// coleta do servidor multiplica o que o jogador recebe, e
        /// essa multiplicacao nao esta aqui. E uma aproximacao
        /// declarada: o ranking de minerio de chao conta NOS, e o
        /// erro e o mesmo para todo mundo no mesmo servidor.
        /// </summary>
        private void OnCollectiblePickup(CollectibleEntity collectible, BasePlayer player, bool eat)
        {
            long started = StatsHookStart();

            try
            {
                if (collectible == null || collectible.itemList == null)
                {
                    return;
                }

                for (int i = 0; i < collectible.itemList.Length; i++)
                {
                    ItemAmount slot = collectible.itemList[i];

                    if (slot == null)
                    {
                        continue;
                    }

                    AddOre(player, slot.itemDef, (int)slot.amount);
                }
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookCollectiblePickup, ex);
            }
            finally
            {
                StatsHookStop(HookCollectiblePickup, started);
            }
        }

        private void AddOreFromItem(BasePlayer player, Item item)
        {
            if (item == null)
            {
                return;
            }

            AddOre(player, item.info, item.amount);
        }

        // Soma um punhado de minerio na conta de um jogador.
        //
        // Tudo o que nao for jogador de verdade sai por aqui: NPC,
        // entidade sem dono, id que nao e SteamID64. Contar um NPC
        // criaria uma linha em `players` no agente para alguem que
        // nunca vai abrir a tela.
        private void AddOre(BasePlayer player, ItemDefinition info, int amount)
        {
            if (player == null || info == null || amount <= 0 || player.IsNpc)
            {
                return;
            }

            // As missoes contam o recurso PELO NOME, e nao pela
            // familia: o ranking soma `ore.total`, a missao pede
            // enxofre. O mesmo golpe de picareta serve aos dois.
            QuestOnGather(player, info.shortname, amount);

            string metric;

            if (!OreMetrics.TryGetValue(info.shortname, out metric))
            {
                return;
            }

            string steamId = player.UserIDString;

            if (!IsSteamId64(steamId))
            {
                return;
            }

            EnsureStatsReady();

            StatsPlayerCounters counters = OpenCountersOf(steamId, player.displayName);

            if (counters == null)
            {
                return;
            }

            BumpMetric(counters, metric, amount);
            BumpMetric(counters, MetricOreTotal, amount);

            _statsDirty = true;
        }

        // A linha daquele jogador no buffer aberto, criada se
        // precisar. null = o buffer encheu e ele nao entrou.
        private StatsPlayerCounters OpenCountersOf(string steamId, string name)
        {
            StatsPlayerCounters counters;

            if (_statsOpen.TryGetValue(steamId, out counters) && counters != null)
            {
                if (!string.IsNullOrEmpty(name))
                {
                    // O nome mais recente ganha: ele e so para o log
                    // e para a tela, e nunca e chave.
                    counters.Name = name;
                }

                return counters;
            }

            if (_statsOpen.Count >= MaxStatsPlayers)
            {
                if (!_statsFullWarned)
                {
                    _statsFullWarned = true;
                    PrintWarning(StatsFlushCommand + ": o buffer passou de " + MaxStatsPlayers +
                                 " jogadores sem ninguem confirmar um lote. O agente esta " +
                                 "alcancando este servidor? Quem ja esta no buffer continua " +
                                 "contando; quem chegar agora fica de fora.");
                }

                return null;
            }

            counters = new StatsPlayerCounters
            {
                Name = name == null ? "" : name,
                Metrics = new Dictionary<string, long>(StringComparer.Ordinal)
            };

            _statsOpen[steamId] = counters;

            return counters;
        }

        // `long` no amount, e nao `int`: o SEQ de um craft de 100
        // balas explosivas ja passa de 2 500, e uma temporada de
        // minerio somada num int estouraria em silencio - o sinal
        // seria um numero NEGATIVO no podio.
        private static void BumpMetric(StatsPlayerCounters counters, string metric, long amount)
        {
            if (counters.Metrics == null)
            {
                counters.Metrics = new Dictionary<string, long>(StringComparer.Ordinal);
            }

            long current;

            if (!counters.Metrics.TryGetValue(metric, out current))
            {
                current = 0;
            }

            counters.Metrics[metric] = current + amount;
        }

        // O log de um hook sai UMA vez, e depois so conta.
        private void ReportStatsHookError(string hook, Exception ex)
        {
            _statsHookErrors++;

            if (_statsHookErrors == 1)
            {
                PrintError("A coleta de estatistica falhou em " + hook + " e foi ignorada " +
                           "naquele golpe. Este aviso sai uma vez so: " + ex);
            }
        }

        // ========================================================
        //  A MATRIZ DE ATRIBUICAO DA MORTE  (OnPlayerDeath)
        //
        //  Documento: Docs/Ranking/19-PESQUISA-RANKING.md, 6.2.
        //
        //  #### O RETORNO NAO-NULO CANCELA A MORTE ####
        //
        //  MEDIDO com Mono.Cecil sobre o Assembly-CSharp.dll deste
        //  servidor: BasePlayer::Die faz
        //
        //      Interface.CallHook("OnPlayerDeath", this, info)
        //      ldnull / beq  -> se o retorno NAO for nulo, o metodo
        //                       RETORNA sem chamar BaseCombatEntity::Die
        //
        //  Ou seja: qualquer valor devolvido aqui deixa o jogador
        //  vivo com vida zero. `void` e o unico retorno seguro, e e
        //  a mesma nota que o OrigemZPlayer.cs:414-417 ja carrega.
        //
        //  #### E DOIS PLUGINS PODEM DECLARAR O MESMO HOOK ####
        //
        //  O OrigemZPlayer tambem tem OnPlayerDeath (ele emite o
        //  evento de sessao). O Oxide chama os dois; nenhum sabe do
        //  outro, e nenhum deve devolver nada.
        //
        //  #### AS NOVE LINHAS, NA ORDEM EM QUE SAO TESTADAS ####
        //
        //  A ordem IMPORTA: a primeira que casa vence, e uma morte
        //  se encaixa em mais de uma linha com frequencia (um
        //  companheiro de time dormindo e team kill E sleeper).
        //
        //   1. vitima e NPC        -> pve.kills do atacante; a
        //                             vitima NAO existe na base
        //   2. suicidio            -> suicides
        //   3. armadilha           -> trap.kills do DONO +
        //                             trap.deaths da vitima
        //   4. NPC/heli/Bradley    -> pve.deaths
        //   5. ambiente            -> env.deaths
        //   6. team kill           -> team.kills + team.deaths
        //   7. sleeper             -> sleeper.kills + sleeper.deaths
        //   8. PvP limpo           -> pvp.kills + pvp.deaths
        //   9. wounded -> morte    -> vale o ULTIMO atacante, que e
        //                             o que o HitInfo do hook ja
        //                             carrega: cai na linha 8 sem
        //                             codigo proprio
        //
        //  #### POR QUE TODO PAR TEM OS DOIS LADOS ####
        //
        //  O K/D do 19-PESQUISA 6.3 encolhe contra a media da
        //  populacao, e a conta so fica ancorada em 1,0 se cada
        //  `pvp.kills` tiver exatamente um `pvp.deaths` do outro
        //  lado. Contar a morte por turret como `pvp.deaths` sem um
        //  `pvp.kills` correspondente puxaria a media da populacao
        //  para baixo e desregularia o encolhimento de todo mundo.
        //
        //  Por isso `trap`, `team` e `sleeper` tem kill E death
        //  proprios: eles ficam fora do K/D dos DOIS lados, e a
        //  ficha do jogador continua contando a historia inteira.
        // ========================================================

        /// <summary>Abate de PvP limpo. Entra no K/D.</summary>
        private const string MetricPvpKills = "pvp.kills";

        /// <summary>Morte causada por outro jogador. Entra no K/D.</summary>
        private const string MetricPvpDeaths = "pvp.deaths";

        /// <summary>NPC, animal, heli, Bradley abatido. Fora do K/D.</summary>
        private const string MetricPveKills = "pve.kills";

        /// <summary>
        /// Morto por NPC.
        ///
        /// O 6.2 deixa a escolha entre `env.deaths` e `pve.deaths`.
        /// Ficou `pve.deaths` porque morrer para um scientist e
        /// morrer de fome nao dizem a mesma coisa sobre o jogador, e
        /// somar os dois apagaria a diferenca para sempre.
        /// </summary>
        private const string MetricPveDeaths = "pve.deaths";

        /// <summary>Queda, fome, frio, afogamento, fogo. Fora do K/D.</summary>
        private const string MetricEnvDeaths = "env.deaths";

        /// <summary>Suicidio, e a propria armadilha. Fora do K/D.</summary>
        private const string MetricSuicides = "suicides";

        private const string MetricTeamKills = "team.kills";
        private const string MetricTeamDeaths = "team.deaths";
        private const string MetricSleeperKills = "sleeper.kills";
        private const string MetricSleeperDeaths = "sleeper.deaths";
        private const string MetricTrapKills = "trap.kills";
        private const string MetricTrapDeaths = "trap.deaths";

        /// <summary>
        /// O tiro mais longo.
        ///
        /// Ela NAO e contador: viaja em `records`, e nao em
        /// `metrics`. Ver o bloco do tiro longo, mais abaixo.
        /// </summary>
        private const string MetricShotDistance = "shot.distance";

        /// <summary>Poder explosivo produzido, em enxofre equivalente.</summary>
        private const string MetricExplosiveSeq = "explosive.seq";

        /// <summary>
        /// A morte de um jogador.
        ///
        /// void, e nenhuma excecao escapa: ver o cabecalho.
        /// </summary>
        private void OnPlayerDeath(BasePlayer player, HitInfo info)
        {
            long started = StatsHookStart();

            try
            {
                ApplyDeath(player, info);
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookPlayerDeath, ex);
            }
            finally
            {
                StatsHookStop(HookPlayerDeath, started);
            }
        }

        // A matriz, linha por linha. Ver o cabecalho para a ordem.
        private void ApplyDeath(BasePlayer victim, HitInfo info)
        {
            if (victim == null)
            {
                return;
            }

            BasePlayer attacker = AttackerOf(info);

            // ####  AS MISSOES ENGANCHAM AQUI  ####
            //
            // No hook que JA roda, e nao num proprio: um segundo
            // OnPlayerDeath custaria o dobro de quadros para contar a
            // mesma morte. O QuestOnKill sai na primeira comparacao
            // quando ninguem persegue aquele alvo.
            //
            // `ShortPrefabName` para o NPC (o `scientistnpc_heavy`
            // que o alias normaliza) e `player` para gente: e assim
            // que o alvo e cadastrado no painel.
            if (attacker != null && attacker != victim)
            {
                QuestOnKill(attacker, victim.IsNpc ? victim.ShortPrefabName : "player");
            }

            // ####  LINHA 1: A VITIMA E NPC  ####
            //
            // IsNpc e a PRIMEIRA pergunta porque o userID de um NPC
            // NAO e SteamID64 - o ScientistNPC herda de BasePlayer, e
            // grava-lo como jogador encheria a base de gente que
            // nunca vai abrir a tela. Mesmo cuidado que o
            // OrigemZPlayer.cs ja documenta.
            if (victim.IsNpc)
            {
                if (attacker != null && !ReferenceEquals(attacker, victim))
                {
                    BumpPlayerMetric(attacker, MetricPveKills, 1);
                }

                return;
            }

            string victimId = victim.UserIDString;

            if (!IsSteamId64(victimId))
            {
                return;
            }

            // ####  LINHA 2: SUICIDIO  ####
            if (IsSuicide(victim, info, attacker))
            {
                BumpPlayerMetric(victim, MetricSuicides, 1);
                return;
            }

            if (attacker == null)
            {
                // ####  LINHA 3: ARMADILHA  ####
                //
                // A turret nao e jogador, entao InitiatorPlayer e
                // null e o abate ficaria sem dono. Quem responde e o
                // OwnerID da entidade - e ele vale mesmo com o dono
                // OFFLINE, que e o caso comum de uma turret matando.
                string trapOwner = TrapOwnerIdOf(info);

                if (trapOwner != null)
                {
                    if (string.Equals(trapOwner, victimId, StringComparison.Ordinal))
                    {
                        // A propria landmine. Nao e abate de
                        // ninguem, e premiar o dono aqui seria
                        // premiar quem morreu.
                        BumpPlayerMetric(victim, MetricSuicides, 1);
                        return;
                    }

                    BumpMetricById(trapOwner, "", MetricTrapKills, 1);
                    BumpPlayerMetric(victim, MetricTrapDeaths, 1);
                    return;
                }

                // ####  LINHA 4: NPC, HELI OU BRADLEY MATOU  ####
                if (IsNpcInitiator(info))
                {
                    BumpPlayerMetric(victim, MetricPveDeaths, 1);
                    return;
                }

                // ####  LINHA 5: AMBIENTE  ####
                //
                // Sem iniciador nenhum: queda, fome, frio,
                // afogamento, radiacao. E tambem o que nao soubemos
                // classificar - e cair aqui e melhor do que sumir da
                // ficha do jogador.
                BumpPlayerMetric(victim, MetricEnvDeaths, 1);
                return;
            }

            // ####  LINHA 6: TEAM KILL  ####
            //
            // Antes do sleeper de proposito: matar o companheiro
            // dormindo e team kill, e chamar isso de sleeper.kill
            // esconderia justamente o que interessa saber.
            if (SameTeam(attacker, victim))
            {
                BumpPlayerMetric(attacker, MetricTeamKills, 1);
                BumpPlayerMetric(victim, MetricTeamDeaths, 1);
                return;
            }

            // ####  LINHA 7: SLEEPER  ####
            //
            // Fora do K/D porque premiar quem anda de machado por
            // base vazia e exatamente o comportamento que a
            // comunidade chama de inflar estatistica (19-PESQUISA 6.1).
            if (victim.IsSleeping())
            {
                BumpPlayerMetric(attacker, MetricSleeperKills, 1);
                BumpPlayerMetric(victim, MetricSleeperDeaths, 1);
                return;
            }

            // ####  LINHA 8: PVP LIMPO  ####
            BumpPlayerMetric(attacker, MetricPvpKills, 1);
            BumpPlayerMetric(victim, MetricPvpDeaths, 1);

            // ####  LINHA 9: E SO AQUI O TIRO LONGO PODE VALER  ####
            //
            // O filtro de elegibilidade do 19-PESQUISA 7.3 pede
            // vitima acordada, jogador de verdade, de outro time e
            // diferente do atacante - que e precisamente o conjunto
            // que sobrevive ate esta linha. Chamar de outro lugar
            // obrigaria a repetir os quatro testes.
            TryRecordLongShot(attacker, victim, info);
        }

        /// <summary>
        /// O atacante, se for jogador de verdade.
        ///
        /// null cobre tres casos diferentes de proposito - sem
        /// iniciador, iniciador que nao e jogador, e NPC -, porque
        /// quem chama trata os tres pela mesma porta e desempata
        /// depois.
        /// </summary>
        private static BasePlayer AttackerOf(HitInfo info)
        {
            if (info == null)
            {
                return null;
            }

            BasePlayer attacker = info.InitiatorPlayer;

            if (attacker == null || attacker.IsNpc)
            {
                return null;
            }

            return IsSteamId64(attacker.UserIDString) ? attacker : null;
        }

        // Suicidio: o proprio jogador, ou o tipo de dano que o jogo
        // usa para o comando `kill` e para o "suicide" do menu.
        private static bool IsSuicide(BasePlayer victim, HitInfo info, BasePlayer attacker)
        {
            if (attacker != null && ReferenceEquals(attacker, victim))
            {
                return true;
            }

            if (info == null || info.damageTypes == null)
            {
                return false;
            }

            return info.damageTypes.Has(Rust.DamageType.Suicide);
        }

        // O iniciador e NPC, bicho, heli ou Bradley?
        //
        // IsNpc cobre o ScientistNPC (que herda de BasePlayer); os
        // outros tres sao entidades sem dono que matam jogador e
        // nao podem virar "ambiente" - morrer para o heli e uma
        // historia diferente de morrer de fome.
        private static bool IsNpcInitiator(HitInfo info)
        {
            if (info == null)
            {
                return false;
            }

            BaseEntity initiator = info.Initiator;

            if (initiator == null)
            {
                return false;
            }

            if (initiator.IsNpc || initiator is BaseNpc)
            {
                return true;
            }

            return initiator is BaseHelicopter || initiator is PatrolHelicopter ||
                   initiator is BradleyAPC;
        }

        /// <summary>
        /// O SteamID do dono da armadilha que matou, ou null.
        ///
        /// #### DEVOLVE O ID, E NAO O BasePlayer ####
        ///
        /// BasePlayer.FindByID so acha quem esta ONLINE, e o caso
        /// normal de uma turret matando e justamente o dono estar
        /// fora. O contador precisa do id, e o nome e dispensavel
        /// aqui: o agente ja tem o jogador em `players` e o
        /// INSERT OR IGNORE de la nao apaga o nome com vazio.
        /// </summary>
        private static string TrapOwnerIdOf(HitInfo info)
        {
            if (info == null)
            {
                return null;
            }

            BaseEntity initiator = info.Initiator;

            if (initiator == null || !IsTrap(initiator))
            {
                return null;
            }

            string owner = initiator.OwnerID.ToString(CultureInfo.InvariantCulture);

            return IsSteamId64(owner) ? owner : null;
        }

        // As armadilhas que matam jogador e tem dono.
        //
        // A lista e por TIPO, e nao por "tem OwnerID": um foguete
        // disparado por jogador tambem tem dono, e ele ja chegou
        // aqui como PvP limpo pelo InitiatorPlayer. Perguntar so
        // pelo OwnerID transformaria em armadilha tudo o que um
        // jogador construiu.
        private static bool IsTrap(BaseEntity entity)
        {
            return entity is AutoTurret || entity is GunTrap || entity is FlameTurret ||
                   entity is BaseTrap || entity is TeslaCoil || entity is SamSite;
        }

        // Mesmo time?
        //
        // currentTeam == 0 quer dizer "sem time": dois jogadores
        // sem time nao sao companheiros, e comparar 0 com 0 daria
        // team kill em todo PvP de servidor com times desligados.
        private static bool SameTeam(BasePlayer attacker, BasePlayer victim)
        {
            return attacker.currentTeam != 0UL && attacker.currentTeam == victim.currentTeam;
        }

        // ========================================================
        //  O TIRO MAIS LONGO  (shot.distance)
        //
        //  Documento: Docs/Ranking/19-PESQUISA-RANKING.md, 7.
        //
        //  #### ELE NAO E CONTADOR: E FATO COM TESTEMUNHO ####
        //
        //  Um contador diria "412". A tabela player_records do
        //  agente diz com que arma, em quem, onde e quando - que e o
        //  que se mostra quando alguem contesta o recorde. Por isso
        //  ele viaja em `records`, e nao em `metrics`.
        //
        //  #### AS DUAS DISTANCIAS, E O QUE CADA UMA FAZ ####
        //
        //      shot     = Vector3.Distance(atirador, vitima)
        //      ratio    = HitInfo.ProjectileDistance / shot
        //
        //  RANQUEIA a linha reta, porque e a que o jogador entende e
        //  a que qualquer print do jogo confirma. VALIDA com o
        //  caminho do projetil, que fica no registro como prova:
        //
        //    ratio perto de 1   -> tiro em linha, integro
        //    ratio bem acima    -> ricochete ou trajetoria longa
        //    ratio bem abaixo   -> os dois pontos nao estavam
        //                          separados no disparo: teleporte,
        //                          HitInfo reconstruido, plugin de
        //                          terceiro
        //
        //  Os dois extremos viram `suspect`, e nao descarte: apagar
        //  seria perder o rastro da fraude. O agente grava e nao
        //  poe no podio.
        //
        //  #### E ELE GUARDA SO O MELHOR ####
        //
        //  Um jogador com um bom tiro geraria uma linha por minuto
        //  ate o fim da temporada se todo tiro viajasse. O buffer
        //  guarda o melhor por (metrica, status) e o lote leva
        //  aquele; do outro lado, o agente ainda compara com o
        //  melhor do periodo antes de inserir.
        // ========================================================

        /// <summary>
        /// O piso, em metros.
        ///
        /// Abaixo disto nao e "tiro longo" - e tiro de corredor, e
        /// ele poluiria a lista com o que ninguem chamaria de
        /// recorde.
        /// </summary>
        private const float MinShotDistance = 25f;

        /// <summary>
        /// O teto de plausibilidade, em metros.
        ///
        /// Acima disto o registro entra como `suspect`. Nao e
        /// descarte: um tiro de 1 200 m pode ser real num mapa
        /// grande, e o que ele nao pode e entrar no podio sem
        /// alguem olhar.
        /// </summary>
        private const float MaxShotDistance = 1000f;

        /// <summary>Ricochete/trajetoria longa acima disto.</summary>
        private const float MaxShotRatio = 1.25f;

        /// <summary>Teleporte/HitInfo reconstruido abaixo disto.</summary>
        private const float MinShotRatio = 0.75f;

        /// <summary>O lado da celula da grade do mapa do Rust.</summary>
        private const float GridCellSize = 146.3f;

        private const string RecordStatusOk = "ok";
        private const string RecordStatusSuspect = "suspect";

        // O tiro que matou, quando ele pode virar recorde.
        //
        // Chamado SO da linha 8 da matriz: os quatro primeiros
        // testes do 7.3 (vitima real, acordada, de outro time,
        // diferente do atacante) ja foram feitos la.
        private void TryRecordLongShot(BasePlayer attacker, BasePlayer victim, HitInfo info)
        {
            if (info == null)
            {
                return;
            }

            // 7.3(3): a arma tem de ser DE PROJETIL. Explosivo,
            // fogo, armadilha e melee nao fazem tiro longo - e um
            // C4 a 300 m "de distancia" seria o recorde de todo
            // servidor no primeiro dia.
            BaseProjectile weapon = info.Weapon as BaseProjectile;

            if (weapon == null || !info.IsProjectile())
            {
                return;
            }

            if (info.damageTypes != null)
            {
                Rust.DamageType major = info.damageTypes.GetMajorityDamageType();

                if (major != Rust.DamageType.Bullet && major != Rust.DamageType.Arrow &&
                    major != Rust.DamageType.Stab && major != Rust.DamageType.Slash)
                {
                    // Explosao, fogo, veneno: a bala pode ate ter
                    // saido de uma arma de projetil, mas o que matou
                    // nao foi o tiro.
                    //
                    // Stab e Slash entram na lista porque algumas
                    // municoes de arco e besta usam esses tipos - e
                    // a peneira forte ja passou: a arma TEM de ser
                    // BaseProjectile, e o golpe de machado nunca e.
                    return;
                }
            }

            Vector3 from = attacker.transform.position;
            Vector3 to = victim.transform.position;
            float shot = Vector3.Distance(from, to);

            if (!IsUsableDistance(shot) || shot < MinShotDistance)
            {
                return;
            }

            float projectile = info.ProjectileDistance;
            bool measured = IsUsableDistance(projectile);
            float ratio = measured ? projectile / shot : 0f;

            string status = RecordStatusOk;
            string reason = null;

            if (shot > MaxShotDistance)
            {
                status = RecordStatusSuspect;
                reason = "teto";
            }
            else if (!measured)
            {
                // #### AUSENCIA DE PROVA NAO E PROVA DE FRAUDE ####
                //
                // Sem ProjectileDistance nao ha o que validar, e e
                // exatamente esse o sinal de um HitInfo reconstruido
                // por plugin de terceiro (7.2). Entra como suspeito -
                // mas com razao PROPRIA, e nao como "teleporte":
                // se um dia o jogo deixar de preencher o campo para
                // alguma arma, o podio fica vazio e o motivo esta
                // escrito na propria linha, em vez de virar uma caca
                // de duas horas.
                status = RecordStatusSuspect;
                reason = "sem-projetil";
            }
            else if (ratio > MaxShotRatio)
            {
                status = RecordStatusSuspect;
                reason = "ricochete";
            }
            else if (ratio < MinShotRatio)
            {
                // 7.2: ratio bem abaixo de 1 quer dizer que os dois
                // pontos nao estavam separados no instante do
                // disparo - o teleporte entra por aqui.
                status = RecordStatusSuspect;
                reason = "teleporte";
            }
            else if (attacker.IsFlying || attacker.IsGod())
            {
                // 7.3(4): admin em noclip ou em modo deus atira de
                // onde quiser, e o dono deste servidor joga como
                // admin. O tiro fica registrado; o podio, nao.
                status = RecordStatusSuspect;
                reason = "admin";
            }

            Dictionary<string, object> detail = new Dictionary<string, object>(StringComparer.Ordinal);

            detail["weapon"] = WeaponNameOf(info, weapon);
            detail["ammo"] = AmmoNameOf(weapon);
            detail["category"] = ShotCategoryOf(weapon);
            detail["headshot"] = info.isHeadshot;
            detail["victim"] = victim.UserIDString;
            detail["victimName"] = SanitizeStatsText(victim.displayName);
            detail["grid"] = GridLabelOf(to);
            detail["from"] = PointOf(from);
            detail["to"] = PointOf(to);
            detail["projectile"] = RoundTo(projectile, 2);
            detail["ratio"] = RoundTo(ratio, 3);

            if (reason != null)
            {
                detail["reason"] = reason;
            }

            KeepRecord(attacker, MetricShotDistance, RoundTo(shot, 2), status, detail);
        }

        // Distancia que da para usar: NaN e infinito chegam de
        // HitInfo reconstruido, e um NaN no JSON viraria a palavra
        // "NaN" - que nao e JSON valido e derrubaria a pagina
        // inteira do lote no zod do agente.
        private static bool IsUsableDistance(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value) && value > 0f;
        }

        // O nome da arma, preferindo o shortname do ITEM.
        //
        // "rifle.bolt" e o que o admin reconhece; o
        // ShortPrefabName ("bolt_rifle.entity") e o que sobra
        // quando o item ja nao existe.
        private static string WeaponNameOf(HitInfo info, BaseProjectile weapon)
        {
            Item item = weapon.GetItem();

            if (item != null && item.info != null && !string.IsNullOrEmpty(item.info.shortname))
            {
                return item.info.shortname;
            }

            if (info.WeaponPrefab != null)
            {
                return info.WeaponPrefab.ShortPrefabName;
            }

            return weapon.ShortPrefabName;
        }

        private static string AmmoNameOf(BaseProjectile weapon)
        {
            if (weapon.primaryMagazine == null || weapon.primaryMagazine.ammoType == null)
            {
                return "";
            }

            return weapon.primaryMagazine.ammoType.shortname;
        }

        /// <summary>
        /// A categoria do tiro: `bow`, `auto`, `semi`, `bolt`.
        ///
        /// #### ELA SAI DA ARMA, E NAO DE UMA LISTA NOSSA ####
        ///
        /// Pela mesma razao do SEQ (19-PESQUISA 5.3): uma lista de
        /// shortnames aqui esqueceria a arma nova do proximo update
        /// e a jogaria em "other" sem ninguem perceber.
        /// `automatic` e `isSemiAuto` sao campos do proprio
        /// BaseProjectile - medidos no Assembly-CSharp deste
        /// servidor.
        /// </summary>
        private static string ShotCategoryOf(BaseProjectile weapon)
        {
            string ammo = AmmoNameOf(weapon);

            if (ammo.StartsWith("arrow", StringComparison.Ordinal))
            {
                return "bow";
            }

            if (weapon.automatic)
            {
                return "auto";
            }

            return weapon.isSemiAuto ? "semi" : "bolt";
        }

        /// <summary>
        /// A celula do mapa: `G12`.
        ///
        /// #### O MUNDO E CENTRADO NA ORIGEM, E A LINHA CRESCE
        ///      PARA BAIXO ####
        ///
        /// Copia deliberada de core/src/game/grid.ts: mesmo
        /// tamanho de celula, mesma inversao da linha
        /// (`size/2 - z`, e nao `z + size/2`) e mesmo nome de
        /// coluna passando do Z. Divergir daria dois rotulos para
        /// a mesma posicao, um no painel e outro no recorde.
        ///
        /// Y e altura e NAO entra: usar (x, y) e o erro classico -
        /// funciona ate alguem subir num predio.
        /// </summary>
        private static string GridLabelOf(Vector3 position)
        {
            float size = World.Size;

            if (size <= 0f)
            {
                return "";
            }

            int cells = (int)Math.Ceiling(size / GridCellSize);

            if (cells <= 0)
            {
                return "";
            }

            float half = size / 2f;
            int col = Clamp((int)Math.Floor((position.x + half) / GridCellSize), 0, cells - 1);
            int row = Clamp((int)Math.Floor((half - position.z) / GridCellSize), 0, cells - 1);

            return GridColumnName(col) + row.ToString(CultureInfo.InvariantCulture);
        }

        // 0 -> A, 25 -> Z, 26 -> AA. Um mundo de 6000 tem 42
        // colunas, entao passar do Z e o padrao, e nao a excecao.
        private static string GridColumnName(int index)
        {
            if (index < 0)
            {
                return "";
            }

            string name = "";
            int remaining = index;

            do
            {
                name = ((char)('A' + (remaining % 26))).ToString() + name;
                remaining = (remaining / 26) - 1;
            }
            while (remaining >= 0);

            return name;
        }

        private static int Clamp(int value, int min, int max)
        {
            if (value < min)
            {
                return min;
            }

            return value > max ? max : value;
        }

        private static Dictionary<string, object> PointOf(Vector3 position)
        {
            Dictionary<string, object> point = new Dictionary<string, object>(StringComparer.Ordinal);

            point["x"] = RoundTo(position.x, 1);
            point["y"] = RoundTo(position.y, 1);
            point["z"] = RoundTo(position.z, 1);

            return point;
        }

        // Arredondar antes de serializar: um float cru vira
        // "412.7300109863281" no JSON, e cada casa dessas e byte
        // no frame do RCON que o teto de 60 KB precisa.
        private static double RoundTo(float value, int digits)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                return 0d;
            }

            return Math.Round((double)value, digits);
        }

        // Texto que o JOGADOR escolhe nao pode quebrar a linha do
        // console: o marcador `#OZSTAT#` e achado por linha, e um
        // \n no nome partiria o JSON em dois fragmentos invalidos.
        private static string SanitizeStatsText(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return "";
            }

            return raw.Replace("\r", " ").Replace("\n", " ").Trim();
        }

        // ========================================================
        //  O EXPLOSIVO  (explosive.seq)
        //
        //  Documento: Docs/Ranking/19-PESQUISA-RANKING.md, 5.
        //
        //  #### A TABELA DE CUSTO NAO PODE SER NOSSA ####
        //
        //  A Facepunch mexe em custo de blueprint entre updates, e
        //  as calculadoras publicas ja divergem entre si HOJE (300
        //  x 480 de enxofre para o mesmo satchel). Uma constante
        //  nossa nasceria errada e envelheceria calada - e um
        //  servidor que mexeu no proprio custo ficaria com o numero
        //  de outro servidor.
        //
        //  Por isso o SEQ e DERIVADO do blueprint daquele servidor:
        //
        //      seq(item) = soma sobre os ingredientes:
        //          ingrediente e enxofre       -> quantidade
        //          ingrediente tem blueprint   -> seq(dele) * qtd
        //          caso contrario              -> 0
        //        dividido por amountToCreate
        //
        //  Assim `gunpowder` resolve para enxofre + carvao, o C4
        //  herda o custo real, e a municao explosiva entra sozinha:
        //  a lista do que "e explosivo" e "tem enxofre na arvore", e
        //  nao um `switch` que esquece o item novo do proximo
        //  update.
        //
        //  GetIngredients() (e nao o campo `ingredients`) porque ele
        //  aplica o override do modo de jogo ATIVO - que e o que faz
        //  dele o custo DAQUELE servidor.
        //
        //  #### E A CADEIA CONTA DUAS VEZES, DE PROPOSITO ####
        //
        //  Quem crafta 1 000 de polvora e depois 10 C4 com ela soma
        //  os dois: a polvora pelo enxofre dela, e o C4 pelo enxofre
        //  que a polvora custou. Isso NAO e defeito - e o que a
        //  formula do 5.3 diz, e e o comportamento desejavel: quem
        //  fez a cadeia inteira trabalhou mais na bancada do que
        //  quem comprou a polvora pronta. O ranking mede producao,
        //  e producao tem etapas.
        //
        //  #### AS ARMADILHAS DO 5.4 ####
        //
        //  1. Item de loja, kit, VIP, `give` do painel ou drop de
        //     heli NAO conta. Este hook so dispara no que passou
        //     pela BANCADA - contamos craft, e nao posse.
        //  2. Craft cancelado devolve os ingredientes, e por isso
        //     nao usamos OnItemCraft (que dispara no INICIO): o
        //     `Finished` so existe para o que terminou. O
        //     `task.cancelled` fecha a fresta que sobra.
        // ========================================================

        /// <summary>O shortname do insumo comum. E a folha da recursao.</summary>
        private const string SulfurShortname = "sulfur";

        /// <summary>
        /// Ate onde a recursao desce.
        ///
        /// Um blueprint que se referencie (direta ou
        /// indiretamente) faria a pilha estourar DENTRO de um hook,
        /// e uma StackOverflowException nao e capturavel: ela mata o
        /// servidor. O conjunto `visiting` ja fecha o ciclo; a
        /// profundidade e o cinto de seguranca.
        /// </summary>
        private const int MaxSeqDepth = 12;

        /// <summary>
        /// itemid -> SEQ por UNIDADE do item.
        ///
        /// `double` porque a divisao por `amountToCreate` quase
        /// nunca e inteira: arredondar por unidade faria 100 balas
        /// explosivas errarem por dezenas.
        /// </summary>
        private Dictionary<int, double> _seqCache = new Dictionary<int, double>();

        private bool _seqReady;

        /// <summary>
        /// O craft que terminou.
        ///
        /// Assinatura MEDIDA com Mono.Cecil sobre o
        /// Assembly-CSharp.dll deste servidor:
        /// ItemCrafter::FinishCrafting chama
        /// CallHook("OnItemCraftFinished", task, item, this) - tres
        /// argumentos - e faz `pop` no retorno, entao aqui nada e
        /// cancelavel. `void` mesmo assim, pela regra da secao.
        /// </summary>
        private void OnItemCraftFinished(ItemCraftTask task, Item item, ItemCrafter crafter)
        {
            long started = StatsHookStart();

            try
            {
                ApplyCraft(task, item, crafter);
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookCraftFinished, ex);
            }
            finally
            {
                StatsHookStop(HookCraftFinished, started);
            }
        }

        private void ApplyCraft(ItemCraftTask task, Item item, ItemCrafter crafter)
        {
            // As missoes contam o item fabricado, no mesmo hook. Um
            // lote de 500 balas conta 500 - e o painel diz "500
            // balas", nao "1 craft".
            if (crafter != null && item != null && item.info != null && item.amount > 0)
            {
                QuestOnCraft(crafter.owner, item.info.shortname, item.amount);
            }

            if (task == null || item == null || item.info == null || item.amount <= 0)
            {
                return;
            }

            // Armadilha 2 do 5.4: cancelado devolve os
            // ingredientes, e o que voltou para a caixa nao foi
            // produzido.
            if (task.cancelled)
            {
                return;
            }

            BasePlayer player = crafter == null ? null : crafter.owner;

            if (player == null)
            {
                player = item.GetOwnerPlayer();
            }

            if (player == null || player.IsNpc)
            {
                return;
            }

            double perUnit = SeqPerUnit(item.info);

            if (perUnit <= 0d)
            {
                return;
            }

            long seq = (long)Math.Round(perUnit * item.amount);

            if (seq <= 0L)
            {
                return;
            }

            BumpPlayerMetric(player, MetricExplosiveSeq, seq);
        }

        // O SEQ de uma unidade, memoizado.
        //
        // O cache e montado no OnServerInitialized justamente para
        // esta chamada ser um TryGetValue dentro do hook. O caminho
        // preguicoso continua aqui como rede: se o boot falhou, o
        // primeiro craft paga a conta uma vez e os seguintes nao.
        private double SeqPerUnit(ItemDefinition definition)
        {
            if (definition == null)
            {
                return 0d;
            }

            double cached;

            if (_seqCache.TryGetValue(definition.itemid, out cached))
            {
                return cached;
            }

            double computed = ComputeSeqPerUnit(definition, new HashSet<int>(), 0);

            _seqCache[definition.itemid] = computed;

            return computed;
        }

        private double ComputeSeqPerUnit(ItemDefinition definition, HashSet<int> visiting, int depth)
        {
            if (definition == null || depth > MaxSeqDepth)
            {
                return 0d;
            }

            if (string.Equals(definition.shortname, SulfurShortname, StringComparison.Ordinal))
            {
                // A folha: uma unidade de enxofre vale um SEQ. E
                // daqui que todo o resto tira o numero.
                return 1d;
            }

            ItemBlueprint blueprint = definition.Blueprint;

            if (blueprint == null)
            {
                return 0d;
            }

            if (!visiting.Add(definition.itemid))
            {
                // Ciclo. Devolver 0 aqui perde um pouco do custo
                // daquele ramo; nao devolver nada mataria o servidor.
                return 0d;
            }

            double total = 0d;

            try
            {
                List<ItemAmount> ingredients = blueprint.GetIngredients();

                if (ingredients != null)
                {
                    for (int i = 0; i < ingredients.Count; i++)
                    {
                        ItemAmount ingredient = ingredients[i];

                        if (ingredient == null || ingredient.itemDef == null ||
                            ingredient.amount <= 0f)
                        {
                            continue;
                        }

                        double unit = ComputeSeqPerUnit(ingredient.itemDef, visiting, depth + 1);

                        if (unit > 0d)
                        {
                            total += unit * ingredient.amount;
                        }
                    }
                }
            }
            finally
            {
                visiting.Remove(definition.itemid);
            }

            int created = blueprint.amountToCreate > 0 ? blueprint.amountToCreate : 1;

            return total / created;
        }

        /// <summary>
        /// Monta o cache de SEQ do servidor inteiro.
        ///
        /// Uma vez por carga do plugin, e FORA do hook: a regra da
        /// secao e que hook so soma em memoria, e uma recursao de
        /// blueprint dentro do primeiro craft do wipe seria o
        /// contrario disso.
        ///
        /// Falhar aqui nao e fatal - o caminho preguicoso do
        /// SeqPerUnit continua valendo, so que mais caro na
        /// primeira vez de cada item.
        /// </summary>
        private void BuildSeqCache()
        {
            if (_seqReady)
            {
                return;
            }

            if (ItemManager.itemList == null)
            {
                // O jogo ainda nao montou a lista. NAO marcamos
                // pronto: o SeqPerUnit preguicoso cobre o intervalo,
                // e a proxima carga do plugin tenta de novo.
                return;
            }

            _seqReady = true;

            int explosives = 0;

            foreach (ItemDefinition definition in ItemManager.itemList)
            {
                if (definition == null)
                {
                    continue;
                }

                if (SeqPerUnit(definition) > 0d)
                {
                    explosives++;
                }
            }

            string line = "SEQ do explosivo derivado do blueprint deste servidor: " +
                          explosives.ToString(CultureInfo.InvariantCulture) +
                          " item(ns) com enxofre na arvore, de " +
                          _seqCache.Count.ToString(CultureInfo.InvariantCulture) + " conferidos.";

            // Adiado pela mesma razao do push do recorde: o
            // OnServerInitialized tambem e disparado por um
            // `oxide.reload`, que E um comando de console - e um
            // Puts sincrono ali sai com o Identifier daquele comando.
            // Ver OrigemZPlayer.cs:463-484.
            timer.Once(0f, delegate { Puts(line); });
        }

        // ========================================================
        //  O CUSTO DOS HOOKS
        //
        //  #### POR QUE MEDIR, SE A PESQUISA JA ESTIMOU ####
        //
        //  O 19-PESQUISA 8.1 ESTIMOU ~33 eventos/s de mineracao com
        //  100 jogadores. Estimativa nao e medicao, e o custo do
        //  hook em producao nunca foi medido neste projeto - entao
        //  este contador existe para que a resposta venha do
        //  servidor, e nao de uma conta de guardanapo.
        //
        //  #### O INSTRUMENTO CUSTA, E O NUMERO INCLUI ELE ####
        //
        //  Sao duas chamadas a Stopwatch.GetTimestamp() e um
        //  TryGetValue por disparo. O que o `diag` mostra e o custo
        //  do hook JA COM o instrumento dentro - que e o numero
        //  honesto para decidir se a coleta cabe, e o unico que da
        //  para medir sem um segundo instrumento medindo o primeiro.
        //
        //  #### O QUE A MEDICAO DEU, EM 06/09/2026 ####
        //
        //  Medido FORA do jogo, com o corpo destes hooks reproduzido
        //  linha por linha (mesmos dicionarios, mesma ordem), 5 mi
        //  de iteracoes por caminho, tres rodadas:
        //
        //      corpo do OnDispenserGather, sozinho      ~71 ns
        //      o instrumento, sozinho                   ~45 ns
        //      OnDispenserGather, como ficou           ~110 ns
        //      OnPlayerDeath, linha 8 (o mais longo)   ~119 ns
        //      OnItemCraftFinished                      ~96 ns
        //      golpe em madeira (sai no 1o mapa)        ~52 ns
        //
        //  Com os ~33 eventos/s que a pesquisa estimou para 100
        //  jogadores minerando, 110 ns/evento dao 3,6 US POR
        //  SEGUNDO - 0,0004% de um nucleo. Para a coleta custar 1%
        //  de um nucleo seriam precisos ~92 000 eventos/s.
        //
        //  #### E O QUE SURPREENDEU FOI O INSTRUMENTO ####
        //
        //  Ele e 63% do trabalho que mede. O hook em si e barato;
        //  o relogio e que nao e. Mesmo assim ele FICA LIGADO: 45 ns
        //  x 33/s = 1,5 us por segundo, e o preco de nao ter o
        //  numero e voltar a discutir isso por estimativa.
        //
        //  Duas ressalvas, ditas antes que alguem cite o numero:
        //  a medicao rodou sob .NET 9, e o servidor roda Mono, que
        //  e mais lento neste tipo de codigo; e ela nao inclui o
        //  dispatch do Oxide, que existe com ou sem esta secao. O
        //  numero de producao sai do `origemz.stats.diag`.
        //
        //  Ticks do Stopwatch, e nao DateTime: no Windows o
        //  DateTime.UtcNow tem resolucao de ~15 ms, e um hook de
        //  microssegundos apareceria como zero para sempre.
        // ========================================================

        private const string HookDispenserGather = "OnDispenserGather";
        private const string HookDispenserBonus = "OnDispenserBonus";
        private const string HookCollectiblePickup = "OnCollectiblePickup";
        private const string HookPlayerDeath = "OnPlayerDeath";
        private const string HookCraftFinished = "OnItemCraftFinished";

        private readonly Dictionary<string, StatsHookCost> _statsHookCost =
            new Dictionary<string, StatsHookCost>(StringComparer.Ordinal);

        private static long StatsHookStart()
        {
            return System.Diagnostics.Stopwatch.GetTimestamp();
        }

        // Nao lanca, e por isso pode viver num `finally`: uma
        // excecao aqui trocaria um numero de diagnostico por uma
        // morte nao contabilizada.
        private void StatsHookStop(string hook, long started)
        {
            try
            {
                long elapsed = System.Diagnostics.Stopwatch.GetTimestamp() - started;

                if (elapsed < 0L)
                {
                    elapsed = 0L;
                }

                StatsHookCost cost;

                if (!_statsHookCost.TryGetValue(hook, out cost))
                {
                    cost = new StatsHookCost();
                    _statsHookCost[hook] = cost;
                }

                cost.Calls++;
                cost.Ticks += elapsed;

                if (elapsed > cost.MaxTicks)
                {
                    cost.MaxTicks = elapsed;
                }
            }
            catch (Exception)
            {
                // Diagnostico nao derruba coleta.
            }
        }

        private List<StatsHookCostInfo> StatsHookCostReport()
        {
            List<StatsHookCostInfo> report = new List<StatsHookCostInfo>();

            // Ticks -> microssegundos. Stopwatch.Frequency e ticks
            // por segundo, e ele NAO e 10 000 000 em toda maquina.
            double perTick = System.Diagnostics.Stopwatch.Frequency > 0L
                ? 1000000d / System.Diagnostics.Stopwatch.Frequency
                : 0d;

            foreach (KeyValuePair<string, StatsHookCost> entry in _statsHookCost)
            {
                StatsHookCost cost = entry.Value;

                if (cost == null || cost.Calls <= 0L)
                {
                    continue;
                }

                report.Add(new StatsHookCostInfo
                {
                    Hook = entry.Key,
                    Calls = cost.Calls,
                    TotalUs = Math.Round(cost.Ticks * perTick, 1),
                    AvgUs = Math.Round(cost.Ticks * perTick / cost.Calls, 3),
                    MaxUs = Math.Round(cost.MaxTicks * perTick, 1)
                });
            }

            report.Sort(delegate(StatsHookCostInfo a, StatsHookCostInfo b)
            {
                return string.CompareOrdinal(a.Hook, b.Hook);
            });

            return report;
        }

        // ========================================================
        //  O SEGREDO DO CANAL `#OZSTAT#`
        //
        //  #### ELE E A DEFESA, E NAO ZELO ####
        //
        //  MEDIDO neste projeto: o onConsoleLine do agente recebe
        //  TODA linha do console, e o chat esta entre elas. Sem
        //  segredo, um jogador que digitasse
        //
        //      #OZSTAT#{"contract":1,"kind":"record",...}
        //
        //  no chat estaria mandando um recorde direto ao agente -
        //  num ranking cujo primeiro lugar ganha premio real. O
        //  desenho e o mesmo do OrigemZItems.cs (_statSecret) e do
        //  OrigemZUI.cs (_storeSecret).
        //
        //  #### E ELE CHEGA NO PROPRIO `flush` ####
        //
        //  Nao por um comando novo: o flush ja sai a cada 60 s e e o
        //  UNICO comando desta secao que o agente manda sozinho.
        //  Poe-lo num comando proprio dobraria o trafego de RCON por
        //  rodada para carregar oito bytes.
        //
        //  Vazio = nunca recebemos segredo (o agente esta fora, ou o
        //  plugin acabou de recarregar). Neste estado NAO SE EMITE -
        //  e nada se perde: o recorde continua no buffer e sai no
        //  lote seguinte, que e o caminho garantido. Emitir sem
        //  segredo seria emitir para o agente descartar.
        // ========================================================

        private const string EventMarker = "#OZSTAT#";

        private const int StatEventContract = 1;

        private string _statSecret = "";

        // Cresce a cada push. Junto com o steamId e o epoch, e o
        // eventId - a chave de idempotencia do agente entre o push
        // e o lote.
        private int _statPushSeq;

        /// <summary>
        /// Guarda o recorde no buffer, e empurra o `agora` se ele
        /// bateu o melhor da sessao daquele jogador.
        ///
        /// #### POR QUE OS DOIS CAMINHOS ####
        ///
        /// O lote roda a cada 60 s e da o GARANTIDO. Um jogador que
        /// acabou de bater o recorde do servidor quer ver o numero
        /// mudar AGORA - esperar um minuto faz o ranking parecer
        /// quebrado. Os dois carregam o mesmo fato, e o agente grava
        /// uma linha so: quem desempata la e a comparacao com o
        /// melhor do periodo.
        ///
        /// #### E O MELHOR E POR (METRICA, STATUS) ####
        ///
        /// Um tiro suspeito de 900 m e um legitimo de 400 m sao dois
        /// fatos diferentes, e guardar so o maior esconderia o
        /// recorde de verdade atras da suspeita.
        /// </summary>
        private void KeepRecord(BasePlayer player, string metric, double value, string status,
                                Dictionary<string, object> detail)
        {
            string steamId = player.UserIDString;

            if (!IsSteamId64(steamId))
            {
                return;
            }

            EnsureStatsReady();

            StatsPlayerCounters counters = OpenCountersOf(steamId, player.displayName);

            if (counters == null)
            {
                return;
            }

            if (counters.Records == null)
            {
                counters.Records = new Dictionary<string, StatsRecordInfo>(StringComparer.Ordinal);
            }

            string key = metric + "|" + status;
            StatsRecordInfo current;

            if (counters.Records.TryGetValue(key, out current) && current != null &&
                current.Value >= value)
            {
                return;
            }

            StatsRecordInfo record = new StatsRecordInfo
            {
                SteamId = steamId,
                Name = SanitizeStatsText(player.displayName),
                Metric = metric,
                Value = value,
                At = (long)DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                Status = status,
                Detail = detail
            };

            counters.Records[key] = record;
            _statsDirty = true;

            PushRecord(record);
        }

        // O `agora`: uma linha marcada no console.
        private void PushRecord(StatsRecordInfo record)
        {
            if (_statSecret.Length == 0)
            {
                // Ver o cabecalho: sem segredo a linha seria
                // descartada do outro lado. O recorde ja esta no
                // buffer e sai no lote.
                return;
            }

            _statPushSeq++;

            StatRecordPush push = new StatRecordPush
            {
                EventId = record.SteamId + "-" + record.At.ToString(CultureInfo.InvariantCulture) +
                          "-" + _statPushSeq.ToString(CultureInfo.InvariantCulture),
                SteamId = record.SteamId,
                Name = record.Name,
                Metric = record.Metric,
                Value = record.Value,
                Status = record.Status,
                At = record.At,
                Detail = record.Detail,
                Secret = _statSecret
            };

            string line = EventMarker + JsonConvert.SerializeObject(push);

            // ####  O ADIAMENTO NAO E ESTILO  ####
            //
            // E a correcao de um bug JA MEDIDO neste projeto, em
            // OrigemZPlayer.cs:463-484: um Puts disparado de dentro
            // de um hook que veio de um COMANDO sai com o mesmo
            // Identifier e vira A RESPOSTA daquele comando.
            //
            // E o caminho existe aqui: `origemz.player.kill` chama
            // player.Die(), que dispara OnPlayerDeath. Sem o timer,
            // o kill morreria com PLUGIN_INVALID_RESPONSE *e* o
            // recorde nunca chegaria - os dois de uma vez.
            timer.Once(0f, delegate { Puts(line); });
        }

        // Soma na conta de um jogador que ja e BasePlayer.
        private void BumpPlayerMetric(BasePlayer player, string metric, long amount)
        {
            if (player == null)
            {
                return;
            }

            BumpMetricById(player.UserIDString, player.displayName, metric, amount);
        }

        // Soma na conta de um steamId - que pode ser de quem esta
        // OFFLINE (o dono da turret).
        private void BumpMetricById(string steamId, string name, string metric, long amount)
        {
            if (amount <= 0L || !IsSteamId64(steamId))
            {
                return;
            }

            EnsureStatsReady();

            StatsPlayerCounters counters = OpenCountersOf(steamId, name);

            if (counters == null)
            {
                return;
            }

            BumpMetric(counters, metric, amount);

            _statsDirty = true;
        }

        // ========================================================
        //  origemz.stats.flush [offset] [limit]
        //
        //  Resposta de sucesso (uma linha so, quebrada aqui para
        //  caber no comentario):
        //
        //  {"ok":true,"contract":1,"batchId":"pvp1-1757088123-41",
        //   "seq":41,"count":312,"offset":0,"limit":100,
        //   "players":[{"steamId":"7656...","name":"Fulano",
        //               "metrics":{"ore.sulfur":1200}}],
        //   "records":[],"events":[]}
        //
        //  #### O QUE "COUNT" CONTA ####
        //
        //  O lote tem TRES listas - jogadores, recordes e eventos -,
        //  e `count` e o tamanho da MAIOR delas. A janela
        //  [offset, offset+limit) e aplicada a cada uma
        //  separadamente, entao cada linha das tres atravessa
        //  exatamente uma vez.
        //
        //  A alternativa - mandar recordes e eventos so na primeira
        //  pagina - poe um teto invisivel neles: um dia de trofeus
        //  num servidor cheio estouraria a pagina 0 e o ciclo
        //  inteiro seria abandonado, sem ninguem entender por que.
        //
        //  #### PAGINA MENOR QUE O LIMIT NAO E FIM DE LISTA ####
        //
        //  Quem avanca a paginacao e o LIMIT QUE VOLTOU, e o fim e
        //  `offset >= count`. Mesma regra do origemz.bp.export.
        // ========================================================
        [ConsoleCommand(StatsFlushCommand)]
        private void CommandStatsFlush(ConsoleSystem.Arg arg)
        {
            // Excecao que sobe de um ConsoleCommand vindo do RCON
            // nao produz resposta nenhuma, e o agente fica pendurado
            // ate o timeout. Todo caminho de saida responde.
            try
            {
                arg.ReplyWith(HandleStatsFlush(arg));
            }
            catch (Exception ex)
            {
                PrintError(StatsFlushCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleStatsFlush(ConsoleSystem.Arg arg)
        {
            int offset;
            if (!TryReadInt(arg, 0, 0, out offset) || offset < 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            int limit;
            if (!TryReadInt(arg, 1, DefaultStatsLimit, out limit) || limit < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            if (limit > MaxStatsLimit)
            {
                limit = MaxStatsLimit;
            }

            // ####  O TERCEIRO ARGUMENTO E O SEGREDO DO `#OZSTAT#`  ####
            //
            // Ele e OPCIONAL de proposito: este mesmo comando e
            // digitado a mao no console do servidor quando alguem
            // quer ver o lote, e uma chamada sem segredo nao pode
            // APAGAR o que o agente ja empurrou - o push pararia e
            // ninguem entenderia por que.
            //
            // Vazio nao mexe; diferente troca. Ver o cabecalho do
            // _statSecret.
            if (arg.Args != null && arg.Args.Length > 2)
            {
                string secret = arg.GetString(2, "").Trim();

                if (secret.Length > 0)
                {
                    _statSecret = secret;
                }
            }

            EnsureStatsReady();

            if (offset == 0 && _statsPending == null)
            {
                // #### AQUI O LOTE CONGELA ####
                //
                // E ele vai para o disco na mesma hora: entre este
                // instante e o `ack` o buffer aberto ja foi trocado,
                // entao um oxide.reload sem este snapshot perderia o
                // lote inteiro.
                _statsPending = FreezeStatsBuffer();
                _statsDirty = true;
                SaveStatsSnapshot(true);
            }

            StatsBatch batch = _statsPending;

            if (batch == null)
            {
                // offset > 0 sem lote pendente: o plugin recarregou
                // entre duas paginas, ou o agente ja confirmou. Nao
                // ha meia pagina que sirva - quem recebe isto larga
                // o ciclo e recomeca do offset 0 na volta seguinte.
                return BuildError(ErrorNoBatch);
            }

            int count = StatsBatchRows(batch);

            // long para nao estourar: offset int.MaxValue com limit
            // 250 dobraria para negativo em int, e a janela passaria
            // a nunca casar por acidente em vez de por regra.
            long end = (long)offset + limit;

            string json = JsonConvert.SerializeObject(new StatsFlushOkResponse
            {
                BatchId = batch.BatchId,
                Seq = batch.Seq,
                Count = count,
                Offset = offset,
                Limit = limit,
                Players = SliceStatsList(batch.Players, offset, end),
                Records = SliceStatsList(batch.Records, offset, end),
                Events = SliceStatsList(batch.Events, offset, end)
            });

            // #### RECUSA INTEIRA, NUNCA CORTE ####
            //
            // Cortar a pagina devolveria um lote pela metade que o
            // agente aceitaria como completo, e o resto do minerio
            // seria descartado no `ack` sem nada no log. O agente
            // reduz o limit pela metade e pede DE NOVO, sem avancar
            // o offset.
            if (Encoding.UTF8.GetByteCount(json) > MaxStatsFlushBytes)
            {
                PrintWarning(StatsFlushCommand + ": a pagina de offset " + offset + " com limit " +
                             limit + " passou de " + MaxStatsFlushBytes + " bytes e foi recusada " +
                             "inteira. O agente reduz o limit e pede de novo.");

                return BuildError(ErrorPayloadTooLarge);
            }

            return json;
        }

        // ========================================================
        //  origemz.stats.ack <batchId>
        //
        //  {"ok":true,"contract":1,"batchId":"...","seq":41,"players":312}
        //
        //  #### E O UNICO CAMINHO QUE DESCARTA UM LOTE ####
        //
        //  O agente so confirma DEPOIS do COMMIT. Confirmar antes
        //  trocaria uma duplicata inofensiva (o lote entra duas
        //  vezes e o batchId o recusa) por uma perda silenciosa.
        //
        //  batchId que nao casa com o pendente devolve NO_BATCH, e
        //  isso NAO e erro: e a confirmacao repetida de um lote que
        //  ja saiu.
        // ========================================================
        [ConsoleCommand(StatsAckCommand)]
        private void CommandStatsAck(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleStatsAck(arg));
            }
            catch (Exception ex)
            {
                PrintError(StatsAckCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleStatsAck(ConsoleSystem.Arg arg)
        {
            if (arg.Args == null || arg.Args.Length < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            string batchId = arg.GetString(0, "").Trim();

            if (batchId.Length == 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            EnsureStatsReady();

            if (_statsPending == null ||
                !string.Equals(_statsPending.BatchId, batchId, StringComparison.Ordinal))
            {
                return BuildError(ErrorNoBatch);
            }

            StatsBatch done = _statsPending;

            _statsPending = null;
            _statsDirty = true;
            SaveStatsSnapshot(true);

            return JsonConvert.SerializeObject(new StatsAckOkResponse
            {
                BatchId = done.BatchId,
                Seq = done.Seq,
                Players = done.Players == null ? 0 : done.Players.Count
            });
        }

        // ========================================================
        //  origemz.stats.diag
        //
        //  {"ok":true,"contract":1,"open":12,"pending":-1,"seq":41,
        //   "hasSecret":true,"hookErrors":0,"seqItems":37,
        //   "hooks":[{"hook":"OnDispenserGather","calls":18422,
        //             "totalUs":91230.4,"avgUs":4.952,"maxUs":812.3}]}
        //
        //  #### PARA QUE ELE EXISTE ####
        //
        //  Para responder, COM NUMERO, se a coleta cabe no
        //  orcamento do servidor. O 19-PESQUISA 8.1 estimou ~33
        //  eventos/s de mineracao com 100 jogadores; o que ninguem
        //  tinha era o custo de CADA evento. `avgUs` x `calls` e a
        //  resposta, e ela vem do servidor em que a duvida existe.
        //
        //  Ele NAO mexe em nada: nao congela lote, nao zera
        //  contador, nao consome o pendente. Da para chamar no meio
        //  de um ciclo sem estragar o ciclo.
        //
        //  E ele fica FORA do flush de proposito: o flush ja carrega
        //  o lote, e enfiar diagnostico ali gastaria bytes do teto
        //  de 60 KB em toda rodada para uma informacao que se olha
        //  uma vez por dia.
        // ========================================================
        [ConsoleCommand(StatsDiagCommand)]
        private void CommandStatsDiag(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleStatsDiag());
            }
            catch (Exception ex)
            {
                PrintError(StatsDiagCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleStatsDiag()
        {
            EnsureStatsReady();

            int seqItems = 0;

            foreach (KeyValuePair<int, double> entry in _seqCache)
            {
                if (entry.Value > 0d)
                {
                    seqItems++;
                }
            }

            return JsonConvert.SerializeObject(new StatsDiagOkResponse
            {
                Open = _statsOpen == null ? 0 : _statsOpen.Count,
                // -1, e nao 0: "nao ha lote pendente" e "ha um lote
                // pendente vazio" sao estados diferentes, e o
                // segundo quer dizer que o agente pediu e ainda nao
                // confirmou.
                Pending = _statsPending == null ? -1 : StatsBatchRows(_statsPending),
                Seq = _statsSeq,
                HasSecret = _statSecret.Length > 0,
                HookErrors = _statsHookErrors,
                SeqItems = seqItems,
                Hooks = StatsHookCostReport()
            });
        }

        // --------------------------------------------------------
        //  O LOTE
        // --------------------------------------------------------

        // Fecha o buffer atual e abre um novo.
        //
        // O lote sai MATERIALIZADO numa lista: paginar sobre uma
        // lista e estavel por construcao, enquanto paginar sobre o
        // dicionario vivo dependeria de ele nao mudar entre duas
        // chamadas de RCON - que e exatamente o que nao se pode
        // prometer.
        //
        // Um buffer vazio TAMBEM vira lote. Uniformidade aqui vale
        // mais que a economia: o agente ve `count: 0`, nao grava
        // nada e confirma, e o plugin tem um caminho so.
        private StatsBatch FreezeStatsBuffer()
        {
            _statsSeq++;

            List<StatsPlayerInfo> players = new List<StatsPlayerInfo>();
            List<StatsRecordInfo> records = new List<StatsRecordInfo>();

            foreach (KeyValuePair<string, StatsPlayerCounters> entry in _statsOpen)
            {
                StatsPlayerCounters counters = entry.Value;

                if (counters == null)
                {
                    continue;
                }

                if (counters.Metrics != null && counters.Metrics.Count > 0)
                {
                    players.Add(new StatsPlayerInfo
                    {
                        SteamId = entry.Key,
                        Name = counters.Name,
                        Metrics = counters.Metrics
                    });
                }

                // O recorde e uma LISTA propria no lote, e nao uma
                // metrica do jogador: player_records guarda o fato
                // com testemunho, e player_stats guarda contador.
                // Um jogador pode ter recorde sem ter contador
                // nenhum naquele minuto - e o contrario tambem.
                if (counters.Records != null)
                {
                    foreach (KeyValuePair<string, StatsRecordInfo> best in counters.Records)
                    {
                        if (best.Value != null)
                        {
                            records.Add(best.Value);
                        }
                    }
                }
            }

            // Ordem determinista, para o log de duas paginas do
            // mesmo lote contar a mesma historia.
            players.Sort(delegate(StatsPlayerInfo a, StatsPlayerInfo b)
            {
                return string.CompareOrdinal(a.SteamId, b.SteamId);
            });

            // A mesma razao, e um segundo criterio: dois recordes do
            // mesmo jogador (o valido e o suspeito) precisam de
            // ordem TOTAL, senao trocam de lugar entre duas paginas
            // do mesmo lote e um deles atravessa duas vezes.
            records.Sort(delegate(StatsRecordInfo a, StatsRecordInfo b)
            {
                int byPlayer = string.CompareOrdinal(a.SteamId, b.SteamId);

                if (byPlayer != 0)
                {
                    return byPlayer;
                }

                int byMetric = string.CompareOrdinal(a.Metric, b.Metric);

                return byMetric != 0 ? byMetric : string.CompareOrdinal(a.Status, b.Status);
            });

            _statsOpen = new Dictionary<string, StatsPlayerCounters>(StringComparer.Ordinal);
            _statsFullWarned = false;

            return new StatsBatch
            {
                BatchId = BuildStatsBatchId(_statsSeq),
                Seq = _statsSeq,
                Players = players,
                Records = records,
                // Os eventos de PONTO sao do OrigemZItems, que tem
                // fila propria em disco e canal proprio
                // (origemz.item.pending). A lista existe aqui porque
                // e CONTRATO: o agente a espera, e acrescentar campo
                // depois obrigaria a mexer nos dois lados.
                Events = new List<StatsEventInfo>()
            };
        }

        // O tamanho da MAIOR das tres listas. Ver o comentario do
        // comando: e por ele que o agente sabe quando parar.
        private static int StatsBatchRows(StatsBatch batch)
        {
            int rows = batch.Players == null ? 0 : batch.Players.Count;

            if (batch.Records != null && batch.Records.Count > rows)
            {
                rows = batch.Records.Count;
            }

            if (batch.Events != null && batch.Events.Count > rows)
            {
                rows = batch.Events.Count;
            }

            return rows;
        }

        private static List<T> SliceStatsList<T>(List<T> source, int offset, long end)
        {
            List<T> page = new List<T>();

            if (source == null)
            {
                return page;
            }

            for (int i = offset; i < source.Count && i < end; i++)
            {
                page.Add(source[i]);
            }

            return page;
        }

        // `identidade-epochSegundos-seq`.
        //
        // #### A CHAVE DE VERDADE E (servidor, batchId) ####
        //
        // Quem garante que o mesmo lote nao entra duas vezes e a
        // tabela `stat_batches` do agente, e o `server_id` dela vem
        // do AGENTE. A identidade aqui e cortesia para quem le o
        // log; o que precisa ser unico e o par
        // (epochSegundos, seq) DESTE servidor - e o `seq` atravessa
        // o oxide.reload no data file justamente por isso.
        private static string BuildStatsBatchId(int seq)
        {
            string identity = SanitizeStatsIdentity(ConVar.Server.identity);
            long epoch = (long)(DateTime.UtcNow - StatsEpoch).TotalSeconds;

            return identity + "-" + epoch.ToString(CultureInfo.InvariantCulture) + "-" +
                   seq.ToString(CultureInfo.InvariantCulture);
        }

        // O batchId viaja numa linha de comando de console: espaco e
        // aspas dentro dele quebrariam o `origemz.stats.ack`.
        private static string SanitizeStatsIdentity(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return "server";
            }

            StringBuilder clean = new StringBuilder();

            for (int i = 0; i < raw.Length && clean.Length < 32; i++)
            {
                char c = raw[i];

                if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                    c == '_')
                {
                    clean.Append(c);
                }
            }

            return clean.Length == 0 ? "server" : clean.ToString();
        }

        // --------------------------------------------------------
        //  O SNAPSHOT NO DATA FILE
        // --------------------------------------------------------

        // O gancho de carga do Oxide.
        //
        // #### ELE EXISTE PARA TIRAR O DISCO DO CAMINHO DO HOOK ####
        //
        // A regra desta secao e que OnDispenserGather so soma em
        // memoria. Sem esta linha, o PRIMEIRO golpe de picareta
        // depois de cada carga do plugin pagaria a leitura do data
        // file dentro do hook - e o hook dispara dezenas de vezes
        // por segundo num servidor cheio.
        //
        // O EnsureStatsReady continua sendo chamado la dentro como
        // rede de seguranca: se este gancho nao rodar, a coleta
        // ainda funciona, so que a primeira soma paga a leitura.
        private void Loaded()
        {
            EnsureStatsReady();
        }

        // Le o buffer de volta e liga o relogio de gravacao.
        //
        // #### POR QUE ELE E IDEMPOTENTE E NAO VIVE NO Init() ####
        //
        // Porque assim esta secao nao depende de nenhuma linha do
        // ciclo de vida que ja existe neste arquivo - e outras
        // frentes estao escrevendo nele. Quem chama primeiro paga a
        // leitura; os outros so olham um booleano.
        private void EnsureStatsReady()
        {
            if (_statsReady)
            {
                return;
            }

            // ANTES de ler: uma falha na leitura nao pode fazer cada
            // golpe de picareta tentar abrir o disco de novo.
            _statsReady = true;

            try
            {
                StatsState state = Interface.Oxide.DataFileSystem.ReadObject<StatsState>(StatsDataFile);

                if (state != null)
                {
                    if (state.Open != null)
                    {
                        _statsOpen = new Dictionary<string, StatsPlayerCounters>(
                            state.Open, StringComparer.Ordinal);
                    }

                    _statsPending = state.Pending;
                    _statsSeq = state.Seq;
                }
            }
            catch (Exception ex)
            {
                PrintError("Nao consegui ler " + StatsDataFile + "; a coleta recomeca do zero: " + ex);
            }

            timer.Every(StatsSnapshotSeconds, delegate { SaveStatsSnapshot(false); });
        }

        private void SaveStatsSnapshot(bool force)
        {
            if (!force && !_statsDirty)
            {
                return;
            }

            try
            {
                Interface.Oxide.DataFileSystem.WriteObject(StatsDataFile, new StatsState
                {
                    Seq = _statsSeq,
                    Open = _statsOpen,
                    Pending = _statsPending
                });

                _statsDirty = false;
            }
            catch (Exception ex)
            {
                PrintError("Nao consegui gravar " + StatsDataFile + ": " + ex);
            }
        }

        // O oxide.reload passa por aqui, e e por isso que ele nao
        // custa nada: o que ainda nao foi confirmado vai para o
        // disco antes de a memoria sumir.
        private void Unload()
        {
            // As missoes gravam SEMPRE, e nao so quando a coleta
            // esta pronta: os dois buffers sao independentes, e um
            // reload no minuto em que a coleta ainda nao subiu nao
            // pode custar o progresso de missao de ninguem.
            QuestSave(true);

            // Os NPCs sao `enableSaving = false`: eles nao vao para o
            // save do mundo, e um oxide.reload sem esta linha
            // deixaria bonecos orfaos no mapa que ninguem consegue
            // remover. O agente os manda de volta na proxima rodada.
            QuestNpcDespawnAll();

            if (!_statsReady)
            {
                return;
            }

            SaveStatsSnapshot(true);
        }

        // --------------------------------------------------------
        //  DTOs da coleta
        // --------------------------------------------------------

        private class StatsFlushOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("contract")]
            public int Contract { get { return StatsContractVersion; } }

            [JsonProperty("batchId")]
            public string BatchId { get; set; }

            [JsonProperty("seq")]
            public int Seq { get; set; }

            // O TOTAL de linhas do lote, e nao o tamanho da pagina.
            [JsonProperty("count")]
            public int Count { get; set; }

            [JsonProperty("offset")]
            public int Offset { get; set; }

            [JsonProperty("limit")]
            public int Limit { get; set; }

            [JsonProperty("players")]
            public List<StatsPlayerInfo> Players { get; set; }

            [JsonProperty("records")]
            public List<StatsRecordInfo> Records { get; set; }

            [JsonProperty("events")]
            public List<StatsEventInfo> Events { get; set; }
        }

        private class StatsAckOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("contract")]
            public int Contract { get { return StatsContractVersion; } }

            [JsonProperty("batchId")]
            public string BatchId { get; set; }

            [JsonProperty("seq")]
            public int Seq { get; set; }

            [JsonProperty("players")]
            public int Players { get; set; }
        }

        private class StatsPlayerInfo
        {
            // String, e nao ulong: 17 digitos nao cabem num number
            // de JavaScript sem perder precisao. Mesma regra do
            // PlayerInfo.SteamId.
            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            // Sempre DELTAS, nunca totais: o agente SOMA o que chega
            // aqui. Mandar total faria cada lote reescrever a
            // temporada inteira.
            [JsonProperty("metrics")]
            public Dictionary<string, long> Metrics { get; set; }
        }

        private class StatsRecordInfo
        {
            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            [JsonProperty("metric")]
            public string Metric { get; set; }

            [JsonProperty("value")]
            public double Value { get; set; }

            [JsonProperty("at")]
            public long At { get; set; }

            /// <summary>
            /// `ok` ou `suspect`.
            ///
            /// Suspeito e GRAVADO do outro lado e nao entra no
            /// podio: apagar seria perder o rastro da fraude, e a
            /// coluna `status` de player_records existe para isso.
            /// </summary>
            [JsonProperty("status")]
            public string Status { get; set; }

            [JsonProperty("detail")]
            public Dictionary<string, object> Detail { get; set; }
        }

        /// <summary>
        /// O recorde no canal do `agora` (`#OZSTAT#`).
        ///
        /// #### POR QUE UMA CLASSE, E NAO O StatsRecordInfo ####
        ///
        /// O push carrega tres campos que o lote nao tem - o
        /// `kind`, o `contract` e o `eventId` -, e um deles o lote
        /// nao PODE ter: o `secret`. Ele viaja na linha do console e
        /// nunca no data file, senao sobreviveria ao restart que
        /// justamente o sorteia de novo. Mesma escolha do
        /// OrigemZItems.cs.
        /// </summary>
        private class StatRecordPush
        {
            [JsonProperty("contract")]
            public int Contract { get { return StatEventContract; } }

            [JsonProperty("kind")]
            public string Kind { get { return "record"; } }

            [JsonProperty("eventId")]
            public string EventId { get; set; }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            [JsonProperty("metric")]
            public string Metric { get; set; }

            [JsonProperty("value")]
            public double Value { get; set; }

            [JsonProperty("status")]
            public string Status { get; set; }

            [JsonProperty("at")]
            public long At { get; set; }

            [JsonProperty("detail")]
            public Dictionary<string, object> Detail { get; set; }

            [JsonProperty("secret")]
            public string Secret { get; set; }
        }

        /// <summary>O custo acumulado de um hook de coleta.</summary>
        private class StatsHookCost
        {
            [JsonProperty("calls")]
            public long Calls { get; set; }

            [JsonProperty("ticks")]
            public long Ticks { get; set; }

            [JsonProperty("maxTicks")]
            public long MaxTicks { get; set; }
        }

        /// <summary>O mesmo custo, ja em microssegundos, para o `diag`.</summary>
        private class StatsHookCostInfo
        {
            [JsonProperty("hook")]
            public string Hook { get; set; }

            [JsonProperty("calls")]
            public long Calls { get; set; }

            [JsonProperty("totalUs")]
            public double TotalUs { get; set; }

            [JsonProperty("avgUs")]
            public double AvgUs { get; set; }

            [JsonProperty("maxUs")]
            public double MaxUs { get; set; }
        }

        private class StatsDiagOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("contract")]
            public int Contract { get { return StatsContractVersion; } }

            /// <summary>Jogadores no buffer ABERTO.</summary>
            [JsonProperty("open")]
            public int Open { get; set; }

            /// <summary>Linhas no lote PENDENTE, ou -1 se nao ha lote.</summary>
            [JsonProperty("pending")]
            public int Pending { get; set; }

            [JsonProperty("seq")]
            public int Seq { get; set; }

            /// <summary>
            /// A resposta de "por que este servidor nao emite
            /// `#OZSTAT#`?" sem precisar mostrar o segredo.
            /// </summary>
            [JsonProperty("hasSecret")]
            public bool HasSecret { get; set; }

            [JsonProperty("hookErrors")]
            public int HookErrors { get; set; }

            /// <summary>Itens com enxofre na arvore do blueprint.</summary>
            [JsonProperty("seqItems")]
            public int SeqItems { get; set; }

            [JsonProperty("hooks")]
            public List<StatsHookCostInfo> Hooks { get; set; }
        }

        private class StatsEventInfo
        {
            [JsonProperty("eventId")]
            public string EventId { get; set; }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            [JsonProperty("metric")]
            public string Metric { get; set; }

            [JsonProperty("amount")]
            public int Amount { get; set; }

            [JsonProperty("source")]
            public string Source { get; set; }

            [JsonProperty("at")]
            public long At { get; set; }
        }

        private class StatsPlayerCounters
        {
            [JsonProperty("name")]
            public string Name { get; set; }

            [JsonProperty("metrics")]
            public Dictionary<string, long> Metrics { get; set; }

            /// <summary>
            /// O melhor recorde daquele jogador, por
            /// `metrica|status`.
            ///
            /// #### POR QUE ELE MORA JUNTO DO CONTADOR ####
            ///
            /// Porque o buffer aberto ja e "o que aquele jogador fez
            /// desde o ultimo lote", e o snapshot em disco ja o
            /// grava inteiro. Uma segunda colecao paralela precisaria
            /// da MESMA poda no congelamento, do MESMO teto de
            /// jogadores e da MESMA gravacao - e a primeira vez que
            /// alguem esquecesse uma das tres, o recorde sumiria sem
            /// nada no log.
            /// </summary>
            [JsonProperty("records")]
            public Dictionary<string, StatsRecordInfo> Records { get; set; }
        }

        private class StatsBatch
        {
            [JsonProperty("batchId")]
            public string BatchId { get; set; }

            [JsonProperty("seq")]
            public int Seq { get; set; }

            [JsonProperty("players")]
            public List<StatsPlayerInfo> Players { get; set; }

            [JsonProperty("records")]
            public List<StatsRecordInfo> Records { get; set; }

            [JsonProperty("events")]
            public List<StatsEventInfo> Events { get; set; }
        }

        // O que vai para oxide/data/OrigemZAgentStats.json.
        private class StatsState
        {
            [JsonProperty("seq")]
            public int Seq { get; set; }

            [JsonProperty("open")]
            public Dictionary<string, StatsPlayerCounters> Open { get; set; }

            [JsonProperty("pending")]
            public StatsBatch Pending { get; set; }
        }

        // ============================================================
        //  AS MISSOES
        //
        //  ####  ESTA REGIAO NAO ABRE HOOK NENHUM DE GRACA  ####
        //
        //  Os hooks de matar, colher e fabricar JA existem neste
        //  plugin, para o ranking. As missoes ENGANCHAM neles: o
        //  ApplyDeath, o AddOre e o OnItemCraftFinished chamam os
        //  QuestOn* daqui, e nenhum quadro a mais e gasto.
        //
        //  A excecao e o LOOT. `OnItemAddedToContainer` dispara para
        //  todo item que entra em qualquer caixa do servidor, o tempo
        //  inteiro, e por isso ele so e REGISTRADO quando o agente
        //  manda um catalogo com alvo de loot dentro. Um servidor sem
        //  missao de loot paga zero.
        //
        //  ####  O PLUGIN CONTA PARA A TELA; O AGENTE CONTA PARA O
        //        PREMIO  ####
        //
        //  Daqui sai o progresso e a PROPOSTA de conclusao. Quem
        //  confere `have >= need` e entrega o premio e o agente, com
        //  o numero dele. Um oxide.reload esvazia este cache sem
        //  derrubar o RCON - e sem essa conferencia a recompensa
        //  sairia de um contador incompleto.
        //
        //  ####  O LOTE CONGELA, E O `ack` E O UNICO QUE DESCARTA  ####
        //
        //  Mesmo desenho do `origemz.stats.flush`: o flush com
        //  offset 0 fecha o buffer como lote pendente e abre um novo;
        //  o ack descarta. Uma queda de RCON no meio do ciclo nao
        //  custa nada.
        //
        //  Contrato: core/src/game/quests-contract.ts.
        //  Documento: Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md, secao 8.
        // ============================================================
        #region Quests

        private const string QuestWatchCommand = "origemz.quest.watch";
        private const string QuestAssignCommand = "origemz.quest.assign";
        private const string QuestForgetCommand = "origemz.quest.forget";
        private const string QuestFlushCommand = "origemz.quest.flush";
        private const string QuestAckCommand = "origemz.quest.ack";
        private const string QuestDiagCommand = "origemz.quest.diag";
        private const string QuestConsumeCommand = "origemz.quest.consume";

        private const string QuestEventMarker = "#OZQUEST#";

        // O nome que o diagnostico de custo usa. Ele entra na
        // MESMA medicao dos hooks do ranking: um so lugar para
        // perguntar quanto os ganchos custam neste servidor.
        private const string HookItemAdded = "OnItemAddedToContainer";
        private const string HookPlayerInput = "OnPlayerInput";
        private const string HookNpcConversation = "OnNpcConversationStart";
        private const string QuestDataFile = "OrigemZAgentQuests";
        private const int QuestContract = 1;

        // Iguais aos do contrato, no agente. A duplicata e de
        // proposito: este comando tambem e digitado a mao no console
        // do servidor, e o plugin nao pode depender de quem o chama.
        private const int DefaultQuestLimit = 100;
        private const int MaxQuestLimit = 250;
        private const int MaxQuestBytes = 60000;

        private const string QuestErrorTooLarge = "PAYLOAD_TOO_LARGE";
        private const string QuestErrorNoBatch = "NO_BATCH";

        // O que observar, por tipo. Vazio = nao observe.
        private Dictionary<string, HashSet<string>> _questWatch =
            new Dictionary<string, HashSet<string>>();

        // A normalizacao das criaturas, que desce do agente. Ver o
        // CREATURE_ALIASES do collector.ts: uma criatura nova do Rust
        // nao pode exigir um release deste plugin.
        private Dictionary<string, string> _questAlias = new Dictionary<string, string>();

        // O segredo que autentica o `#OZQUEST#` de volta. Sem ele, o
        // push nao sai: o agente ignoraria a linha de qualquer jeito.
        private string _questSecret;

        // As tentativas vivas de cada jogador. steamId -> lista.
        private Dictionary<ulong, List<QuestAssignment>> _questAssigned =
            new Dictionary<ulong, List<QuestAssignment>>();

        // O buffer aberto: (pq, seq) -> delta acumulado.
        private Dictionary<string, QuestEntryInfo> _questOpen =
            new Dictionary<string, QuestEntryInfo>();

        private QuestBatch _questPending;
        private int _questSeq;
        private bool _questDirty;
        private bool _questLootHooked;

        // O que ja foi proposto ao agente, para nao gritar duas vezes
        // a mesma conclusao a cada golpe de picareta depois de ela
        // fechar.
        private HashSet<long> _questAnnounced = new HashSet<long>();

        // ------------------------------------------------------
        //  O CATALOGO
        // ------------------------------------------------------

        [ConsoleCommand(QuestWatchCommand)]
        private void CommandQuestWatch(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleQuestWatch(arg));
            }
            catch (Exception ex)
            {
                PrintError(QuestWatchCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleQuestWatch(ConsoleSystem.Arg arg)
        {
            if (!arg.HasArgs(1))
            {
                return BuildError(ErrorInvalidArgs);
            }

            JObject payload = QuestDecode(arg.GetString(0));

            if (payload == null)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // ####  ELE SUBSTITUI O ANTERIOR, INTEIRO  ####
            //
            // Um alvo que sumiu do catalogo para de ser contado. Sem
            // isso, o plugin guardaria para sempre o que ja nao
            // existe - o mesmo motivo do `origemz.item.clear`.
            Dictionary<string, HashSet<string>> watch =
                new Dictionary<string, HashSet<string>>();

            JObject raw = payload["watch"] as JObject;

            if (raw != null)
            {
                foreach (KeyValuePair<string, JToken> entry in raw)
                {
                    JArray list = entry.Value as JArray;

                    if (list == null)
                    {
                        continue;
                    }

                    HashSet<string> targets = new HashSet<string>();

                    for (int i = 0; i < list.Count; i++)
                    {
                        string target = (string)list[i];

                        if (!string.IsNullOrEmpty(target))
                        {
                            targets.Add(target);
                        }
                    }

                    if (targets.Count > 0)
                    {
                        watch[entry.Key] = targets;
                    }
                }
            }

            Dictionary<string, string> alias = new Dictionary<string, string>();
            JObject aliasRaw = payload["alias"] as JObject;

            if (aliasRaw != null)
            {
                foreach (KeyValuePair<string, JToken> entry in aliasRaw)
                {
                    alias[entry.Key] = (string)entry.Value;
                }
            }

            _questWatch = watch;
            _questAlias = alias;
            _questSecret = (string)payload["secret"];

            QuestSyncLootHook();

            int total = 0;

            foreach (KeyValuePair<string, HashSet<string>> entry in watch)
            {
                total += entry.Value.Count;
            }

            // Isto PRECISA aparecer no log: a resposta abaixo vai pelo
            // RCON e nao fica no log do Oxide. Sem esta linha, "a
            // missao nao progride" nao teria como ser diagnosticado.
            Puts("Missoes: catalogo com " + total + " alvo(s); loot " +
                (_questLootHooked ? "LIGADO" : "desligado"));

            return "{\"ok\":true,\"contract\":" + QuestContract + ",\"targets\":" + total + "}";
        }

        // ####  O HOOK MAIS QUENTE DO JOGO SO ENTRA SE PRECISAR  ####
        //
        // `OnItemAddedToContainer` dispara para todo item que entra em
        // qualquer caixa do servidor. Registra-lo sem missao de loot
        // seria cobrar de todo servidor por um recurso que so alguns
        // usam.
        private void QuestSyncLootHook()
        {
            bool wanted = _questWatch.ContainsKey("loot");

            if (wanted == _questLootHooked)
            {
                return;
            }

            if (wanted)
            {
                Subscribe("OnItemAddedToContainer");
            }
            else
            {
                Unsubscribe("OnItemAddedToContainer");
            }

            _questLootHooked = wanted;
        }

        // ------------------------------------------------------
        //  QUEM PERSEGUE O QUE
        // ------------------------------------------------------

        [ConsoleCommand(QuestAssignCommand)]
        private void CommandQuestAssign(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleQuestAssign(arg));
            }
            catch (Exception ex)
            {
                PrintError(QuestAssignCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleQuestAssign(ConsoleSystem.Arg arg)
        {
            if (!arg.HasArgs(2))
            {
                return BuildError(ErrorInvalidArgs);
            }

            ulong steamId;

            if (!ulong.TryParse(arg.GetString(0), out steamId))
            {
                return BuildError(ErrorInvalidArgs);
            }

            JObject payload = QuestDecode(arg.GetString(1));

            if (payload == null)
            {
                return BuildError(ErrorInvalidArgs);
            }

            List<QuestAssignment> assignments = new List<QuestAssignment>();
            JArray quests = payload["quests"] as JArray;

            if (quests != null)
            {
                for (int i = 0; i < quests.Count; i++)
                {
                    JObject quest = quests[i] as JObject;

                    if (quest == null)
                    {
                        continue;
                    }

                    JArray objectives = quest["objectives"] as JArray;

                    if (objectives == null)
                    {
                        continue;
                    }

                    for (int j = 0; j < objectives.Count; j++)
                    {
                        JObject objective = objectives[j] as JObject;

                        if (objective == null)
                        {
                            continue;
                        }

                        assignments.Add(new QuestAssignment
                        {
                            PlayerQuestId = (long)quest["pq"],
                            Seq = (int)objective["seq"],
                            Kind = (string)objective["kind"],
                            Target = (string)objective["target"],
                            Need = (int)objective["need"],
                            Have = (int)objective["have"]
                        });
                    }
                }
            }

            if (assignments.Count == 0)
            {
                _questAssigned.Remove(steamId);
            }
            else
            {
                _questAssigned[steamId] = assignments;
            }

            // O anunciado e limpo junto: uma tentativa nova precisa
            // poder anunciar a conclusao dela, mesmo que o id seja
            // reaproveitado depois de um wipe do banco.
            for (int i = 0; i < assignments.Count; i++)
            {
                _questAnnounced.Remove(assignments[i].PlayerQuestId);
            }

            return "{\"ok\":true,\"contract\":" + QuestContract +
                ",\"objectives\":" + assignments.Count + "}";
        }

        [ConsoleCommand(QuestForgetCommand)]
        private void CommandQuestForget(ConsoleSystem.Arg arg)
        {
            try
            {
                ulong steamId;

                if (!arg.HasArgs(1) || !ulong.TryParse(arg.GetString(0), out steamId))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                _questAssigned.Remove(steamId);
                arg.ReplyWith("{\"ok\":true,\"contract\":" + QuestContract + "}");
            }
            catch (Exception ex)
            {
                PrintError(QuestForgetCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // O jogador saiu: o cache dele nao precisa mais existir.
        //
        // Sem isto, um servidor de meses acumularia a atribuicao de
        // todo mundo que ja passou por ele - e o agente reenvia no
        // OnPlayerConnected de qualquer jeito.
        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player != null)
            {
                _questAssigned.Remove(player.userID);
            }
        }

        // ------------------------------------------------------
        //  A CONTAGEM
        // ------------------------------------------------------

        // Os quatro pontos de entrada. Cada um e chamado de DENTRO de
        // um hook que ja existe para o ranking - nenhum quadro a mais
        // e gasto por causa das missoes.
        private void QuestOnKill(BasePlayer killer, string rawTarget)
        {
            QuestCount(killer, "kill", QuestNormalize(rawTarget), 1);
        }

        private void QuestOnGather(BasePlayer player, string shortname, int amount)
        {
            QuestCount(player, "gather", shortname, amount);
        }

        private void QuestOnCraft(BasePlayer player, string shortname, int amount)
        {
            QuestCount(player, "craft", shortname, amount);
        }

        private void QuestOnLoot(BasePlayer player, string shortname, int amount)
        {
            QuestCount(player, "loot", shortname, amount);
        }

        // ####  O HOOK MAIS CARO DO JOGO  ####
        //
        // Ele dispara para TODO item que entra em qualquer container
        // do servidor. Tres contencoes o seguram:
        //
        //   1. ele so e REGISTRADO quando ha alvo de loot no catalogo
        //      (ver QuestSyncLootHook) - num servidor sem missao de
        //      loot este metodo nunca e chamado;
        //   2. a primeira coisa que ele faz e comparar o shortname
        //      contra um HashSet, dentro do QuestCount;
        //   3. so conta o que entra no inventario de um JOGADOR - o
        //      item que vai para uma caixa nao e loot de ninguem.
        //
        // O custo medido sai no `origemz.quest.diag`.
        private void OnItemAddedToContainer(ItemContainer container, Item item)
        {
            long started = StatsHookStart();

            try
            {
                if (container == null || item == null || item.info == null || item.amount <= 0)
                {
                    return;
                }

                BasePlayer owner = container.playerOwner;

                if (owner == null)
                {
                    return;
                }

                QuestOnLoot(owner, item.info.shortname, item.amount);
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookItemAdded, ex);
            }
            finally
            {
                StatsHookStop(HookItemAdded, started);
            }
        }

        // A criatura, com o nome que o admin cadastrou.
        //
        // `scientistnpc_heavy` vira `scientist`. A tabela desce do
        // agente: ver o cabecalho do QuestWatchCommand.
        private string QuestNormalize(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return raw;
            }

            string mapped;

            return _questAlias.TryGetValue(raw, out mapped) ? mapped : raw;
        }

        // O coracao. Ele sai na PRIMEIRA comparacao quando ninguem
        // persegue aquilo - e e por isso que o custo de uma missao
        // cadastrada nao aparece nos hooks das outras.
        private void QuestCount(BasePlayer player, string kind, string target, int amount)
        {
            if (player == null || player.IsNpc || amount <= 0 || string.IsNullOrEmpty(target))
            {
                return;
            }

            HashSet<string> targets;

            if (!_questWatch.TryGetValue(kind, out targets) || !targets.Contains(target))
            {
                return;
            }

            List<QuestAssignment> assignments;

            if (!_questAssigned.TryGetValue(player.userID, out assignments))
            {
                return;
            }

            for (int i = 0; i < assignments.Count; i++)
            {
                QuestAssignment assignment = assignments[i];

                if (assignment.Kind != kind || assignment.Target != target)
                {
                    continue;
                }

                assignment.Have += amount;
                QuestBump(assignment.PlayerQuestId, assignment.Seq, amount);

                // ####  O PUSH SO SAI NA VIRADA, E UMA VEZ SO  ####
                //
                // Gritar a cada golpe de picareta depois de a missao
                // fechar encheria o console e o agente recusaria
                // todos, menos o primeiro. O `_questAnnounced` e o
                // que garante uma linha por tentativa.
                if (assignment.Have >= assignment.Need &&
                    QuestAllDone(player.userID, assignment.PlayerQuestId) &&
                    _questAnnounced.Add(assignment.PlayerQuestId))
                {
                    QuestPush(player, assignment.PlayerQuestId, "complete", 0);
                }
            }
        }

        // Todos os objetivos daquela tentativa fecharam?
        //
        // O plugin PROPOE; quem decide e o agente. Mas propor sem
        // conferir os outros objetivos faria uma missao de dois
        // passos gritar no primeiro.
        private bool QuestAllDone(ulong steamId, long playerQuestId)
        {
            List<QuestAssignment> assignments;

            if (!_questAssigned.TryGetValue(steamId, out assignments))
            {
                return false;
            }

            for (int i = 0; i < assignments.Count; i++)
            {
                if (assignments[i].PlayerQuestId == playerQuestId &&
                    assignments[i].Have < assignments[i].Need)
                {
                    return false;
                }
            }

            return true;
        }

        private void QuestBump(long playerQuestId, int seq, int delta)
        {
            string key = playerQuestId + ":" + seq;
            QuestEntryInfo entry;

            if (!_questOpen.TryGetValue(key, out entry))
            {
                entry = new QuestEntryInfo
                {
                    PlayerQuestId = playerQuestId,
                    Seq = seq,
                    Delta = 0
                };

                _questOpen[key] = entry;
            }

            entry.Delta += delta;
            _questDirty = true;
        }

        // ------------------------------------------------------
        //  O PUSH
        // ------------------------------------------------------

        // ####  O SEGREDO NAO E ZELO  ####
        //
        // O agente le TODA linha do console, e o chat dos jogadores
        // passa por ele. Sem o segredo, alguem digitando o marcador
        // no chat concluiria a propria missao.
        private void QuestPush(BasePlayer player, long playerQuestId, string kind, float meters)
        {
            if (string.IsNullOrEmpty(_questSecret) || player == null)
            {
                return;
            }

            // O eventId e daqui, e e ele que faz o push e o lote do
            // mesmo fato virarem UMA linha no agente.
            string eventId = playerQuestId + ":" + kind + ":" + _questSeq;

            StringBuilder line = new StringBuilder();

            line.Append(QuestEventMarker);
            line.Append("{\"contract\":").Append(QuestContract);
            line.Append(",\"secret\":\"").Append(_questSecret).Append('"');
            line.Append(",\"eventId\":\"").Append(eventId).Append('"');
            line.Append(",\"kind\":\"").Append(kind).Append('"');
            line.Append(",\"steamId\":\"").Append(player.UserIDString).Append('"');
            line.Append(",\"pq\":").Append(playerQuestId);

            if (kind == "deliver")
            {
                line.Append(",\"meters\":").Append(
                    meters.ToString("0.##", CultureInfo.InvariantCulture));
            }

            line.Append('}');

            Puts(line.ToString());
        }

        // ------------------------------------------------------
        //  O `consume`: os itens que a missao cobra
        // ------------------------------------------------------

        // ####  E TUDO OU NADA, E ESSA E A REGRA INTEIRA  ####
        //
        // O agente pergunta ANTES de entregar o premio. Se faltar um
        // item, NADA sai do inventario e o resgate para - o jogador
        // junta o que falta e volta. Tirar metade cobraria material
        // por um premio que nao veio.
        //
        // Por isso sao duas passadas: a primeira CONTA, a segunda
        // tira. Uma passada so, tirando enquanto conta, deixaria o
        // inventario mexido quando o ultimo item faltasse.
        [ConsoleCommand(QuestConsumeCommand)]
        private void CommandQuestConsume(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleQuestConsume(arg));
            }
            catch (Exception ex)
            {
                PrintError(QuestConsumeCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleQuestConsume(ConsoleSystem.Arg arg)
        {
            if (!arg.HasArgs(2))
            {
                return BuildError(ErrorInvalidArgs);
            }

            ulong steamId;

            if (!ulong.TryParse(arg.GetString(0), out steamId))
            {
                return BuildError(ErrorInvalidArgs);
            }

            BasePlayer player = BasePlayer.FindByID(steamId);

            if (player == null || player.inventory == null)
            {
                // Ele saiu entre o clique e este comando. O agente
                // trata como "faltou", e a missao continua pronta.
                return "{\"ok\":true,\"contract\":" + QuestContract +
                    ",\"taken\":[],\"complete\":false}";
            }

            JObject payload = QuestDecode(arg.GetString(1));

            if (payload == null)
            {
                return BuildError(ErrorInvalidArgs);
            }

            JArray items = payload["items"] as JArray;

            if (items == null)
            {
                return BuildError(ErrorInvalidArgs);
            }

            List<string> names = new List<string>();
            List<int> amounts = new List<int>();

            for (int i = 0; i < items.Count; i++)
            {
                JObject item = items[i] as JObject;

                if (item == null)
                {
                    continue;
                }

                string shortname = (string)item["shortname"];
                int amount = (int)item["amount"];

                if (string.IsNullOrEmpty(shortname) || amount <= 0)
                {
                    continue;
                }

                names.Add(shortname);
                amounts.Add(amount);
            }

            // Primeira passada: da para pagar tudo?
            for (int i = 0; i < names.Count; i++)
            {
                ItemDefinition definition = ItemManager.FindItemDefinition(names[i]);

                if (definition == null || player.inventory.GetAmount(definition.itemid) < amounts[i])
                {
                    return "{\"ok\":true,\"contract\":" + QuestContract +
                        ",\"taken\":[],\"complete\":false}";
                }
            }

            // Segunda: tira.
            StringBuilder taken = new StringBuilder();

            for (int i = 0; i < names.Count; i++)
            {
                ItemDefinition definition = ItemManager.FindItemDefinition(names[i]);

                player.inventory.Take(null, definition.itemid, amounts[i]);

                if (taken.Length > 0)
                {
                    taken.Append(',');
                }

                taken.Append("{\"shortname\":").Append(JsonConvert.ToString(names[i]));
                taken.Append(",\"amount\":").Append(amounts[i]).Append('}');
            }

            return "{\"ok\":true,\"contract\":" + QuestContract +
                ",\"taken\":[" + taken + "],\"complete\":true}";
        }

        // ------------------------------------------------------
        //  O LOTE
        // ------------------------------------------------------

        [ConsoleCommand(QuestFlushCommand)]
        private void CommandQuestFlush(ConsoleSystem.Arg arg)
        {
            // Excecao que sobe de um ConsoleCommand vindo do RCON nao
            // produz resposta nenhuma, e o agente fica pendurado ate o
            // timeout. Todo caminho de saida responde.
            try
            {
                arg.ReplyWith(HandleQuestFlush(arg));
            }
            catch (Exception ex)
            {
                PrintError(QuestFlushCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleQuestFlush(ConsoleSystem.Arg arg)
        {
            int offset;

            if (!TryReadInt(arg, 0, 0, out offset) || offset < 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            int limit;

            if (!TryReadInt(arg, 1, DefaultQuestLimit, out limit) || limit < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            if (limit > MaxQuestLimit)
            {
                limit = MaxQuestLimit;
            }

            // ####  O OFFSET ZERO E O QUE CONGELA  ####
            //
            // Ele fecha o buffer atual como lote pendente e abre um
            // novo. Com um pendente nao confirmado, ele devolve o
            // MESMO lote - e e isso que faz uma queda de RCON no meio
            // do ciclo nao custar nada.
            if (offset == 0 && _questPending == null && _questOpen.Count > 0)
            {
                _questSeq++;

                _questPending = new QuestBatch
                {
                    BatchId = _questSeq + "-" + DateTime.UtcNow.Ticks,
                    Entries = new List<QuestEntryInfo>(_questOpen.Values)
                };

                _questOpen = new Dictionary<string, QuestEntryInfo>();
                _questDirty = true;
                QuestSave(true);
            }

            if (_questPending == null)
            {
                // Nada pendente: um lote vazio, com um batchId que o
                // agente vai confirmar e descartar. Responder "sem
                // lote" faria o agente tratar como falha.
                return "{\"ok\":true,\"contract\":" + QuestContract +
                    ",\"batchId\":\"vazio\",\"entries\":[],\"total\":0}";
            }

            StringBuilder json = new StringBuilder();

            json.Append("{\"ok\":true,\"contract\":").Append(QuestContract);
            json.Append(",\"batchId\":\"").Append(_questPending.BatchId).Append('"');
            json.Append(",\"total\":").Append(_questPending.Entries.Count);
            json.Append(",\"entries\":[");

            int written = 0;

            for (int i = offset; i < _questPending.Entries.Count && written < limit; i++)
            {
                QuestEntryInfo entry = _questPending.Entries[i];

                if (written > 0)
                {
                    json.Append(',');
                }

                json.Append("{\"pq\":").Append(entry.PlayerQuestId);
                json.Append(",\"seq\":").Append(entry.Seq);
                json.Append(",\"delta\":").Append(entry.Delta).Append('}');

                written++;
            }

            json.Append("]}");

            // ####  A PAGINA E RECUSADA INTEIRA, E NAO CORTADA  ####
            //
            // Resposta truncada chega ao agente como JSON invalido, e
            // meio lote PARECE ter funcionado. Quem recebe este codigo
            // reduz o limit pela metade e pede de novo, sem avancar o
            // offset.
            if (json.Length > MaxQuestBytes)
            {
                return BuildError(QuestErrorTooLarge);
            }

            return json.ToString();
        }

        [ConsoleCommand(QuestAckCommand)]
        private void CommandQuestAck(ConsoleSystem.Arg arg)
        {
            try
            {
                if (!arg.HasArgs(1))
                {
                    arg.ReplyWith(BuildError(ErrorInvalidArgs));
                    return;
                }

                string batchId = arg.GetString(0);

                if (_questPending == null || _questPending.BatchId != batchId)
                {
                    // Um oxide.reload entre duas paginas, ou um ack
                    // repetido de um lote que ja saiu. Nenhum dos dois
                    // e defeito.
                    arg.ReplyWith(BuildError(QuestErrorNoBatch));
                    return;
                }

                _questPending = null;
                _questDirty = true;
                QuestSave(true);

                arg.ReplyWith("{\"ok\":true,\"contract\":" + QuestContract + "}");
            }
            catch (Exception ex)
            {
                PrintError(QuestAckCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // ####  O DIAG EXISTE PARA UMA DECISAO, E NAO PARA CURIOSIDADE  ####
        //
        // "O hook de loot cabe no orcamento deste servidor?" e a
        // pergunta que ele responde, com numero. Quem nao gostar da
        // resposta desliga o loot em quest_settings, e o resto do
        // modulo continua funcionando.
        [ConsoleCommand(QuestDiagCommand)]
        private void CommandQuestDiag(ConsoleSystem.Arg arg)
        {
            try
            {
                StringBuilder json = new StringBuilder();

                json.Append("{\"ok\":true,\"contract\":").Append(QuestContract);
                json.Append(",\"lootHooked\":").Append(_questLootHooked ? "true" : "false");
                json.Append(",\"watchedKinds\":").Append(_questWatch.Count);
                json.Append(",\"assignedPlayers\":").Append(_questAssigned.Count);
                json.Append(",\"openEntries\":").Append(_questOpen.Count);
                json.Append(",\"pending\":").Append(
                    _questPending == null ? 0 : _questPending.Entries.Count);
                json.Append('}');

                arg.ReplyWith(json.ToString());
            }
            catch (Exception ex)
            {
                PrintError(QuestDiagCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        // ------------------------------------------------------
        //  O DISCO
        // ------------------------------------------------------

        // ####  O oxide.reload NAO PODE CUSTAR PROGRESSO  ####
        //
        // O que ainda nao foi confirmado vai para o disco antes de a
        // memoria sumir. O catalogo e as atribuicoes NAO vao: eles
        // vem do agente, e o plugin pede de volta com `#OZAREQ#`.
        private void QuestSave(bool force)
        {
            if (!force && !_questDirty)
            {
                return;
            }

            try
            {
                Interface.Oxide.DataFileSystem.WriteObject(QuestDataFile, new QuestState
                {
                    Seq = _questSeq,
                    Open = new List<QuestEntryInfo>(_questOpen.Values),
                    Pending = _questPending
                });

                _questDirty = false;
            }
            catch (Exception ex)
            {
                PrintError("Nao consegui gravar " + QuestDataFile + ": " + ex);
            }
        }

        private void QuestLoad()
        {
            try
            {
                QuestState state = Interface.Oxide.DataFileSystem.ReadObject<QuestState>(QuestDataFile);

                if (state == null)
                {
                    return;
                }

                _questSeq = state.Seq;
                _questPending = state.Pending;
                _questOpen = new Dictionary<string, QuestEntryInfo>();

                if (state.Open != null)
                {
                    for (int i = 0; i < state.Open.Count; i++)
                    {
                        QuestEntryInfo entry = state.Open[i];

                        _questOpen[entry.PlayerQuestId + ":" + entry.Seq] = entry;
                    }
                }
            }
            catch (Exception ex)
            {
                // Arquivo ilegivel e o mesmo que arquivo ausente: o
                // progresso do minuto se perde, e o resto continua. O
                // agente reenvia as atribuicoes na proxima rodada.
                PrintWarning("Nao consegui ler " + QuestDataFile + ": " + ex.Message);
            }
        }

        private JObject QuestDecode(string base64)
        {
            try
            {
                string json = Encoding.UTF8.GetString(Convert.FromBase64String(base64));

                return JObject.Parse(json);
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ------------------------------------------------------
        //  OS TIPOS
        // ------------------------------------------------------

        private class QuestAssignment
        {
            public long PlayerQuestId;
            public int Seq;
            public string Kind;
            public string Target;
            public int Need;
            public int Have;
        }

        private class QuestEntryInfo
        {
            [JsonProperty("pq")]
            public long PlayerQuestId { get; set; }

            [JsonProperty("seq")]
            public int Seq { get; set; }

            [JsonProperty("delta")]
            public int Delta { get; set; }
        }

        private class QuestBatch
        {
            [JsonProperty("batchId")]
            public string BatchId { get; set; }

            [JsonProperty("entries")]
            public List<QuestEntryInfo> Entries { get; set; }
        }

        // O que vai para oxide/data/OrigemZAgentQuests.json.
        private class QuestState
        {
            [JsonProperty("seq")]
            public int Seq { get; set; }

            [JsonProperty("open")]
            public List<QuestEntryInfo> Open { get; set; }

            [JsonProperty("pending")]
            public QuestBatch Pending { get; set; }
        }

        #endregion

        // ============================================================
        //  OS NPCs DAS MISSOES
        //
        //  ####  POR QUE ELES SAO CONSTRUIDOS AQUI  ####
        //
        //  O Quests.cs de referencia depende do HumanNPC, que nao
        //  esta instalado nesta rede. O boneco e nosso.
        //
        //  ####  O HOOK DE CONVERSA EXISTE, E ELE E QUEM DA O "TALK"  ####
        //
        //  A medicao de 06/09 disse que nao havia - ela olhou o
        //  Oxide.Rust.dll, e o lugar errado. REMEDIDO em 11/09/2026
        //  com o ilspycmd contra o Assembly-CSharp.dll DESTA
        //  instalacao (o Oxide ja o patcheia): o
        //  NPCTalking.Server_BeginTalking chama
        //  `Interface.CallHook("OnNpcConversationStart", ...)` e
        //  ABORTA quando a resposta nao e nula.
        //
        //  Isso muda o desenho: o prompt "TALK" do jogo aparece
        //  sozinho em cima de qualquer NPCTalking - e a conversa
        //  vanilla, que nao queremos, morre no hook. O jogador ve o
        //  que o Rust ensinou a ver, e quem responde e a nossa tela.
        //
        //  MEDIDO no server01, spawnando cada prefab e lendo o tipo:
        //
        //    bandit_conversationalist   VehicleVendor : NPCTalking
        //    boat_shopkeeper            VehicleVendor : NPCTalking
        //    stables_shopkeeper         VehicleVendor : NPCTalking
        //    apartment_vendor           ApartmentVendor : NPCTalking
        //    bandit_shopkeeper          NPCShopKeeper  <- SEM talk
        //    missionprovider_*          NPCTalking, mas IMissionProvider:
        //                               spawna um MapMarkerMissionProvider
        //                               que fica no mapa. Fora.
        //
        //  ####  O `OnPlayerInput` E O HOOK MAIS QUENTE QUE EXISTE  ####
        //
        //  Ele dispara a cada quadro, para cada jogador. Tres
        //  contencoes o seguram:
        //
        //    1. ele so e REGISTRADO quando ha NPC neste servidor;
        //    2. a primeira coisa que ele faz e olhar UM botao;
        //    3. so depois disso ele mede distancia, e contra uma
        //       lista que tem tres ou quatro entradas.
        //
        //  ####  DOIS CAMINHOS PARA A MESMA PORTA  ####
        //
        //  O TALK so alcanca 3 m - e o teto do RPC do jogo
        //  (`RPC_Server.MaxDistance(3f)`), e nao uma escolha nossa.
        //  O raio do painel vai a 20, entao o USE por proximidade
        //  continua existindo para quem configurou mais que isso.
        //
        //  Os dois desaguam no `QuestNpcTalk`, e o mesmo freio de
        //  1,5 s vale para ambos: apertar E em cima do NPC dispara o
        //  TALK e o USE no mesmo instante, e sem o freio a tela
        //  abriria duas vezes.
        //
        //  ####  A TELA E DO AGENTE, E O TRANSPORTE JA EXISTE  ####
        //
        //  Apertar USE perto do NPC nao abre nada aqui: o plugin
        //  manda o jogador abrir `tela-missoes:npc:<id>` pelo mesmo
        //  caminho que o menu ja usa. Zero transporte novo, zero
        //  cache novo, zero tratamento de erro novo.
        //
        //  Documento: Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md, secao 10.
        // ============================================================
        #region QuestNpcs

        private const string QuestNpcClearCommand = "origemz.quest.npc.clear";
        private const string QuestNpcSetCommand = "origemz.quest.npc.set";
        private const string QuestNpcMarker = "#OZQUESTNPC#";

        // O que o agente mandou spawnar. id -> definicao.
        private Dictionary<string, QuestNpcInfo> _questNpcs =
            new Dictionary<string, QuestNpcInfo>();

        // O que esta VIVO no mundo. id -> boneco.
        private Dictionary<string, BasePlayer> _questNpcEntities =
            new Dictionary<string, BasePlayer>();

        private Dictionary<string, BaseEntity> _questNpcMarkers =
            new Dictionary<string, BaseEntity>();

        private bool _questNpcInputHooked;

        // Quando cada jogador falou com um NPC pela ultima vez.
        //
        // O USE fica pressionado por varios quadros; sem este freio,
        // um toque no botao mandaria dez pedidos de tela ao agente.
        private Dictionary<ulong, float> _questNpcLastUse = new Dictionary<ulong, float>();

        private const float QuestNpcUseCooldown = 1.5f;

        [ConsoleCommand(QuestNpcClearCommand)]
        private void CommandQuestNpcClear(ConsoleSystem.Arg arg)
        {
            try
            {
                QuestNpcDespawnAll();
                _questNpcs.Clear();
                QuestNpcSyncInputHook();

                arg.ReplyWith("{\"ok\":true,\"contract\":" + QuestContract + "}");
            }
            catch (Exception ex)
            {
                PrintError(QuestNpcClearCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        [ConsoleCommand(QuestNpcSetCommand)]
        private void CommandQuestNpcSet(ConsoleSystem.Arg arg)
        {
            try
            {
                arg.ReplyWith(HandleQuestNpcSet(arg));
            }
            catch (Exception ex)
            {
                PrintError(QuestNpcSetCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleQuestNpcSet(ConsoleSystem.Arg arg)
        {
            if (!arg.HasArgs(1))
            {
                return BuildError(ErrorInvalidArgs);
            }

            JObject payload = QuestDecode(arg.GetString(0));

            if (payload == null)
            {
                return BuildError(ErrorInvalidArgs);
            }

            QuestNpcInfo info = new QuestNpcInfo
            {
                Id = (string)payload["id"],
                Name = (string)payload["name"],
                X = (float)payload["x"],
                Y = (float)payload["y"],
                Z = (float)payload["z"],
                Rotation = (float)payload["rotation"],
                Prefab = (string)payload["prefab"],
                MapMarker = (bool)payload["mapMarker"],
                UseRadius = (float)payload["useRadius"]
            };

            if (string.IsNullOrEmpty(info.Id) || string.IsNullOrEmpty(info.Prefab))
            {
                return BuildError(ErrorInvalidArgs);
            }

            _questNpcs[info.Id] = info;

            QuestNpcDespawn(info.Id);
            bool spawned = QuestNpcSpawn(info);

            QuestNpcSyncInputHook();

            return "{\"ok\":true,\"contract\":" + QuestContract +
                ",\"spawned\":" + (spawned ? "true" : "false") + "}";
        }

        // ####  A ALTURA E RECALCULADA, E A GRAVADA E SO UM PALPITE  ####
        //
        // O mapa muda a cada wipe: o chao sobe e desce, e um NPC
        // enterrado e invisivel e insuportavel de diagnosticar. O
        // TerrainMeta manda; o `y` do banco so serve para o painel
        // mostrar alguma coisa.
        private bool QuestNpcSpawn(QuestNpcInfo info)
        {
            try
            {
                Vector3 position = new Vector3(info.X, info.Y, info.Z);

                if (TerrainMeta.HeightMap != null)
                {
                    position.y = TerrainMeta.HeightMap.GetHeight(position);
                }

                BaseEntity entity = GameManager.server.CreateEntity(
                    info.Prefab,
                    position,
                    Quaternion.Euler(0f, info.Rotation, 0f));

                if (entity == null)
                {
                    PrintWarning("NPC de missao: o prefab nao existe - " + info.Prefab);
                    return false;
                }

                entity.enableSaving = false;
                entity.Spawn();

                BasePlayer npc = entity as BasePlayer;

                if (npc == null)
                {
                    entity.Kill();
                    PrintWarning("NPC de missao: o prefab nao e um BasePlayer - " + info.Prefab);
                    return false;
                }

                // O nome que aparece sobre a cabeca dele.
                npc.displayName = info.Name;

                // ####  O NPCTalking TEM UM SEGUNDO NOME  ####
                //
                // O `displayName` e o do jogador; o `NPCName` e o
                // que a interface de conversa do jogo usa. Um
                // boneco chamado "Mateus" que se apresenta como
                // "Airwolf Vendor" - o nome que vem no prefab - e o
                // tipo de detalhe que faz o jogador achar que
                // entrou na tela errada.
                NPCTalking talking = npc as NPCTalking;

                if (talking != null)
                {
                    talking.NPCName = new Translate.Phrase(string.Empty, info.Name);
                }

                // ####  ELE NAO ANDA E NAO MORRE  ####
                //
                // Um vendedor que persegue jogador ou que morre para
                // o primeiro tiro nao e um ponto do mapa: e um bug
                // que alguem vai reportar como "o NPC sumiu".
                NPCPlayer ai = npc as NPCPlayer;

                if (ai != null)
                {
                    ai.CancelInvoke("EquipTest");
                }

                npc.SetPlayerFlag(BasePlayer.PlayerFlags.Sleeping, false);
                npc.baseProtection.Clear();
                npc.baseProtection.Add(1f);

                _questNpcEntities[info.Id] = npc;

                if (info.MapMarker)
                {
                    QuestNpcMark(info, position);
                }

                return true;
            }
            catch (Exception ex)
            {
                PrintError("NPC de missao nao subiu (" + info.Id + "): " + ex);
                return false;
            }
        }

        // ####  O CIRCULO, E NAO O ROTULO  ####
        //
        // `MapMarkerGenericRadius` desenha um circulo colorido e nao
        // depende de nada. O rotulo com NOME seria
        // `VendingMachineMapMarker`, que exige uma VendingMachine de
        // verdade por tras - MEDIDO na DLL: `SetVendingMachine(vm,
        // shopName)`. Uma maquina invisivel por NPC e uma entidade a
        // mais no mundo para um texto; o circulo diz onde, e o
        // jogador ve o nome ao chegar.
        private void QuestNpcMark(QuestNpcInfo info, Vector3 position)
        {
            try
            {
                BaseEntity marker = GameManager.server.CreateEntity(
                    "assets/prefabs/tools/map/genericradiusmarker.prefab",
                    position);

                if (marker == null)
                {
                    return;
                }

                MapMarkerGenericRadius radius = marker as MapMarkerGenericRadius;

                if (radius != null)
                {
                    radius.radius = 0.25f;
                    radius.alpha = 0.7f;
                    radius.color1 = new Color(0.77f, 0.25f, 0.17f);
                    radius.color2 = new Color(0.77f, 0.25f, 0.17f);
                }

                marker.enableSaving = false;
                marker.Spawn();

                if (radius != null)
                {
                    radius.SendUpdate(true);
                }

                _questNpcMarkers[info.Id] = marker;
            }
            catch (Exception ex)
            {
                // O marcador e conforto: o NPC continua la, e quem
                // sabe onde ele fica chega do mesmo jeito.
                PrintWarning("Marcador do NPC " + info.Id + " nao subiu: " + ex.Message);
            }
        }

        private void QuestNpcDespawn(string id)
        {
            BasePlayer npc;

            if (_questNpcEntities.TryGetValue(id, out npc))
            {
                if (npc != null && !npc.IsDestroyed)
                {
                    npc.Kill();
                }

                _questNpcEntities.Remove(id);
            }

            BaseEntity marker;

            if (_questNpcMarkers.TryGetValue(id, out marker))
            {
                if (marker != null && !marker.IsDestroyed)
                {
                    marker.Kill();
                }

                _questNpcMarkers.Remove(id);
            }
        }

        private void QuestNpcDespawnAll()
        {
            List<string> ids = new List<string>(_questNpcEntities.Keys);

            for (int i = 0; i < ids.Count; i++)
            {
                QuestNpcDespawn(ids[i]);
            }

            ids = new List<string>(_questNpcMarkers.Keys);

            for (int i = 0; i < ids.Count; i++)
            {
                QuestNpcDespawn(ids[i]);
            }
        }

        // Ver o cabecalho: os hooks so entram se houver NPC.
        private void QuestNpcSyncInputHook()
        {
            bool wanted = _questNpcs.Count > 0;

            if (wanted == _questNpcInputHooked)
            {
                return;
            }

            if (wanted)
            {
                Subscribe("OnPlayerInput");
                Subscribe("OnNpcConversationStart");
            }
            else
            {
                Unsubscribe("OnPlayerInput");
                Unsubscribe("OnNpcConversationStart");
            }

            _questNpcInputHooked = wanted;
        }

        // ####  O "TALK" DO JOGO CHEGA AQUI  ####
        //
        // O cliente desenha o prompt sozinho em cima de qualquer
        // NPCTalking e, ao apertar, manda o RPC que o jogo trata em
        // `Server_BeginTalking`. Ele chama este hook ANTES de abrir
        // a conversa vanilla - e devolver qualquer coisa nao nula a
        // aborta.
        //
        // E e isso que queremos: o boneco e nosso, as falas do
        // prefab nao sao. Abortamos e abrimos a nossa tela.
        //
        // Um NPC que NAO e nosso (um do Bandit Camp, num mapa que os
        // tenha) devolve null e conversa como sempre.
        private object OnNpcConversationStart(NPCTalking npc, BasePlayer player, ConversationData conversation)
        {
            if (npc == null || player == null || _questNpcs.Count == 0)
            {
                return null;
            }

            try
            {
                QuestNpcInfo mine = QuestNpcOf(npc);

                if (mine == null)
                {
                    return null;
                }

                QuestNpcTalk(player, mine);

                // Nao nulo = a conversa do jogo nao comeca.
                return true;
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookNpcConversation, ex);

                // ####  O ERRO NAO PODE DEVOLVER O JOGADOR A CONVERSA VANILLA  ####
                //
                // Se a nossa tela falhou, abrir as falas do prefab
                // no lugar dela seria o pior dos dois mundos: o
                // jogador veria o "Airwolf Vendor" oferecendo
                // helicoptero. Melhor nao abrir nada.
                return true;
            }
        }

        // O NPC do jogo e um dos nossos? Devolve a definicao dele.
        //
        // A varredura e por valor e nao por chave porque a lista tem
        // tres ou quatro entradas - um dicionario reverso por net.ID
        // custaria mais manutencao que os microssegundos que economiza.
        private QuestNpcInfo QuestNpcOf(BaseEntity entity)
        {
            foreach (KeyValuePair<string, BasePlayer> entry in _questNpcEntities)
            {
                if (!ReferenceEquals(entry.Value, entity))
                {
                    continue;
                }

                QuestNpcInfo info;

                return _questNpcs.TryGetValue(entry.Key, out info) ? info : null;
            }

            return null;
        }

        // ####  O HOOK DE CADA QUADRO  ####
        //
        // A primeira linha e uma comparacao de botao. Tudo o que vem
        // depois so roda no quadro em que alguem apertou USE - e
        // esse gesto acontece algumas vezes por minuto, nao 60 vezes
        // por segundo.
        private void OnPlayerInput(BasePlayer player, InputState input)
        {
            if (input == null || !input.WasJustPressed(BUTTON.USE))
            {
                return;
            }

            try
            {
                if (player == null || player.IsNpc || _questNpcs.Count == 0)
                {
                    return;
                }

                QuestNpcInfo nearest = QuestNpcNear(player);

                if (nearest == null)
                {
                    return;
                }

                QuestNpcTalk(player, nearest);
            }
            catch (Exception ex)
            {
                ReportStatsHookError(HookPlayerInput, ex);
            }
        }

        // ####  A PORTA UNICA: O TALK E O USE DESAGUAM AQUI  ####
        //
        // O freio esta DENTRO, e nao em cada caminho: apertar E em
        // cima do NPC dispara os dois no mesmo instante, e o
        // segundo a chegar precisa encontrar a porta fechada.
        private void QuestNpcTalk(BasePlayer player, QuestNpcInfo npc)
        {
            float last;

            if (_questNpcLastUse.TryGetValue(player.userID, out last) &&
                UnityEngine.Time.realtimeSinceStartup - last < QuestNpcUseCooldown)
            {
                return;
            }

            _questNpcLastUse[player.userID] = UnityEngine.Time.realtimeSinceStartup;

            // ####  A ENTREGA ACONTECE ANTES DA TELA  ####
            //
            // Se este NPC e o destino de uma entrega que o jogador
            // esta fazendo, o pacote chega AQUI - e a tela que abre
            // em seguida ja mostra a missao pronta para resgatar.
            //
            // A ordem importa: abrir a tela primeiro mostraria a
            // entrega ainda pendente, e o jogador apertaria USE de
            // novo achando que nao funcionou.
            QuestTryDeliver(player, npc.Id);

            // ####  QUEM ABRE A TELA E O AGENTE  ####
            //
            // Nao ha CUI aqui, e o plugin TAMBEM nao manda o
            // `origemz.ui.open`: aquele comando recusa o que vem do
            // cliente (`arg.Connection != null`) - de proposito,
            // para um jogador nao abrir a tela de outro.
            //
            // Entao este plugin GRITA, o agente le, confere que o
            // NPC existe naquele servidor e manda o comando com a
            // autoridade dele. Uma ida a mais, e a conferencia que
            // ela paga vale.
            QuestNpcPush(player, npc.Id);
        }

        // O pacote chegou?
        //
        // ####  O PLUGIN SO SABE ONDE O JOGADOR ESTA  ####
        //
        // Ele nao decide se a entrega vale: manda "o Fulano apertou
        // USE no npc X, na tentativa Y" e o agente confere que
        // aquela tentativa realmente pedia uma entrega PARA ESSE
        // NPC. Um push com o NPC errado nao marca nada.
        //
        // A distancia vai junto porque o contrato a aceita - e o
        // agente a IGNORA, medindo a dele com as coordenadas do
        // banco. Um cliente adulterado que dissesse ter andado 40 km
        // seria pago por 40 km.
        private void QuestTryDeliver(BasePlayer player, string npcId)
        {
            List<QuestAssignment> assignments;

            if (!_questAssigned.TryGetValue(player.userID, out assignments))
            {
                return;
            }

            for (int i = 0; i < assignments.Count; i++)
            {
                QuestAssignment assignment = assignments[i];

                if (assignment.Kind != "deliver" || assignment.Target != npcId)
                {
                    continue;
                }

                if (assignment.Have >= assignment.Need)
                {
                    // Ja entregue. O USE repetido no mesmo NPC cai
                    // aqui, e nao grita de novo.
                    continue;
                }

                assignment.Have = assignment.Need;

                float meters = 0f;
                BasePlayer npc;

                if (_questNpcEntities.TryGetValue(npcId, out npc) && npc != null)
                {
                    meters = Vector3.Distance(player.transform.position, npc.transform.position);
                }

                QuestPushDeliver(player, assignment.PlayerQuestId, npcId, meters);
            }
        }

        private void QuestPushDeliver(BasePlayer player, long playerQuestId, string npcId, float meters)
        {
            if (string.IsNullOrEmpty(_questSecret))
            {
                return;
            }

            StringBuilder line = new StringBuilder();

            line.Append(QuestEventMarker);
            line.Append("{\"contract\":").Append(QuestContract);
            line.Append(",\"secret\":\"").Append(_questSecret).Append('"');
            line.Append(",\"eventId\":\"").Append(playerQuestId).Append(":deliver:").Append(npcId).Append('"');
            line.Append(",\"kind\":\"deliver\"");
            line.Append(",\"steamId\":\"").Append(player.UserIDString).Append('"');
            line.Append(",\"pq\":").Append(playerQuestId);
            line.Append(",\"npcId\":").Append(JsonConvert.ToString(npcId));
            line.Append(",\"meters\":").Append(meters.ToString("0.##", CultureInfo.InvariantCulture));
            line.Append('}');

            Puts(line.ToString());
        }

        // O grito. Mesmo segredo e mesmo cano do `#OZQUEST#`: sem
        // ele, alguem digitando o marcador no chat abriria a tela de
        // qualquer NPC para si mesmo - o que e inofensivo, mas o
        // canal e um so e a regra tambem.
        private void QuestNpcPush(BasePlayer player, string npcId)
        {
            if (string.IsNullOrEmpty(_questSecret))
            {
                return;
            }

            StringBuilder line = new StringBuilder();

            line.Append(QuestNpcMarker);
            line.Append("{\"contract\":").Append(QuestContract);
            line.Append(",\"secret\":\"").Append(_questSecret).Append('"');
            line.Append(",\"kind\":\"use\"");
            line.Append(",\"steamId\":\"").Append(player.UserIDString).Append('"');
            line.Append(",\"npcId\":").Append(JsonConvert.ToString(npcId));
            line.Append('}');

            Puts(line.ToString());
        }

        // O NPC mais proximo dentro do raio dele.
        //
        // "O mais proximo", e nao "o primeiro que couber": dois NPCs
        // vizinhos disputariam o mesmo clique, e quem joga nao teria
        // como saber com qual dos dois falou.
        private QuestNpcInfo QuestNpcNear(BasePlayer player)
        {
            QuestNpcInfo best = null;
            float bestDistance = float.MaxValue;
            Vector3 position = player.transform.position;

            foreach (KeyValuePair<string, QuestNpcInfo> entry in _questNpcs)
            {
                BasePlayer npc;

                if (!_questNpcEntities.TryGetValue(entry.Key, out npc) ||
                    npc == null || npc.IsDestroyed)
                {
                    continue;
                }

                float distance = Vector3.Distance(position, npc.transform.position);

                if (distance <= entry.Value.UseRadius && distance < bestDistance)
                {
                    best = entry.Value;
                    bestDistance = distance;
                }
            }

            return best;
        }

        // ------------------------------------------------------
        //  O CADASTRO IN-GAME
        // ------------------------------------------------------

        // ####  NINGUEM ESCOLHE COORDENADA DIGITANDO NUMERO  ####
        //
        // O admin vai ate o lugar, olha para onde o NPC deve olhar, e
        // digita. Para posicao no mundo, o jogo e a melhor interface
        // que existe - e e o unico pedaco do Quests.cs que sobrevive
        // quase igual.
        //
        // O painel faz o resto: renomear, ligar, desligar, apagar.
        [ChatCommand("questnpc")]
        private void ChatQuestNpc(BasePlayer player, string command, string[] args)
        {
            if (player == null || !player.IsAdmin)
            {
                return;
            }

            if (args == null || args.Length == 0)
            {
                player.ChatMessage(
                    "/questnpc add <nome>  |  /questnpc move <id>  |  " +
                    "/questnpc remove <id>  |  /questnpc list");
                return;
            }

            if (args[0] == "list")
            {
                if (_questNpcs.Count == 0)
                {
                    player.ChatMessage("Nenhum NPC de missao neste servidor.");
                    return;
                }

                foreach (KeyValuePair<string, QuestNpcInfo> entry in _questNpcs)
                {
                    player.ChatMessage(entry.Key + " - " + entry.Value.Name);
                }

                return;
            }

            // ####  MOVER E TRAZER, E POR ISSO NAO PEDE COORDENADA  ####
            //
            // Quem quer mudar o NPC de lugar ja esta no lugar novo:
            // e a mesma ideia do `add`. Antes disto, o painel mandava
            // usar o `add` de novo - e o admin terminava com dois
            // bonecos, "mateus" e "mateus-2".
            if (args[0] == "move" || args[0] == "remove")
            {
                if (args.Length < 2)
                {
                    player.ChatMessage("Uso: /questnpc " + args[0] + " <id>   (veja os ids em /questnpc list)");
                    return;
                }

                string id = args[1];

                if (!_questNpcs.ContainsKey(id))
                {
                    player.ChatMessage("Nao ha NPC com o id \"" + id + "\" aqui. Veja /questnpc list.");
                    return;
                }

                if (args[0] == "remove")
                {
                    QuestNpcChatPush("remove", id, null, Vector3.zero, 0f);
                    player.ChatMessage("Pedi ao agente para apagar \"" + id + "\".");
                    return;
                }

                QuestNpcChatPush("move", id, null, player.transform.position, QuestNpcEyesY(player));
                player.ChatMessage("Pedi ao agente para trazer \"" + id + "\" para ca.");
                return;
            }

            if (args[0] != "add" || args.Length < 2)
            {
                player.ChatMessage("Uso: /questnpc add <nome>");
                return;
            }

            string name = string.Join(" ", args, 1, args.Length - 1);

            QuestNpcChatPush("add", null, name, player.transform.position, QuestNpcEyesY(player));

            player.ChatMessage("Pedi ao agente para cadastrar \"" + name +
                "\" aqui. Ele aparece em instantes.");
        }

        private static float QuestNpcEyesY(BasePlayer player)
        {
            return player.eyes == null ? 0f : player.eyes.rotation.eulerAngles.y;
        }

        // O grito do cadastro in-game.
        //
        // O agente e quem grava: aqui so se REPORTA. Um NPC que
        // existisse so na memoria do plugin sumiria no primeiro
        // oxide.reload, e o painel nunca saberia dele.
        private void QuestNpcChatPush(string kind, string id, string name, Vector3 position, float rotation)
        {
            StringBuilder line = new StringBuilder();

            line.Append(QuestNpcMarker);
            line.Append("{\"contract\":").Append(QuestContract);
            line.Append(",\"secret\":\"").Append(_questSecret ?? string.Empty).Append('"');
            line.Append(",\"kind\":\"").Append(kind).Append('"');

            if (id != null)
            {
                line.Append(",\"npcId\":").Append(JsonConvert.ToString(id));
            }

            if (name != null)
            {
                line.Append(",\"name\":").Append(JsonConvert.ToString(name));
            }

            if (kind != "remove")
            {
                line.Append(",\"x\":").Append(position.x.ToString("0.##", CultureInfo.InvariantCulture));
                line.Append(",\"y\":").Append(position.y.ToString("0.##", CultureInfo.InvariantCulture));
                line.Append(",\"z\":").Append(position.z.ToString("0.##", CultureInfo.InvariantCulture));
                line.Append(",\"rotation\":").Append(rotation.ToString("0.##", CultureInfo.InvariantCulture));
            }

            line.Append('}');

            Puts(line.ToString());
        }

        private class QuestNpcInfo
        {
            public string Id;
            public string Name;
            public float X;
            public float Y;
            public float Z;
            public float Rotation;
            public string Prefab;
            public bool MapMarker;
            public float UseRadius;
        }

        #endregion
    }
}
