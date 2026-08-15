// Requires: OrigemZAgent

// ============================================================
//  OrigemZQueue.cs
//
//  Ordena a fila de entrada do servidor por nivel de VIP e
//  oferece o caminho de compra do VIP para quem esperou.
//
//  Ele faz TRES coisas, e elas sao separadas de proposito:
//
//   1. CanBypassQueue - decide quem NEM CHEGA a esperar. E um
//      hook binario: fura ou nao fura. Ele nao ordena niveis.
//
//   2. Reordena ServerMgr.Instance.connectionQueue.queue por
//      pontuacao. E DAQUI que sai a escada
//          admin > gold > silver > bronze > normal
//      porque o hook de bypass sozinho nao a produz.
//
//   3. Mostra a tela da loja com o link de compra do VIP. O
//      endereco e configuravel - ver a chave Loja.Url.
//
//  ESTE PLUGIN NAO GUARDA ESTADO DE VIP. Quem e VIP ele
//  pergunta ao OrigemZAgent por hook, a cada vez. O config
//  daqui e de POLITICA (pesos da fila, textos da loja), nunca
//  de estado.
//
//  Contrato de hook: Docs\OrigemZAgent\HOOKS.md
//  Config:           Docs\OrigemZAgent\config\OrigemZQueue.md
//
//  ------------------------------------------------------------
//  #### AS REGRAS QUE VALEM PARA O ARQUIVO INTEIRO ####
//
//   1. NENHUMA chamada ao agente em Init(). O Oxide so garante
//      as dependencias a partir de OnServerInitialized(), e
//      chamar antes disso devolve null sem erro nenhum.
//
//   2. [PluginReference] vira null quando o alvo e descarregado.
//      Null-check em TODA chamada, e nao so na primeira.
//
//   3. A LISTA DE NIVEIS E DADO, NAO 'if'. Ela sai do config e
//      atravessa o plugin inteiro como mapa; o quarto nivel
//      entra editando JSON, sem tocar em codigo.
//
//   4. Nada de sintaxe acima de C# 6. O compilador em tempo de
//      execucao do Oxide para nesse teto, e codigo mais novo
//      compila no MSBuild e e recusado no servidor - com erro
//      longe da causa. Sem "out var", sem tupla, sem funcao
//      local, sem pattern matching, sem interpolacao de string.
//
//   5. Texto que o jogador le sai do lang, nunca do codigo. A
//      excecao consciente e a lista de beneficios da loja, que
//      e OFERTA COMERCIAL e muda com a promocao - essa mora no
//      config, ao lado do preco e do link.
//
//  ------------------------------------------------------------
//  #### TRES COISAS QUE O RUST NAO DEIXA FAZER ####
//
//  Estao aqui porque cada uma ja custou uma linha de config que
//  prometia o que nao existe.
//
//  A. NAO DA PARA FALAR COM QUEM ESTA NA FILA. Quem espera
//     ainda e uma Network.Connection, e nao um BasePlayer: nao
//     ha chat, nao ha CUI, nao ha console. O unico pacote que o
//     servidor manda para a tela de fila e
//     SendQueueUpdate(connection, position), que carrega DOIS
//     numeros - o tamanho da fila e a posicao. Nao ha campo de
//     texto.
//
//     Por isso o aviso de "sua posicao piorou" e entregue na
//     ENTRADA do jogador, ja com ele dentro do servidor, e a
//     chave se chama AvisarNaEntradaQuandoAPosicaoPiorou. O
//     nome descreve o que acontece.
//
//  B. NAO DA PARA ABRIR O NAVEGADOR DO JOGADOR. Procuramos:
//     Application.OpenURL so existe no cliente, dentro do
//     MonoBehaviour Assets\Scripts\UI\OpenURL.cs, que o servidor
//     nao instancia; nao ha convar de cliente que receba uma
//     URL; e o CUI nao tem componente de link - a lista inteira
//     de componentes esta em Oxide.Game.Rust.Cui e nenhum abre
//     endereco.
//
//     Entao o botao COMPRAR VIP abre um painel com o endereco
//     em um campo de texto SOMENTE LEITURA, que o jogador
//     seleciona com Ctrl+A e copia com Ctrl+C. E o mais perto
//     de um link clicavel que o jogo permite. O mesmo endereco
//     sai tambem no chat e no console (F1) do jogador, porque
//     copiar dali funciona quando o campo nao coopera.
//
//     Quem quiser um botao clicavel de verdade tem UM caminho, e
//     ele e do jogo, nao nosso: a convar server.url, que vira o
//     botao de site do servidor no menu ESC e no navegador de
//     servidores. Ver Loja.AvisarSeServerUrlDivergir.
//
//  C. NAO EXISTE "RESERVAR N SLOTS PARA VIP" NATIVO. O
//     ConnectionQueue.TryAddReservedSlot que parecia servir para
//     isso reserva o slot de quem ACABOU DE SAIR, por
//     ConVar.Server.rejoin_delay segundos, para a pessoa
//     reconectar - e nada tem a ver com VIP.
//
//     Por isso nao ha chave ReservarSlotsParaVip neste config.
//     O mecanismo real de "entra na frente de todo mundo" e a
//     lista NiveisQueFuramAFila, que alimenta o CanBypassQueue.
// ============================================================

using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using UnityEngine;

// [PluginReference] e o tipo Plugin moram em Oxide.Core.Plugins.
// [Info], [Description] e [ConsoleCommand] vem do Oxide.CSharp, no
// proprio namespace Oxide.Plugins - por isso nao precisam de using.
using Oxide.Core.Plugins;
using Oxide.Game.Rust.Cui;

namespace Oxide.Plugins
{
    // O nome em [Info], o nome da classe e o nome do arquivo tem
    // de ser identicos, senao o Oxide recusa carregar.
    [Info("OrigemZQueue", "OrigemZ", "0.1.0")]
    [Description("Fila de entrada ordenada por nivel de VIP, com envelhecimento por tempo de espera e loja de VIP no jogo")]
    public class OrigemZQueue : RustPlugin
    {
        // ========================================================
        //  DEPENDENCIA
        //
        //  O "// Requires: OrigemZAgent" la em cima torna a
        //  dependencia obrigatoria: este plugin nao inicia sem o
        //  agente, e descarregar o agente descarrega este junto.
        //  E reload em cadeia, e e proposital - sem o agente nao
        //  ha como saber quem e VIP, e uma fila que trata todo
        //  mundo como normal seria pior do que fila nenhuma,
        //  porque pareceria estar funcionando.
        // ========================================================
        [PluginReference]
        private Plugin OrigemZAgent;

        // Nome de hook e string dos dois lados da fronteira: erro
        // de digitacao aqui so apareceria em runtime, no servidor.
        private const string HookGetApiVersion = "GetApiVersion";
        private const string HookGetVipTier = "GetVipTier";
        private const string HookNotifyQueueEvent = "NotifyQueueEvent";

        // Versao do contrato contra a qual este plugin foi escrito.
        // Divergencia e AVISO, nao recusa - ver LogAgentApiVersion.
        private const int ExpectedAgentApiVersion = 1;

        // ========================================================
        //  TELEMETRIA
        //
        //  Os quatro valores de "action" do NotifyQueueEvent, em
        //  Docs\OrigemZAgent\HOOKS.md. Sao protocolo: ingles
        //  minusculo, iguais dos dois lados.
        // ========================================================
        private const string ActionBypass = "bypass";
        private const string ActionQueued = "queued";
        private const string ActionJoined = "joined";
        private const string ActionLeft = "left";

        // ========================================================
        //  NIVEIS
        //
        //  "normal" e "admin" sao chaves do mapa Prioridades como
        //  qualquer outra - o codigo nao conhece bronze, silver
        //  nem gold. Estes dois estao aqui porque nao vem do
        //  agente: "normal" e a ausencia de VIP e "admin" sai do
        //  auth level do Rust.
        // ========================================================
        private const string TierNormal = "normal";
        private const string TierAdmin = "admin";

        // ========================================================
        //  COMANDOS
        //
        //  Prefixo "origemz." porque comando de console no Oxide e
        //  global: sem namespace, dois plugins com um comando
        //  "status" colidiriam.
        //
        //  Os comandos de CHAT nao estao aqui: eles saem do
        //  config e sao registrados a mao no OnServerInitialized,
        //  porque [ChatCommand] e atributo e atributo nao le
        //  arquivo.
        // ========================================================
        private const string QueueConsoleCommand = "origemz.queue";
        private const string ShopConsoleCommand = "origemz.fila.loja";
        private const string CloseConsoleCommand = "origemz.fila.fechar";

        // Argumentos do ShopConsoleCommand.
        private const string ShopArgLink = "link";
        private const string ShopArgHome = "home";

        // ========================================================
        //  PAGINACAO
        //
        //  A regra do projeto (PLANO.md, secao 7) e que TODA
        //  colecao que pode crescer e paginada desde a primeira
        //  versao. A fila pode ter centenas de nomes, e resposta
        //  truncada chega ao agente como JSON invalido - que
        //  parece bug do plugin e e limite de frame do WebRCON.
        //
        //  Os numeros sao os mesmos do origemz.players, medidos
        //  neste servidor: 250 registros = 35 KB, integro.
        // ========================================================
        private const int DefaultQueueLimit = 100;
        private const int MaxQueueLimit = 250;

        // ========================================================
        //  CODIGOS DE ERRO
        //
        //  Os mesmos de Docs\OrigemZAgent\HOOKS.md:
        //  SCREAMING_SNAKE_CASE, nunca frase para o jogador.
        // ========================================================
        private const string ErrorInvalidArgs = "INVALID_ARGS";
        private const string ErrorInternal = "INTERNAL_ERROR";
        private const string ErrorQueueUnavailable = "QUEUE_UNAVAILABLE";

        // ========================================================
        //  CHAVES DO LANG
        // ========================================================
        private const string TierLabelPrefix = "TierLabel.";
        private const string MsgQueueStatus = "QueueStatus";
        private const string MsgQueueEmpty = "QueueEmpty";
        private const string MsgQueuePriority = "QueuePriority";
        private const string MsgWaitReport = "WaitReport";
        private const string MsgWaitReportOvertaken = "WaitReportOvertaken";
        private const string MsgShopOffer = "ShopOffer";
        private const string MsgShopTitle = "ShopTitle";
        private const string MsgShopSubtitle = "ShopSubtitle";
        private const string MsgShopBuyButton = "ShopBuyButton";
        private const string MsgShopCloseButton = "ShopCloseButton";
        private const string MsgShopBackButton = "ShopBackButton";
        private const string MsgShopLinkTitle = "ShopLinkTitle";
        private const string MsgShopLinkHint = "ShopLinkHint";
        private const string MsgShopChatLink = "ShopChatLink";
        private const string MsgShopDisabled = "ShopDisabled";
        private const string MsgDurationMinutes = "DurationMinutes";
        private const string MsgDurationHours = "DurationHours";
        private const string MsgUnavailable = "Unavailable";

        // ========================================================
        //  NOMES DOS ELEMENTOS DE UI
        //
        //  Prefixados porque o CUI e um espaco de nomes GLOBAL por
        //  jogador: dois plugins com um painel "main" destroem a
        //  tela um do outro, e o sintoma aparece no plugin errado.
        // ========================================================
        private const string UiRoot = "origemz.queue.shop";
        private const string UiCard = "origemz.queue.shop.card";
        private const string UiBody = "origemz.queue.shop.body";

        // ========================================================
        //  CORES DO PAINEL
        //
        //  Sao os acentos que o painel web ja usa (--amber e o
        //  fundo escuro do tema), para o jogador reconhecer a
        //  mesma marca no jogo e no site.
        // ========================================================
        private const string ColorScreen = "0 0 0 0.75";
        private const string ColorCard = "0.13 0.12 0.11 0.99";
        private const string ColorHeader = "0.75 0.45 0.11 1";
        private const string ColorButtonBuy = "0.30 0.55 0.20 1";
        private const string ColorButtonNeutral = "0.25 0.24 0.22 1";
        private const string ColorField = "0.07 0.07 0.06 1";
        private const string ColorText = "0.94 0.92 0.88 1";
        private const string ColorTextDim = "0.70 0.68 0.64 1";
        private const string ColorTextStrong = "1 1 1 1";

        private const string FontBold = "robotocondensed-bold.ttf";
        private const string FontRegular = "robotocondensed-regular.ttf";

        private const int SteamId64Length = 17;

        // Teto de caracteres do campo de texto do endereco. Uma URL
        // maior que isto seria cortada NA TELA sem aviso, o que
        // entrega um endereco quebrado ao jogador - por isso o
        // config valida o tamanho no boot, e nao aqui.
        private const int UrlFieldCharLimit = 256;

        private PluginConfig _config;

        // Prioridades JA VALIDADAS. Vazio ate o
        // OnServerInitialized montar - ver _ready.
        private Dictionary<string, int> _priorities =
            new Dictionary<string, int>(StringComparer.Ordinal);

        // Niveis que furam a fila pelo CanBypassQueue.
        private HashSet<string> _bypassTiers =
            new HashSet<string>(StringComparer.Ordinal);

        // Quem esta (ou esteve) na fila, por SteamID64. Descartavel
        // de proposito: perder isto num reload so reembaralha
        // empates dentro do mesmo nivel, e o PLANO.md aceita esse
        // custo explicitamente.
        private Dictionary<ulong, ArrivalRecord> _arrivals =
            new Dictionary<ulong, ArrivalRecord>();

        // Jogadores com a tela da loja aberta. Serve para fechar
        // tudo no Unload - CUI aberto sobrevive ao descarregamento
        // do plugin, e o jogador ficaria com um painel que nenhum
        // botao mais fecha.
        private HashSet<ulong> _openShops = new HashSet<ulong>();

        // Niveis que o agente devolveu e que o config nao conhece.
        // Guardados so para nao repetir o mesmo aviso a cada
        // reordenacao - ver ResolveBaseScore.
        private HashSet<string> _unknownTiersWarned =
            new HashSet<string>(StringComparer.Ordinal);

        private float _lastReorder;
        private bool _ready;
        private bool _shopEnabled;

        // O timer da reordenacao. Guardado para ser cancelado no
        // Unload: timer do Oxide sobrevive ao plugin descarregado e
        // dispara contra objeto morto.
        private Timer _reorderTimer;

        // ========================================================
        //  CICLO DE VIDA
        // ========================================================
        private void Init()
        {
            // So log. Qualquer conversa com o agente daqui devolve
            // null sem erro - ver regra 1 no topo do arquivo.
            Puts("Init() - contrato do agente esperado: v" + ExpectedAgentApiVersion + ".");
        }

        private void OnServerInitialized()
        {
            try
            {
                _priorities = BuildPriorities(_config);
                _bypassTiers = BuildBypassTiers(_config);
                _shopEnabled = ValidateShop(_config);

                WarnAboutStarvation();
                RegisterChatCommands();
                LogAgentApiVersion();

                float interval = _config.SegundosEntreReordenacoes < 1
                    ? 1f
                    : _config.SegundosEntreReordenacoes;

                // O timer existe porque o envelhecimento muda a
                // ordem pelo TEMPO, e nao so por evento: sem ele,
                // uma fila parada nunca reordenaria e o jogador
                // normal nunca alcancaria ninguem.
                _reorderTimer = timer.Every(interval, ReorderTick);

                _ready = true;

                Puts("Fila no ar: " + _priorities.Count + " nivel(is) de prioridade, " +
                     _bypassTiers.Count + " com bypass, reordenando a cada " +
                     interval + "s. Loja: " + (_shopEnabled ? _config.Loja.Url : "desligada") + ".");
            }
            catch (Exception ex)
            {
                // _ready continua falso: com o boot pela metade e
                // melhor NAO reordenar a fila do que reordenar com
                // politica pela metade - o segundo caso ninguem
                // percebe, e ele muda quem entra no servidor.
                PrintError("OnServerInitialized falhou; a fila fica no comportamento nativo do Rust " +
                           "ate um reload: " + ex);
            }
        }

        private void Unload()
        {
            try
            {
                if (_reorderTimer != null)
                {
                    _reorderTimer.Destroy();
                    _reorderTimer = null;
                }

                // CUI aberto sobrevive ao plugin descarregado. Sem
                // esta limpeza o jogador fica com um painel e um
                // cursor que nenhum botao mais fecha, e o unico
                // jeito de sair seria reconectar.
                CloseAllShops();
            }
            catch (Exception ex)
            {
                PrintError("Unload falhou: " + ex);
            }
        }

        // ========================================================
        //  CanBypassQueue - QUEM NEM CHEGA A ESPERAR
        //
        //  #### O RETORNO E null, NUNCA false ####
        //
        //      true  = fura a fila
        //      false = BLOQUEIA ate o bypass NATIVO do Rust
        //      null  = o Rust decide sozinho
        //
        //  Para quem nao e VIP a resposta certa e null. "false"
        //  nao significa "nao e VIP": significa "ninguem fura, nem
        //  quem o Rust deixaria" - e derruba o bypass de dev,
        //  moderador, dono e skipqueueid. O sintoma seria O DONO
        //  DO SERVIDOR PEGANDO FILA NO PROPRIO SERVIDOR, e ninguem
        //  liga isso ao plugin de VIP: a depuracao comeca no
        //  server.cfg, passa pelo skipqueueid, e o plugin de fila
        //  e o ultimo lugar onde alguem olha.
        //
        //  Quando este hook e consultado: o Rust so o chama se ja
        //  ha fila OU o servidor esta cheio (ConnectionQueue.Join).
        //  Com o servidor vazio ninguem passa por aqui.
        // ========================================================
        private object CanBypassQueue(Network.Connection connection)
        {
            try
            {
                if (connection == null || !_ready)
                {
                    return null;
                }

                // Admin sai do auth level do Rust, e nao de um
                // grupo nosso: quem ja e admin nao precisa de
                // cadastro de VIP para ter prioridade.
                if (_config.AdminSempreNoTopo && connection.authLevel > 0)
                {
                    NotifyAgent(connection.userid, ActionBypass, TierAdmin);
                    return true;
                }

                string tier = GetTier(connection.userid);

                if (tier != null && _bypassTiers.Contains(tier))
                {
                    NotifyAgent(connection.userid, ActionBypass, tier);
                    return true;
                }

                return null;
            }
            catch (Exception ex)
            {
                // Excecao no caminho de conexao do jogador nao pode
                // virar recusa de entrada. null devolve a decisao
                // ao Rust, que e exatamente o comportamento de
                // antes do plugin.
                PrintError("CanBypassQueue falhou: " + ex);
                return null;
            }
        }

        // ========================================================
        //  OnConnectionQueue - A CHEGADA
        //
        //  Disparado dentro de ConnectionQueue.Join, ANTES de a
        //  conexao entrar na lista.
        //
        //  #### ESTE HOOK NAO PODE DEVOLVER VALOR ####
        //
        //  O Rust checa "retorno != null" e ABANDONA o Join: a
        //  conexao nao entra na fila E nao entra no jogo. Ela fica
        //  pendurada ate o timeout do cliente. Por isso o metodo e
        //  void - void devolve null, e null e a unica resposta
        //  segura.
        // ========================================================
        private void OnConnectionQueue(Network.Connection connection)
        {
            try
            {
                if (connection == null || !_ready)
                {
                    return;
                }

                float now = Time.realtimeSinceStartup;
                ulong userId = connection.userid;
                ArrivalRecord record;

                if (_arrivals.TryGetValue(userId, out record) &&
                    record.LeftAt >= 0f &&
                    now - record.LeftAt <= _config.SegundosDeCarenciaNaReconexao)
                {
                    // Voltou dentro da carencia: recupera os
                    // minutos acumulados. Quem cai e volta perderia
                    // tudo e voltaria para o fim - e quem tem
                    // internet ruim e justamente quem mais sofreria
                    // com isso.
                    record.LeftAt = -1f;
                }
                else
                {
                    record = new ArrivalRecord();
                    record.ArrivedAt = now;
                    record.LeftAt = -1f;
                    _arrivals[userId] = record;
                }

                record.Name = connection.username;

                NotifyAgent(userId, ActionQueued, GetTier(userId));

                // Reordena JA se o intervalo minimo permitir. Sem
                // isto, um gold que chega esperaria o proximo tique
                // do timer para subir - e o tique padrao e de 15
                // segundos, que e tempo demais para quem pagou.
                MaybeReorder(now);
            }
            catch (Exception ex)
            {
                PrintError("OnConnectionQueue falhou: " + ex);
            }
        }

        // ========================================================
        //  OnConnectionDequeue - A DESISTENCIA
        //
        //  Disparado em ConnectionQueue.RemoveConnection, que e o
        //  caminho de quem FECHOU o jogo ou caiu. Quem entra no
        //  servidor NAO passa por aqui: o JoinGame tira da lista
        //  direto.
        //
        //  Vale a mesma regra do OnConnectionQueue: retorno
        //  nao-null CANCELA a remocao, e a conexao morta ficaria na
        //  fila para sempre, ocupando lugar de gente viva. Por isso
        //  o metodo e void.
        // ========================================================
        private void OnConnectionDequeue(Network.Connection connection)
        {
            try
            {
                if (connection == null || !_ready)
                {
                    return;
                }

                ulong userId = connection.userid;
                ArrivalRecord record;

                if (_arrivals.TryGetValue(userId, out record))
                {
                    // Marcado, e nao apagado: a carencia da
                    // reconexao precisa saber QUANDO ele saiu.
                    record.LeftAt = Time.realtimeSinceStartup;
                }

                NotifyAgent(userId, ActionLeft, GetTier(userId));
            }
            catch (Exception ex)
            {
                PrintError("OnConnectionDequeue falhou: " + ex);
            }
        }

        // ========================================================
        //  OnPlayerConnected - A ENTRADA, E O UNICO MOMENTO EM QUE
        //  DA PARA FALAR COM QUEM ESPEROU
        //
        //  Ver o item A do cabecalho: nao existe canal de texto
        //  para quem esta na fila. O relatorio da espera e a oferta
        //  de VIP saem aqui, com o jogador ja dentro.
        // ========================================================
        private void OnPlayerConnected(BasePlayer player)
        {
            try
            {
                if (player == null || !_ready)
                {
                    return;
                }

                ulong userId = player.userID;
                ArrivalRecord record;

                if (!_arrivals.TryGetValue(userId, out record))
                {
                    // Entrou sem passar pela fila - o caso comum em
                    // servidor com vaga. Nada a relatar.
                    return;
                }

                _arrivals.Remove(userId);

                string tier = GetTier(userId);
                NotifyAgent(userId, ActionJoined, tier);

                float waited = Time.realtimeSinceStartup - record.ArrivedAt;

                if (!_config.AvisarNaEntradaQuandoAPosicaoPiorou)
                {
                    return;
                }

                ReportWait(player, record, waited, tier);
            }
            catch (Exception ex)
            {
                PrintError("OnPlayerConnected falhou: " + ex);
            }
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player == null)
            {
                return;
            }

            // O CUI morre junto com a sessao, mas o registro em
            // memoria nao - e ele vazaria um ulong por jogador que
            // ja saiu.
            _openShops.Remove(player.userID);
        }

        // O relatorio da espera. Ele existe para responder, com
        // numero, a pergunta que o jogador faz sozinho quando ve a
        // posicao andar para tras: "por que eu voltei do 5o para o
        // 7o?". Sem resposta, isso parece bug do servidor ou
        // trapaca da loja - e a reclamacao e razoavel, porque do
        // lado dele nada mudou.
        private void ReportWait(BasePlayer player, ArrivalRecord record, float waited, string tier)
        {
            string userId = player.UserIDString;

            // Espera curta demais nao rende relatorio: quem esperou
            // 20 segundos nao viu posicao nenhuma piorar, e a
            // mensagem seria ruido no primeiro segundo de jogo.
            if (waited < _config.SegundosMinimosParaRelatarAEspera)
            {
                return;
            }

            if (record.Overtaken > 0)
            {
                SendReply(player, string.Format(Msg(MsgWaitReportOvertaken, userId),
                    FormatDuration(waited, userId), record.Overtaken));
            }
            else
            {
                SendReply(player, string.Format(Msg(MsgWaitReport, userId),
                    FormatDuration(waited, userId)));
            }

            // A oferta so vai para quem NAO tem VIP. Oferecer VIP a
            // quem acabou de comprar VIP e a forma mais rapida de
            // transformar propaganda em reclamacao.
            if (tier != null || !_shopEnabled || !_config.Loja.OferecerNaEntrada)
            {
                return;
            }

            SendReply(player, string.Format(Msg(MsgShopOffer, userId), _config.Loja.ComandoDeChat));

            if (_config.Loja.AbrirTelaNaEntrada)
            {
                OpenShop(player, false);
            }
        }

        // ========================================================
        //  A REORDENACAO - O CORACAO
        //
        //  #### POR QUE OS SCORES SAO CALCULADOS ANTES DO SORT ####
        //
        //  List.Sort chama o comparador varias vezes por elemento.
        //  Se o comparador lesse Time.realtimeSinceStartup a cada
        //  chamada, dois itens poderiam comparar diferente em dois
        //  momentos do MESMO sort - e o .NET detecta isso e lanca
        //  "IComparer.Compare() method returns inconsistent
        //  results". A fila ficaria na ordem anterior e o log teria
        //  uma excecao que nao aponta para o relogio.
        //
        //  Por isso o score de cada conexao e congelado numa lista
        //  auxiliar antes de ordenar. O comparador so le numero
        //  pronto.
        //
        //  #### POR QUE A LISTA E REESCRITA POR INDICE ####
        //
        //  queue e a lista VIVA que o servidor cicla: o Cycle pega
        //  sempre queue[0]. Trocar a lista por outra nao adianta
        //  (o campo continua apontando para a antiga) e um
        //  Clear+AddRange deixaria a fila VAZIA por um instante, no
        //  meio de um Update do servidor. Escrever posicao a
        //  posicao mantem Count constante o tempo todo.
        // ========================================================
        private void ReorderTick()
        {
            try
            {
                float now = Time.realtimeSinceStartup;
                CleanupArrivals(now);
                Reorder(now);
            }
            catch (Exception ex)
            {
                PrintError("Reordenacao periodica falhou: " + ex);
            }
        }

        private void MaybeReorder(float now)
        {
            if (now - _lastReorder < _config.SegundosEntreReordenacoes)
            {
                return;
            }

            Reorder(now);
        }

        private void Reorder(float now)
        {
            ConnectionQueue queue = GetConnectionQueue();

            if (queue == null || queue.queue == null)
            {
                return;
            }

            List<Network.Connection> list = queue.queue;
            _lastReorder = now;

            if (list.Count < 2)
            {
                return;
            }

            List<QueueEntry> entries = new List<QueueEntry>(list.Count);

            for (int i = 0; i < list.Count; i++)
            {
                Network.Connection connection = list[i];

                if (connection == null)
                {
                    // Buraco na lista viva: nao da para pontuar, e
                    // remover aqui seria mexer em quem nao e nosso.
                    // Abortamos a reordenacao inteira - a ordem
                    // anterior continua valendo, que e um estado
                    // que ao menos ja funcionava.
                    PrintWarning("A fila tem uma conexao nula na posicao " + i +
                                 "; reordenacao adiada para o proximo ciclo.");
                    return;
                }

                QueueEntry entry = new QueueEntry();
                entry.Connection = connection;
                entry.UserId = connection.userid;
                entry.OriginalIndex = i;
                entry.ArrivedAt = GetArrivedAt(connection, now);
                entry.Tier = GetTier(connection.userid);
                entry.Score = ComputeScore(entry.Tier, connection.authLevel, now - entry.ArrivedAt);

                entries.Add(entry);
            }

            entries.Sort(CompareEntries);

            bool changed = false;

            for (int i = 0; i < entries.Count; i++)
            {
                if (entries[i].OriginalIndex != i)
                {
                    changed = true;
                    break;
                }
            }

            if (!changed)
            {
                return;
            }

            for (int i = 0; i < entries.Count; i++)
            {
                QueueEntry entry = entries[i];

                // Indice MAIOR e posicao PIOR. Guardamos quantas
                // posicoes ele perdeu para poder explicar isso na
                // entrada dele - ver ReportWait.
                int lost = i - entry.OriginalIndex;

                if (lost > 0)
                {
                    ArrivalRecord record;

                    if (_arrivals.TryGetValue(entry.UserId, out record))
                    {
                        record.Overtaken += lost;
                    }
                }

                list[i] = entry.Connection;
            }

            // Reordenar sem avisar deixa o jogador vendo a posicao
            // antiga na tela de espera. O SendQueueUpdates tem um
            // travao proprio de 10 segundos (nextMessageTime), e
            // zera-lo antes e a unica forma de a atualizacao sair
            // agora. O campo e publico exatamente para isso.
            queue.nextMessageTime = 0f;
            queue.SendQueueUpdates();
        }

        // Comparador TOTAL e DETERMINISTICO: score decrescente,
        // chegada crescente, e o indice original como ultimo
        // criterio.
        //
        // O terceiro criterio nao e enfeite. List.Sort NAO e
        // estavel: sem ele, dois jogadores do mesmo nivel que
        // chegaram no mesmo frame trocariam de lugar a cada
        // reordenacao, e cada troca contaria como "posicao piorou"
        // para um deles - o jogador levaria um relatorio de
        // ultrapassagem que nunca aconteceu.
        private static int CompareEntries(QueueEntry a, QueueEntry b)
        {
            if (a.Score > b.Score)
            {
                return -1;
            }

            if (a.Score < b.Score)
            {
                return 1;
            }

            if (a.ArrivedAt < b.ArrivedAt)
            {
                return -1;
            }

            if (a.ArrivedAt > b.ArrivedAt)
            {
                return 1;
            }

            if (a.OriginalIndex < b.OriginalIndex)
            {
                return -1;
            }

            if (a.OriginalIndex > b.OriginalIndex)
            {
                return 1;
            }

            return 0;
        }

        // ========================================================
        //  A FORMULA
        //
        //      score = base_do_nivel
        //            + min(minutos * PontosPorMinutoEsperando,
        //                  TetoDeEnvelhecimento)
        //
        //  #### A PROPRIEDADE QUE DA PARA ESCREVER NO SITE ####
        //
        //  Com PontosPorMinutoEsperando = 1, a base de cada nivel E
        //  o numero maximo de minutos que aquele nivel pode atrasar
        //  um jogador normal. A conta e direta: um normal esperando
        //  T minutos vale T; um gold recem-chegado vale 40; o
        //  normal passa na frente quando T > 40.
        //
        //  Nao existe outra interpretacao do numero, e e por isso
        //  que ele esta na config e nao no codigo.
        // ========================================================
        private float ComputeScore(string tier, uint authLevel, float waitedSeconds)
        {
            // Admin nao e base alta, e EXCECAO. A tentacao e
            // resolver com "admin": 100 no mapa e tratar todo mundo
            // pela mesma formula - e nao funciona: com taxa 1, um
            // jogador normal esperando 101 minutos passa na frente
            // do dono do servidor. Nenhum numero finito resolve
            // isso enquanto o envelhecimento existir.
            if (_config.AdminSempreNoTopo && authLevel > 0)
            {
                return float.MaxValue;
            }

            string key = authLevel > 0 ? TierAdmin : (tier == null ? TierNormal : tier);
            int baseScore = ResolveBaseScore(key);

            if (waitedSeconds < 0f)
            {
                waitedSeconds = 0f;
            }

            float aging = (waitedSeconds / 60f) * _config.PontosPorMinutoEsperando;

            // O teto tem de ser MAIOR que a maior base, e o
            // WarnAboutStarvation avisa quando nao e. Sem teto, o
            // tempo domina tudo: tres horas de espera dao 180
            // pontos, e 180 fura qualquer base que a gente escreva.
            bool applyCap = !_config.AplicarTetoSomenteAoNormal || key == TierNormal;

            if (applyCap && aging > _config.TetoDeEnvelhecimento)
            {
                aging = _config.TetoDeEnvelhecimento;
            }

            return baseScore + aging;
        }

        // Nivel que existe como grupo mas nao esta em Prioridades
        // vale o mesmo que normal, COM AVISO. As alternativas eram
        // recusar o config (derrubaria a fila inteira por causa de
        // uma linha) ou silenciar (o admin nunca saberia que o
        // nivel que ele vende nao ordena nada).
        //
        // O aviso sai UMA vez por nivel: isto roda dentro do laco
        // da reordenacao, a cada 15 segundos, e repetir encheria o
        // log ate esconde-lo.
        private int ResolveBaseScore(string key)
        {
            int value;

            if (_priorities.TryGetValue(key, out value))
            {
                return value;
            }

            if (_unknownTiersWarned.Add(key))
            {
                PrintWarning("Nivel '" + key + "' nao esta em Prioridades no config: " +
                             "quem tem esse nivel esta sendo tratado como '" + TierNormal +
                             "' na fila. Acrescente a chave em " +
                             "Server\\oxide\\config\\OrigemZQueue.json.");
            }

            if (_priorities.TryGetValue(TierNormal, out value))
            {
                return value;
            }

            return 0;
        }

        // O instante em que a conexao entrou na fila. O
        // OnConnectionQueue guarda isso; o fallback existe para o
        // caso de o plugin ter sido carregado com gente JA
        // esperando - a alternativa seria tratar todos como
        // recem-chegados, o que jogaria quem esperava ha uma hora
        // para o fim.
        private float GetArrivedAt(Network.Connection connection, float now)
        {
            ArrivalRecord record;

            if (_arrivals.TryGetValue(connection.userid, out record))
            {
                return record.ArrivedAt;
            }

            record = new ArrivalRecord();
            record.ArrivedAt = now;
            record.LeftAt = -1f;
            record.Name = connection.username;
            _arrivals[connection.userid] = record;

            return now;
        }

        // Registro de quem saiu da fila e nao voltou dentro da
        // carencia. Sem esta limpeza o dicionario cresceria com um
        // registro por jogador que ja passou pelo servidor - lento
        // de vazar, e por isso dificil de perceber.
        private void CleanupArrivals(float now)
        {
            if (_arrivals.Count == 0)
            {
                return;
            }

            List<ulong> expired = null;

            foreach (KeyValuePair<ulong, ArrivalRecord> pair in _arrivals)
            {
                ArrivalRecord record = pair.Value;

                if (record.LeftAt < 0f || now - record.LeftAt <= _config.SegundosDeCarenciaNaReconexao)
                {
                    continue;
                }

                if (expired == null)
                {
                    expired = new List<ulong>();
                }

                expired.Add(pair.Key);
            }

            if (expired == null)
            {
                return;
            }

            for (int i = 0; i < expired.Count; i++)
            {
                _arrivals.Remove(expired[i]);
            }
        }

        // ========================================================
        //  A LOJA
        //
        //  Ver o item B do cabecalho para o porque de o botao nao
        //  abrir o navegador: nao existe caminho para isso no Rust,
        //  e este painel e o mais perto que da.
        // ========================================================
        private void OpenShop(BasePlayer player, bool showLink)
        {
            if (player == null || player.IsNpc || !player.IsConnected)
            {
                return;
            }

            if (!_shopEnabled)
            {
                SendReply(player, Msg(MsgShopDisabled, player.UserIDString));
                return;
            }

            string userId = player.UserIDString;

            // DestroyUi antes de montar: sem isto, dois cliques no
            // botao empilham dois paineis, e fechar o de cima
            // revela o de baixo.
            CuiHelper.DestroyUi(player, UiRoot);

            CuiElementContainer container = new CuiElementContainer();

            // ---- a tela inteira, com o cursor ------------------
            CuiPanel screen = new CuiPanel();
            screen.Image = new CuiImageComponent();
            screen.Image.Color = ColorScreen;
            screen.RectTransform.AnchorMin = "0 0";
            screen.RectTransform.AnchorMax = "1 1";
            screen.CursorEnabled = true;
            container.Add(screen, "Overlay", UiRoot);

            // ---- o cartao --------------------------------------
            CuiPanel card = new CuiPanel();
            card.Image = new CuiImageComponent();
            card.Image.Color = ColorCard;
            card.RectTransform.AnchorMin = "0.5 0.5";
            card.RectTransform.AnchorMax = "0.5 0.5";
            card.RectTransform.OffsetMin = "-260 -190";
            card.RectTransform.OffsetMax = "260 190";
            container.Add(card, UiRoot, UiCard);

            // ---- faixa do titulo -------------------------------
            CuiPanel header = new CuiPanel();
            header.Image = new CuiImageComponent();
            header.Image.Color = ColorHeader;
            header.RectTransform.AnchorMin = "0 1";
            header.RectTransform.AnchorMax = "1 1";
            header.RectTransform.OffsetMin = "0 -54";
            header.RectTransform.OffsetMax = "0 0";
            container.Add(header, UiCard);

            AddLabel(container, UiCard, Msg(MsgShopTitle, userId), 20, FontBold,
                     ColorTextStrong, TextAnchor.MiddleCenter, "0 1", "1 1", "0 -54", "0 0");

            // ---- corpo -----------------------------------------
            CuiPanel body = new CuiPanel();
            body.Image = new CuiImageComponent();
            body.Image.Color = "0 0 0 0";
            body.RectTransform.AnchorMin = "0 0";
            body.RectTransform.AnchorMax = "1 1";
            body.RectTransform.OffsetMin = "16 56";
            body.RectTransform.OffsetMax = "-16 -62";
            container.Add(body, UiCard, UiBody);

            if (showLink)
            {
                BuildLinkBody(container, userId);
            }
            else
            {
                BuildOfferBody(container, userId);
            }

            // ---- rodape ----------------------------------------
            if (showLink)
            {
                AddButton(container, UiCard, Msg(MsgShopBackButton, userId),
                          ShopConsoleCommand + " " + ShopArgHome, null, ColorButtonNeutral,
                          "0 0", "0.5 0", "16 14", "-8 46");
            }
            else
            {
                AddButton(container, UiCard, Msg(MsgShopBuyButton, userId),
                          ShopConsoleCommand + " " + ShopArgLink, null, ColorButtonBuy,
                          "0 0", "0.5 0", "16 14", "-8 46");
            }

            // O botao de fechar leva Command E Close. O Command
            // deixa o SERVIDOR saber que a tela fechou (senao o
            // _openShops mentiria); o Close destroi o painel no
            // proprio CLIENTE, e e ele que salva o jogador de ficar
            // preso com o cursor se o servidor engasgar.
            AddButton(container, UiCard, Msg(MsgShopCloseButton, userId),
                      CloseConsoleCommand, UiRoot, ColorButtonNeutral,
                      "0.5 0", "1 0", "8 14", "-16 46");

            CuiHelper.AddUi(player, container);
            _openShops.Add(player.userID);
        }

        // A oferta: subtitulo e a lista de beneficios do config.
        private void BuildOfferBody(CuiElementContainer container, string userId)
        {
            AddLabel(container, UiBody, Msg(MsgShopSubtitle, userId), 14, FontRegular,
                     ColorTextDim, TextAnchor.UpperCenter, "0 1", "1 1", "0 -34", "0 -4");

            List<string> benefits = _config.Loja.Beneficios;

            if (benefits == null)
            {
                return;
            }

            // Teto de linhas: a lista vem do config e o cartao tem
            // altura fixa. Sem o corte, a decima linha seria
            // desenhada fora do cartao - e o sintoma seria "sumiu",
            // nao "nao coube".
            int max = benefits.Count < 8 ? benefits.Count : 8;

            for (int i = 0; i < max; i++)
            {
                string text = benefits[i];

                if (string.IsNullOrEmpty(text))
                {
                    continue;
                }

                int top = -44 - (i * 24);

                AddLabel(container, UiBody, text, 13, FontRegular,
                         ColorText, TextAnchor.MiddleLeft, "0 1", "1 1",
                         "8 " + (top - 22), "-8 " + top);
            }

            if (benefits.Count > max)
            {
                PrintWarning("A loja tem " + benefits.Count + " beneficios no config e a tela " +
                             "mostra " + max + ". As linhas seguintes nao aparecem para o jogador.");
            }
        }

        // O endereco. Campo SOMENTE LEITURA porque ele existe para
        // ser copiado, e nao editado - o jogador seleciona com
        // Ctrl+A e copia com Ctrl+C.
        private void BuildLinkBody(CuiElementContainer container, string userId)
        {
            AddLabel(container, UiBody, Msg(MsgShopLinkTitle, userId), 15, FontBold,
                     ColorText, TextAnchor.UpperCenter, "0 1", "1 1", "0 -30", "0 -4");

            CuiPanel field = new CuiPanel();
            field.Image = new CuiImageComponent();
            field.Image.Color = ColorField;
            field.RectTransform.AnchorMin = "0 1";
            field.RectTransform.AnchorMax = "1 1";
            field.RectTransform.OffsetMin = "0 -84";
            field.RectTransform.OffsetMax = "0 -40";
            string fieldName = container.Add(field, UiBody);

            CuiElement input = new CuiElement();
            input.Name = UiRoot + ".url";
            input.Parent = fieldName;

            CuiInputFieldComponent inputField = new CuiInputFieldComponent();
            inputField.Text = _config.Loja.Url;
            inputField.FontSize = 15;
            inputField.Font = FontBold;
            inputField.Align = TextAnchor.MiddleCenter;
            inputField.Color = ColorTextStrong;
            inputField.CharsLimit = UrlFieldCharLimit;

            // ReadOnly nao impede selecionar nem copiar - impede
            // APAGAR. Sem ele, o jogador que clica e digita apaga o
            // proprio endereco que veio buscar.
            inputField.ReadOnly = true;
            inputField.NeedsKeyboard = true;
            input.Components.Add(inputField);

            CuiRectTransformComponent inputRect = new CuiRectTransformComponent();
            inputRect.AnchorMin = "0 0";
            inputRect.AnchorMax = "1 1";
            inputRect.OffsetMin = "8 0";
            inputRect.OffsetMax = "-8 0";
            input.Components.Add(inputRect);

            container.Add(input);

            AddLabel(container, UiBody, Msg(MsgShopLinkHint, userId), 12, FontRegular,
                     ColorTextDim, TextAnchor.UpperCenter, "0 1", "1 1", "0 -132", "0 -90");
        }

        private void CloseShop(BasePlayer player)
        {
            if (player == null)
            {
                return;
            }

            CuiHelper.DestroyUi(player, UiRoot);
            _openShops.Remove(player.userID);
        }

        private void CloseAllShops()
        {
            if (_openShops.Count == 0)
            {
                return;
            }

            // Copia antes de percorrer: o CloseShop mexe no
            // _openShops, e alterar a colecao dentro do proprio
            // foreach lanca InvalidOperationException.
            List<ulong> ids = new List<ulong>(_openShops);

            for (int i = 0; i < ids.Count; i++)
            {
                BasePlayer player = BasePlayer.FindByID(ids[i]);

                if (player != null)
                {
                    CuiHelper.DestroyUi(player, UiRoot);
                }
            }

            _openShops.Clear();
        }

        // ========================================================
        //  COMANDOS DE CHAT
        //
        //  Registrados a mao porque o NOME vem do config, e
        //  [ChatCommand] e atributo - atributo nao le arquivo.
        // ========================================================
        private void RegisterChatCommands()
        {
            AddChatCommandSafe(_config.ComandoDeChatDaFila, "ChatQueueStatus");

            if (_shopEnabled)
            {
                AddChatCommandSafe(_config.Loja.ComandoDeChat, "ChatShop");
            }
        }

        private void AddChatCommandSafe(string name, string callback)
        {
            string trimmed = name == null ? null : name.Trim();

            if (string.IsNullOrEmpty(trimmed))
            {
                return;
            }

            try
            {
                cmd.AddChatCommand(trimmed, this, callback);
            }
            catch (Exception ex)
            {
                // Comando de chat e espaco de nomes global. Colisao
                // com outro plugin nao pode derrubar a fila: a fila
                // funciona sem comando nenhum.
                PrintError("Nao deu para registrar o comando de chat '/" + trimmed + "': " +
                           ex.Message + ". Outro plugin ja usa esse nome? " +
                           "Troque no config e recarregue.");
            }
        }

        // /fila - o estado da fila e a prioridade de quem pergunta.
        private void ChatQueueStatus(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            string userId = player.UserIDString;

            try
            {
                ConnectionQueue queue = GetConnectionQueue();

                if (queue == null)
                {
                    SendReply(player, Msg(MsgUnavailable, userId));
                    return;
                }

                int waiting = queue.Queued;

                if (waiting <= 0)
                {
                    SendReply(player, Msg(MsgQueueEmpty, userId));
                }
                else
                {
                    SendReply(player, string.Format(Msg(MsgQueueStatus, userId), waiting));
                }

                string tier = GetTier(player.userID);
                bool isAdmin = _config.AdminSempreNoTopo && player.net != null &&
                               player.net.connection != null && player.net.connection.authLevel > 0;
                string key = isAdmin ? TierAdmin : (tier == null ? TierNormal : tier);

                SendReply(player, string.Format(Msg(MsgQueuePriority, userId),
                    ResolveTierLabel(key, userId), ResolveBaseScore(key)));

                if (tier == null && _shopEnabled)
                {
                    SendReply(player, string.Format(Msg(MsgShopOffer, userId), _config.Loja.ComandoDeChat));
                }
            }
            catch (Exception ex)
            {
                PrintError("Comando de status da fila falhou para " + userId + ": " + ex);
                SendReply(player, Msg(MsgUnavailable, userId));
            }
        }

        // O comando de chat da loja. Ele ALTERNA: quem digita duas
        // vezes fecha a tela, em vez de empilhar dois paineis.
        private void ChatShop(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            try
            {
                if (_openShops.Contains(player.userID))
                {
                    CloseShop(player);
                    return;
                }

                OpenShop(player, false);

                // O endereco tambem sai no chat, e nao so na tela:
                // copiar do campo depende de o InputField cooperar,
                // e o chat e o caminho que sempre funciona.
                if (_shopEnabled)
                {
                    SendReply(player, string.Format(Msg(MsgShopChatLink, player.UserIDString),
                        _config.Loja.Url));
                }
            }
            catch (Exception ex)
            {
                PrintError("Comando da loja falhou para " + player.UserIDString + ": " + ex);
                SendReply(player, Msg(MsgUnavailable, player.UserIDString));
            }
        }

        // ========================================================
        //  COMANDOS DE CONSOLE DA UI
        //
        //  Estes sao chamados PELO CLIENTE, pelo botao do CUI.
        //  arg.Player() nulo significa que veio do RCON ou do
        //  console do servidor - e ai nao ha tela para mexer.
        // ========================================================
        [ConsoleCommand(ShopConsoleCommand)]
        private void ConsoleShop(ConsoleSystem.Arg arg)
        {
            try
            {
                BasePlayer player = arg.Player();

                if (player == null)
                {
                    arg.ReplyWith("Este comando e da tela do jogador; nao ha o que fazer pelo console.");
                    return;
                }

                bool showLink = string.Equals(arg.GetString(0, ShopArgHome), ShopArgLink,
                                              StringComparison.Ordinal);

                OpenShop(player, showLink);

                if (showLink && _shopEnabled)
                {
                    // Console do cliente (F1): da para selecionar e
                    // copiar dali com o mouse, o que e um terceiro
                    // caminho para o mesmo endereco.
                    player.ConsoleMessage(_config.Loja.Url);
                    SendReply(player, string.Format(Msg(MsgShopChatLink, player.UserIDString),
                        _config.Loja.Url));
                }
            }
            catch (Exception ex)
            {
                PrintError(ShopConsoleCommand + " falhou: " + ex);
            }
        }

        [ConsoleCommand(CloseConsoleCommand)]
        private void ConsoleClose(ConsoleSystem.Arg arg)
        {
            try
            {
                BasePlayer player = arg.Player();

                if (player == null)
                {
                    return;
                }

                CloseShop(player);
            }
            catch (Exception ex)
            {
                PrintError(CloseConsoleCommand + " falhou: " + ex);
            }
        }

        // ========================================================
        //  origemz.queue [offset] [limit]
        //
        //  A fila ao vivo, para o RustAgent e para o painel.
        //
        //      {"ok":true,"count":7,"offset":0,"limit":100,
        //       "serverFull":true,"joining":1,
        //       "queue":[{"position":0,"steamId":"7656...",
        //                 "name":"Fulano","tier":"gold",
        //                 "waitingSeconds":312,"score":45.2}]}
        //
        //  Resposta de UMA LINHA, como no resto do projeto: o
        //  agente separa respostas por linha no RCON, e um JSON
        //  quebrado em varias viraria fragmento invalido.
        //
        //  "offset" e "limit" voltam JA NORMALIZADOS, entao quem
        //  pede limit=5000 recebe limit=250 e ve na resposta que
        //  foi limitado, em vez de achar que o resto sumiu.
        // ========================================================
        [ConsoleCommand(QueueConsoleCommand)]
        private void ConsoleQueue(ConsoleSystem.Arg arg)
        {
            // Excecao que sobe de um ConsoleCommand vindo do RCON
            // nao produz resposta nenhuma, e o agente fica pendurado
            // ate o timeout. Todo caminho de saida daqui responde.
            try
            {
                arg.ReplyWith(HandleQueueQuery(arg));
            }
            catch (Exception ex)
            {
                PrintError(QueueConsoleCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleQueueQuery(ConsoleSystem.Arg arg)
        {
            int offset;

            if (!TryReadInt(arg, 0, 0, out offset) || offset < 0)
            {
                return BuildError(ErrorInvalidArgs);
            }

            int limit;

            if (!TryReadInt(arg, 1, DefaultQueueLimit, out limit) || limit < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            if (limit > MaxQueueLimit)
            {
                limit = MaxQueueLimit;
            }

            ConnectionQueue queue = GetConnectionQueue();

            if (queue == null || queue.queue == null)
            {
                return BuildError(ErrorQueueUnavailable);
            }

            List<Network.Connection> list = queue.queue;
            float now = Time.realtimeSinceStartup;
            List<QueueItem> items = new List<QueueItem>();

            // long para nao estourar: offset int.MaxValue com limit
            // 250 dobraria para negativo em int, e a janela viraria
            // vazia sem ninguem entender por que.
            long end = (long)offset + limit;

            for (int i = 0; i < list.Count; i++)
            {
                if (i < offset || i >= end)
                {
                    continue;
                }

                Network.Connection connection = list[i];

                if (connection == null)
                {
                    continue;
                }

                float arrivedAt = GetArrivedAt(connection, now);
                string tier = GetTier(connection.userid);

                QueueItem item = new QueueItem();
                item.Position = i;
                item.SteamId = connection.userid.ToString();
                item.Name = connection.username;
                item.Tier = tier;
                item.WaitingSeconds = (int)(now - arrivedAt);
                item.Score = ComputeScore(tier, connection.authLevel, now - arrivedAt);

                // float.MaxValue nao sobrevive a uma viagem por JSON
                // com significado nenhum do outro lado. O admin sai
                // com a marca dele e um score legivel.
                if (item.Score >= float.MaxValue)
                {
                    item.Tier = TierAdmin;
                    item.Score = -1f;
                }

                items.Add(item);
            }

            QueueResponse response = new QueueResponse();
            response.Count = list.Count;
            response.Offset = offset;
            response.Limit = limit;
            response.ServerFull = queue.IsServerFull;
            response.Joining = queue.Joining;
            response.Queue = items;

            return JsonConvert.SerializeObject(response);
        }

        // ========================================================
        //  AGENTE
        // ========================================================

        // O nivel do jogador, do cache do agente. NAO dispara
        // chamada de rede - isto roda no caminho de conexao e
        // dentro do laco da reordenacao.
        //
        // null significa "nao e VIP", e e o lado seguro: agente
        // fora do ar vira fila sem prioridade, e nao fila invertida.
        private string GetTier(ulong userId)
        {
            try
            {
                // Null-check obrigatorio em toda chamada (regra 2):
                // o [PluginReference] vira null quando o agente e
                // descarregado.
                if (OrigemZAgent == null)
                {
                    return null;
                }

                string tier = OrigemZAgent.Call(HookGetVipTier, userId.ToString()) as string;

                return NormalizeTier(tier);
            }
            catch (Exception ex)
            {
                PrintError("GetVipTier falhou para " + userId + ": " + ex);
                return null;
            }
        }

        // Telemetria. Sem retorno de proposito: isto esta no
        // caminho de conexao do jogador e nao pode somar latencia a
        // entrada de ninguem.
        private void NotifyAgent(ulong userId, string action, string tier)
        {
            try
            {
                if (OrigemZAgent == null || !_config.RegistrarEventosDaFila)
                {
                    return;
                }

                ConnectionQueue queue = GetConnectionQueue();
                int size = queue == null ? 0 : queue.Queued;

                OrigemZAgent.Call(HookNotifyQueueEvent, userId.ToString(), action,
                                  tier == null ? string.Empty : tier, size);
            }
            catch (Exception ex)
            {
                PrintError("NotifyQueueEvent falhou: " + ex);
            }
        }

        // Chamado UMA vez, no boot. Como toda chamada entre plugins
        // e por string, um metodo renomeado do outro lado so falha
        // em runtime - esta versao e o unico aviso antecipado que
        // existe.
        private void LogAgentApiVersion()
        {
            if (OrigemZAgent == null)
            {
                PrintError("OrigemZAgent nao esta carregado - sem ele este plugin trata " +
                           "TODO MUNDO como jogador normal, e a fila fica por ordem de chegada.");
                return;
            }

            object raw = OrigemZAgent.Call(HookGetApiVersion);

            if (!(raw is int))
            {
                PrintError("GetApiVersion do agente devolveu " + (raw == null ? "null" : raw.ToString()) +
                           ", que nao e um inteiro. O contrato de hook pode ter mudado.");
                return;
            }

            int version = (int)raw;
            Puts("API do agente: v" + version + " (este plugin foi escrito para a v" +
                 ExpectedAgentApiVersion + ").");

            if (version != ExpectedAgentApiVersion)
            {
                PrintWarning("Versao de contrato diferente da esperada. A fila continua " +
                             "funcionando, mas confira Docs\\OrigemZAgent\\HOOKS.md antes de " +
                             "confiar no resultado.");
            }
        }

        // ========================================================
        //  CONFIG
        // ========================================================
        protected override void LoadDefaultConfig()
        {
            _config = PluginConfig.Default();
            PrintWarning("Config novo criado com a politica padrao de fila.");
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();

            try
            {
                _config = Config.ReadObject<PluginConfig>();
            }
            catch (Exception ex)
            {
                // Config ilegivel NAO vira config padrao gravado por
                // cima: sobrescrever apagaria o arquivo que o admin
                // escreveu errado, e com ele a unica pista do que
                // ele quis dizer.
                PrintError("Config ilegivel, usando os padroes SEM gravar por cima. " +
                           "Conserte Server\\oxide\\config\\OrigemZQueue.json: " + ex.Message);
                _config = PluginConfig.Default();
                return;
            }

            if (_config == null)
            {
                LoadDefaultConfig();
            }

            // Sub-objeto ausente vira o padrao dele, e nao null: um
            // config antigo, sem a secao Loja, carregaria e so
            // quebraria quando o primeiro jogador digitasse o
            // comando.
            if (_config.Prioridades == null)
            {
                _config.Prioridades = PluginConfig.DefaultPriorities();
            }

            if (_config.Loja == null)
            {
                _config.Loja = ShopConfig.Default();
            }

            if (_config.NiveisQueFuramAFila == null)
            {
                _config.NiveisQueFuramAFila = new List<string>();
            }

            // Grava de volta para o arquivo ganhar as chaves novas
            // de uma versao futura do plugin.
            SaveConfig();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(_config, true);
        }

        // Config cru vira mapa validado. Chave sem nome e
        // DESCARTADA, e nao completada com um padrao: adivinhar o
        // nivel daria prioridade a quem ninguem cadastrou.
        private Dictionary<string, int> BuildPriorities(PluginConfig config)
        {
            Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.Ordinal);

            if (config == null || config.Prioridades == null)
            {
                return map;
            }

            foreach (KeyValuePair<string, int> pair in config.Prioridades)
            {
                string tier = NormalizeTier(pair.Key);

                if (tier == null)
                {
                    PrintError("Prioridades tem uma chave vazia no config; ela foi ignorada.");
                    continue;
                }

                if (map.ContainsKey(tier))
                {
                    PrintError("Nivel '" + tier + "' aparece mais de uma vez em Prioridades. " +
                               "So a primeira entrada vale.");
                    continue;
                }

                map[tier] = pair.Value;
            }

            if (!map.ContainsKey(TierNormal))
            {
                // "normal" e o zero da regua, e o
                // AplicarTetoSomenteAoNormal precisa dele para
                // saber a quem o teto se aplica.
                PrintWarning("Prioridades nao tem a chave '" + TierNormal + "'; " +
                             "assumindo 0 para quem nao e VIP.");
                map[TierNormal] = 0;
            }

            return map;
        }

        private HashSet<string> BuildBypassTiers(PluginConfig config)
        {
            HashSet<string> set = new HashSet<string>(StringComparer.Ordinal);

            if (config == null || config.NiveisQueFuramAFila == null)
            {
                return set;
            }

            for (int i = 0; i < config.NiveisQueFuramAFila.Count; i++)
            {
                string tier = NormalizeTier(config.NiveisQueFuramAFila[i]);

                if (tier == null)
                {
                    continue;
                }

                set.Add(tier);
            }

            if (set.Count > 0)
            {
                // Isto nao e detalhe: quando o Rust aceita o bypass
                // com o servidor cheio, ele chama JoinGame direto e
                // o jogador entra ACIMA do maxplayers. Um servidor
                // de 100 com trinta gold online vira um servidor de
                // 130, e a queda de desempenho nao aponta para esta
                // linha de config.
                Puts("Niveis que furam a fila: " + string.Join(", ", ToArray(set)) +
                     ". Lembre que quem fura entra mesmo com o servidor cheio, " +
                     "acima de server.maxplayers.");
            }

            return set;
        }

        // A validacao que impede a fila de prometer o que nao
        // cumpre. Nenhum destes casos e erro de sintaxe - o JSON
        // esta perfeito, e a POLITICA e que esta quebrada.
        private void WarnAboutStarvation()
        {
            if (_config.PontosPorMinutoEsperando <= 0)
            {
                PrintWarning("PontosPorMinutoEsperando e " + _config.PontosPorMinutoEsperando +
                             ": o envelhecimento esta DESLIGADO. A fila vira ordenacao pura por " +
                             "nivel, e um jogador normal fica atras de todo VIP para sempre.");
                return;
            }

            int highest = 0;
            string highestTier = null;

            foreach (KeyValuePair<string, int> pair in _priorities)
            {
                // O admin sai da conta quando ele nem passa pela
                // formula.
                if (pair.Key == TierAdmin && _config.AdminSempreNoTopo)
                {
                    continue;
                }

                if (highestTier == null || pair.Value > highest)
                {
                    highest = pair.Value;
                    highestTier = pair.Key;
                }
            }

            if (highestTier == null)
            {
                return;
            }

            if (_config.TetoDeEnvelhecimento <= highest && !_config.AplicarTetoSomenteAoNormal)
            {
                PrintWarning("TetoDeEnvelhecimento (" + _config.TetoDeEnvelhecimento +
                             ") nao e maior que a maior base, '" + highestTier + "' (" + highest +
                             "). Um jogador normal satura em " + _config.TetoDeEnvelhecimento +
                             " pontos e NUNCA alcanca um '" + highestTier +
                             "' recem-chegado: fome permanente, causada pelo teto.");
            }
        }

        // A loja com endereco quebrado nao vira loja meia-boca: ela
        // e DESLIGADA. Um botao que leva a lugar nenhum custa mais
        // do que botao nenhum.
        private bool ValidateShop(PluginConfig config)
        {
            if (config.Loja == null || !config.Loja.Ativa)
            {
                return false;
            }

            string url = config.Loja.Url == null ? null : config.Loja.Url.Trim();

            if (string.IsNullOrEmpty(url))
            {
                PrintError("Loja.Ativa e true mas Loja.Url esta vazia. A loja foi desligada.");
                return false;
            }

            // http/https explicito: o campo vai para a tela do
            // jogador, e um "javascript:" ou um caminho local ali
            // seria ruido no melhor caso.
            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                PrintError("Loja.Url ('" + url + "') nao comeca com http:// nem https://. " +
                           "A loja foi desligada.");
                return false;
            }

            if (url.Length > UrlFieldCharLimit)
            {
                PrintError("Loja.Url tem " + url.Length + " caracteres e o campo da tela mostra " +
                           UrlFieldCharLimit + ". O endereco chegaria CORTADO ao jogador, " +
                           "entao a loja foi desligada.");
                return false;
            }

            config.Loja.Url = url;

            // server.url e o UNICO botao clicavel de verdade que o
            // Rust oferece (menu ESC e navegador de servidores). Se
            // ele aponta para outro lugar, o jogador tem dois
            // enderecos e nenhuma explicacao.
            if (config.Loja.AvisarSeServerUrlDivergir)
            {
                CompareWithServerUrl(url);
            }

            return true;
        }

        private void CompareWithServerUrl(string url)
        {
            try
            {
                string serverUrl = ConVar.Server.url;

                if (string.IsNullOrEmpty(serverUrl))
                {
                    PrintWarning("A convar server.url esta vazia. Defina-a com o site do servidor " +
                                 "para o jogador ter um botao CLICAVEL no menu ESC - o painel deste " +
                                 "plugin so consegue mostrar o endereco para copiar.");
                    return;
                }

                if (!string.Equals(serverUrl.Trim(), url, StringComparison.OrdinalIgnoreCase))
                {
                    PrintWarning("server.url ('" + serverUrl + "') e diferente de Loja.Url ('" + url +
                                 "'). Sao dois enderecos diferentes chegando ao mesmo jogador.");
                }
            }
            catch (Exception ex)
            {
                PrintWarning("Nao deu para ler a convar server.url: " + ex.Message);
            }
        }

        // ========================================================
        //  LANG
        //
        //  #### POR QUE \uXXXX EM VEZ DE ACENTO DIRETO ####
        //
        //  O arquivo fonte e ASCII puro de proposito: ele viaja do
        //  MSBuild para Server\oxide\plugins e e recompilado la
        //  pelo Oxide, e byte acentuado dependeria de os dois lados
        //  concordarem sobre a codificacao.
        //
        //  O jogador nunca ve o escape: o Oxide grava o lang em
        //  Server\oxide\lang\<idioma>\OrigemZQueue.json ja com o
        //  caractere certo.
        // ========================================================
        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>
            {
                { MsgQueueStatus, "Queue: {0} player(s) waiting." },
                { MsgQueueEmpty, "Nobody is waiting in the queue right now." },
                { MsgQueuePriority, "Your priority: {0} ({1} points)." },
                { MsgWaitReport, "You waited {0} in the queue." },
                { MsgWaitReportOvertaken, "You waited {0} in the queue and {1} priority player(s) went ahead of you." },
                { MsgShopOffer, "Want to skip the line? Type /{0}" },
                { MsgShopTitle, "BECOME VIP" },
                { MsgShopSubtitle, "Priority in the queue and perks on the server" },
                { MsgShopBuyButton, "BUY VIP" },
                { MsgShopCloseButton, "CLOSE" },
                { MsgShopBackButton, "BACK" },
                { MsgShopLinkTitle, "Open this address in your browser" },
                { MsgShopLinkHint, "Click the field, select with Ctrl+A and copy with Ctrl+C." },
                { MsgShopChatLink, "VIP store: {0}" },
                { MsgShopDisabled, "The VIP store is not configured on this server." },
                { MsgDurationMinutes, "{0} min" },
                { MsgDurationHours, "{0}h {1}min" },
                { MsgUnavailable, "Queue information unavailable right now. Try again in a moment." },
                { TierLabelPrefix + TierNormal, "NO VIP" },
                { TierLabelPrefix + TierAdmin, "ADMIN" },
                { TierLabelPrefix + "bronze", "VIP BRONZE" },
                { TierLabelPrefix + "silver", "VIP SILVER" },
                { TierLabelPrefix + "gold", "VIP GOLD" }
            }, this);

            lang.RegisterMessages(new Dictionary<string, string>
            {
                // Rende: Fila: {0} jogador(es) esperando.
                { MsgQueueStatus, "Fila: {0} jogador(es) esperando." },
                // Rende: Ninguem esta esperando na fila agora.
                { MsgQueueEmpty, "Ningu\u00e9m est\u00e1 esperando na fila agora." },
                // Rende: Sua prioridade: {0} ({1} pontos).
                { MsgQueuePriority, "Sua prioridade: {0} ({1} pontos)." },
                // Rende: Voce esperou {0} na fila.
                { MsgWaitReport, "Voc\u00ea esperou {0} na fila." },
                // Rende: Voce esperou {0} na fila e {1} jogador(es) com prioridade entraram na sua frente.
                { MsgWaitReportOvertaken, "Voc\u00ea esperou {0} na fila e {1} jogador(es) com prioridade entraram na sua frente." },
                // Rende: Quer entrar na frente? Digite /{0}
                { MsgShopOffer, "Quer entrar na frente? Digite /{0}" },
                { MsgShopTitle, "SEJA VIP" },
                // Rende: Prioridade na fila e beneficios no servidor
                { MsgShopSubtitle, "Prioridade na fila e benef\u00edcios no servidor" },
                { MsgShopBuyButton, "COMPRAR VIP" },
                { MsgShopCloseButton, "FECHAR" },
                { MsgShopBackButton, "VOLTAR" },
                // Rende: Abra este endereco no seu navegador
                { MsgShopLinkTitle, "Abra este endere\u00e7o no seu navegador" },
                // Rende: Clique no campo, selecione com Ctrl+A e copie com Ctrl+C.
                { MsgShopLinkHint, "Clique no campo, selecione com Ctrl+A e copie com Ctrl+C." },
                { MsgShopChatLink, "Loja de VIP: {0}" },
                // Rende: A loja de VIP nao esta configurada neste servidor.
                { MsgShopDisabled, "A loja de VIP n\u00e3o est\u00e1 configurada neste servidor." },
                { MsgDurationMinutes, "{0} min" },
                { MsgDurationHours, "{0}h {1}min" },
                // Rende: Informacao da fila indisponivel agora. Tente de novo em instantes.
                { MsgUnavailable, "Informa\u00e7\u00e3o da fila indispon\u00edvel agora. Tente de novo em instantes." },
                { TierLabelPrefix + TierNormal, "SEM VIP" },
                { TierLabelPrefix + TierAdmin, "ADMIN" },
                { TierLabelPrefix + "bronze", "VIP BRONZE" },
                { TierLabelPrefix + "silver", "VIP PRATA" },
                { TierLabelPrefix + "gold", "VIP OURO" }
            }, this, "pt-BR");
        }

        private string Msg(string key, string userId)
        {
            return lang.GetMessage(key, this, userId);
        }

        // Nivel acrescentado no config sem linha no lang cai no
        // identificador em maiuscula: "PLATINUM" e um rotulo pobre,
        // mas "TierLabel.platinum" na cara do jogador seria
        // vazamento de chave interna.
        private string ResolveTierLabel(string tier, string userId)
        {
            string key = TierLabelPrefix + tier;
            string label = Msg(key, userId);

            // lang.GetMessage devolve a PROPRIA chave quando ela nao
            // esta registrada - e por isso a comparacao com a chave
            // e o teste de "nao existe".
            if (string.IsNullOrEmpty(label) || label == key)
            {
                return tier.ToUpperInvariant();
            }

            return label;
        }

        private string FormatDuration(float seconds, string userId)
        {
            if (seconds < 0f)
            {
                seconds = 0f;
            }

            int totalMinutes = (int)(seconds / 60f);

            if (totalMinutes < 60)
            {
                return string.Format(Msg(MsgDurationMinutes, userId), totalMinutes);
            }

            return string.Format(Msg(MsgDurationHours, userId),
                totalMinutes / 60, totalMinutes % 60);
        }

        // ========================================================
        //  AUXILIARES
        // ========================================================

        private ConnectionQueue GetConnectionQueue()
        {
            ServerMgr manager = ServerMgr.Instance;

            if (manager == null)
            {
                return null;
            }

            return manager.connectionQueue;
        }

        // Identificador de nivel e SEMPRE ingles minusculo, em toda
        // a cadeia - site, banco, agente e plugin. Normalizar na
        // entrada deixa a comparacao ser ordinal simples, e nao um
        // ToLower espalhado por cinco lugares.
        private static string NormalizeTier(string tier)
        {
            if (string.IsNullOrEmpty(tier))
            {
                return null;
            }

            string normalized = tier.Trim().ToLowerInvariant();
            return normalized.Length == 0 ? null : normalized;
        }

        // NAO indexe arg.Args diretamente: no Rust atual ele e
        // Facepunch.StringView[], que nao converte para string nem
        // tem os metodos dela. arg.GetString e a API estavel.
        private static bool TryReadInt(ConsoleSystem.Arg arg, int index, int fallback, out int value)
        {
            value = fallback;

            if (arg.Args == null || arg.Args.Length <= index)
            {
                return true;
            }

            string raw = arg.GetString(index, "").Trim();

            if (raw.Length == 0)
            {
                return true;
            }

            return int.TryParse(raw, out value);
        }

        private static string BuildError(string code)
        {
            return JsonConvert.SerializeObject(new ErrorResponse { Error = code });
        }

        // string.Join(string, IEnumerable<string>) so existe a
        // partir do .NET 4, e o array intermediario e o caminho que
        // compila em qualquer um.
        private static string[] ToArray(HashSet<string> set)
        {
            string[] array = new string[set.Count];
            set.CopyTo(array);
            return array;
        }

        // --------------------------------------------------------
        //  UI: os dois ajudantes que evitam repetir doze linhas de
        //  componente por elemento de tela.
        // --------------------------------------------------------
        private static void AddLabel(CuiElementContainer container, string parent, string text,
                                     int fontSize, string font, string color, TextAnchor align,
                                     string anchorMin, string anchorMax,
                                     string offsetMin, string offsetMax)
        {
            CuiLabel label = new CuiLabel();
            label.Text.Text = text;
            label.Text.FontSize = fontSize;
            label.Text.Font = font;
            label.Text.Color = color;
            label.Text.Align = align;
            label.RectTransform.AnchorMin = anchorMin;
            label.RectTransform.AnchorMax = anchorMax;
            label.RectTransform.OffsetMin = offsetMin;
            label.RectTransform.OffsetMax = offsetMax;

            container.Add(label, parent);
        }

        private static void AddButton(CuiElementContainer container, string parent, string text,
                                      string command, string close, string color,
                                      string anchorMin, string anchorMax,
                                      string offsetMin, string offsetMax)
        {
            CuiButton button = new CuiButton();
            button.Button.Command = command;
            button.Button.Color = color;

            if (!string.IsNullOrEmpty(close))
            {
                button.Button.Close = close;
            }

            button.Text.Text = text;
            button.Text.FontSize = 14;
            button.Text.Font = FontBold;
            button.Text.Color = ColorTextStrong;
            button.Text.Align = TextAnchor.MiddleCenter;
            button.RectTransform.AnchorMin = anchorMin;
            button.RectTransform.AnchorMax = anchorMax;
            button.RectTransform.OffsetMin = offsetMin;
            button.RectTransform.OffsetMax = offsetMax;

            container.Add(button, parent);
        }

        // --------------------------------------------------------
        //  Quem esta (ou esteve) na fila.
        //
        //  Classe, e nao struct: o codigo edita o registro no lugar
        //  (record.Overtaken += lost), e com struct isso alteraria
        //  uma COPIA e o incremento se perderia sem erro nenhum.
        // --------------------------------------------------------
        private class ArrivalRecord
        {
            // Time.realtimeSinceStartup, e nao DateTime: e o mesmo
            // relogio que o Rust usa na fila, e ele nao anda para
            // tras quando o horario de verao muda.
            public float ArrivedAt;

            // -1 significa "ainda esta na fila".
            public float LeftAt;

            // Quantas posicoes ele perdeu para quem tem mais
            // prioridade. E o numero do relatorio da entrada.
            public int Overtaken;

            public string Name;
        }

        // Uma conexao da fila com o score ja congelado. Ver o
        // comentario da reordenacao para o porque de congelar.
        private class QueueEntry
        {
            public Network.Connection Connection;
            public ulong UserId;
            public string Tier;
            public float Score;
            public float ArrivedAt;
            public int OriginalIndex;
        }

        // --------------------------------------------------------
        //  CONFIG
        //
        //  Chaves em portugues porque quem le e edita este arquivo e
        //  o admin do servidor - so os IDENTIFICADORES DE NIVEL
        //  ficam em ingles, porque sao protocolo e viajam para fora
        //  daqui.
        // --------------------------------------------------------
        // #### POR QUE CADA PROPRIEDADE TEM INICIALIZADOR ####
        //
        // Chave NOVA num arquivo de config que ja existe nao vem no
        // JSON, e o Newtonsoft entao deixa o default do TIPO
        // (false, 0) - nao o do Default(). O SaveConfig logo em
        // seguida grava esse valor errado no arquivo, e ele parece
        // uma escolha de alguem.
        //
        // Sem inicializador, acrescentar uma chave "ligada por
        // padrao" a este plugin a entregaria DESLIGADA em todo
        // servidor que ja rodou a versao anterior. Ja aconteceu no
        // OrigemZPlayer.
        //
        // As duas excecoes sao intencionais:
        // AplicarTetoSomenteAoNormal fica em `false`, que E o
        // padrao do tipo; o mapa Prioridades e a lista de bypass
        // sao tratados no LoadConfig, porque `null` e diferente de
        // "vazio de proposito".
        private class PluginConfig
        {
            [JsonProperty("Prioridades")]
            public Dictionary<string, int> Prioridades { get; set; }

            [JsonProperty("PontosPorMinutoEsperando")]
            public int PontosPorMinutoEsperando { get; set; } = 1;

            [JsonProperty("TetoDeEnvelhecimento")]
            public int TetoDeEnvelhecimento { get; set; } = 60;

            [JsonProperty("AplicarTetoSomenteAoNormal")]
            public bool AplicarTetoSomenteAoNormal { get; set; }

            [JsonProperty("AdminSempreNoTopo")]
            public bool AdminSempreNoTopo { get; set; } = true;

            [JsonProperty("NiveisQueFuramAFila")]
            public List<string> NiveisQueFuramAFila { get; set; }

            [JsonProperty("SegundosDeCarenciaNaReconexao")]
            public int SegundosDeCarenciaNaReconexao { get; set; } = 180;

            [JsonProperty("SegundosEntreReordenacoes")]
            public int SegundosEntreReordenacoes { get; set; } = 15;

            [JsonProperty("AvisarNaEntradaQuandoAPosicaoPiorou")]
            public bool AvisarNaEntradaQuandoAPosicaoPiorou { get; set; } = true;

            [JsonProperty("SegundosMinimosParaRelatarAEspera")]
            public int SegundosMinimosParaRelatarAEspera { get; set; } = 60;

            [JsonProperty("RegistrarEventosDaFila")]
            public bool RegistrarEventosDaFila { get; set; } = true;

            [JsonProperty("ComandoDeChatDaFila")]
            public string ComandoDeChatDaFila { get; set; } = "fila";

            [JsonProperty("Loja")]
            public ShopConfig Loja { get; set; }

            public static PluginConfig Default()
            {
                PluginConfig config = new PluginConfig();

                config.Prioridades = DefaultPriorities();
                config.PontosPorMinutoEsperando = 1;
                config.TetoDeEnvelhecimento = 60;
                config.AplicarTetoSomenteAoNormal = false;
                config.AdminSempreNoTopo = true;

                // VAZIO de proposito. Quem fura a fila entra ACIMA
                // do maxplayers quando o servidor esta cheio, e a
                // escada de prioridade ja e entregue pela
                // reordenacao - que e o desenho que sustenta a
                // promessa dos "no maximo 40 minutos".
                config.NiveisQueFuramAFila = new List<string>();

                config.SegundosDeCarenciaNaReconexao = 180;
                config.SegundosEntreReordenacoes = 15;
                config.AvisarNaEntradaQuandoAPosicaoPiorou = true;
                config.SegundosMinimosParaRelatarAEspera = 60;
                config.RegistrarEventosDaFila = true;
                config.ComandoDeChatDaFila = "fila";
                config.Loja = ShopConfig.Default();

                return config;
            }

            // Base 20/30/40 espacada de 10 de proposito: com
            // PontosPorMinutoEsperando 1, a distancia entre duas
            // bases E o numero de minutos que o nivel de baixo leva
            // para alcancar o de cima recem-chegado.
            //
            // "admin" esta aqui, com 100, mas so e LIDO quando
            // AdminSempreNoTopo e false - com ele ligado, o admin
            // nem passa pela formula.
            public static Dictionary<string, int> DefaultPriorities()
            {
                Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.Ordinal);

                map[TierAdmin] = 100;
                map["gold"] = 40;
                map["silver"] = 30;
                map["bronze"] = 20;
                map[TierNormal] = 0;

                return map;
            }
        }

        private class ShopConfig
        {
            [JsonProperty("Ativa")]
            public bool Ativa { get; set; } = true;

            [JsonProperty("Url")]
            public string Url { get; set; }

            [JsonProperty("ComandoDeChat")]
            public string ComandoDeChat { get; set; } = "comprarvip";

            [JsonProperty("OferecerNaEntrada")]
            public bool OferecerNaEntrada { get; set; } = true;

            [JsonProperty("AbrirTelaNaEntrada")]
            public bool AbrirTelaNaEntrada { get; set; }

            [JsonProperty("AvisarSeServerUrlDivergir")]
            public bool AvisarSeServerUrlDivergir { get; set; } = true;

            // Texto de OFERTA, e por isso mora aqui e nao no lang: o
            // que o VIP entrega muda com a promocao, e quem edita e
            // o dono do servidor, nao o tradutor.
            [JsonProperty("Beneficios")]
            public List<string> Beneficios { get; set; }

            public static ShopConfig Default()
            {
                ShopConfig shop = new ShopConfig();

                shop.Ativa = true;
                shop.Url = "https://origemznetwork.com/rust/";
                shop.ComandoDeChat = "comprarvip";
                shop.OferecerNaEntrada = true;

                // Abrir a tela sozinho no primeiro segundo de jogo
                // rouba o controle do jogador que acabou de entrar.
                // A oferta no chat basta, e ela nao interrompe
                // ninguem.
                shop.AbrirTelaNaEntrada = false;

                shop.AvisarSeServerUrlDivergir = true;
                shop.Beneficios = new List<string>
                {
                    "- Prioridade na fila de entrada",
                    "- Kit exclusivo do seu n\u00edvel",
                    "- Tag VIP no chat",
                    "- Acesso a eventos exclusivos"
                };

                return shop;
            }
        }

        // --------------------------------------------------------
        //  DTOs
        //
        //  Cada campo tem [JsonProperty] com o nome exato: sem isso
        //  o Newtonsoft usaria PascalCase e o agente nao
        //  reconheceria nada.
        // --------------------------------------------------------
        private class QueueResponse
        {
            // "ok" e propriedade so de leitura com valor fixo: assim
            // nao existe caminho de codigo capaz de mandar um erro
            // com ok:true, ou vice-versa.
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            // O TOTAL, e nao o tamanho da pagina. Sem ele, quem pede
            // 100 e recebe 100 nao tem como saber se acabou ou se
            // falta.
            [JsonProperty("count")]
            public int Count { get; set; }

            [JsonProperty("offset")]
            public int Offset { get; set; }

            [JsonProperty("limit")]
            public int Limit { get; set; }

            [JsonProperty("serverFull")]
            public bool ServerFull { get; set; }

            [JsonProperty("joining")]
            public int Joining { get; set; }

            [JsonProperty("queue")]
            public List<QueueItem> Queue { get; set; }
        }

        private class QueueItem
        {
            [JsonProperty("position")]
            public int Position { get; set; }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("name")]
            public string Name { get; set; }

            // null quando o jogador nao e VIP. Precisa SAIR como
            // null no JSON: omitir o campo faria "sem VIP" e "campo
            // ausente" virarem a mesma coisa para quem le.
            [JsonProperty("tier")]
            public string Tier { get; set; }

            [JsonProperty("waitingSeconds")]
            public int WaitingSeconds { get; set; }

            // -1 significa "fora da formula", que hoje e o admin com
            // AdminSempreNoTopo ligado.
            [JsonProperty("score")]
            public float Score { get; set; }
        }

        private class ErrorResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return false; } }

            [JsonProperty("error")]
            public string Error { get; set; }
        }
    }
}
