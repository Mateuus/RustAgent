// ============================================================
//  OrigemZUI.cs
//
//  A ponta dentro do jogo do editor de interfaces. Ele desenha
//  os menus que foram feitos no painel (/interface) e resolve os
//  cliques.
//
//  Contrato (fonte da verdade do outro lado):
//      RustAgent\core\src\types\ui-transport.ts
//  Plano:
//      Docs\OrigemZUI\PLANO.md
//
//  ------------------------------------------------------------
//  ####  ESTE PLUGIN NAO SABE DESENHAR  ####
//
//  Ele nao converte modelo em CUI: o agente manda a tela ja como
//  lista de CuiElement pronta, e aqui so se troca o token da
//  sessao e chama CuiHelper.AddUi.
//
//  A conversao mora no agente (core\src\game\ui-cui.ts) porque
//  ela tem armadilhas que falham em SILENCIO no cliente - nome
//  de campo minusculo, botao que sao dois elementos, cor em
//  float - e la ela tem teste. Aqui nao teria: nao ha servidor
//  de Rust no CI.
//
//  A consequencia boa: campo novo no modelo NAO exige recompilar
//  este plugin.
//
//  ------------------------------------------------------------
//  ####  CARGA INICIAL LEVE, TELAS SOB DEMANDA  ####
//
//  MEDIDO: o menu principal inteiro da 52 KB, e o teto do WebRCON
//  e ~50 KB. Por isso o agente empurra so os metadados mais a
//  tela de ENTRADA (origemz.ui.doc), e as outras telas descem uma
//  a uma quando o jogador navega ate elas.
//
//  Abrir o menu, entao, nunca espera rede. Navegar para uma tela
//  nova espera - e e por isso que existe o aviso de carregando.
//
//  ------------------------------------------------------------
//  ####  O BOTAO E UM COMANDO DO CLIENTE  ####
//
//  `origemz.ui.act <token> <actionId>` e enviado pelo CLIENTE, e
//  qualquer jogador pode digita-lo no F1 com os argumentos que
//  quiser. Por isso ele carrega so um ENDERECO, e quem decide o
//  que fazer e este plugin, olhando a tela em que o jogador
//  esta. Ver HandleAct.
//
//  ------------------------------------------------------------
//  Nada de sintaxe acima de C# 6. O compilador em tempo de
//  execucao do Oxide para nesse teto, e codigo mais novo compila
//  no Visual Studio e e recusado no servidor - com erro longe da
//  causa. Sem "out var", sem tupla, sem funcao local, sem pattern
//  matching.
// ============================================================

using System;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Game.Rust.Cui;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("OrigemZUI", "OrigemZ", "0.1.0")]
    [Description("Desenha no jogo as interfaces feitas no painel do RustAgent.")]
    public class OrigemZUI : RustPlugin
    {
        // ----------------------------------------------------
        //  Comandos e marcadores
        // ----------------------------------------------------
        private const string DocCommand = "origemz.ui.doc";
        private const string ScreenCommand = "origemz.ui.screen";
        private const string OpenCommand = "origemz.ui.open";
        private const string ActCommand = "origemz.ui.act";
        private const string CloseCommand = "origemz.ui.close";

        /// <summary>O desfecho de uma compra, vindo do agente.</summary>
        private const string BuyResultCommand = "origemz.ui.buyresult";

        /// <summary>Uma imagem nossa, em base64, vinda do agente.</summary>
        private const string ImageCommand = "origemz.ui.image";

        /// <summary>O saldo de um jogador, para o cabecalho.</summary>
        private const string BalanceCommand = "origemz.ui.balance";

        /// <summary>
        /// O marcador do pedido de tela.
        ///
        /// Feio de proposito, como o #OZPEVT# do OrigemZPlayer: um
        /// prefixo bonito seria ambiguo com o que outro plugin
        /// imprime. O agente so aceita a linha se ela vier com o
        /// prefixo de origem que o Oxide poe no Puts.
        /// </summary>
        private const string RequestMarker = "#OZUIREQ#";

        /// <summary>
        /// O marcador do pedido de COMPRA.
        ///
        /// #### ESTA LINHA MOVE DINHEIRO ####
        ///
        /// O agente le o console inteiro, e o chat dos jogadores
        /// entra por ele. So o prefixo do plugin nao basta: uma
        /// mensagem de chat com "[OrigemZUI] #OZBUY# ..." chegaria
        /// com o prefixo presente.
        ///
        /// Por isso todo pedido leva o SEGREDO que o agente
        /// entregou na carga inicial. Quem esta jogando nao tem
        /// como sabe-lo - ele so existe na memoria dos dois lados
        /// e numa linha de RCON que o jogador nao ve.
        /// </summary>
        private const string BuyMarker = "#OZBUY#";

        /// <summary>
        /// Perguntando o saldo do jogador.
        ///
        /// O cabecalho e empurrado ao servidor sem jogador nenhum,
        /// entao ele nasce com um traco no lugar do numero. Este
        /// pedido, disparado quando a interface ABRE, e o que o
        /// preenche.
        /// </summary>
        private const string BalanceMarker = "#OZBAL#";

        /// <summary>Nome do elemento raiz. Precisa bater com ui-cui.ts.</summary>
        private const string RootName = "OrigemZUI";

        /// <summary>O que o agente poe no lugar do token da sessao.</summary>
        private const string TokenPlaceholder = "{token}";

        private const string LoadingName = "OrigemZUI.loading";

        /// <summary>
        /// Chave da imagem -> o CRC dela no FileStorage.
        ///
        /// #### POR QUE O AGENTE NAO PODE SABER ISTO ####
        ///
        /// O CUI desenha imagem propria por `png`, que e um numero
        /// do FileStorage do SERVIDOR. Esse numero so nasce quando
        /// os bytes sao guardados, e guardar so o servidor de Rust
        /// pode - o agente esta noutro processo.
        ///
        /// Entao o agente manda os BYTES e desenha a tela com um
        /// lugar reservado (`{img:ozcoin}`); aqui os bytes viram
        /// CRC, e o lugar reservado e trocado na hora de desenhar.
        /// O mesmo mecanismo do token da sessao, pelo mesmo
        /// motivo: o valor so existe em tempo de execucao.
        ///
        /// Vazio ate a primeira carga. Uma tela desenhada antes
        /// dela sai com o quadrado vazio, e a proxima ja vem
        /// certa - e por isso as imagens sao enviadas ANTES dos
        /// documentos.
        /// </summary>
        private readonly Dictionary<string, uint> _images = new Dictionary<string, uint>();

        /// <summary>
        /// O segredo que autentica os pedidos de compra.
        ///
        /// Vem do agente junto com os documentos e muda a cada
        /// reinicio dele. Vazio = compra desligada: sem segredo o
        /// agente descartaria o pedido em silencio, e e melhor
        /// dizer isso ao jogador do que deixar um botao que nao
        /// faz nada.
        /// </summary>
        private string _storeSecret;

        /// <summary>
        /// Quanto esperar antes de mostrar o aviso de carregando.
        ///
        /// Mostrado de imediato ele PISCARIA em toda navegacao
        /// rapida, que e pior que nao existir.
        /// </summary>
        private const float LoadingDelaySeconds = 0.25f;

        /// <summary>
        /// Depois disso, desiste e avisa o jogador.
        ///
        /// Sem timeout, o agente fora do ar deixaria o aviso de
        /// carregando na tela para sempre - e o jogador sem como
        /// sair da interface.
        /// </summary>
        private const float RequestTimeoutSeconds = 8f;

        // ====================================================
        //  CACHE
        // ====================================================

        private class ScreenCache
        {
            public string Id;
            public string Name;
            /// <summary>"page" ou "modal" — decide onde e desenhada.</summary>
            public string Kind;
            /// <summary>A lista de CuiElement, como veio do agente.</summary>
            public JArray Cui;
            /// <summary>Elementos do shell a atualizar (update:true).</summary>
            public JArray Updates;
            /// <summary>actionId -> o que aquela acao faz.</summary>
            public JObject Actions;
            /// <summary>
            /// NAO GUARDE ESTA TELA.
            ///
            /// As telas da loja sao montadas pelo agente a partir
            /// do banco: preco, etiqueta e saldo mudam entre um
            /// clique e o seguinte. Em cache, ela mostraria um
            /// preco que nao vale mais - e o jogador compraria
            /// confiando nele.
            /// </summary>
            public bool Volatile;
        }

        private class DocumentCache
        {
            public string Id;
            public string Command;
            public string Permission;
            public string EntryScreenId;
            /// <summary>
            /// O shell: desenhado UMA vez, na abertura.
            ///
            /// Vazio = documento antigo, em que cada tela desenha
            /// tudo. Os dois modos convivem de proposito.
            /// </summary>
            public JArray Shell;
            /// <summary>Elemento do shell que recebe o conteudo.</summary>
            public string ContentSlot;
            /// <summary>Elemento do shell onde os modais aparecem.</summary>
            public string ModalSlot;
            /// <summary>Telas JA baixadas. A de entrada vem na carga inicial.</summary>
            public Dictionary<string, ScreenCache> Screens = new Dictionary<string, ScreenCache>();
            /// <summary>Todas as telas que EXISTEM, baixadas ou nao.</summary>
            public Dictionary<string, string> ScreenIndex = new Dictionary<string, string>();
        }

        private readonly Dictionary<string, DocumentCache> _documents =
            new Dictionary<string, DocumentCache>();

        /// <summary>Comando de chat -> id do documento.</summary>
        private readonly Dictionary<string, string> _byCommand = new Dictionary<string, string>();

        /// <summary>
        /// Comandos de chat ja registrados no Oxide.
        ///
        /// O Oxide nao aceita registrar o mesmo comando duas vezes,
        /// e a carga inicial chega de novo a cada reconexao de
        /// RCON. Sem este controle, o segundo envio encheria o log
        /// de avisos.
        /// </summary>
        private readonly HashSet<string> _registeredCommands = new HashSet<string>();

        // ====================================================
        //  SESSAO
        //
        //  ####  E O QUE TORNA O CLIQUE CONFIAVEL  ####
        //
        //  O comando do botao vem do CLIENTE. A sessao responde
        //  as tres perguntas que o tornam seguro: este token e o
        //  deste jogador? a tela em que ele esta contem esta
        //  acao? ele tem a permissao do documento?
        // ====================================================
        private class Session
        {
            public string Token;
            public string DocumentId;
            public string ScreenId;

            /// <summary>
            /// A tela DESENHADA agora, com a tabela de acoes dela.
            ///
            /// #### POR QUE AQUI, E NAO NO CACHE DO DOCUMENTO ####
            ///
            /// A validacao do clique pergunta "esta acao esta na
            /// tela em que ele esta?". Antes ela ia buscar a
            /// resposta no cache do documento - e funcionava por
            /// acidente, porque toda tela era cacheada.
            ///
            /// As telas da loja NAO sao (ver ScreenCache.Volatile).
            /// Com elas, o cache ficava vazio e a validacao
            /// recusava tudo - inclusive o botao de FECHAR, o que
            /// travava o menu inteiro.
            ///
            /// Cache do documento e economia de rede. O que esta na
            /// tela do jogador e estado da SESSAO, e e aqui que ele
            /// mora.
            /// </summary>
            public ScreenCache CurrentScreen;

            /// <summary>O modal desenhado por cima, se houver.</summary>
            public ScreenCache CurrentModal;
            /// <summary>O shell ja foi desenhado para este jogador?</summary>
            public bool ShellDrawn;
            /// <summary>
            /// O modal aberto agora, se houver.
            ///
            /// Precisa ser lembrado porque as acoes DELE tambem
            /// valem enquanto ele estiver na tela: sem isto, o
            /// botao "confirmar" de um modal seria recusado pela
            /// validacao, que so olharia a pagina de tras.
            /// </summary>
            public string ModalScreenId;
            /// <summary>
            /// Compra em curso, se houver.
            ///
            /// #### E O QUE IMPEDE COBRAR DUAS VEZES ####
            ///
            /// Sem isto, dois cliques rapidos em "confirmar" sairiam
            /// como dois pedidos, e o agente cobraria os dois - ele
            /// nao tem como saber que era o mesmo dedo. O segundo
            /// clique e ignorado enquanto o primeiro nao responde.
            /// </summary>
            public string PendingBuyId;
            public Timer BuyTimeoutTimer;

            /// <summary>Pedido em curso, se houver.</summary>
            public string PendingRequestId;
            public string PendingScreenId;
            public Timer LoadingTimer;
            public Timer TimeoutTimer;
        }

        private readonly Dictionary<ulong, Session> _sessions = new Dictionary<ulong, Session>();

        /// <summary>requestId -> quem pediu. Some quando responde.</summary>
        private readonly Dictionary<string, ulong> _pending = new Dictionary<string, ulong>();

        /// <summary>O mesmo, para compras. Separado de proposito.</summary>
        private readonly Dictionary<string, ulong> _pendingBuys = new Dictionary<string, ulong>();

        private readonly System.Random _random = new System.Random();

        /// <summary>
        /// Rastro do caminho do clique no log do servidor.
        ///
        /// A validacao recusa em silencio (ver CmdAct), o que
        /// esconde tanto ataque quanto defeito nosso. Ligue com
        ///
        ///     origemz.ui.debug 1
        ///
        /// para ver onde ela parou. Desligado por padrao: com
        /// varios jogadores clicando, isto enche o log.
        /// </summary>
        private bool _debug;

        [ConsoleCommand("origemz.ui.debug")]
        private void CmdDebug(ConsoleSystem.Arg arg)
        {
            // So do console do servidor, nunca de um jogador.
            if (arg.Connection != null)
            {
                return;
            }

            _debug = !arg.HasArgs(1) || arg.GetString(0) != "0";
            arg.ReplyWith("{\"ok\":true,\"debug\":" + (_debug ? "true" : "false") + "}");
        }

        private void Trace(string message)
        {
            if (_debug)
            {
                Puts("[act] " + message);
            }
        }

        // ====================================================
        //  CICLO DE VIDA
        // ====================================================

        /// <summary>
        /// Pede a carga inicial assim que o plugin sobe.
        ///
        /// ####  SEM ISTO O MENU MORRE APOS UM RELOAD  ####
        ///
        /// Um `oxide.reload` esvazia este cache SEM derrubar o
        /// RCON - para o agente, nada aconteceu, e ele nao
        /// reenvia. O menu ficaria sem responder ate a rede de
        /// seguranca periodica do agente (5 min).
        ///
        /// O Puts leva o prefixo do plugin, que e o controle de
        /// origem que o agente exige.
        /// </summary>
        /// <summary>Quantas vezes ainda vale insistir pela carga.</summary>
        private int _asksLeft;
        private Timer _askTimer;

        private void OnServerInitialized()
        {
            // ####  UM PEDIDO SO NAO BASTA  ####
            //
            // O pedido sai durante o CARREGAMENTO do plugin, e
            // depende de o agente estar conectado e ouvindo naquele
            // instante. Ele nao esta, por exemplo, quando o
            // servidor acabou de subir e o RCON ainda nao abriu.
            //
            // Perder esse unico pedido deixa o menu MUDO ate a rede
            // de seguranca periodica do agente (5 min) - e nesse
            // meio-tempo /menu responde "Unknown command", porque o
            // comando de chat so e registrado quando a carga chega.
            //
            // Por isso ele insiste, e para assim que a carga chega.
            _asksLeft = 10;
            ScheduleAsk(1f);

            // O overlay de propagandas tem a MESMA necessidade e a
            // mesma cura: ele nasce vazio e o agente so reenviaria
            // na volta periodica (5 min). A diferenca e que aqui
            // nao ha `/menu` que revele o problema — o jogador
            // simplesmente nao ve propaganda nenhuma e ninguem
            // percebe.
            timer.Once(2f, AdsAskForConfig);
        }

        private void ScheduleAsk(float delay)
        {
            if (_askTimer != null)
            {
                _askTimer.Destroy();
                _askTimer = null;
            }

            _askTimer = timer.Once(delay, delegate
            {
                _askTimer = null;

                // Chegou: nao ha mais o que pedir.
                if (_documents.Count > 0)
                {
                    return;
                }

                if (_asksLeft <= 0)
                {
                    PrintWarning(
                        "o agente nao mandou as interfaces. /menu nao vai responder ate ele mandar - " +
                        "confira se o RustAgent esta no ar.");
                    return;
                }

                _asksLeft -= 1;
                AskForDocuments();

                // Espaca as tentativas: se o agente esta fora do ar,
                // insistir de segundo em segundo so enche o log.
                ScheduleAsk(5f);
            });
        }

        /// <summary>
        /// Pede a carga inicial ao agente.
        ///
        /// Separado do hook para poder ser disparado a mao no
        /// diagnostico (origemz.ui.reask) — sem isso nao ha como
        /// distinguir "o agente ignora o pedido" de "o pedido sai
        /// cedo demais, durante o carregamento".
        /// </summary>
        private void AskForDocuments()
        {
            Puts(RequestMarker + "{\"want\":\"documents\"}");
        }

        [ConsoleCommand("origemz.ui.reask")]
        private void CmdReask(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            AskForDocuments();
            arg.ReplyWith("{\"ok\":true}");
        }

        private void Unload()
        {
            if (_askTimer != null)
            {
                _askTimer.Destroy();
                _askTimer = null;
            }

            AdsStopEverything();

            // Sem isto, um oxide.reload deixaria a interface presa
            // na tela de quem estivesse com ela aberta - e sem
            // plugin para fechar.
            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                if (player == null)
                {
                    continue;
                }

                CuiHelper.DestroyUi(player, RootName);
                CuiHelper.DestroyUi(player, LoadingName);
                // O overlay tambem: ele fica na tela SEM menu
                // aberto, entao um reload sem isto o deixaria
                // congelado no canto para sempre.
                CuiHelper.DestroyUi(player, AdsRoot);
                CuiHelper.DestroyUi(player, AdsLogoName);
            }
        }

        /// <summary>
        /// Quem entra ganha o overlay.
        ///
        /// ####  E DEPOIS DE UM INSTANTE, DE PROPOSITO  ####
        ///
        /// O hook dispara antes de o cliente terminar de montar a
        /// propria interface. Um AddUi nesse momento chega e se
        /// perde — o elemento e criado e o cliente o descarta ao
        /// montar o HUD, sem erro nenhum. Dois segundos e o que
        /// separa "aparece" de "as vezes aparece".
        /// </summary>
        private void OnPlayerConnected(BasePlayer player)
        {
            if (player == null || !_adsEnabled)
            {
                return;
            }

            ulong userId = player.userID;

            timer.Once(2f, delegate
            {
                BasePlayer target = BasePlayer.FindByID(userId);

                if (target == null || !target.IsConnected || !_adsEnabled)
                {
                    return;
                }

                if (_adsDrawn.Contains(userId) || !AdsCanSee(target))
                {
                    return;
                }

                AdsDrawRoot(target);
            });
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player == null)
            {
                return;
            }

            ClearSession(player.userID);

            // Sem isto, o overlay continuaria mandando quadros para
            // um jogador que nao esta mais aqui — e os conjuntos
            // cresceriam a cada entrada e saida.
            _adsDrawn.Remove(player.userID);
            _adsInCycle.Remove(player.userID);
            _adsQueue.Remove(player.userID);
        }

        // ====================================================
        //  origemz.ui.doc  -  a carga inicial
        // ====================================================
        [ConsoleCommand(DocCommand)]
        private void CmdDoc(ConsoleSystem.Arg arg)
        {
            if (!arg.HasArgs(1))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            string json = DecodeBase64(arg.GetString(0));
            if (json == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_BASE64\"}");
                return;
            }

            JObject payload;
            try
            {
                payload = JObject.Parse(json);
            }
            catch (Exception)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_JSON\"}");
                return;
            }

            JArray documents = payload["documents"] as JArray;
            if (documents == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_PAYLOAD\"}");
                return;
            }

            // ####  MONTA TUDO ANTES DE TROCAR  ####
            //
            // O cache novo so substitui o antigo na ultima linha.
            // Assim um payload que estoure no meio deixa o menu
            // ANTERIOR funcionando, em vez de meio menu.
            Dictionary<string, DocumentCache> built = new Dictionary<string, DocumentCache>();
            Dictionary<string, string> byCommand = new Dictionary<string, string>();

            for (int i = 0; i < documents.Count; i++)
            {
                JObject item = documents[i] as JObject;
                if (item == null)
                {
                    continue;
                }

                DocumentCache document = BuildDocument(item);
                if (document == null)
                {
                    continue;
                }

                built[document.Id] = document;

                if (!string.IsNullOrEmpty(document.Command))
                {
                    byCommand[document.Command] = document.Id;
                }
            }

            // O segredo da loja vem no mesmo pacote. Ausente =
            // agente antigo: o menu carrega igual, so a compra
            // fica indisponivel.
            _storeSecret = (string)payload["secret"];

            _documents.Clear();
            foreach (KeyValuePair<string, DocumentCache> entry in built)
            {
                _documents[entry.Key] = entry.Value;
            }

            _byCommand.Clear();
            StringBuilder commands = new StringBuilder();

            foreach (KeyValuePair<string, string> entry in byCommand)
            {
                _byCommand[entry.Key] = entry.Value;
                RegisterChatCommand(entry.Key);

                if (commands.Length > 0)
                {
                    commands.Append(", ");
                }
                commands.Append('/');
                commands.Append(entry.Key);
            }

            InvalidateDrawnShells();

            // ####  ISTO PRECISA APARECER NO LOG  ####
            //
            // A resposta abaixo vai pelo RCON e NAO fica no log do
            // Oxide. Sem esta linha, "o menu nao abre" nao teria
            // como ser diagnosticado de fora: ninguem saberia
            // dizer se a carga chegou, quantos documentos vieram
            // ou qual comando ficou registrado.
            Puts(built.Count == 0
                ? "carga recebida, mas SEM documentos - nada foi registrado"
                : "carga recebida: " + built.Count.ToString() + " documento(s), comandos: " + commands);

            arg.ReplyWith("{\"ok\":true,\"documents\":" + built.Count.ToString() + "}");
        }

        // ====================================================
        //  origemz.ui.image  -  uma imagem nossa
        //
        //  Vem do AGENTE (arg.Connection == null), como os
        //  documentos. Os bytes vao para o FileStorage do
        //  servidor, e o CRC devolvido e o que o cliente usa.
        // ====================================================
        [ConsoleCommand(ImageCommand)]
        private void CmdImage(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(2))
            {
                return;
            }

            string key = arg.GetString(0);
            if (string.IsNullOrEmpty(key))
            {
                return;
            }

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(arg.GetString(1));
            }
            catch (Exception)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_BASE64\"}");
                return;
            }

            if (bytes.Length == 0)
            {
                return;
            }

            if (CommunityEntity.ServerInstance == null)
            {
                // O servidor ainda nao terminou de subir. A carga
                // periodica reenvia, entao isto se resolve sozinho.
                arg.ReplyWith("{\"ok\":false,\"error\":\"SERVER_NOT_READY\"}");
                return;
            }

            // O CRC sai dos BYTES, entao reenviar a mesma imagem
            // devolve o mesmo numero e nao acumula lixo.
            uint crc = FileStorage.server.Store(
                bytes,
                FileStorage.Type.png,
                CommunityEntity.ServerInstance.net.ID);

            _images[key] = crc;

            Puts("imagem " + key + ": " + bytes.Length + " bytes, crc " + crc);
            arg.ReplyWith("{\"ok\":true,\"crc\":" + crc + "}");
        }

        private DocumentCache BuildDocument(JObject item)
        {
            string id = (string)item["id"];
            if (string.IsNullOrEmpty(id))
            {
                return null;
            }

            DocumentCache document = new DocumentCache();
            document.Id = id;
            document.Command = (string)item["command"];
            document.Permission = (string)item["permission"];
            document.EntryScreenId = (string)item["entryScreenId"];
            document.Shell = item["shell"] as JArray;
            document.ContentSlot = (string)item["contentSlot"];
            document.ModalSlot = (string)item["modalSlot"];

            JArray index = item["screenIndex"] as JArray;
            if (index != null)
            {
                for (int i = 0; i < index.Count; i++)
                {
                    JObject reference = index[i] as JObject;
                    if (reference == null)
                    {
                        continue;
                    }

                    string screenId = (string)reference["id"];
                    if (!string.IsNullOrEmpty(screenId))
                    {
                        document.ScreenIndex[screenId] = (string)reference["name"];
                    }
                }
            }

            JArray screens = item["screens"] as JArray;
            if (screens != null)
            {
                for (int i = 0; i < screens.Count; i++)
                {
                    ScreenCache screen = BuildScreen(screens[i] as JObject);
                    if (screen != null)
                    {
                        document.Screens[screen.Id] = screen;
                    }
                }
            }

            // Permissao registrada aqui, e nao no Init: ela vem do
            // documento, e o documento so existe depois da carga.
            if (!string.IsNullOrEmpty(document.Permission) &&
                !permission.PermissionExists(document.Permission, this))
            {
                permission.RegisterPermission(document.Permission, this);
            }

            return document;
        }

        private ScreenCache BuildScreen(JObject item)
        {
            if (item == null)
            {
                return null;
            }

            string id = (string)item["id"];
            JArray cui = item["cui"] as JArray;

            if (string.IsNullOrEmpty(id) || cui == null)
            {
                return null;
            }

            ScreenCache screen = new ScreenCache();
            screen.Id = id;
            screen.Name = (string)item["name"];
            screen.Kind = (string)item["kind"];
            screen.Cui = cui;
            screen.Updates = item["updates"] as JArray;
            screen.Actions = item["actions"] as JObject;

            JToken isVolatile = item["volatile"];
            screen.Volatile = isVolatile != null && (bool)isVolatile;

            return screen;
        }

        private void RegisterChatCommand(string command)
        {
            if (_registeredCommands.Contains(command))
            {
                return;
            }

            _registeredCommands.Add(command);
            cmd.AddChatCommand(command, this, "HandleOpenChat");
        }

        // ====================================================
        //  /menu  -  abrir a interface
        //
        //  O nome do comando vem do DOCUMENTO: um documento com
        //  command "menu" responde a /menu. Trocar o comando no
        //  painel troca o comando no jogo.
        // ====================================================
        private void HandleOpenChat(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            string documentId;
            if (!_byCommand.TryGetValue(command, out documentId))
            {
                return;
            }

            DocumentCache document;
            if (!_documents.TryGetValue(documentId, out document))
            {
                return;
            }

            if (!CanUse(player, document))
            {
                player.ChatMessage(lang.GetMessage("NoPermission", this, player.UserIDString));
                return;
            }

            // ####  O MESMO COMANDO FECHA  ####
            //
            // Digitar /menu com o menu aberto FECHA, em vez de
            // redesenhar. E a segunda saida para quem ficou preso:
            // o chat continua funcionando mesmo com o cursor
            // liberado, e nem todo mundo sabe usar o F1.
            Session existing;
            if (_sessions.TryGetValue(player.userID, out existing) && existing.ShellDrawn)
            {
                ForceClose(player);
                return;
            }

            Open(player, document, document.EntryScreenId);
        }

        [ConsoleCommand(OpenCommand)]
        private void CmdOpen(ConsoleSystem.Arg arg)
        {
            // Vem do agente (painel), nao de jogador.
            if (arg.Connection != null)
            {
                return;
            }

            if (!arg.HasArgs(2))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            ulong steamId;
            if (!ulong.TryParse(arg.GetString(0), out steamId))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            BasePlayer player = BasePlayer.FindByID(steamId);
            if (player == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"PLAYER_NOT_FOUND\"}");
                return;
            }

            DocumentCache document;
            if (!_documents.TryGetValue(arg.GetString(1), out document))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"DOCUMENT_NOT_FOUND\"}");
                return;
            }

            Open(player, document, document.EntryScreenId);
            arg.ReplyWith("{\"ok\":true}");
        }

        // ====================================================
        //  origemz.ui.close  -  A SAIDA DE EMERGENCIA
        //
        //  ####  POR QUE ISTO EXISTE  ####
        //
        //  Uma interface presa na tela com o cursor liberado
        //  IMPEDE DE JOGAR: nao da para mirar, correr nem sair.
        //  E o botao de fechar, que seria a saida, e justamente
        //  o que pode ter parado de responder.
        //
        //  Este comando nao depende de sessao, de token nem de
        //  documento em cache - ele destroi os elementos pelo
        //  NOME e limpa o estado. Funciona mesmo com o cache
        //  vazio, que e quando mais se precisa dele.
        //
        //  Sem argumento, o jogador se livra sozinho pelo F1.
        //  Com steamId, um admin livra outra pessoa pelo RCON.
        // ====================================================
        [ConsoleCommand(CloseCommand)]
        private void CmdClose(ConsoleSystem.Arg arg)
        {
            // Do proprio jogador, pelo F1.
            if (arg.Connection != null)
            {
                BasePlayer self = BasePlayer.FindByID(arg.Connection.userid);
                if (self != null)
                {
                    ForceClose(self);
                }
                return;
            }

            // Do console do servidor: sem argumento, fecha de
            // TODO MUNDO. E o que se quer depois de um deploy que
            // deixou gente presa.
            if (!arg.HasArgs(1))
            {
                int count = 0;
                foreach (BasePlayer player in BasePlayer.activePlayerList)
                {
                    if (player == null)
                    {
                        continue;
                    }

                    ForceClose(player);
                    count++;
                }

                arg.ReplyWith("{\"ok\":true,\"closed\":" + count.ToString() + "}");
                return;
            }

            ulong steamId;
            if (!ulong.TryParse(arg.GetString(0), out steamId))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            BasePlayer target = BasePlayer.FindByID(steamId);
            if (target == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"PLAYER_NOT_FOUND\"}");
                return;
            }

            ForceClose(target);
            arg.ReplyWith("{\"ok\":true,\"closed\":1}");
        }

        /// <summary>
        /// Tira a interface da tela, aconteca o que acontecer.
        ///
        /// Destroi pelo NOME, sem depender de sessao ou cache: e
        /// isso que faz o comando funcionar justamente quando o
        /// estado esta inconsistente.
        /// </summary>
        private void ForceClose(BasePlayer player)
        {
            CuiHelper.DestroyUi(player, RootName);
            CuiHelper.DestroyUi(player, LoadingName);
            ClearSession(player.userID);
        }

        private bool CanUse(BasePlayer player, DocumentCache document)
        {
            if (string.IsNullOrEmpty(document.Permission))
            {
                return true;
            }

            return player.IsAdmin || permission.UserHasPermission(player.UserIDString, document.Permission);
        }

        /// <summary>
        /// Abre (ou navega para) uma tela.
        ///
        /// A sessao e criada aqui, com um token novo: e ele que
        /// autoriza os cliques dos botoes daquela tela.
        /// </summary>
        private void Open(BasePlayer player, DocumentCache document, string screenId)
        {
            // ####  VARRE O QUE FICOU DE ANTES  ####
            //
            // O aviso de carregando ja ficou preso sobre o JOGO,
            // sem menu atras: basta o agente reiniciar (ou uma
            // resposta se perder) com um pedido em voo, e o
            // elemento sobrevive a tudo que deveria remove-lo.
            //
            // Nao adianta so corrigir cada caminho que o deixa
            // orfao — sempre haverá um novo. Limpar na ABERTURA
            // fecha a questao: qualquer resto morre no primeiro
            // /menu, que e exatamente o que a pessoa faz quando ve
            // algo preso na tela.
            CuiHelper.DestroyUi(player, LoadingName);

            Session session;
            if (!_sessions.TryGetValue(player.userID, out session))
            {
                session = new Session();
                _sessions[player.userID] = session;
            }

            // Token novo a cada ABERTURA, nao a cada navegacao: a
            // interface continua sendo a mesma sessao enquanto ela
            // estiver na tela.
            if (string.IsNullOrEmpty(session.Token) || session.DocumentId != document.Id)
            {
                session.Token = NewToken();
            }

            bool firstDraw = !session.ShellDrawn;
            session.DocumentId = document.Id;

            OpenScreen(player, session, document, screenId);

            // So na ABERTURA, nao a cada navegacao: o saldo nao
            // muda por trocar de aba, e uma consulta por clique
            // seria uma ida a rede (carteira remota!) para nada.
            if (firstDraw)
            {
                RequestBalance(player);
            }
        }

        /// <summary>
        /// Mostra uma tela: do cache, ou pedindo ao agente.
        ///
        /// Vale para pagina e para modal — o `kind` da tela e que
        /// decide onde ela vai parar (ver Draw).
        /// </summary>
        private void OpenScreen(
            BasePlayer player,
            Session session,
            DocumentCache document,
            string screenId)
        {
            ScreenCache screen;
            if (document.Screens.TryGetValue(screenId, out screen))
            {
                Draw(player, session, document, screen);
                return;
            }

            // ####  O INDICE E UMA DICA, NAO UM PORTAO  ####
            //
            // Antes, uma tela fora do indice era recusada aqui em
            // silencio. Isso matava a loja inteira: as telas dela
            // sao GERADAS pelo agente e nunca estao no indice -
            // ele lista o que esta gravado no documento, e
            // `ozstore:recursos` ou `ozitem:ak:3` nao estao.
            //
            // O sintoma era o pior possivel: clicar na categoria
            // ou em COMPRAR nao fazia nada, sem erro, sem log.
            //
            // Agora pede sempre. Uma tela que de fato nao existe
            // custa uma ida ao agente e volta como
            // SCREEN_NOT_FOUND, que ja e tratado abaixo - e o
            // screenId vem do documento que o admin salvou, nunca
            // do cliente, entao nao ha o que inundar com isso.
            RequestScreen(player, session, document.Id, screenId);
        }

        /// <summary>
        /// Desenha uma tela.
        ///
        /// ####  E AQUI QUE O PISCAR FOI RESOLVIDO  ####
        ///
        /// Antes, cada navegacao destruia a raiz e recriava tudo:
        /// o jogador via o menu fechar e reabrir a cada clique.
        ///
        /// Agora, com shell:
        ///
        ///   1. o SHELL (moldura + cabecalho) e desenhado UMA vez,
        ///      na abertura, e nunca mais tocado;
        ///   2. navegar destroi so o CONTEUDO do slot e poe o novo;
        ///   3. a cor do botao ativo e ATUALIZADA no lugar
        ///      (update:true), sem recriar o botao.
        ///
        /// Nada do que fica parado na tela e recriado, entao nao
        /// ha o que piscar.
        ///
        /// Documento sem shell cai no caminho antigo - e o que
        /// mantem funcionando o que foi gravado antes disto.
        /// </summary>
        private void Draw(BasePlayer player, Session session, DocumentCache document, ScreenCache screen)
        {
            CancelPending(session);
            CuiHelper.DestroyUi(player, LoadingName);

            bool hasShell = document.Shell != null &&
                            document.Shell.Count > 0 &&
                            !string.IsNullOrEmpty(document.ContentSlot);

            // ####  MODAL NAO SUBSTITUI A PAGINA  ####
            //
            // Ele vai num slot proprio, POR CIMA. A pagina
            // continua embaixo, intacta, e fechar o modal volta
            // para ela sem redesenhar nada nem ir a rede.
            bool isModal = screen.Kind == "modal";

            if (isModal && hasShell && !string.IsNullOrEmpty(document.ModalSlot))
            {
                if (!session.ShellDrawn)
                {
                    // Modal sem a interface aberta nao faz sentido:
                    // ele nao tem o que cobrir.
                    return;
                }

                session.ModalScreenId = screen.Id;
                session.CurrentModal = screen;

                // Fecha um modal anterior antes de abrir o novo —
                // e o que permite a cadeia item -> quantidade ->
                // confirmar sem empilhar tres caixas na tela.
                CuiHelper.DestroyUi(player, ModalName(document));

                // ####  O CONTEINER NASCE AQUI, NAO NO SHELL  ####
                //
                // Ele ja morou no shell, cobrindo a tela inteira e
                // transparente - e ENGOLIA TODOS OS CLIQUES. No
                // Unity, alpha 0 nao desliga o raycast: um painel
                // invisivel por cima continua interceptando, e o
                // clique nem saia do cliente.
                //
                // Criando-o so agora, nao ha nada por cima
                // enquanto nao ha modal. E com o modal aberto,
                // bloquear o que esta atras passa a ser o
                // comportamento certo.
                // ####  UMA CHAMADA SO, NAO DUAS  ####
                //
                // Conteiner e conteudo iam em dois AddUi. Entre um
                // e outro o cliente ja tinha desenhado a caixa
                // vazia, e trocar a quantidade do modal fazia ele
                // piscar - some, aparece vazio, aparece cheio.
                //
                // Juntos, o cliente monta tudo de uma vez.
                JArray batch = JArray.Parse(ModalContainerJson(document));
                for (int i = 0; i < screen.Cui.Count; i++)
                {
                    batch.Add(screen.Cui[i].DeepClone());
                }

                CuiHelper.AddUi(player, Personalize(batch, session.Token));
                return;
            }

            // Daqui para baixo e PAGINA: trocar de pagina fecha
            // qualquer modal aberto.
            CloseModal(player, session, document);
            session.ScreenId = screen.Id;
            session.CurrentScreen = screen;

            if (!hasShell)
            {
                // Caminho antigo: a tela traz tudo, entao a raiz
                // inteira e refeita.
                CuiHelper.DestroyUi(player, RootName);
                CuiHelper.AddUi(player, Personalize(screen.Cui, session.Token));
                session.ShellDrawn = false;
                return;
            }

            if (!session.ShellDrawn)
            {
                CuiHelper.DestroyUi(player, RootName);
                CuiHelper.AddUi(player, Personalize(document.Shell, session.Token));
                session.ShellDrawn = true;
            }
            else
            {
                // ####  DESTRUIR O SLOT LEVA O SLOT JUNTO  ####
                //
                // O CUI nao sabe "apagar so os filhos": DestroyUi
                // apaga o elemento nomeado e tudo dentro dele. Com
                // o slot destruido, o conteudo novo tentava se
                // pendurar num pai que nao existia mais - e um
                // parent invalido faz o AddUI do CLIENTE lancar
                // NullReferenceException, o que DERRUBA O JOGADOR
                // do servidor.
                //
                // Por isso o slot e recriado, vazio, antes do
                // conteudo. O shell em volta continua intocado, que
                // e o que evita o piscar.
                CuiHelper.DestroyUi(player, ContentName(document));

                string slot = SlotJson(document, session.Token);
                if (slot == null)
                {
                    // Sem a definicao do slot nao da para recriar, e
                    // adicionar o conteudo agora derrubaria o
                    // jogador. Redesenhar tudo pisca uma vez - e
                    // muito melhor que desconectar.
                    session.ShellDrawn = false;
                    CuiHelper.DestroyUi(player, RootName);
                    CuiHelper.AddUi(player, Personalize(document.Shell, session.Token));
                    session.ShellDrawn = true;
                }
                else
                {
                    CuiHelper.AddUi(player, slot);
                }
            }

            CuiHelper.AddUi(player, Personalize(screen.Cui, session.Token));

            // O "voce esta aqui" da navegacao, sem recriar o botao.
            if (screen.Updates != null && screen.Updates.Count > 0)
            {
                CuiHelper.AddUi(player, Personalize(screen.Updates, session.Token));
            }
        }

        /// <summary>
        /// Nome do elemento que segura o conteudo.
        ///
        /// Precisa bater com o que o agente gera em ui-cui.ts
        /// (RootName + "." + id): e por este nome que o conteudo
        /// antigo e destruido.
        /// </summary>
        private string ContentName(DocumentCache document)
        {
            return RootName + "." + document.ContentSlot;
        }

        /// <summary>
        /// A definicao do slot de conteudo, VAZIA, tirada do shell.
        ///
        /// Serve para recria-lo depois de destruir o conteudo -
        /// ver o comentario em Draw. Os filhos sao descartados de
        /// proposito: o que se quer e a moldura vazia, pronta para
        /// receber a pagina nova.
        ///
        /// `null` quando o shell nao tem esse elemento, o que so
        /// acontece se as duas pontas divergirem.
        /// </summary>
        private string SlotJson(DocumentCache document, string token)
        {
            if (document.Shell == null)
            {
                return null;
            }

            string wanted = ContentName(document);

            for (int i = 0; i < document.Shell.Count; i++)
            {
                JObject element = document.Shell[i] as JObject;
                if (element == null || (string)element["name"] != wanted)
                {
                    continue;
                }

                JArray one = new JArray();
                one.Add(element.DeepClone());

                return one.ToString(Formatting.None).Replace(TokenPlaceholder, token);
            }

            return null;
        }

        /// <summary>Nome do elemento que segura os modais.</summary>
        private string ModalName(DocumentCache document)
        {
            return RootName + "." + document.ModalSlot;
        }

        /// <summary>
        /// O conteiner do modal: tela cheia, sobre o resto.
        ///
        /// Montado como JSON aqui, e nao vindo do agente, porque
        /// ele so pode EXISTIR enquanto ha modal aberto - ver o
        /// comentario em Draw.
        /// </summary>
        private string ModalContainerJson(DocumentCache document)
        {
            return "[{\"name\":\"" + ModalName(document) +
                   "\",\"parent\":\"" + RootName +
                   "\",\"components\":[" +
                   "{\"type\":\"UnityEngine.UI.Image\",\"color\":\"0 0 0 0\"}," +
                   "{\"type\":\"RectTransform\",\"anchormin\":\"0 0\",\"anchormax\":\"1 1\"}" +
                   "]}]";
        }

        /// <summary>
        /// Fecha o modal, deixando a pagina intacta.
        ///
        /// Destroi so o conteudo do slot de modal. A pagina por
        /// baixo nunca foi tocada, entao ela reaparece sem
        /// precisar ser redesenhada.
        /// </summary>
        private void CloseModal(BasePlayer player, Session session, DocumentCache document)
        {
            if (session.ModalScreenId == null)
            {
                return;
            }

            session.ModalScreenId = null;
            // As acoes do modal deixam de valer JUNTO com ele: sem
            // isto, o botao "confirmar" de um modal fechado ainda
            // passaria na validacao.
            session.CurrentModal = null;

            if (!string.IsNullOrEmpty(document.ModalSlot))
            {
                CuiHelper.DestroyUi(player, ModalName(document));
            }
        }

        /// <summary>
        /// A UNICA coisa que mexemos no JSON que o agente mandou.
        ///
        /// O token so existe em tempo de execucao, entao o agente
        /// o deixa como lugar reservado. Nada mais e reescrito.
        /// </summary>
        private string Personalize(JArray elements, string token)
        {
            string json = elements.ToString(Formatting.None).Replace(TokenPlaceholder, token);

            // As imagens proprias: `{img:ozcoin}` vira o CRC. So
            // percorre o mapa se houver o que trocar - a maioria
            // das telas nao usa imagem nossa.
            if (_images.Count > 0 && json.IndexOf("{img:") >= 0)
            {
                foreach (KeyValuePair<string, uint> image in _images)
                {
                    json = json.Replace("{img:" + image.Key + "}", image.Value.ToString());
                }
            }

            return json;
        }

        // ====================================================
        //  PEDIR UMA TELA AO AGENTE
        // ====================================================
        private void RequestScreen(BasePlayer player, Session session, string documentId, string screenId)
        {
            CancelPending(session);

            Trace("pedindo tela " + screenId +
                  (document_ScreenKnown(documentId, screenId) ? "" : " (gerada: nao esta no documento)"));

            string requestId = NewToken();
            session.PendingRequestId = requestId;
            session.PendingScreenId = screenId;
            _pending[requestId] = player.userID;

            // O aviso de carregando so aparece se DEMORAR. Ver
            // LoadingDelaySeconds.
            ulong userId = player.userID;
            session.LoadingTimer = timer.Once(LoadingDelaySeconds, delegate
            {
                ShowLoading(userId, requestId);
            });

            session.TimeoutTimer = timer.Once(RequestTimeoutSeconds, delegate
            {
                FailPending(userId, requestId);
            });

            // Puts: o Oxide prefixa a linha com o nome do plugin, e
            // e esse prefixo que o agente exige como controle de
            // origem - sem ele, alguem digitando o marcador no chat
            // forjaria um pedido.
            StringBuilder builder = new StringBuilder();
            builder.Append(RequestMarker);
            builder.Append("{\"requestId\":\"");
            builder.Append(requestId);
            builder.Append("\",\"documentId\":\"");
            builder.Append(documentId);
            builder.Append("\",\"screenId\":\"");
            builder.Append(screenId);
            builder.Append("\",\"steamId\":\"");
            builder.Append(player.UserIDString);
            builder.Append("\"}");

            Puts(builder.ToString());
        }

        /// <summary>
        /// A tela esta GRAVADA no documento, ou e gerada?
        ///
        /// So para o diagnostico: as duas sao pedidas do mesmo
        /// jeito. Saber de qual tipo era a tela que nao voltou e
        /// o que separa "o agente caiu" de "esse id nao existe".
        /// </summary>
        private bool document_ScreenKnown(string documentId, string screenId)
        {
            DocumentCache document;
            return _documents.TryGetValue(documentId, out document) &&
                   document.ScreenIndex.ContainsKey(screenId);
        }

        /// <summary>
        /// O aviso de "carregando".
        ///
        /// #### NAO E UM SPINNER ####
        ///
        /// O CUI nao anima rotacao: nao ha transform, nem
        /// keyframes. O que da para fazer e trocar o texto por
        /// timer, e isso custaria um timer por jogador esperando
        /// para animar tres pontinhos. Um aviso estatico diz a
        /// mesma coisa - "espera, esta vindo" - sem esse custo.
        /// </summary>
        private void ShowLoading(ulong userId, string requestId)
        {
            BasePlayer player = BasePlayer.FindByID(userId);
            if (player == null)
            {
                return;
            }

            Session session;
            if (!_sessions.TryGetValue(userId, out session) || session.PendingRequestId != requestId)
            {
                // A tela ja chegou. Nao mostra o aviso depois do
                // fato - seria um piscar sem motivo.
                return;
            }

            // ####  SEM MENU NAO HA O QUE CARREGAR  ####
            //
            // Este aviso roda 0,25 s DEPOIS do pedido. Nesse
            // intervalo o jogador pode ter fechado o menu — e ai
            // ele apareceria sozinho sobre o jogo, sem nada atras
            // e sem nada que o tire.
            if (!session.ShellDrawn)
            {
                return;
            }

            CuiElementContainer container = new CuiElementContainer();

            container.Add(new CuiPanel
            {
                Image = { Color = "0.06 0.06 0.06 0.85" },
                RectTransform =
                {
                    AnchorMin = "0.5 0.5",
                    AnchorMax = "0.5 0.5",
                    OffsetMin = "-90 -22",
                    OffsetMax = "90 22"
                }
            }, "Overlay", LoadingName);

            container.Add(new CuiLabel
            {
                Text =
                {
                    Text = lang.GetMessage("Loading", this, player.UserIDString),
                    FontSize = 14,
                    Font = "RobotoCondensed-Bold.ttf",
                    Align = TextAnchor.MiddleCenter,
                    // --text do painel.
                    Color = "0.91 0.91 0.91 1"
                },
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1" }
            }, LoadingName);

            CuiHelper.AddUi(player, container);
        }

        /// <summary>
        /// Pergunta o saldo ao agente, para o cabecalho.
        ///
        /// Sem resposta o traco continua no lugar do numero - o
        /// que e honesto. Por isso nao ha timeout nem aviso aqui:
        /// nada trava esperando por ele.
        /// </summary>
        private void RequestBalance(BasePlayer player)
        {
            if (string.IsNullOrEmpty(_storeSecret))
            {
                return;
            }

            StringBuilder builder = new StringBuilder();
            builder.Append(BalanceMarker);
            builder.Append("{\"secret\":\"");
            builder.Append(_storeSecret);
            builder.Append("\",\"steamId\":\"");
            builder.Append(player.UserIDString);
            builder.Append("\"}");

            Puts(builder.ToString());
        }

        // ====================================================
        //  origemz.ui.balance  -  o saldo chegou
        //
        //  Vem do AGENTE. Nao ha requestId: o saldo e um valor so,
        //  e receber duas vezes escreve o mesmo numero no mesmo
        //  lugar.
        // ====================================================
        [ConsoleCommand(BalanceCommand)]
        private void CmdBalance(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(2))
            {
                return;
            }

            Trace("[bal] recebido para " + arg.GetString(0));

            ulong userId;
            if (!ulong.TryParse(arg.GetString(0), out userId))
            {
                Trace("[bal] steamId invalido");
                return;
            }

            Session session;
            if (!_sessions.TryGetValue(userId, out session) || !session.ShellDrawn)
            {
                Trace("[bal] sem sessao ou shell nao desenhado");
                // Fechou o menu antes de a resposta chegar. Nao ha
                // onde escrever, e escrever num shell nao desenhado
                // criaria um elemento solto na tela.
                return;
            }

            BasePlayer player = BasePlayer.FindByID(userId);
            if (player == null)
            {
                return;
            }

            string json = DecodeBase64(arg.GetString(1));
            if (json == null)
            {
                return;
            }

            try
            {
                JArray updates = JArray.Parse(json);
                Trace("[bal] aplicando " + updates.Count + " update(s)");
                if (updates.Count > 0)
                {
                    CuiHelper.AddUi(player, Personalize(updates, session.Token));
                }
            }
            catch (Exception)
            {
                // JSON quebrado no transporte. O traco continua.
            }
        }

        /// <summary>
        /// O agente nao respondeu a tempo.
        ///
        /// Precisa avisar E tirar o aviso da tela: sem isso o
        /// jogador fica olhando "carregando" para sempre, sem
        /// saber que nada mais vem.
        /// </summary>
        private void FailPending(ulong userId, string requestId)
        {
            Session session;
            if (!_sessions.TryGetValue(userId, out session) || session.PendingRequestId != requestId)
            {
                return;
            }

            _pending.Remove(requestId);
            CancelPending(session);

            BasePlayer player = BasePlayer.FindByID(userId);
            if (player == null)
            {
                return;
            }

            CuiHelper.DestroyUi(player, LoadingName);
            player.ChatMessage(lang.GetMessage("ScreenUnavailable", this, player.UserIDString));
        }

        private void CancelPending(Session session)
        {
            if (session.LoadingTimer != null)
            {
                session.LoadingTimer.Destroy();
                session.LoadingTimer = null;
            }

            if (session.TimeoutTimer != null)
            {
                session.TimeoutTimer.Destroy();
                session.TimeoutTimer = null;
            }

            session.PendingRequestId = null;
            session.PendingScreenId = null;
        }

        // ====================================================
        //  origemz.ui.screen  -  a tela pedida chegou
        // ====================================================
        [ConsoleCommand(ScreenCommand)]
        private void CmdScreen(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(1))
            {
                return;
            }

            string json = DecodeBase64(arg.GetString(0));
            if (json == null)
            {
                return;
            }

            JObject payload;
            try
            {
                payload = JObject.Parse(json);
            }
            catch (Exception)
            {
                return;
            }

            string requestId = (string)payload["requestId"];
            if (string.IsNullOrEmpty(requestId))
            {
                return;
            }

            ulong userId;
            if (!_pending.TryGetValue(requestId, out userId))
            {
                // Pedido que ja expirou, ou resposta repetida. Nao e
                // erro: o timeout ja avisou o jogador.
                return;
            }

            _pending.Remove(requestId);

            BasePlayer player = BasePlayer.FindByID(userId);
            Session session;

            if (!_sessions.TryGetValue(userId, out session))
            {
                // ####  A SESSAO SUMIU COM O PEDIDO EM VOO  ####
                //
                // O jogador fechou o menu enquanto a tela vinha. A
                // resposta chega para ninguem — mas o AVISO de
                // carregando pode ter sido desenhado, e sem isto
                // ele fica sobre o jogo, sem menu atras.
                ClearLoading(player);
                return;
            }

            if (player == null)
            {
                return;
            }

            // O agente respondeu com erro (tela apagada no meio do
            // caminho, banco fora). Avisa em vez de deixar girando.
            string error = (string)payload["error"];
            if (!string.IsNullOrEmpty(error))
            {
                CancelPending(session);
                CuiHelper.DestroyUi(player, LoadingName);
                player.ChatMessage(lang.GetMessage("ScreenUnavailable", this, player.UserIDString));
                return;
            }

            ScreenCache screen = BuildScreen(payload["screen"] as JObject);
            if (screen == null)
            {
                CancelPending(session);
                CuiHelper.DestroyUi(player, LoadingName);
                return;
            }

            DocumentCache document;
            string documentId = (string)payload["documentId"];
            if (!screen.Volatile && documentId != null &&
                _documents.TryGetValue(documentId, out document))
            {
                // Guarda em cache: a segunda visita a esta tela nao
                // vai a rede. Telas volateis ficam de fora - ver
                // ScreenCache.Volatile.
                document.Screens[screen.Id] = screen;
            }

            // Se o jogador navegou para OUTRA coisa enquanto isso,
            // a tela que chegou nao e mais a que ele quer ver.
            //
            // O aviso NAO e removido aqui: o pedido novo tem o
            // proprio, e apaga-lo faria a tela seguinte piscar
            // sem aviso nenhum no meio.
            if (session.PendingScreenId != screen.Id)
            {
                return;
            }

            DocumentCache owner;
            if (!_documents.TryGetValue(session.DocumentId, out owner))
            {
                return;
            }

            Draw(player, session, owner, screen);
        }

        // ====================================================
        //  origemz.ui.act  -  O CLIQUE
        //
        //  ####  AQUI E ONDE A SEGURANCA ACONTECE  ####
        //
        //  Este comando vem do CLIENTE. Qualquer jogador pode
        //  digita-lo no F1 com os argumentos que quiser, tendo
        //  aberto a interface ou nao.
        //
        //  Por isso ele nao carrega o que fazer - carrega um
        //  endereco. Tres validacoes, nesta ordem:
        //
        //    1. o token e o da sessao DESTE jogador?
        //    2. a tela em que ele esta AGORA contem esta acao?
        //    3. ele tem a permissao do documento?
        //
        //  So entao a acao e executada, e o que se executa vem do
        //  documento que o admin salvou - nunca do argumento.
        // ====================================================
        [ConsoleCommand(ActCommand)]
        private void CmdAct(ConsoleSystem.Arg arg)
        {
            Trace("recebido: " + (arg.Args == null ? "(sem args)" : string.Join(" ", arg.Args)));

            // O jogador sai da CONEXAO que enviou o comando, e nao
            // de um argumento: e o que amarra o clique a quem
            // clicou. Um argumento com steamId seria escolhido pelo
            // cliente, e a validacao inteira perderia o sentido.
            if (arg.Connection == null || !arg.HasArgs(2))
            {
                Trace("recusado: sem conexao ou sem os dois argumentos");
                return;
            }

            BasePlayer player = BasePlayer.FindByID(arg.Connection.userid);
            if (player == null)
            {
                return;
            }

            Session session;
            if (!_sessions.TryGetValue(player.userID, out session))
            {
                // Sem sessao aberta. Um clique forjado cai aqui.
                Trace("recusado: jogador sem sessao aberta");
                return;
            }

            // 1. O token.
            if (string.IsNullOrEmpty(session.Token) || session.Token != arg.GetString(0))
            {
                Trace("recusado: token nao confere (sessao=" + (session.Token ?? "null") +
                      " recebido=" + arg.GetString(0) + ")");
                return;
            }

            DocumentCache document;
            if (!_documents.TryGetValue(session.DocumentId, out document))
            {
                Trace("recusado: documento " + (session.DocumentId ?? "null") + " nao esta em cache");
                return;
            }

            // 3. A permissao, revalidada a cada clique: ela pode
            // ter sido removida com a interface ainda aberta.
            if (!CanUse(player, document))
            {
                Close(player);
                return;
            }

            // 2. A acao pertence ao que esta NA TELA agora?
            //
            // E o que impede alguem de usar um token valido para
            // disparar a acao de outra tela - o botao "comprar" de
            // uma loja que ele nem abriu.
            //
            // "Na tela" sao ate DUAS telas: a pagina e, se houver,
            // o modal aberto por cima dela. Olhar so a pagina
            // recusaria o botao "confirmar" de um modal legitimo.
            string actionId = arg.GetString(1);
            JObject action = FindAction(session.CurrentScreen, actionId);

            if (action == null)
            {
                action = FindAction(session.CurrentModal, actionId);
            }

            if (action == null)
            {
                Trace("recusado: acao " + actionId + " nao esta na tela " +
                      (session.ScreenId ?? "null") +
                      (session.ModalScreenId == null ? "" : " nem no modal " + session.ModalScreenId));
                return;
            }

            Trace("ok: " + actionId + " -> " + (string)action["kind"]);
            Execute(player, session, document, action);
        }

        /// <summary>
        /// A acao existe NESTA tela? Devolve o que ela faz.
        ///
        /// A tela vem da SESSAO - o que esta desenhado agora - e
        /// nao do cache do documento. Ver Session.CurrentScreen.
        /// </summary>
        private JObject FindAction(ScreenCache screen, string actionId)
        {
            if (screen == null || screen.Actions == null)
            {
                return null;
            }

            return screen.Actions[actionId] as JObject;
        }

        private void Execute(BasePlayer player, Session session, DocumentCache document, JObject action)
        {
            string kind = (string)action["kind"];

            if (kind == "close")
            {
                Close(player);
                return;
            }

            if (kind == "modal.close")
            {
                CloseModal(player, session, document);
                return;
            }

            if (kind == "modal.open")
            {
                string target = (string)action["screenId"];
                if (!string.IsNullOrEmpty(target))
                {
                    OpenScreen(player, session, document, target);
                }
                return;
            }

            if (kind == "navigate")
            {
                string target = (string)action["screenId"];
                if (!string.IsNullOrEmpty(target))
                {
                    Open(player, document, target);
                }
                return;
            }

            if (kind == "chat")
            {
                // Roda COMO O JOGADOR: e o que "/tpa" significa.
                string command = (string)action["command"];
                if (!string.IsNullOrEmpty(command))
                {
                    player.SendConsoleCommand("chat.say", command);
                }
                return;
            }

            if (kind == "console")
            {
                // Roda com autoridade do SERVIDOR - e o comando vem
                // do documento salvo pelo admin, nunca do que
                // chegou no argumento.
                string command = (string)action["command"];
                if (!string.IsNullOrEmpty(command))
                {
                    // ConsoleSystem.Run com Option.Server: roda com
                    // autoridade do SERVIDOR, sem passar pela
                    // conexao de ninguem.
                    ConsoleSystem.Run(
                        ConsoleSystem.Option.Server,
                        command.Replace("{steamid}", player.UserIDString));
                }
                return;
            }

            if (kind == "store.buy")
            {
                RequestBuy(player, session, action);
            }
        }

        // ====================================================
        //  A COMPRA
        //
        //  ####  O PLUGIN NAO SABE PRECO  ####
        //
        //  Ele manda o que a ACAO diz - offerId e quantidade - e o
        //  agente cobra pelo que esta no banco dele. O valor nunca
        //  passa por aqui, entao nao ha o que adulterar no caminho.
        //
        //  A acao, por sua vez, so chega aqui se estiver na tela em
        //  que o jogador esta agora (ver CmdAct). O clique carrega
        //  um endereco, nunca uma intencao.
        // ====================================================
        private void RequestBuy(BasePlayer player, Session session, JObject action)
        {
            if (string.IsNullOrEmpty(_storeSecret))
            {
                // Sem segredo o agente descartaria o pedido em
                // silencio. Dizer e melhor que um botao morto.
                player.ChatMessage(lang.GetMessage("StoreUnavailable", this, player.UserIDString));
                return;
            }

            if (!string.IsNullOrEmpty(session.PendingBuyId))
            {
                // Segundo clique com o primeiro ainda no ar. Ver
                // Session.PendingBuyId: cobrar duas vezes por um
                // dedo nervoso e o pior desfecho possivel aqui.
                Trace("compra ignorada: ja existe uma em curso");
                return;
            }

            string offerId = (string)action["offerId"];
            if (string.IsNullOrEmpty(offerId))
            {
                return;
            }

            int quantity = 1;
            JToken raw = action["quantity"];
            if (raw != null)
            {
                quantity = (int)raw;
            }
            if (quantity < 1)
            {
                quantity = 1;
            }

            string requestId = NewToken();
            session.PendingBuyId = requestId;
            _pendingBuys[requestId] = player.userID;

            // ####  O BOTAO SAI DA FRENTE AGORA  ####
            //
            // ISTO ACONTECEU DE VERDADE: o agente reiniciou entre
            // o clique e a resposta, o aviso nunca chegou, e o
            // jogador — vendo o mesmo botao — comprou o barco duas
            // vezes.
            //
            // `PendingBuyId` ja barrava o segundo clique, mas so
            // ate o timeout de 8 s. Passado ele, o botao voltava a
            // funcionar com a primeira compra ainda em curso.
            //
            // Fechar o modal resolve pela raiz: nao ha o que
            // clicar. Quem quiser comprar de novo precisa navegar
            // de volta, e no caminho ve a mensagem do que houve.
            DocumentCache document;
            if (_documents.TryGetValue(session.DocumentId, out document))
            {
                CloseModal(player, session, document);
            }

            ulong userId = player.userID;
            session.BuyTimeoutTimer = timer.Once(RequestTimeoutSeconds, delegate
            {
                FailBuy(userId, requestId);
            });

            // Puts: o Oxide prefixa a linha com o nome do plugin, e
            // o agente exige esse prefixo. O SEGREDO e o que separa
            // isto de uma linha digitada no chat - ver BuyMarker.
            StringBuilder builder = new StringBuilder();
            builder.Append(BuyMarker);
            builder.Append("{\"requestId\":\"");
            builder.Append(requestId);
            builder.Append("\",\"secret\":\"");
            builder.Append(_storeSecret);
            builder.Append("\",\"steamId\":\"");
            // Da CONEXAO, nunca de argumento: e o que amarra a
            // cobranca a quem clicou.
            builder.Append(player.UserIDString);
            builder.Append("\",\"offerId\":\"");
            builder.Append(offerId);
            builder.Append("\",\"quantity\":");
            builder.Append(quantity);
            // Em qual menu desenhar o aviso de resultado. O agente
            // nao tem como saber qual o jogador abriu.
            builder.Append(",\"documentId\":\"");
            builder.Append(session.DocumentId);

            // ####  E EM QUAL PAGINA ELE ESTAVA  ####
            //
            // ISTO EXISTE POR UM DEFEITO VISIVEL: depois de pegar um
            // kit, o card continuava dizendo RESGATAR. A pagina
            // atras do modal nao e redesenhada — e ela e justamente
            // a que mudou.
            //
            // Com a pagina no pedido, o agente monta o botao OK do
            // aviso como uma NAVEGACAO de volta para ela. O plugin
            // ja sabe fazer isso: navegar fecha o modal e pede a
            // tela de novo, e a tela vem do banco de AGORA.
            //
            // `session.ScreenId` e sempre uma pagina: o Draw so o
            // atualiza fora do caminho de modal.
            builder.Append("\",\"screenId\":\"");
            builder.Append(session.ScreenId);
            builder.Append("\"}");

            Puts(builder.ToString());
        }

        /// <summary>
        /// O agente nao respondeu a tempo.
        ///
        /// #### O QUE ISTO NAO SIGNIFICA ####
        ///
        /// Nao significa que a compra falhou: ela pode ter sido
        /// concluida e so a resposta ter se perdido. Por isso a
        /// mensagem manda CONFERIR o inventario, em vez de dizer
        /// que deu errado - e por isso ela nao convida a tentar de
        /// novo, que seria arriscar pagar duas vezes.
        /// </summary>
        private void FailBuy(ulong userId, string requestId)
        {
            Session session;
            if (!_sessions.TryGetValue(userId, out session) || session.PendingBuyId != requestId)
            {
                return;
            }

            session.PendingBuyId = null;
            session.BuyTimeoutTimer = null;
            _pendingBuys.Remove(requestId);

            BasePlayer player = BasePlayer.FindByID(userId);
            if (player != null)
            {
                ClearLoading(player);
                player.ChatMessage(lang.GetMessage("BuyTimeout", this, player.UserIDString));
            }
        }

        // ====================================================
        //  origemz.ui.buyresult  -  O DESFECHO
        //
        //  Vem do AGENTE (arg.Connection == null), como as telas.
        //  A frase ja chega pronta: trocar o que a loja diz nao
        //  pode exigir recompilar este arquivo.
        // ====================================================
        [ConsoleCommand(BuyResultCommand)]
        private void CmdBuyResult(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(1))
            {
                return;
            }

            string json = DecodeBase64(arg.GetString(0));
            if (json == null)
            {
                return;
            }

            JObject payload;
            try
            {
                payload = JObject.Parse(json);
            }
            catch (Exception)
            {
                return;
            }

            string requestId = (string)payload["requestId"];
            if (string.IsNullOrEmpty(requestId))
            {
                return;
            }

            ulong userId;
            if (!_pendingBuys.TryGetValue(requestId, out userId))
            {
                // Ja expirou, ou resposta repetida.
                return;
            }

            _pendingBuys.Remove(requestId);

            BasePlayer player = BasePlayer.FindByID(userId);
            Session session;

            if (!_sessions.TryGetValue(userId, out session))
            {
                return;
            }

            session.PendingBuyId = null;
            if (session.BuyTimeoutTimer != null)
            {
                session.BuyTimeoutTimer.Destroy();
                session.BuyTimeoutTimer = null;
            }

            if (player == null)
            {
                return;
            }

            DocumentCache document;
            if (!_documents.TryGetValue(session.DocumentId, out document))
            {
                // Sem documento nao ha onde desenhar. O chat ainda
                // conta o que aconteceu.
                string orphan = (string)payload["message"];
                if (!string.IsNullOrEmpty(orphan))
                {
                    player.ChatMessage(orphan);
                }
                return;
            }

            // ####  O SALDO DO CABECALHO VEM PRIMEIRO  ####
            //
            // Ele ficava DEPOIS do aviso, e o `return` daquele
            // caminho o pulava: a compra dizia "saldo 9.700" no
            // modal e o cabecalho continuava com o valor antigo,
            // na mesma tela, ao mesmo tempo.
            //
            // Aplicar antes de qualquer saida e o que garante que
            // nenhum caminho novo repita isso.
            //
            // `update: true` troca o texto no lugar - recriar o
            // elemento faria o cabecalho piscar.
            JArray updates = payload["updates"] as JArray;
            if (updates != null && updates.Count > 0 && session.ShellDrawn)
            {
                CuiHelper.AddUi(player, Personalize(updates, session.Token));
            }

            // ####  O AVISO E UM MODAL, COM UM OK  ####
            //
            // A mensagem de chat aparece atras do menu, no canto, e
            // some sozinha. Quem acabou de gastar OZCoin ficava
            // olhando a loja sem saber se funcionou - e clicava de
            // novo. O modal exige um OK.
            //
            // Ele SUBSTITUI o modal da compra: desenhar um modal ja
            // destroi o anterior.
            ScreenCache result = BuildScreen(payload["screen"] as JObject);
            if (result != null)
            {
                Draw(player, session, document, result);
                return;
            }

            // Sem tela (agente antigo, ou documento sumido do lado
            // de la): o chat e o caminho de sempre.
            string message = (string)payload["message"];
            if (!string.IsNullOrEmpty(message))
            {
                player.ChatMessage(message);
            }

            JToken close = payload["closeModal"];
            if (close != null && (bool)close && session.ModalScreenId != null)
            {
                CloseModal(player, session, document);
            }
        }

        private void Close(BasePlayer player)
        {
            // Destruir a raiz leva o modal junto: ele e filho dela.
            CuiHelper.DestroyUi(player, RootName);
            CuiHelper.DestroyUi(player, LoadingName);
            ClearSession(player.userID);
        }

        /// <summary>
        /// Tira o aviso de carregando, doa no que der.
        ///
        /// #### ELE JA FICOU PRESO NA TELA ####
        ///
        /// Com um pedido em voo e o menu fechando (ou o agente
        /// reiniciando), o aviso continuava sobre o JOGO — sem
        /// menu atras, sem nada que o tirasse, e sem o jogador
        /// entender de onde veio.
        ///
        /// Chamado de todo caminho que termina um pedido, e nao
        /// so do caminho feliz.
        /// </summary>
        private void ClearLoading(BasePlayer player)
        {
            if (player != null)
            {
                CuiHelper.DestroyUi(player, LoadingName);
            }
        }

        /// <summary>
        /// Uma carga nova invalida o shell ja desenhado.
        ///
        /// Sem isto, quem estivesse com o menu aberto na hora de
        /// uma edicao continuaria vendo o cabecalho ANTIGO, com o
        /// conteudo novo por baixo.
        /// </summary>
        private void InvalidateDrawnShells()
        {
            foreach (KeyValuePair<ulong, Session> entry in _sessions)
            {
                entry.Value.ShellDrawn = false;
            }
        }

        /// <summary>
        /// Encerra a sessao e INVALIDA o token.
        ///
        /// E o que impede um clique com token velho de funcionar
        /// depois de a interface ter sido fechada.
        /// </summary>
        private void ClearSession(ulong userId)
        {
            Session session;
            if (_sessions.TryGetValue(userId, out session))
            {
                CancelPending(session);

                // A compra em curso perde o dono. O agente ainda
                // vai responder, e a resposta cai no vazio - o que
                // esta certo: a compra ACONTECEU no servidor, e o
                // item foi entregue ou estornado la. O que se
                // perde e so o aviso na tela de quem ja saiu.
                if (!string.IsNullOrEmpty(session.PendingBuyId))
                {
                    _pendingBuys.Remove(session.PendingBuyId);
                    session.PendingBuyId = null;
                }

                if (session.BuyTimeoutTimer != null)
                {
                    session.BuyTimeoutTimer.Destroy();
                    session.BuyTimeoutTimer = null;
                }

                _sessions.Remove(userId);
            }
        }

        // ====================================================
        //  AUXILIARES
        // ====================================================

        /// <summary>
        /// Base64 nao e enfeite.
        ///
        /// MEDIDO no servidor real: o parser de console do Rust
        /// COME AS ASPAS de um JSON passado cru como argumento. A
        /// informacao se perde ANTES de o plugin ver, entao nao ha
        /// remontagem que desfaca. Base64 nao tem aspas, nem
        /// espaco, nem chave.
        /// </summary>
        private string DecodeBase64(string encoded)
        {
            if (string.IsNullOrEmpty(encoded))
            {
                return null;
            }

            try
            {
                return Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Token de sessao / id de pedido.
        ///
        /// Alfabeto restrito porque ele viaja num comando de
        /// console separado por ESPACO: um token com espaco
        /// deslocaria os argumentos.
        /// </summary>
        private string NewToken()
        {
            const string alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
            StringBuilder builder = new StringBuilder(12);

            for (int i = 0; i < 12; i++)
            {
                builder.Append(alphabet[_random.Next(alphabet.Length)]);
            }

            return builder.ToString();
        }

        // ====================================================
        // ====================================================
        //
        //   O OVERLAY DE PROPAGANDAS
        //
        //   ####  ELE NAO E UM MENU, E POR ISSO MORA AQUI  ####
        //
        //   Um documento de interface abre por comando, tem
        //   sessao, token e telas que trocam sob clique. O
        //   overlay nao tem nada disso: aparece sozinho, para
        //   todo mundo, e o que ele faz e se MEXER.
        //
        //   O que ele reaproveita deste plugin e o resto — o
        //   canal de RCON, o FileStorage das imagens e a mesma
        //   troca de lugares reservados. Um plugin separado
        //   duplicaria as tres coisas.
        //
        //   ####  ESTE CODIGO NAO SABE ANIMAR  ####
        //
        //   Ele recebe QUADROS prontos do agente (`at` em
        //   milissegundos + o CUI daquele instante) e faz uma
        //   coisa so: no instante certo, manda o que esta no
        //   quadro. E um toca-discos.
        //
        //   A matematica das animacoes mora em
        //   core/src/game/ads-timeline.ts, onde ela tem teste —
        //   aqui nao teria, porque nao ha servidor de Rust no CI.
        //
        //   ####  DOIS RELOGIOS, E ELES SAO INDEPENDENTES  ####
        //
        //   O do BALANCO do logo roda sempre, e vale para quem
        //   esta com o logo na tela. O do CICLO abre o painel de
        //   tempos em tempos, e vale para quem tem propaganda
        //   para ver.
        //
        //   Um so nao serviria: uma propaganda restrita por
        //   permissao deixaria quem nao a ve sem nada acontecendo
        //   — e com o logo congelado, porque o relogio estaria
        //   ocupado com o painel dos outros.
        // ====================================================
        // ====================================================

        private const string AdsConfigCommand = "origemz.ads.config";
        private const string AdsShowCommand = "origemz.ads.show";
        private const string AdsHideCommand = "origemz.ads.hide";
        private const string AdsTestCommand = "origemz.ads.test";

        private const string AdsImageBeginCommand = "origemz.ads.image.begin";
        private const string AdsImagePartCommand = "origemz.ads.image.part";
        private const string AdsImageEndCommand = "origemz.ads.image.end";

        /// <summary>O marcador do pedido de recarga. Ver ads-sync.ts.</summary>
        private const string AdsRequestMarker = "#OZADSREQ#";

        /// <summary>A raiz do overlay. Precisa bater com ads-timeline.ts.</summary>
        private const string AdsRoot = "OrigemZAds";

        /// <summary>
        /// O logo.
        ///
        /// ####  ELE NEM SEMPRE E FILHO DA RAIZ  ####
        ///
        /// Com "logo em lugar proprio" ligado, o agente o pendura
        /// direto na CAMADA do jogo: a raiz e o retangulo do
        /// painel, no canto, e um logo no alto e ao centro nao
        /// cabe dentro dela.
        ///
        /// A consequencia e que `DestroyUi(AdsRoot)` NAO o leva
        /// junto — e sem destrui-lo a parte, ele ficaria na tela
        /// para sempre depois de desligar o overlay. Por isso todo
        /// lugar que limpa a raiz limpa este nome tambem.
        /// </summary>
        private const string AdsLogoName = "OrigemZAds.logo";

        private const string AdImagePlaceholder = "{adimage}";
        private const string AdAnchorMinPlaceholder = "{adanchormin}";
        private const string AdAnchorMaxPlaceholder = "{adanchormax}";
        private const string AdBackgroundPlaceholder = "{adbg}";

        /// <summary>Uma propaganda, como o agente a manda.</summary>
        private class AdItem
        {
            public string Id;
            /// <summary>A chave da imagem (modo stored) ou a URL.</summary>
            public string Image;
            public int DisplayMs;
            public string AnchorMin;
            public string AnchorMax;
            public string Background;
            public int Weight;
            /// <summary>Quem pode VER esta. Vazio = todo mundo.</summary>
            public string Permission;
        }

        /// <summary>Uma animacao: quadros com o instante de cada um.</summary>
        private class AdAnimation
        {
            public int DurationMs;
            /// <summary>Os quadros, na ordem, como vieram.</summary>
            public JArray Frames = new JArray();
        }

        private bool _adsEnabled;
        private string _adsLayer = "Hud";
        private string _adsPermission;
        private JArray _adsRoot;
        private AdAnimation _adsOpening = new AdAnimation();
        private AdAnimation _adsEnter = new AdAnimation();
        private AdAnimation _adsExit = new AdAnimation();
        private AdAnimation _adsClosing = new AdAnimation();
        private readonly List<AdItem> _adsItems = new List<AdItem>();

        private int _adsIntervalMs = 300000;

        /// <summary>
        /// Quem baixa a imagem: "stored" ou "url".
        ///
        /// So decide UMA coisa aqui: se vale a pena pre-carregar.
        /// Ver AdsPreload.
        /// </summary>
        private string _adsImageMode = "stored";

        /// <summary>
        /// O logo tem lugar proprio?
        ///
        /// Decide UMA coisa aqui: quem recebe o balanco. No lugar
        /// padrao o logo E o painel recolhido — ele some quando o
        /// painel abre, e balancar so faz sentido para quem esta
        /// fora do ciclo.
        ///
        /// Com lugar proprio ele fica na tela o tempo todo, e
        /// continuar pulando quem esta vendo o painel o deixaria
        /// CONGELADO no meio da tela enquanto a propaganda passa
        /// ao lado.
        /// </summary>
        private bool _adsLogoDetached;
        private string _adsOrderMode = "sequential";
        private int _adsPerCycle = 3;

        /// <summary>
        /// Quem esta com o overlay DESENHADO.
        ///
        /// Nao e a lista de quem esta online: um jogador sem a
        /// permissao do overlay nunca entra aqui, e quem entrou
        /// antes de a permissao ser tirada sai na proxima carga.
        /// </summary>
        private readonly HashSet<ulong> _adsDrawn = new HashSet<ulong>();

        /// <summary>Quem esta vendo o PAINEL agora (nao o logo).</summary>
        private readonly HashSet<ulong> _adsInCycle = new HashSet<ulong>();

        /// <summary>
        /// A fila da vez, por jogador.
        ///
        /// Cada um tem a sua porque a permissao e por jogador: no
        /// mesmo instante, um ve a propaganda de VIP e outro ve a
        /// do Discord. Os TEMPOS, esses, sao os mesmos para todos.
        /// </summary>
        private readonly Dictionary<ulong, List<int>> _adsQueue = new Dictionary<ulong, List<int>>();

        /// <summary>Onde o rodizio sequencial parou, entre ciclos.</summary>
        private int _adsCursor;

        private Timer _adsCycleTimer;
        private Timer _adsStepTimer;

        /// <summary>Um ciclo esta em curso? Impede dois ao mesmo tempo.</summary>
        private bool _adsCycleRunning;

        /// <summary>
        /// As imagens chegando em pedacos.
        ///
        /// ####  POR QUE EM PEDACOS  ####
        ///
        /// O frame do WebRCON aguenta ~50 KB, e base64 infla o
        /// arquivo em 4/3. Uma propaganda de 600x200 nao cabe num
        /// comando so — o `origemz.ui.image` serve ao icone de 17
        /// KB do menu e nao a isto.
        ///
        /// Os pedacos ficam aqui ate o `end`, que confere a
        /// contagem antes de guardar. Meio arquivo nunca vira
        /// imagem: um PNG cortado no meio e um arquivo invalido, e
        /// o sintoma seria um quadrado vazio sem nada dizer por
        /// que.
        /// </summary>
        private readonly Dictionary<string, byte[][]> _adsImageParts =
            new Dictionary<string, byte[][]>();

        // ----------------------------------------------------
        //  origemz.ads.image.begin / .part / .end
        // ----------------------------------------------------
        [ConsoleCommand(AdsImageBeginCommand)]
        private void CmdAdsImageBegin(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(2))
            {
                return;
            }

            string key = arg.GetString(0);
            int parts = arg.GetInt(1);

            // 128 pedacos de 27 KB dao ~3,4 MB — bem acima do teto
            // do agente (1,5 MB). O que este limite impede e um
            // `begin` com um numero absurdo alocando um array
            // gigante antes de qualquer byte chegar.
            if (string.IsNullOrEmpty(key) || parts <= 0 || parts > 128)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            _adsImageParts[key] = new byte[parts][];
            arg.ReplyWith("{\"ok\":true}");
        }

        [ConsoleCommand(AdsImagePartCommand)]
        private void CmdAdsImagePart(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(3))
            {
                return;
            }

            string key = arg.GetString(0);
            int index = arg.GetInt(1);

            byte[][] parts;
            if (!_adsImageParts.TryGetValue(key, out parts))
            {
                // Chegou sem o `begin`: o agente reiniciou no meio,
                // ou a ordem se perdeu. Descartar e o certo — a
                // proxima carga reenvia tudo.
                arg.ReplyWith("{\"ok\":false,\"error\":\"NO_BEGIN\"}");
                return;
            }

            if (index < 0 || index >= parts.Length)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"BAD_INDEX\"}");
                return;
            }

            try
            {
                parts[index] = Convert.FromBase64String(arg.GetString(2));
            }
            catch (Exception)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_BASE64\"}");
                return;
            }

            arg.ReplyWith("{\"ok\":true}");
        }

        [ConsoleCommand(AdsImageEndCommand)]
        private void CmdAdsImageEnd(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(1))
            {
                return;
            }

            string key = arg.GetString(0);

            byte[][] parts;
            if (!_adsImageParts.TryGetValue(key, out parts))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"NO_BEGIN\"}");
                return;
            }

            _adsImageParts.Remove(key);

            // ####  FALTOU PEDACO: DESCARTA  ####
            //
            // Guardar um PNG incompleto no FileStorage daria um CRC
            // valido para um arquivo que o cliente nao monta — o
            // pior desfecho, porque parece que funcionou.
            int total = 0;
            for (int i = 0; i < parts.Length; i++)
            {
                if (parts[i] == null)
                {
                    PrintWarning("imagem " + key + ": faltou o pedaco " + i + ", descartada");
                    arg.ReplyWith("{\"ok\":false,\"error\":\"MISSING_PART\"}");
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

            if (CommunityEntity.ServerInstance == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"SERVER_NOT_READY\"}");
                return;
            }

            // O CRC sai dos BYTES, entao reenviar a mesma imagem
            // devolve o mesmo numero e nao acumula lixo.
            uint crc = FileStorage.server.Store(
                bytes,
                FileStorage.Type.png,
                CommunityEntity.ServerInstance.net.ID);

            _images[key] = crc;

            Puts("propaganda " + key + ": " + bytes.Length + " bytes em " +
                 parts.Length + " pedaco(s), crc " + crc);
            arg.ReplyWith("{\"ok\":true,\"crc\":" + crc + "}");
        }

        // ----------------------------------------------------
        //  origemz.ads.config  -  a carga do overlay
        // ----------------------------------------------------
        [ConsoleCommand(AdsConfigCommand)]
        private void CmdAdsConfig(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(1))
            {
                return;
            }

            string json = DecodeBase64(arg.GetString(0));
            if (json == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_BASE64\"}");
                return;
            }

            JObject payload;
            try
            {
                payload = JObject.Parse(json);
            }
            catch (Exception)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_JSON\"}");
                return;
            }

            AdsStopEverything();

            JToken enabled = payload["enabled"];
            _adsEnabled = enabled != null && (bool)enabled;

            if (!_adsEnabled)
            {
                // ####  DESLIGAR PRECISA APAGAR  ####
                //
                // Sem isto, quem estivesse com o overlay na tela
                // ficaria com ele la, congelado, ate o servidor
                // reiniciar.
                AdsClearAll();
                Puts("overlay de propagandas DESLIGADO");
                arg.ReplyWith("{\"ok\":true,\"enabled\":false}");
                return;
            }

            _adsLayer = (string)payload["layer"];
            _adsImageMode = (string)payload["imageMode"];

            JToken detached = payload["logoDetached"];
            _adsLogoDetached = detached != null && (bool)detached;
            _adsPermission = (string)payload["permission"];
            _adsRoot = payload["root"] as JArray;

            JObject animations = payload["animations"] as JObject;
            _adsOpening = AdsAnimationFrom(animations, "opening");
            _adsEnter = AdsAnimationFrom(animations, "adEnter");
            _adsExit = AdsAnimationFrom(animations, "adExit");
            _adsClosing = AdsAnimationFrom(animations, "closing");

            JObject cycle = payload["cycle"] as JObject;
            if (cycle != null)
            {
                _adsIntervalMs = AdsInt(cycle["intervalMs"], 300000);
                _adsOrderMode = (string)cycle["orderMode"];
                _adsPerCycle = AdsInt(cycle["adsPerCycle"], 0);
            }

            _adsItems.Clear();
            JArray ads = payload["ads"] as JArray;

            if (ads != null)
            {
                for (int i = 0; i < ads.Count; i++)
                {
                    JObject item = ads[i] as JObject;
                    if (item == null)
                    {
                        continue;
                    }

                    AdItem ad = new AdItem();
                    ad.Id = (string)item["id"];
                    ad.Image = (string)item["image"];
                    ad.DisplayMs = AdsInt(item["displayMs"], 8000);
                    ad.AnchorMin = (string)item["anchorMin"];
                    ad.AnchorMax = (string)item["anchorMax"];
                    ad.Background = (string)item["background"];
                    ad.Weight = AdsInt(item["weight"], 1);
                    ad.Permission = (string)item["permission"];

                    if (!string.IsNullOrEmpty(ad.Permission) &&
                        !permission.PermissionExists(ad.Permission, this))
                    {
                        permission.RegisterPermission(ad.Permission, this);
                    }

                    _adsItems.Add(ad);
                }
            }

            if (!string.IsNullOrEmpty(_adsPermission) &&
                !permission.PermissionExists(_adsPermission, this))
            {
                permission.RegisterPermission(_adsPermission, this);
            }

            AdsRedrawAll();

            // RETOMA, nao reinicia: a carga chega a cada 5 minutos e
            // a cada edicao no painel, e zerar a contagem aqui fazia
            // o ciclo nunca disparar sozinho. Ver AdsResumeCycle.
            AdsResumeCycle();

            // ####  ISTO PRECISA APARECER NO LOG  ####
            //
            // A resposta abaixo vai pelo RCON e NAO fica no log do
            // Oxide. Sem esta linha, "a propaganda nao aparece" nao
            // teria como ser diagnosticado de fora.
            //
            // O "proximo em Xs" e o que separa "o ciclo esta parado"
            // de "o ciclo esta contando" — e foi a falta dele que
            // deixou o relogio zerado passar despercebido. Fica
            // DEPOIS do reagendamento, senao mostraria o valor
            // antigo.
            int remaining = (int)Math.Max(0f, _adsNextCycleAt - Time.realtimeSinceStartup);

            Puts("overlay: " + _adsItems.Count + " propaganda(s), ciclo a cada " +
                 (_adsIntervalMs / 1000) + "s (proximo em " + remaining + "s), logo " +
                 (_adsLogoDetached ? "em lugar proprio" : "no canto do painel"));

            arg.ReplyWith("{\"ok\":true,\"ads\":" + _adsItems.Count + "}");
        }

        private AdAnimation AdsAnimationFrom(JObject animations, string name)
        {
            AdAnimation animation = new AdAnimation();

            if (animations == null)
            {
                return animation;
            }

            JObject item = animations[name] as JObject;
            if (item == null)
            {
                return animation;
            }

            animation.DurationMs = AdsInt(item["durationMs"], 0);

            JArray frames = item["frames"] as JArray;
            if (frames != null)
            {
                animation.Frames = frames;
            }

            return animation;
        }

        private int AdsInt(JToken token, int fallback)
        {
            if (token == null)
            {
                return fallback;
            }

            try
            {
                return (int)token;
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        // ----------------------------------------------------
        //  QUEM VE O QUE
        // ----------------------------------------------------

        /// <summary>O jogador pode ver o overlay?</summary>
        private bool AdsCanSee(BasePlayer player)
        {
            if (player == null || !player.IsConnected)
            {
                return false;
            }

            if (string.IsNullOrEmpty(_adsPermission))
            {
                return true;
            }

            return AdsAllows(player, _adsPermission);
        }

        /// <summary>
        /// O jogador pode ver ESTA propaganda?
        ///
        /// ####  GRUPO OU PERMISSAO, E NAO UM OU OUTRO  ####
        ///
        /// No Oxide as duas coisas existem e sao diferentes:
        /// `vip` costuma ser um GRUPO, e `origemz.vip.usar` uma
        /// PERMISSAO. Quem administra pensa em "mostrar para o
        /// grupo VIP" e escolhe da lista sem saber (nem precisar
        /// saber) em qual das duas familias aquele nome cai.
        ///
        /// Testar so uma delas faria metade das escolhas da lista
        /// nao funcionar — em silencio, porque uma propaganda que
        /// nao aparece e indistinguivel de uma propaganda fora do
        /// horario.
        /// </summary>
        private bool AdsCanSeeItem(BasePlayer player, AdItem ad)
        {
            if (string.IsNullOrEmpty(ad.Permission))
            {
                return true;
            }

            return AdsAllows(player, ad.Permission);
        }

        private bool AdsAllows(BasePlayer player, string groupOrPermission)
        {
            if (permission.GroupExists(groupOrPermission))
            {
                return permission.UserHasGroup(player.UserIDString, groupOrPermission);
            }

            return permission.UserHasPermission(player.UserIDString, groupOrPermission);
        }

        // ----------------------------------------------------
        //  origemz.ui.audience  -  os grupos e as permissoes
        //
        //  ####  A LISTA PRECISA VIR DO SERVIDOR  ####
        //
        //  O painel oferecia um campo de texto livre para
        //  "permissao", e um nome digitado errado (`vips` em vez de
        //  `vip`) nao da erro nenhum: a propaganda simplesmente
        //  nao aparece para ninguem, e nao ha como distinguir isso
        //  de "ainda nao chegou a hora dela".
        //
        //  Com a lista de verdade na tela, o erro deixa de ser
        //  possivel.
        // ----------------------------------------------------
        [ConsoleCommand("origemz.ui.audience")]
        private void CmdAudience(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            StringBuilder builder = new StringBuilder();
            builder.Append("{\"ok\":true,\"groups\":[");

            string[] groups = permission.GetGroups();
            for (int i = 0; i < groups.Length; i++)
            {
                if (i > 0) builder.Append(',');
                builder.Append('"').Append(groups[i]).Append('"');
            }

            builder.Append("],\"permissions\":[");

            string[] permissions = permission.GetPermissions();
            for (int i = 0; i < permissions.Length; i++)
            {
                if (i > 0) builder.Append(',');
                builder.Append('"').Append(permissions[i]).Append('"');
            }

            builder.Append("]}");
            arg.ReplyWith(builder.ToString());
        }

        /// <summary>
        /// Desenha (ou apaga) o overlay de todo mundo que esta
        /// online, conforme a permissao.
        /// </summary>
        private void AdsRedrawAll()
        {
            _adsDrawn.Clear();
            _adsInCycle.Clear();
            _adsQueue.Clear();

            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                if (player == null)
                {
                    continue;
                }

                CuiHelper.DestroyUi(player, AdsRoot);
                CuiHelper.DestroyUi(player, AdsLogoName);

                if (!AdsCanSee(player))
                {
                    continue;
                }

                AdsDrawRoot(player);
            }
        }

        private void AdsDrawRoot(BasePlayer player)
        {
            if (_adsRoot == null || _adsRoot.Count == 0)
            {
                return;
            }

            CuiHelper.AddUi(player, PersonalizeAds(_adsRoot, null));
            _adsDrawn.Add(player.userID);

            AdsPreload(player);
        }

        /// <summary>
        /// Faz o cliente BAIXAR as imagens antes de precisar delas.
        ///
        /// ####  O QUADRADO PRETO NO MEIO DA CARTA  ####
        ///
        /// ISTO ACONTECEU DE VERDADE. No modo `url` quem baixa e o
        /// CLIENTE, e enquanto ele busca o endereco desenha o
        /// quadrado de "carregando" do proprio Rust. Como o
        /// elemento da imagem e RECRIADO a cada troca, esse
        /// quadrado aparecia no meio de toda virada de carta — a
        /// propaganda entrava preta e so depois virava imagem.
        ///
        /// A cura e baixar ANTES: estes elementos nascem junto com
        /// o logo, invisiveis, e ficam ali durante os minutos de
        /// repouso. Quando o painel abre, a textura ja esta no
        /// cliente e a troca e instantanea.
        ///
        /// ####  POR QUE 1x1 E TRANSPARENTE  ####
        ///
        /// O download comeca quando o componente e CRIADO, e nao
        /// quando ele fica visivel. Um pixel transparente no canto
        /// nao aparece para ninguem, nao recebe clique e nao pesa —
        /// e e o suficiente para o cliente ir buscar o arquivo.
        ///
        /// No modo `stored` isto nao existe: la a imagem vem pelo
        /// canal do jogo, do FileStorage do proprio servidor, e nao
        /// ha download nenhum para adiantar.
        /// </summary>
        private void AdsPreload(BasePlayer player)
        {
            if (_adsImageMode != "url" || _adsItems.Count == 0)
            {
                return;
            }

            StringBuilder builder = new StringBuilder();
            builder.Append('[');

            int written = 0;

            for (int i = 0; i < _adsItems.Count; i++)
            {
                AdItem ad = _adsItems[i];

                if (string.IsNullOrEmpty(ad.Image) || !AdsCanSeeItem(player, ad))
                {
                    // Pre-carregar o que ele nao pode ver seria
                    // gastar a banda dele com uma imagem que nunca
                    // vai aparecer na tela dele.
                    continue;
                }

                if (written > 0)
                {
                    builder.Append(',');
                }

                builder.Append("{\"name\":\"").Append(AdsPreloadName(i));
                builder.Append("\",\"parent\":\"").Append(AdsRoot);
                builder.Append("\",\"components\":[");
                builder.Append("{\"type\":\"UnityEngine.UI.RawImage\",\"color\":\"1 1 1 0\",\"url\":\"");
                builder.Append(ad.Image);
                builder.Append("\"},");
                builder.Append("{\"type\":\"RectTransform\",\"anchormin\":\"0 0\",\"anchormax\":\"0 0\",");
                builder.Append("\"offsetmin\":\"0 0\",\"offsetmax\":\"1 1\"}");
                builder.Append("]}");

                written++;
            }

            builder.Append(']');

            if (written == 0)
            {
                return;
            }

            CuiHelper.AddUi(player, builder.ToString());
        }

        private string AdsPreloadName(int index)
        {
            return AdsRoot + ".pre" + index;
        }

        private void AdsClearAll()
        {
            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                if (player != null)
                {
                    CuiHelper.DestroyUi(player, AdsRoot);
                    CuiHelper.DestroyUi(player, AdsLogoName);
                }
            }

            _adsDrawn.Clear();
            _adsInCycle.Clear();
            _adsQueue.Clear();
        }

        // ----------------------------------------------------
        //  O CICLO
        // ----------------------------------------------------

        /// <summary>
        /// Quando o proximo ciclo deve comecar.
        ///
        /// Em `Time.realtimeSinceStartup`, e nao em segundos
        /// restantes: e o que permite RETOMAR a contagem depois de
        /// uma carga nova — ver AdsResumeCycle.
        /// </summary>
        private float _adsNextCycleAt;

        private void AdsScheduleCycle()
        {
            AdsKillTimer(ref _adsCycleTimer);

            if (!_adsEnabled || _adsItems.Count == 0)
            {
                // Sem propaganda nenhuma o overlay fica no logo, e
                // isso e o comportamento certo — nao um defeito.
                return;
            }

            float seconds = _adsIntervalMs / 1000f;

            _adsNextCycleAt = Time.realtimeSinceStartup + seconds;
            _adsCycleTimer = timer.Once(seconds, AdsStartCycle);
        }

        /// <summary>
        /// Reagenda o ciclo SEM perder o tempo que ja passou.
        ///
        /// ####  ISTO ACONTECEU DE VERDADE  ####
        ///
        /// O agente reenvia a configuracao a cada 5 minutos (rede
        /// de seguranca para o `oxide.reload`) e a cada edicao no
        /// painel. Enquanto a carga nova chamava
        /// `AdsScheduleCycle`, o relogio do ciclo VOLTAVA A ZERO a
        /// cada reenvio.
        ///
        /// Com os dois na mesma cadencia (300 s), a carga chegava
        /// cerca de um segundo ANTES de o ciclo disparar — e o
        /// zerava. O sintoma era exato: a propaganda nunca aparecia
        /// sozinha, so pelo botao "Mostrar no jogo". E mexer no
        /// painel piorava, porque cada salvamento reiniciava a
        /// contagem de novo.
        ///
        /// Aqui o que se preserva e o INSTANTE do proximo ciclo. A
        /// contagem so recomeca do zero quando ela ainda nao
        /// existia, ja passou, ou o intervalo encolheu — que sao
        /// justamente os casos em que reiniciar e o certo.
        /// </summary>
        private void AdsResumeCycle()
        {
            AdsKillTimer(ref _adsCycleTimer);

            if (!_adsEnabled || _adsItems.Count == 0)
            {
                return;
            }

            float seconds = _adsIntervalMs / 1000f;
            float remaining = _adsNextCycleAt - Time.realtimeSinceStartup;

            if (remaining <= 0f || remaining > seconds)
            {
                // Primeira carga, contagem vencida, ou o admin
                // ENCURTOU o intervalo (e ai esperar o prazo antigo
                // seria ignorar o que ele acabou de pedir).
                AdsScheduleCycle();
                return;
            }

            _adsCycleTimer = timer.Once(remaining, AdsStartCycle);
        }

        private void AdsStartCycle()
        {
            if (!_adsEnabled || _adsCycleRunning)
            {
                // ####  UM CICLO POR VEZ  ####
                //
                // Dois ciclos sobrepostos mandariam quadros de
                // animacoes diferentes para o mesmo elemento, e o
                // painel ficaria tremendo entre dois estados.
                AdsScheduleCycle();
                return;
            }

            // A fila de cada jogador, ja filtrada pela permissao
            // dele. Quem nao tem nenhuma propaganda para ver fica
            // de fora do ciclo — e continua com o logo balancando.
            _adsQueue.Clear();
            _adsInCycle.Clear();

            foreach (ulong userId in _adsDrawn)
            {
                BasePlayer player = BasePlayer.FindByID(userId);
                if (player == null || !player.IsConnected)
                {
                    continue;
                }

                List<int> queue = AdsQueueFor(player);
                if (queue.Count == 0)
                {
                    continue;
                }

                _adsQueue[userId] = queue;
                _adsInCycle.Add(userId);
            }

            if (_adsInCycle.Count == 0)
            {
                AdsScheduleCycle();
                return;
            }

            _adsCycleRunning = true;
            _adsCursor++;

            AdsPlay(_adsOpening, null, 0, AdsShowSlot0);
        }

        /// <summary>
        /// A fila deste jogador, na ordem em que ele vai ver.
        ///
        /// Sequencial gira um cursor GLOBAL: sem ele, todo ciclo
        /// comecaria pela primeira propaganda e as do fim da lista
        /// nunca apareceriam.
        ///
        /// Aleatorio sorteia por PESO, sem repetir dentro do
        /// ciclo.
        /// </summary>
        private List<int> AdsQueueFor(BasePlayer player)
        {
            List<int> allowed = new List<int>();

            for (int i = 0; i < _adsItems.Count; i++)
            {
                if (AdsCanSeeItem(player, _adsItems[i]))
                {
                    allowed.Add(i);
                }
            }

            List<int> queue = new List<int>();

            if (allowed.Count == 0)
            {
                return queue;
            }

            int slots = _adsPerCycle > 0 ? _adsPerCycle : allowed.Count;
            if (slots > allowed.Count)
            {
                slots = allowed.Count;
            }

            if (_adsOrderMode == "random")
            {
                List<int> pool = new List<int>(allowed);

                for (int taken = 0; taken < slots && pool.Count > 0; taken++)
                {
                    int totalWeight = 0;
                    for (int i = 0; i < pool.Count; i++)
                    {
                        int weight = _adsItems[pool[i]].Weight;
                        totalWeight += weight < 1 ? 1 : weight;
                    }

                    int roll = _random.Next(totalWeight);
                    int chosen = pool.Count - 1;

                    for (int i = 0; i < pool.Count; i++)
                    {
                        int weight = _adsItems[pool[i]].Weight;
                        roll -= weight < 1 ? 1 : weight;

                        if (roll < 0)
                        {
                            chosen = i;
                            break;
                        }
                    }

                    queue.Add(pool[chosen]);
                    pool.RemoveAt(chosen);
                }

                return queue;
            }

            for (int taken = 0; taken < slots; taken++)
            {
                queue.Add(allowed[(_adsCursor + taken) % allowed.Count]);
            }

            return queue;
        }

        /// <summary>Quantos slots o ciclo tem — o maior das filas.</summary>
        private int AdsSlotCount()
        {
            int max = 0;

            foreach (KeyValuePair<ulong, List<int>> entry in _adsQueue)
            {
                if (entry.Value.Count > max)
                {
                    max = entry.Value.Count;
                }
            }

            return max;
        }

        private void AdsShowSlot0()
        {
            AdsShowSlot(0);
        }

        /// <summary>
        /// Mostra o slot `index` do ciclo.
        ///
        /// ####  A PROPAGANDA E POR JOGADOR; O TEMPO, NAO  ####
        ///
        /// No mesmo instante, um jogador ve a de VIP e outro a do
        /// Discord — mas os dois veem a carta girar ao mesmo
        /// tempo. E o que permite UM relogio para todo o servidor.
        /// </summary>
        private void AdsShowSlot(int index)
        {
            if (!_adsEnabled)
            {
                AdsFinishCycle();
                return;
            }

            if (index >= AdsSlotCount())
            {
                AdsPlay(_adsClosing, null, 0, AdsFinishCycle);
                return;
            }

            // Agrupa por PROPAGANDA: o JSON de um quadro e montado
            // uma vez por imagem, e nao uma vez por jogador.
            Dictionary<int, List<BasePlayer>> byAd = new Dictionary<int, List<BasePlayer>>();

            foreach (KeyValuePair<ulong, List<int>> entry in _adsQueue)
            {
                BasePlayer player = BasePlayer.FindByID(entry.Key);
                if (player == null || !player.IsConnected || entry.Value.Count == 0)
                {
                    continue;
                }

                // Modulo: quem tem menos propagandas que o ciclo
                // repete as dele em vez de ficar com o painel
                // vazio nos slots que sobram.
                int adIndex = entry.Value[index % entry.Value.Count];

                List<BasePlayer> audience;
                if (!byAd.TryGetValue(adIndex, out audience))
                {
                    audience = new List<BasePlayer>();
                    byAd[adIndex] = audience;
                }

                audience.Add(player);
            }

            if (byAd.Count == 0)
            {
                AdsFinishCycle();
                return;
            }

            // ####  O SLOT DURA O MAIOR DOS TEMPOS  ####
            //
            // No mesmo slot, jogadores diferentes podem estar
            // vendo propagandas diferentes (a permissao e por
            // jogador). Usar o MENOR tempo cortaria a propaganda
            // de alguem pela metade; o maior faz todo mundo ver a
            // sua inteira, ao preco de o painel ficar parado mais
            // tempo para quem tem a mais curta.
            int displayMs = 0;

            foreach (KeyValuePair<int, List<BasePlayer>> entry in byAd)
            {
                AdItem ad = _adsItems[entry.Key];
                if (ad.DisplayMs > displayMs)
                {
                    displayMs = ad.DisplayMs;
                }
            }

            if (displayMs <= 0)
            {
                displayMs = 8000;
            }

            AdsPlayPerAd(_adsEnter, byAd, 0, delegate
            {
                // Fica parado o tempo da propaganda. ZERO trafego
                // aqui: nada se move, e nada precisa ser mandado.
                _adsStepTimer = timer.Once(displayMs / 1000f, delegate
                {
                    AdsPlayPerAd(_adsExit, byAd, 0, delegate
                    {
                        AdsShowSlot(index + 1);
                    });
                });
            });
        }

        private void AdsFinishCycle()
        {
            _adsCycleRunning = false;
            _adsInCycle.Clear();
            _adsQueue.Clear();

            AdsScheduleCycle();
        }

        // ----------------------------------------------------
        //  O TOCA-DISCOS
        // ----------------------------------------------------

        /// <summary>
        /// Toca uma animacao, quadro a quadro, e chama `onDone`.
        ///
        /// UM timer por vez, e nao um por quadro: agendar quinze
        /// timers de uma vez deixaria quinze objetos vivos que
        /// ninguem consegue cancelar se o ciclo for interrompido no
        /// meio.
        /// </summary>
        private void AdsPlay(AdAnimation animation, AdItem ad, int index, Action onDone)
        {
            if (!_adsEnabled)
            {
                return;
            }

            if (animation == null || index >= animation.Frames.Count)
            {
                if (onDone != null)
                {
                    onDone();
                }
                return;
            }

            JObject frame = animation.Frames[index] as JObject;
            List<BasePlayer> audience = AdsCycleAudience();

            AdsApplyFrame(frame, audience, ad);

            int at = frame == null ? 0 : AdsInt(frame["at"], 0);
            int nextAt = animation.DurationMs;

            if (index + 1 < animation.Frames.Count)
            {
                JObject next = animation.Frames[index + 1] as JObject;
                nextAt = next == null ? at : AdsInt(next["at"], at);
            }

            int delay = nextAt - at;
            if (delay < 0)
            {
                delay = 0;
            }

            int nextIndex = index + 1;
            _adsStepTimer = timer.Once(delay / 1000f, delegate
            {
                AdsPlay(animation, ad, nextIndex, onDone);
            });
        }

        /// <summary>
        /// O mesmo, mas com uma propaganda DIFERENTE por grupo.
        ///
        /// E o que faz a mesma carta girar ao mesmo tempo na tela
        /// de todo mundo, mostrando conteudos diferentes.
        /// </summary>
        private void AdsPlayPerAd(
            AdAnimation animation,
            Dictionary<int, List<BasePlayer>> byAd,
            int index,
            Action onDone)
        {
            if (!_adsEnabled)
            {
                return;
            }

            if (animation == null || index >= animation.Frames.Count)
            {
                if (onDone != null)
                {
                    onDone();
                }
                return;
            }

            JObject frame = animation.Frames[index] as JObject;

            foreach (KeyValuePair<int, List<BasePlayer>> entry in byAd)
            {
                AdsApplyFrame(frame, entry.Value, _adsItems[entry.Key]);
            }

            int at = frame == null ? 0 : AdsInt(frame["at"], 0);
            int nextAt = animation.DurationMs;

            if (index + 1 < animation.Frames.Count)
            {
                JObject next = animation.Frames[index + 1] as JObject;
                nextAt = next == null ? at : AdsInt(next["at"], at);
            }

            int delay = nextAt - at;
            if (delay < 0)
            {
                delay = 0;
            }

            int nextIndex = index + 1;
            _adsStepTimer = timer.Once(delay / 1000f, delegate
            {
                AdsPlayPerAd(animation, byAd, nextIndex, onDone);
            });
        }

        /// <summary>Quem esta vendo o PAINEL agora.</summary>
        private List<BasePlayer> AdsCycleAudience()
        {
            List<BasePlayer> audience = new List<BasePlayer>();

            foreach (ulong userId in _adsInCycle)
            {
                BasePlayer player = BasePlayer.FindByID(userId);
                if (player != null && player.IsConnected)
                {
                    audience.Add(player);
                }
            }

            return audience;
        }

        /// <summary>
        /// Manda UM quadro para uma plateia.
        ///
        /// ####  O JSON E MONTADO UMA VEZ  ####
        ///
        /// Serializar por jogador multiplicaria o custo pelo numero
        /// de gente online — e o quadro e exatamente o mesmo para
        /// todos os que veem a mesma propaganda.
        /// </summary>
        private void AdsApplyFrame(JObject frame, List<BasePlayer> audience, AdItem ad)
        {
            if (frame == null || audience.Count == 0)
            {
                return;
            }

            JArray destroy = frame["destroy"] as JArray;
            JArray cui = frame["cui"] as JArray;

            string json = null;
            if (cui != null && cui.Count > 0)
            {
                json = PersonalizeAds(cui, ad);
            }

            for (int i = 0; i < audience.Count; i++)
            {
                BasePlayer player = audience[i];

                if (destroy != null)
                {
                    for (int d = 0; d < destroy.Count; d++)
                    {
                        CuiHelper.DestroyUi(player, (string)destroy[d]);
                    }
                }

                if (json != null)
                {
                    CuiHelper.AddUi(player, json);
                }
            }
        }

        /// <summary>
        /// Troca os lugares reservados do quadro.
        ///
        /// O mesmo mecanismo do `{token}` e do `{img:...}` do menu,
        /// e pelo mesmo motivo: o valor so existe em tempo de
        /// execucao, deste lado. O agente monta o quadro UMA vez, e
        /// ele serve a todas as propagandas.
        /// </summary>
        private string PersonalizeAds(JArray elements, AdItem ad)
        {
            string json = elements.ToString(Formatting.None);

            if (ad != null)
            {
                if (json.IndexOf(AdImagePlaceholder, StringComparison.Ordinal) >= 0)
                {
                    // Modo `stored`: a chave vira o CRC que so este
                    // plugin conhece. Modo `url`: o endereco passa
                    // cru para o cliente.
                    uint crc;
                    string value = _images.TryGetValue(ad.Image, out crc)
                        ? crc.ToString()
                        : ad.Image;

                    json = json.Replace(AdImagePlaceholder, value);
                }

                if (!string.IsNullOrEmpty(ad.AnchorMin))
                {
                    json = json.Replace(AdAnchorMinPlaceholder, ad.AnchorMin);
                }

                if (!string.IsNullOrEmpty(ad.AnchorMax))
                {
                    json = json.Replace(AdAnchorMaxPlaceholder, ad.AnchorMax);
                }

                if (!string.IsNullOrEmpty(ad.Background))
                {
                    json = json.Replace(AdBackgroundPlaceholder, ad.Background);
                }
            }

            // Sobrou algum lugar reservado (quadro de logo, ou
            // propaganda sem cor)? Vira um valor inofensivo — um
            // literal `{adbg}` num campo de cor faz o cliente
            // recusar o elemento INTEIRO, e o overlay some sem
            // dizer por que.
            if (json.IndexOf("{ad", StringComparison.Ordinal) >= 0)
            {
                json = json.Replace(AdBackgroundPlaceholder, "0 0 0 0");
                json = json.Replace(AdAnchorMinPlaceholder, "0 0");
                json = json.Replace(AdAnchorMaxPlaceholder, "1 1");
                json = json.Replace(AdImagePlaceholder, "0");
            }

            // As imagens do MENU tambem valem aqui: o logo pode ser
            // uma delas.
            if (_images.Count > 0 && json.IndexOf("{img:", StringComparison.Ordinal) >= 0)
            {
                foreach (KeyValuePair<string, uint> image in _images)
                {
                    json = json.Replace("{img:" + image.Key + "}", image.Value.ToString());
                }
            }

            return json;
        }

        // ----------------------------------------------------
        //  OS COMANDOS DE TESTE
        // ----------------------------------------------------

        [ConsoleCommand(AdsShowCommand)]
        private void CmdAdsShow(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            if (!_adsEnabled)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"ADS_DISABLED\"}");
                return;
            }

            // Com steamId: so aquele jogador entra no ciclo. Sem
            // ele, o ciclo comeca agora para todo mundo.
            if (arg.HasArgs(1))
            {
                ulong steamId;
                if (!ulong.TryParse(arg.GetString(0), out steamId))
                {
                    arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                    return;
                }

                BasePlayer target = BasePlayer.FindByID(steamId);
                if (target == null)
                {
                    arg.ReplyWith("{\"ok\":false,\"error\":\"PLAYER_NOT_FOUND\"}");
                    return;
                }

                if (!_adsDrawn.Contains(steamId))
                {
                    AdsDrawRoot(target);
                }
            }

            AdsKillTimer(ref _adsCycleTimer);
            AdsStartCycle();

            arg.ReplyWith("{\"ok\":true}");
        }

        [ConsoleCommand(AdsHideCommand)]
        private void CmdAdsHide(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            if (!arg.HasArgs(1))
            {
                AdsStopEverything();
                AdsClearAll();
                arg.ReplyWith("{\"ok\":true,\"hidden\":\"all\"}");
                return;
            }

            ulong steamId;
            if (!ulong.TryParse(arg.GetString(0), out steamId))
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                return;
            }

            BasePlayer target = BasePlayer.FindByID(steamId);
            if (target == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"PLAYER_NOT_FOUND\"}");
                return;
            }

            CuiHelper.DestroyUi(target, AdsRoot);
            CuiHelper.DestroyUi(target, AdsLogoName);
            _adsDrawn.Remove(steamId);
            _adsInCycle.Remove(steamId);
            _adsQueue.Remove(steamId);

            arg.ReplyWith("{\"ok\":true,\"hidden\":1}");
        }

        /// <summary>
        /// Mostra UMA propaganda agora, sem mexer no rodizio.
        ///
        /// Testar uma campanha nao deveria adiar o proximo ciclo
        /// nem gastar a vez de outra.
        /// </summary>
        [ConsoleCommand(AdsTestCommand)]
        private void CmdAdsTest(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null || !arg.HasArgs(1))
            {
                return;
            }

            if (!_adsEnabled)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"ADS_DISABLED\"}");
                return;
            }

            string adId = arg.GetString(0);
            int index = -1;

            for (int i = 0; i < _adsItems.Count; i++)
            {
                if (_adsItems[i].Id == adId)
                {
                    index = i;
                    break;
                }
            }

            if (index < 0)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"AD_NOT_FOUND\"}");
                return;
            }

            List<BasePlayer> audience = new List<BasePlayer>();

            if (arg.HasArgs(2))
            {
                ulong steamId;
                if (!ulong.TryParse(arg.GetString(1), out steamId))
                {
                    arg.ReplyWith("{\"ok\":false,\"error\":\"INVALID_ARGS\"}");
                    return;
                }

                BasePlayer target = BasePlayer.FindByID(steamId);
                if (target == null)
                {
                    arg.ReplyWith("{\"ok\":false,\"error\":\"PLAYER_NOT_FOUND\"}");
                    return;
                }

                if (!_adsDrawn.Contains(steamId))
                {
                    AdsDrawRoot(target);
                }

                audience.Add(target);
            }
            else
            {
                foreach (ulong userId in _adsDrawn)
                {
                    BasePlayer player = BasePlayer.FindByID(userId);
                    if (player != null && player.IsConnected)
                    {
                        audience.Add(player);
                    }
                }
            }

            if (audience.Count == 0)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"NO_AUDIENCE\"}");
                return;
            }

            if (_adsCycleRunning)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"CYCLE_RUNNING\"}");
                return;
            }

            _adsCycleRunning = true;
            _adsInCycle.Clear();
            _adsQueue.Clear();

            for (int i = 0; i < audience.Count; i++)
            {
                List<int> queue = new List<int>();
                queue.Add(index);
                _adsQueue[audience[i].userID] = queue;
                _adsInCycle.Add(audience[i].userID);
            }

            AdsPlay(_adsOpening, null, 0, AdsShowSlot0);
            arg.ReplyWith("{\"ok\":true,\"audience\":" + audience.Count + "}");
        }

        // ----------------------------------------------------
        //  CICLO DE VIDA DO OVERLAY
        // ----------------------------------------------------

        private void AdsKillTimer(ref Timer target)
        {
            if (target != null)
            {
                target.Destroy();
                target = null;
            }
        }

        /// <summary>
        /// Para TODOS os relogios do overlay.
        ///
        /// Chamado antes de qualquer troca de estado. Sem isto, uma
        /// carga nova chegando no meio de um ciclo deixaria o
        /// ciclo antigo mandando quadros de uma animacao que nao
        /// existe mais.
        /// </summary>
        private void AdsStopEverything()
        {
            AdsKillTimer(ref _adsCycleTimer);
            AdsKillTimer(ref _adsStepTimer);
            _adsCycleRunning = false;
        }

        private void AdsAskForConfig()
        {
            // O Puts leva o prefixo do plugin, que e o controle de
            // origem que o agente exige — ver game/ads-sync.ts.
            Puts(AdsRequestMarker + "{\"want\":\"ads\"}");
        }

        [ConsoleCommand("origemz.ads.reload")]
        private void CmdAdsReload(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            AdsAskForConfig();
            arg.ReplyWith("{\"ok\":true}");
        }

        /// <summary>
        /// Esquece as imagens guardadas.
        ///
        /// So o MAPA chave->CRC: os bytes continuam no FileStorage
        /// do servidor. A proxima carga reenvia o que faltar.
        /// </summary>
        [ConsoleCommand("origemz.ads.clearcache")]
        private void CmdAdsClearCache(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            int count = _images.Count;
            _images.Clear();
            _adsImageParts.Clear();

            arg.ReplyWith("{\"ok\":true,\"cleared\":" + count + "}");
        }

        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>
            {
                { "NoPermission", "Voce nao tem permissao para abrir isso." },
                { "Loading", "CARREGANDO..." },
                { "ScreenUnavailable", "Nao consegui carregar essa pagina. Tente de novo." },
                { "StoreUnavailable", "A loja ainda nao esta disponivel." },
                { "BuyTimeout", "Nao recebi a confirmacao da compra. Confira seu inventario e o saldo antes de tentar de novo." }
            }, this);

            lang.RegisterMessages(new Dictionary<string, string>
            {
                { "NoPermission", "You don't have permission to open this." },
                { "Loading", "LOADING..." },
                { "ScreenUnavailable", "Could not load that page. Try again." },
                { "StoreUnavailable", "The store is not available yet." },
                { "BuyTimeout", "No confirmation received. Check your inventory and balance before trying again." }
            }, this, "en");
        }
    }
}
