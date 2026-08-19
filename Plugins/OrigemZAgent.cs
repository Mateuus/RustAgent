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
    [Info("OrigemZAgent", "OrigemZ", "0.3.0")]
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
        private const string RequestSpawnStatus = "status";

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
            });

            try
            {
                EnsureItemCatalog();
            }
            catch (Exception ex)
            {
                PrintError("Catalogo de itens nao montou no boot: " + ex);
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
        //             "itemId":1545779598,
        //             "category":"Weapon",
        //             "maxStack":1,
        //             "hasCondition":true}]}
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

            return catalog;
        }

        private static ItemInfo BuildItemInfo(ItemDefinition definition)
        {
            return new ItemInfo
            {
                Shortname = definition.shortname,
                DisplayName = ReadDisplayName(definition),
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

                HasCondition = definition.condition.enabled
            };
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
                long room = CountFreeSlotRoom(inventory.containerMain, probe, maxStack)
                          + CountFreeSlotRoom(inventory.containerBelt, probe, maxStack)
                          + CountStackRoom(inventory.containerMain, probe, maxStack)
                          + CountStackRoom(inventory.containerBelt, probe, maxStack);

                return room >= amount;
            }
            finally
            {
                probe.Remove();
            }
        }

        // Slot vazio cabe uma pilha cheia - nem mais (o fatiamento
        // nunca cria pedaco maior) nem menos.
        private static long CountFreeSlotRoom(ItemContainer container, Item item, int maxStack)
        {
            if (!Accepts(container, item))
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

        private static long CountStackRoom(ItemContainer container, Item item, int maxStack)
        {
            if (!Accepts(container, item))
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
        private static bool Accepts(ItemContainer container, Item item)
        {
            if (container == null || container.itemList == null)
            {
                return false;
            }

            return container.CanAcceptItem(item, -1) == ItemContainer.CanAcceptResult.CanAccept;
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
    }
}
