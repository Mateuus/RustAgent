// ============================================================
//  OrigemZBattlePass  -  o Passe de Batalha da OrigemZ, na tela do jogo.
//
//  Especificação: Docs/BattlePass/01-A-TEMPORADA-E-AS-REGRAS.md (as
//  regras), 02-O-PASSE-DO-JOGADOR.md (o agente) e
//  03-MENU-DO-PASSE.md (esta tela).
//
//  ####  POR QUE A TELA NASCE AQUI, E NÃO NO AGENTE  ####
//
//  Quase toda tela deste projeto é montada no agente e servida pelo
//  OrigemZUI, que não sabe desenhar — ele recebe a lista de
//  CuiElement pronta. Duas coisas que o passe precisa NÃO EXISTEM
//  naquele modelo: a trilha que ROLA (ScrollView) e o TOOLTIP da
//  caixa de pendências, que o dono pediu com todas as letras. O menu
//  de skins já é a exceção que mostra o caminho, e é o molde deste
//  arquivo, linha a linha (03 §1 e §5).
//
//  ####  O QUE É DAQUI E O QUE É DO AGENTE  ####
//
//    AGENTE   a temporada, a trilha, o XP, quem comprou, o que já foi
//             resgatado e a entrega de verdade (mochila, carteira)
//    AQUI     a tela, o estado de cada faixa NO DESENHO, e o pedido
//
//  Este arquivo nunca entrega nada. Ele PEDE — e quem decide se cabe
//  na mochila é o agente, que é o único que sabe (02 §6.2).
//
//  ####  O JOGADOR VÊ O QUE NÃO PODE LEVAR  ####
//
//  A faixa paga aparece mesmo para quem não comprou: apagada, com
//  cadeado e selo. Cadeado sem conteúdo não vende nada — o gancho de
//  conversão é ver o que está ficando na mesa (03 §3.1, regra 2). E
//  nada se comunica SÓ pela cor: cadeado para bloqueado, ✓ para
//  resgatado, ! para disponível.
//
// ============================================================
//  ####  ARMADILHAS MEDIDAS (03 §11)  ####
//
//  1. `[ConsoleCommand]` NÃO funciona em CovalencePlugin: o plugin
//     carrega limpo, o comando simplesmente não existe, e o sintoma
//     chega como RCON_TIMEOUT. Este plugin é RustPlugin e tem de
//     continuar sendo.
//
//  2. `arg.Args` é `Facepunch.StringView[]`, e não `string[]`. Tratar
//     como string compila, roda e devolve lixo em silêncio. Toda
//     leitura aqui é por `arg.GetString(i)` / `arg.GetInt(i, …)`.
//
//  3. `SkinId = 0` num ícone de item sem skins DERRUBA O JOGADOR
//     (core/src/game/ui-cui.ts:198). O `Icon` daqui só atribui o
//     campo quando a skin existe.
//
//  4. NENHUM `Puts` sai no frame em que um comando do agente
//     responde: ele entra na resposta CASADA do RCON e a transforma
//     em algo que não é JSON. Todo push passa por `timer.Once`.
//
//  5. `InputField` sem `needsKeyboard` não aceita tecla. Esta tela
//     não tem campo de texto — se um dia tiver, é a regra.
//
//  6. Painel transparente de tela cheia engole o clique no Unity. A
//     raiz de cada região cobre SÓ a faixa dela.
//
// ============================================================
//  ####  O CONTRATO  ####
//
//  Não há HTTP entre o agente e o plugin: o canal é o console do
//  RCON. Duas cargas, as duas INTEIRAS (nunca delta), as duas em
//  base64 e em pedaços, porque o parser de console do Rust COME AS
//  ASPAS de um JSON cru (medido; core/src/game/plugin-push.ts).
//
//  AGENTE → PLUGIN (resposta CASADA no POST /rcon):
//
//      origemz.passe.sync <lote> <i> <n> <b64>
//          → {"ok":true,"levels":N,"period":"2026-09"}
//      origemz.passe.progress <steamId> <lote> <i> <n> <b64>
//          → {"ok":true,"steamId":…,"level":N}
//      origemz.passe.status
//          → {"ok":true,"period":…,"levels":N,"players":N,"secret":bool}
//      origemz.passe.reply <b64>
//          → {"ok":true}
//      origemz.passe.open <steamId>        (abre o menu para alguém)
//          → {"ok":true}
//      origemz.passe.bytes [níveis]        (o pior caso, sem servidor)
//          → {"ok":true,"limit":40000,"regions":{…},"open":[…]}
//      origemz.passe.scroll 0|1            (liga e desliga a rolagem)
//          → {"ok":true,"trackScroll":…,"openAtCurrentLevel":…}
//
//  ####  E OS COMANDOS QUE O CLIENTE DIGITA  ####
//
//  Só um deles interessa a quem está do outro lado: o CARD DA HOME
//  (que é do agente, 03 §7) dispara `origemz.passe.open`, sem
//  argumento — o mesmo caminho pelo qual o botão SKINS abre o menu de
//  skins. Os outros (`close`, `claim`, `claimall`, `box`, `buy`,
//  `page`) nascem dos botões desta tela, carregam o token da sessão e
//  são recusados EM SILÊNCIO quando ele não bate.
//
//  O `sync` é o CATÁLOGO do servidor: temporada, trilha e preço. Ele
//  traz o `secret` do processo do agente, e é ele que destrava tudo
//  o mais — progresso que chega antes do catálogo é RECUSADO, e o
//  agente reenvia no próximo gatilho.
//
//      {"secret":"…","period":"2026-09","name":"SETEMBRO 2026",
//       "serverName":"PVP 1","endsAt":1761955199000,
//       "freeLane":true,"paidLane":true,"purchasable":true,
//       "priceLabel":"2.500 OZCOIN","note":"…",
//       "levels":[{"level":1,"xp":1000,
//                  "free":{"kind":"item","label":"Scrap x50",
//                          "shortname":"scrap","amount":50,
//                          "skinId":"0","icon":"","dlc":false,
//                          "milestone":false},
//                  "paid":{…}}, …]}
//
//  `skinId` viaja como TEXTO (não cabe em inteiro com sinal), `icon`
//  é o CRC de um PNG já gravado no FileStorage (OrigemZImages) e vale
//  quando não há item do jogo para desenhar — OZCoin, kit, arte
//  própria. Faixa ausente = aquele nível não dá nada naquela faixa.
//
//  O `progress` é de UM jogador, e é a VERDADE sobre ele:
//
//      {"secret":"…","period":"2026-09","level":17,"xp":48400,
//       "xpInto":2400,"xpNeeded":3000,"hasPass":false,
//       "boxSeen":false,
//       "claims":[{"level":13,"lane":"free","state":"claimed"},
//                 {"level":16,"lane":"paid","state":"pending"}],
//       "pending":[{"label":"AK-47","origin":"full"},
//                  {"label":"Kit Bruto","origin":"season"}]}
//
//  ####  A LISTA DE CLAIMS SÓ TRAZ EXCEÇÃO  ####
//
//  O que não está nela é DERIVADO aqui, pela regra do 01 §4.1: faixa
//  de nível alcançado é `available`; faixa paga sem direito é
//  `locked`; nível não alcançado é `locked`. Mandar as 30 linhas de
//  uma trilha inteira em toda carga seria pagar banda para repetir o
//  que a regra já diz — e duas fontes para a mesma verdade divergem
//  no primeiro caso de borda.
//
//  `origin` distingue as duas origens de pendência (02 §6.4), e elas
//  precisam ficar distinguíveis na tela: `full` = não coube na
//  mochila; `season` = sobrou da temporada anterior.
//
//  PLUGIN → AGENTE, pelo console:
//
//      #OZPASSE#{"kind":"ready"}                        SEM segredo
//      #OZPASSE#{"kind":"open","secret":…,"steamId":…}
//      #OZPASSE#{"kind":"claim","secret":…,"requestId":…,
//                "steamId":…,"level":N,"lane":"free"|"paid"}
//      #OZPASSE#{"kind":"claimAll","secret":…,"requestId":…,"steamId":…}
//      #OZPASSE#{"kind":"box","secret":…,"requestId":…,"steamId":…}
//      #OZPASSE#{"kind":"buy","secret":…,"requestId":…,"steamId":…}
//
//  O `ready` é o handshake e vai SEM segredo — é ele que PEDE as
//  cargas, e o segredo só existe depois que o catálogo chega. Todo o
//  resto carrega o segredo: sem ele, um jogador digita o marcador no
//  chat e resgata a trilha inteira (o `onConsoleLine` do agente
//  recebe o chat junto com o resto).
//
//  O `open` não espera resposta: ele avisa que a tela abriu, para o
//  agente mandar o progresso fresco. O XP chega ao agente em lotes de
//  60 s, então o que está aqui pode ter meio minuto de idade.
//
//  Os outros quatro esperam `origemz.passe.reply` com o mesmo
//  `requestId`:
//
//      {"requestId":"…","ok":true,"message":"…"}
//
//  A `message` é o que o jogador lê no rodapé, em português, escrita
//  pelo agente — ele é quem sabe quantos slots faltaram.
//
//  ####  DEPOIS DA RESPOSTA, O AGENTE MANDA O PROGRESSO  ####
//
//  Não é opcional, e é a única coisa que este contrato exige do lado
//  de lá. A tela desenha o clique na hora (o resgate vira "esperando"
//  antes de qualquer resposta), e é a carga de `progress` que apaga
//  essa marca. Sem ela, um resgate recusado continuaria parecendo em
//  andamento até o jogador fechar e reabrir o menu.
//
// ============================================================
//  ####  O QUE ESTE PLUGIN GUARDA EM DISCO, E O QUE NÃO GUARDA  ####
//
//  A TEMPORADA é gravada (`season.json`, sem o segredo): o servidor
//  que reinicia com o agente fora do ar continua mostrando a trilha.
//
//  O PROGRESSO não é. Ele muda a cada rodada de 60 s, e um nível
//  gravado ontem seria mostrado hoje como se fosse verdade. Ausente
//  é honesto: a tela diz "sincronizando" e não mente sobre nível nem
//  sobre resgate. "Não sei" é diferente de "não tem" — a mesma regra
//  do menu de skins (02 §5.3 do Workshop).
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Core.Plugins;
using Oxide.Game.Rust.Cui;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("OrigemZBattlePass", "OrigemZ", "0.1.0")]
    [Description("O Passe de Batalha da OrigemZ: a trilha de níveis, o resgate e a caixa de pendências.")]
    public class OrigemZBattlePass : RustPlugin
    {
        private const string Marker = "#OZPASSE#";

        // Os comandos do AGENTE (console do servidor, sem jogador).
        private const string SyncCommand = "origemz.passe.sync";
        private const string ProgressCommand = "origemz.passe.progress";
        private const string StatusCommand = "origemz.passe.status";
        private const string ReplyCommand = "origemz.passe.reply";
        private const string BytesCommand = "origemz.passe.bytes";
        private const string ScrollCommand = "origemz.passe.scroll";

        // Os comandos da tela. Digitados pelo CLIENTE, então conferem
        // tudo de novo: um jogador pode mandá-los pelo F1 com qualquer
        // argumento. O `open` é o único sem token — é ele que cria um.
        private const string MenuOpenCommand = "origemz.passe.open";
        private const string MenuCloseCommand = "origemz.passe.close";
        private const string MenuClaimCommand = "origemz.passe.claim";
        private const string MenuClaimAllCommand = "origemz.passe.claimall";
        private const string MenuBoxCommand = "origemz.passe.box";

        /// <summary>"Resgatar tudo" DENTRO da caixa: entregar de novo o que ficou devendo.</summary>
        private const string MenuRetryCommand = "origemz.passe.retry";

        private const string MenuBuyCommand = "origemz.passe.buy";

        /// <summary>Só existe com a rolagem desligada (ver `TrackScroll`), e é a rede de segurança dela.</summary>
        private const string MenuPageCommand = "origemz.passe.page";

        /// <summary>O comando de fechar do OrigemZUI (servidor, com steamId). Ver `CloseMainMenu`.</summary>
        private const string MainMenuCloseCommand = "origemz.ui.close";

        private const string AdminPermission = "origemzbattlepass.admin";

        /// <summary>A cópia da temporada em disco. O progresso NÃO tem cópia — ver o cabeçalho.</summary>
        private const string SeasonFile = "OrigemZBattlePass/season";

        /// <summary>
        /// O teto de um `AddUI`. O mesmo do menu de skins: o projeto mediu
        /// 50.000 como seguro para o transporte do agente, e o RPC direto
        /// do plugin nunca foi medido — a régua aqui é mais curta de
        /// propósito. O `Pack` corta a carga neste número.
        /// </summary>
        private const int AddUiByteLimit = 40000;

        /// <summary>Quanto um pedido espera a resposta do agente antes de virar frase de erro.</summary>
        private const float RequestTimeoutSeconds = 20f;

        /// <summary>Quanto a faixa de mensagem fica na tela.</summary>
        private const float FlashSeconds = 6f;

        /// <summary>Um comando de tela a cada 80 ms, por jogador. Ver `SessionOf`.</summary>
        private const float CommandCooldownSeconds = 0.08f;

        private const long DayMs = 24L * 60 * 60 * 1000;

        // ============================================================
        //  §1  A CONFIGURAÇÃO
        // ============================================================

        private class PluginConfig
        {
            /// <summary>
            /// A trilha ROLA (ScrollView do CUI) em vez de paginar.
            ///
            /// A receita foi medida no jogo em 17/09/2026 pelo menu de
            /// skins. Se um cliente derrubar: `origemz.passe.scroll 0` no
            /// console desliga na hora, sem recarregar o plugin — e a trilha
            /// volta a paginar de 8 em 8 níveis.
            /// </summary>
            [JsonProperty("TrackScroll")]
            public bool TrackScroll = true;

            /// <summary>
            /// A trilha abre na linha do nível atual, e não no nível 1.
            ///
            /// ####  PENDENTE: ISTO NÃO FOI MEDIDO NO JOGO  ####
            ///
            /// O deslocamento é feito na ÂNCORA do conteúdo do ScrollView,
            /// que é o único jeito de nascer rolado sem mandar RPC depois. O
            /// `ScrollRect` em `Clamped` só recoloca o conteúdo quando ele
            /// passa dos limites, então uma posição válida deve sobreviver ao
            /// primeiro quadro — mas isso é leitura do comportamento, não
            /// medição. Se no jogo a trilha abrir no lugar errado, desligue
            /// aqui: quem está no nível 17 rola dois dedos, e ninguém cai.
            /// </summary>
            [JsonProperty("OpenAtCurrentLevel")]
            public bool OpenAtCurrentLevel = true;
        }

        private PluginConfig _config;

        protected override void LoadDefaultConfig()
        {
            _config = new PluginConfig();
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();

            try
            {
                _config = Config.ReadObject<PluginConfig>();
            }
            catch (Exception cause)
            {
                PrintWarning("A configuração não abriu (" + cause.Message + "): usando o padrão.");
                _config = null;
            }

            if (_config == null)
            {
                _config = new PluginConfig();
            }

            // Grava de volta: chave nova aparece no arquivo sem apagar as
            // que o dono já mexeu.
            SaveConfig();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(_config, true);
        }

        // ============================================================
        //  §2  A TEMPORADA E A TRILHA
        // ============================================================

        /// <summary>As duas faixas de um nível (01 §9: `lane`, nunca `tier` — `tier` é do VIP).</summary>
        private const string LaneFree = "free";
        private const string LanePaid = "paid";

        // Os estados de uma recompensa (01 §4). Não existe `unavailable`:
        // na trilha por XP nada se perde por ter deixado passar.
        private const int StateLocked = 0;
        private const int StateAvailable = 1;
        private const int StateClaimed = 2;
        private const int StatePending = 3;

        /// <summary>O que uma faixa dá num nível. Vazia = aquele nível não dá nada ali.</summary>
        private class Reward
        {
            /// <summary>`item`, `coins`, `kit`, `points`, `vip` ou `skin` — o `QuestReward` do projeto.</summary>
            public string Kind = "";

            /// <summary>O texto que o jogador lê. Em português, escrito pelo agente.</summary>
            public string Label = "";

            /// <summary>O item do jogo, resolvido AQUI pelo shortname (o agente não manda itemId).</summary>
            public int ItemId;
            public string Shortname = "";

            /// <summary>0 = sem skin. O ícone vai SEM `SkinId` — a armadilha 3 do cabeçalho.</summary>
            public ulong SkinId;

            /// <summary>CRC de um PNG do FileStorage, para o que não é item do jogo.</summary>
            public string Icon = "";

            /// <summary>
            /// A skin é de uma DLC da Facepunch (03 §9). A recompensa aparece
            /// para todos; quem não tem a DLC lê o motivo e não a leva.
            /// </summary>
            public bool Dlc;

            /// <summary>Marco: ganha destaque de TAMANHO, e não só de cor (03 §3.1, regra 5).</summary>
            public bool Milestone;

            public bool Has;
        }

        private class Level
        {
            public int Number;

            /// <summary>O XP acumulado que ALCANÇA este nível. Só informa; quem soma é o agente.</summary>
            public long Xp;

            public readonly Reward Free = new Reward();
            public readonly Reward Paid = new Reward();
        }

        /// <summary>
        /// A temporada inteira, já indexada.
        ///
        /// É montada NOVA a cada `sync` e só então trocada: limpar a velha
        /// antes e falhar no meio deixaria o servidor sem trilha — e o
        /// agente acreditando que mandou uma.
        /// </summary>
        private class Season
        {
            public string Period = "";
            public string Name = "";

            /// <summary>De qual servidor é esta trilha (01 §1.4). Sem isto, a 1ª queixa é "meu nível sumiu".</summary>
            public string ServerName = "";

            /// <summary>Quando a temporada fecha (epoch ms). 0 = não sei.</summary>
            public long EndsAt;

            public bool FreeLane = true;
            public bool PaidLane = true;

            /// <summary>O passe está à venda aqui e agora.</summary>
            public bool Purchasable;

            /// <summary>"2.500 OZCOIN" — o preço já formatado pelo agente, que é quem tem a moeda.</summary>
            public string PriceLabel = "";

            public string Note = "";

            public readonly List<Level> Levels = new List<Level>();

            public bool Has
            {
                get { return Levels.Count > 0; }
            }
        }

        private Season _season = new Season();

        /// <summary>
        /// O que o agente sabe sobre UM jogador.
        ///
        /// AUSENTE do dicionário = ninguém disse ainda, e a tela mostra
        /// "sincronizando" em vez de cadeado: dizer "bloqueado" sobre um
        /// nível que talvez seja dele seria mentir com cara de regra.
        /// </summary>
        private class Progress
        {
            /// <summary>De que temporada é este progresso. Diferente da atual = velho, e não vale.</summary>
            public string Period = "";

            public int Level;
            public long Xp;
            public long XpInto;

            /// <summary>0 = trilha concluída (01 §2: passar do último nível não é erro).</summary>
            public long XpNeeded;

            public bool HasPass;

            /// <summary>O ponto de notificação já foi visto (01 §7.1).</summary>
            public bool BoxSeen;

            /// <summary>(nível → estado) das exceções que o agente mandou. O resto é derivado.</summary>
            public readonly Dictionary<int, int> Free = new Dictionary<int, int>();
            public readonly Dictionary<int, int> Paid = new Dictionary<int, int>();

            public readonly List<PendingRow> Pending = new List<PendingRow>();
        }

        /// <summary>Uma linha da caixa. `Origin` distingue as duas origens de pendência (02 §6.4).</summary>
        private class PendingRow
        {
            public string Label = "";
            /// <summary>`full` = não coube na mochila; `season` = sobrou da temporada anterior.</summary>
            public string Origin = "";
        }

        private readonly Dictionary<string, Progress> _progress = new Dictionary<string, Progress>();

        /// <summary>O segredo do `sync`. Vazio = nenhum push sai daqui, e nenhum progresso entra.</summary>
        private string _secret = "";

        private class ChunkBatch
        {
            public string Id = "";
            public int Expected;
            public int Total;
            public readonly StringBuilder Data = new StringBuilder();

            public void Reset()
            {
                Id = "";
                Expected = 0;
                Total = 0;
                Data.Length = 0;
            }
        }

        /// <summary>O lote da temporada em montagem.</summary>
        private readonly ChunkBatch _seasonBatch = new ChunkBatch();

        /// <summary>Os lotes de progresso em montagem, um por steamId.</summary>
        private readonly Dictionary<string, ChunkBatch> _progressBatches = new Dictionary<string, ChunkBatch>();

        // ============================================================
        //  §3  O BOOT E O FIM
        // ============================================================

        private void Init()
        {
            permission.RegisterPermission(AdminPermission, this);
        }

        private void OnServerInitialized()
        {
            LoadSeason();
            StoreIcons();

            // O handshake. Sem segredo de propósito: é ele que PEDE as
            // cargas, e o segredo só existe depois que a temporada chega.
            Puts(Marker + "{\"kind\":\"ready\"}");
        }

        private void Unload()
        {
            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                if (player == null) continue;

                CuiHelper.DestroyUi(player, UiRoot);
            }

            foreach (MenuSession session in _menus.Values)
            {
                if (session.FlashTimer != null) session.FlashTimer.Destroy();
            }

            _menus.Clear();

            foreach (PendingRequest pending in _requests.Values)
            {
                if (pending.Timeout != null) pending.Timeout.Destroy();
            }

            _requests.Clear();
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player == null) return;

            CloseMenu(player);
            _progressBatches.Remove(player.UserIDString);
            _nextOpen.Remove(player.userID);

            // O progresso some com ele: ele é de UMA sessão e envelhece em
            // 60 s. Quem voltar recebe carga nova do agente.
            _progress.Remove(player.UserIDString);
        }

        private void OnPlayerDeath(BasePlayer player, HitInfo info)
        {
            CloseMenu(player);
        }

        private void OnPlayerWound(BasePlayer player, HitInfo info)
        {
            CloseMenu(player);
        }

        // ============================================================
        //  §4  A CARGA DA TEMPORADA  -  origemz.passe.sync
        // ============================================================

        [ConsoleCommand(SyncCommand)]
        private void CmdSync(ConsoleSystem.Arg arg)
        {
            // Jogador digitando no F1. O comando carrega o segredo do
            // agente: não tem resposta para ele, nem uma de erro.
            if (arg.Connection != null) return;

            try
            {
                string encoded;

                if (arg.HasArgs(4))
                {
                    string reply = CollectChunk(_seasonBatch, arg.GetString(0), arg.GetInt(1, -1),
                                                arg.GetInt(2, -1), arg.GetString(3), out encoded);
                    if (reply != null)
                    {
                        arg.ReplyWith(reply);
                        return;
                    }
                }
                else if (arg.HasArgs(1))
                {
                    // A forma de um argumento só, para a carga pequena e para
                    // o teste manual pelo console.
                    encoded = arg.GetString(0);
                }
                else
                {
                    arg.ReplyWith(Fail("INVALID_ARGS", "Use: " + SyncCommand + " <lote> <i> <n> <base64>"));
                    return;
                }

                JObject payload = DecodePayload(encoded);
                if (payload == null)
                {
                    arg.ReplyWith(Fail("INVALID_PAYLOAD", "O payload não é Base64 de um objeto JSON."));
                    return;
                }

                arg.ReplyWith(ApplySeason(payload, true));
            }
            catch (Exception cause)
            {
                arg.ReplyWith(Fail("EXCEPTION", cause.Message));
            }
        }

        /// <summary>
        /// Guarda um pedaço. Devolve `null` quando o lote fechou (e
        /// `whole` traz o base64 inteiro), ou a resposta a dar agora.
        ///
        /// Lote fora de ordem é descartado INTEIRO, e a cópia anterior
        /// sobrevive: meia temporada é pior que temporada velha, porque o
        /// plugin acreditaria que ela está completa.
        /// </summary>
        private static string CollectChunk(ChunkBatch state, string batch, int index, int total,
                                           string piece, out string whole)
        {
            whole = null;

            if (string.IsNullOrEmpty(batch) || index < 0 || total < 1 || index >= total || total > 200)
            {
                state.Reset();
                return Fail("INVALID_ARGS", "Pedaço fora do contrato.");
            }

            if (index == 0)
            {
                state.Reset();
                state.Id = batch;
                state.Total = total;
            }

            if (batch != state.Id || index != state.Expected || total != state.Total)
            {
                state.Reset();
                return Fail("OUT_OF_ORDER", "Pedaço " + index + "/" + total + " fora de ordem.");
            }

            state.Data.Append(piece);
            state.Expected++;

            if (state.Expected < state.Total)
            {
                JObject reply = new JObject
                {
                    ["ok"] = true,
                    ["pending"] = true,
                    ["part"] = index,
                };

                return reply.ToString(Formatting.None);
            }

            whole = state.Data.ToString();
            state.Reset();
            return null;
        }

        /// <summary>
        /// Troca a temporada inteira pela que chegou.
        ///
        /// `fromAgent` = veio do console, e não do disco. Só a do agente
        /// traz segredo e é gravada.
        /// </summary>
        private string ApplySeason(JObject payload, bool fromAgent)
        {
            List<string> skipped = new List<string>();
            Season next = ReadSeason(payload, skipped);

            _season = next;

            if (fromAgent)
            {
                _secret = Text(payload, "secret");
                SaveSeason(payload);
            }

            // ####  O PROGRESSO DE OUTRA TEMPORADA NÃO SOBREVIVE  ####
            //
            // Na virada do mês o XP zera (01 §7). Um progresso de setembro
            // desenhado sobre a trilha de outubro mostraria nível comprado
            // que não existe mais.
            List<string> stale = new List<string>();
            foreach (KeyValuePair<string, Progress> pair in _progress)
            {
                if (pair.Value.Period != next.Period) stale.Add(pair.Key);
            }

            foreach (string steamId in stale)
            {
                _progress.Remove(steamId);
            }

            RedrawAllMenus(Region.All);

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["levels"] = next.Levels.Count,
                ["period"] = next.Period,
            };

            if (skipped.Count > 0)
            {
                reply["skipped"] = string.Join(", ", skipped.ToArray());
            }

            return reply.ToString(Formatting.None);
        }

        private Season ReadSeason(JObject payload, List<string> skipped)
        {
            Season next = new Season
            {
                Period = Text(payload, "period").Trim(),
                Name = Text(payload, "name").Trim(),
                ServerName = Text(payload, "serverName").Trim(),
                EndsAt = Long(payload, "endsAt"),
                FreeLane = Flag(payload, "freeLane", true),
                PaidLane = Flag(payload, "paidLane", true),
                Purchasable = Flag(payload, "purchasable", false),
                PriceLabel = Text(payload, "priceLabel").Trim(),
                Note = Text(payload, "note").Trim(),
            };

            if (next.Name.Length == 0) next.Name = next.Period;

            JArray levels = payload["levels"] as JArray;
            if (levels == null) return next;

            HashSet<int> seen = new HashSet<int>();

            foreach (JToken token in levels)
            {
                JObject row = token as JObject;
                if (row == null) continue;

                int number = Int(row, "level");
                if (number <= 0 || !seen.Add(number))
                {
                    skipped.Add("level=" + number);
                    continue;
                }

                Level level = new Level { Number = number, Xp = Long(row, "xp") };

                ReadReward(row["free"] as JObject, level.Free);
                ReadReward(row["paid"] as JObject, level.Paid);

                next.Levels.Add(level);
            }

            next.Levels.Sort(delegate(Level a, Level b) { return a.Number.CompareTo(b.Number); });

            return next;
        }

        /// <summary>
        /// Lê uma faixa. O item é resolvido AQUI, pelo shortname: o agente
        /// não conhece o `itemid` do jogo, e um shortname que o Rust não
        /// reconhece vira recompensa sem ícone — nunca um erro que apaga a
        /// trilha.
        /// </summary>
        private void ReadReward(JObject row, Reward reward)
        {
            if (row == null) return;

            reward.Has = true;
            reward.Kind = Text(row, "kind").Trim().ToLowerInvariant();
            reward.Label = Text(row, "label").Trim();
            reward.Shortname = Text(row, "shortname").Trim().ToLowerInvariant();
            reward.Icon = Text(row, "icon").Trim();
            reward.Dlc = Flag(row, "dlc", false);
            reward.Milestone = Flag(row, "milestone", false);

            ulong skinId;
            if (ulong.TryParse(Text(row, "skinId"), NumberStyles.None, CultureInfo.InvariantCulture, out skinId))
            {
                reward.SkinId = skinId;
            }

            if (reward.Shortname.Length > 0)
            {
                ItemDefinition def = ItemManager.FindItemDefinition(reward.Shortname);
                if (def != null)
                {
                    reward.ItemId = def.itemid;

                    if (reward.Label.Length == 0)
                    {
                        reward.Label = def.displayName != null ? def.displayName.english : reward.Shortname;
                    }
                }
            }

            if (reward.Label.Length == 0) reward.Label = "Recompensa";
        }

        // ---- a cópia da temporada em disco -------------------------

        private class SeasonFileData
        {
            public long SavedAt;
            public string Payload = "";
        }

        private void SaveSeason(JObject payload)
        {
            try
            {
                JObject copy = (JObject)payload.DeepClone();
                copy.Remove("secret");

                SeasonFileData data = new SeasonFileData
                {
                    SavedAt = NowMs(),
                    Payload = copy.ToString(Formatting.None),
                };

                Interface.Oxide.DataFileSystem.WriteObject(SeasonFile, data);
            }
            catch (Exception cause)
            {
                PrintWarning("Não consegui gravar a cópia da temporada: " + cause.Message);
            }
        }

        private void LoadSeason()
        {
            try
            {
                if (!Interface.Oxide.DataFileSystem.ExistsDatafile(SeasonFile)) return;

                SeasonFileData data = Interface.Oxide.DataFileSystem.ReadObject<SeasonFileData>(SeasonFile);
                if (data == null || string.IsNullOrEmpty(data.Payload)) return;

                ApplySeason(JObject.Parse(data.Payload), false);
                Puts("Temporada carregada do disco (" + _season.Levels.Count + " níveis). O agente manda a " +
                     "carga atual assim que conectar.");
            }
            catch (Exception cause)
            {
                PrintWarning("A cópia da temporada em disco não abriu (" + cause.Message + "): o menu fica " +
                             "vazio até o agente mandar a carga.");
            }
        }

        // ============================================================
        //  §5  O PROGRESSO  -  origemz.passe.progress
        // ============================================================

        [ConsoleCommand(ProgressCommand)]
        private void CmdProgress(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            try
            {
                string steamId = arg.GetString(0);
                if (!IsSteamId(steamId))
                {
                    arg.ReplyWith(Fail("INVALID_ARGS",
                        "Use: " + ProgressCommand + " <steamId> <lote> <i> <n> <base64>"));
                    return;
                }

                string encoded;

                if (arg.HasArgs(5))
                {
                    ChunkBatch state;
                    if (!_progressBatches.TryGetValue(steamId, out state))
                    {
                        state = new ChunkBatch();
                        _progressBatches[steamId] = state;
                    }

                    string pendingReply = CollectChunk(state, arg.GetString(1), arg.GetInt(2, -1),
                                                       arg.GetInt(3, -1), arg.GetString(4), out encoded);
                    if (pendingReply != null)
                    {
                        if (state.Id.Length == 0) _progressBatches.Remove(steamId);
                        arg.ReplyWith(pendingReply);
                        return;
                    }

                    _progressBatches.Remove(steamId);
                }
                else if (arg.HasArgs(2))
                {
                    encoded = arg.GetString(1);
                }
                else
                {
                    arg.ReplyWith(Fail("INVALID_ARGS",
                        "Use: " + ProgressCommand + " <steamId> <lote> <i> <n> <base64>"));
                    return;
                }

                JObject payload = DecodePayload(encoded);
                if (payload == null)
                {
                    arg.ReplyWith(Fail("INVALID_PAYLOAD", "O payload não é Base64 de um objeto JSON."));
                    return;
                }

                // O mesmo segredo do último `sync`: sem ele, qualquer um com
                // acesso ao console se daria a trilha inteira. Progresso que
                // chega ANTES da temporada é recusado — o agente reenvia no
                // próximo gatilho.
                string secret = Text(payload, "secret");
                if (_secret.Length == 0 || secret != _secret)
                {
                    arg.ReplyWith(Fail(_secret.Length == 0 ? "NO_SEASON" : "BAD_SECRET",
                        "O progresso precisa do segredo do último " + SyncCommand + "."));
                    return;
                }

                Progress record = ReadProgress(payload);

                // Progresso de outra temporada é dado velho com cara de novo.
                if (_season.Has && record.Period.Length > 0 && record.Period != _season.Period)
                {
                    arg.ReplyWith(Fail("STALE_PERIOD",
                        "O progresso é de " + record.Period + " e a temporada aqui é " + _season.Period + "."));
                    return;
                }

                _progress[steamId] = record;

                BasePlayer player = FindOnline(steamId);
                MenuSession session;
                if (player != null && _menus.TryGetValue(player.userID, out session))
                {
                    // ####  A CARGA É A VERDADE, E DESFAZ O OTIMISMO  ####
                    //
                    // O clique desenha na hora (`Mark`) e esse desenho tem
                    // prioridade sobre tudo — até aqui. Limpar a marca é o
                    // que faz o agente mandar: se ele recusou o resgate, a
                    // faixa volta a ficar disponível sem ninguém precisar
                    // avisar a tela. Sem esta linha o otimismo vira verdade
                    // permanente, e uma recusa fica invisível.
                    session.OptimisticFree.Clear();
                    session.OptimisticPaid.Clear();
                    session.Busy = false;
                    Redraw(player, session, Region.AllButWindow);
                }

                JObject reply = new JObject
                {
                    ["ok"] = true,
                    ["steamId"] = steamId,
                    ["level"] = record.Level,
                };

                arg.ReplyWith(reply.ToString(Formatting.None));
            }
            catch (Exception cause)
            {
                arg.ReplyWith(Fail("EXCEPTION", cause.Message));
            }
        }

        private Progress ReadProgress(JObject payload)
        {
            Progress record = new Progress
            {
                Period = Text(payload, "period").Trim(),
                Level = Math.Max(0, Int(payload, "level")),
                Xp = Math.Max(0L, Long(payload, "xp")),
                XpInto = Math.Max(0L, Long(payload, "xpInto")),
                XpNeeded = Math.Max(0L, Long(payload, "xpNeeded")),
                HasPass = Flag(payload, "hasPass", false),
                BoxSeen = Flag(payload, "boxSeen", true),
            };

            JArray claims = payload["claims"] as JArray;
            if (claims != null)
            {
                foreach (JToken token in claims)
                {
                    JObject row = token as JObject;
                    if (row == null) continue;

                    int level = Int(row, "level");
                    if (level <= 0) continue;

                    int state = ParseState(Text(row, "state"));
                    if (state < 0) continue;

                    if (Text(row, "lane") == LanePaid)
                    {
                        record.Paid[level] = state;
                    }
                    else
                    {
                        record.Free[level] = state;
                    }
                }
            }

            JArray pending = payload["pending"] as JArray;
            if (pending != null)
            {
                foreach (JToken token in pending)
                {
                    JObject row = token as JObject;
                    if (row == null) continue;

                    string label = Text(row, "label").Trim();
                    if (label.Length == 0) continue;

                    record.Pending.Add(new PendingRow
                    {
                        Label = label,
                        Origin = Text(row, "origin").Trim(),
                    });
                }
            }

            return record;
        }

        private static int ParseState(string raw)
        {
            switch ((raw ?? "").Trim().ToLowerInvariant())
            {
                case "locked": return StateLocked;
                case "available": return StateAvailable;
                case "claimed": return StateClaimed;
                case "pending": return StatePending;
                default: return -1;
            }
        }

        // ============================================================
        //  §6  A RESPOSTA DO AGENTE  -  origemz.passe.reply
        // ============================================================

        /// <summary>Um pedido esperando resposta. O relógio existe para o jogador nunca ficar no escuro.</summary>
        private class PendingRequest
        {
            public string SteamId = "";
            public string Kind = "";
            public Timer Timeout;
        }

        private readonly Dictionary<string, PendingRequest> _requests = new Dictionary<string, PendingRequest>();

        [ConsoleCommand(ReplyCommand)]
        private void CmdReply(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            try
            {
                JObject payload = DecodePayload(arg.GetString(0));
                if (payload == null)
                {
                    arg.ReplyWith(Fail("INVALID_PAYLOAD", "O payload não é Base64 de um objeto JSON."));
                    return;
                }

                string requestId = Text(payload, "requestId");
                PendingRequest request;
                if (requestId.Length == 0 || !_requests.TryGetValue(requestId, out request))
                {
                    // Resposta de um pedido que já venceu, ou de um plugin
                    // recarregado. Não é erro: o agente fez a parte dele.
                    arg.ReplyWith("{\"ok\":true,\"unknown\":true}");
                    return;
                }

                _requests.Remove(requestId);
                if (request.Timeout != null) request.Timeout.Destroy();

                bool ok = Flag(payload, "ok", false);
                string message = Text(payload, "message").Trim();

                BasePlayer player = FindOnline(request.SteamId);
                MenuSession session;
                if (player != null && _menus.TryGetValue(player.userID, out session))
                {
                    session.Busy = false;
                    Flash(player, session, message.Length > 0 ? message : (ok ? "Pronto." : "Não deu certo."), ok);
                }

                arg.ReplyWith("{\"ok\":true}");
            }
            catch (Exception cause)
            {
                arg.ReplyWith(Fail("EXCEPTION", cause.Message));
            }
        }

        // ============================================================
        //  §7  O DIAGNÓSTICO  -  origemz.passe.status
        // ============================================================

        [ConsoleCommand(StatusCommand)]
        private void CmdStatus(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                BasePlayer player = arg.Player();
                if (player == null || !IsAdmin(player)) return;
            }

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["period"] = _season.Period,
                ["name"] = _season.Name,
                ["levels"] = _season.Levels.Count,
                ["players"] = _progress.Count,
                ["menus"] = _menus.Count,
                ["secret"] = _secret.Length > 0,
                ["endsAt"] = _season.EndsAt,
            };

            arg.ReplyWith(reply.ToString(Formatting.None));
        }

        /// <summary>
        /// `origemz.passe.scroll 0|1`: liga e desliga a trilha rolável na
        /// hora, sem recarregar o plugin. A saída se um cliente cair.
        /// </summary>
        [ConsoleCommand(ScrollCommand)]
        private void CmdScroll(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                BasePlayer player = arg.Player();
                if (player == null || !IsAdmin(player)) return;
            }

            if (arg.HasArgs(1))
            {
                string value = arg.GetString(0).ToLowerInvariant();
                _config.TrackScroll = value == "1" || value == "true";
                SaveConfig();
                RedrawAllMenus(Region.Track);
            }

            arg.ReplyWith("{\"ok\":true,\"trackScroll\":" + (_config.TrackScroll ? "true" : "false") +
                          ",\"openAtCurrentLevel\":" + (_config.OpenAtCurrentLevel ? "true" : "false") + "}");
        }

        // ####  OS ÍCONES DO MENU MORAM AQUI, EM PNG  ####
        //
        // Nenhum sprite do jogo foi confirmado no servidor (os bundles são
        // do cliente), e um caminho errado vira um quadrado branco. Estes
        // são nossos: 64x64, brancos sobre transparente, tingidos pelo CUI.
        // Vão para o FileStorage no boot, e o CUI os pede pelo CRC — que é
        // o hash do CONTEÚDO, então regravar os mesmos bytes devolve o
        // mesmo número.
        //
        // O cadeado é PNG, e não os três painéis do menu de skins, por
        // causa do orçamento: a trilha desenha até 80 faixas de uma vez, e
        // três painéis por cadeado custariam dois terços de um AddUI só
        // em fechadura.
        private static readonly Dictionary<string, string> IconPng = new Dictionary<string, string>
        {
            { "lock", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABM0lEQVR42u3aXQ2DMBSGYSQgAQlIqAQk1BFSkFAJSEACEr7dNBkh/I2V7RTek/SGjG/sKf1LVkgqntwKAAAAAAAAAAAAAAAAAAAAAK5vTlIrKUga9a4xXmvjZ24H4CUNOl5DvCd7gFpSr/PVx4wsAZrZa362xpiVFUCj9NXkAlDv9HyI47ua3FPFa2HnTahzAOg3xrM7uFJsZZgG8BsPXn6QU24geMsAQ4Ifv4cwWAVwKz3mjGVeBtCuTHjf5i5NjK1FgHDRePUXwSYHWFr6qgS51cqSaA5gqcxnp3oYSwUAAAAAAAAAxgG62X7exWuPAPAnjtO3AegO5Hd3BnBfHIFvAWDpOwBgCDAJsgz+dSOUuuez2wr/KhcAAADgOAwAAAAAAAAA/FUWAAAAAAAAAACYtBcQToP5Oj6LTwAAAABJRU5ErkJggg==" },
            { "box", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAd0lEQVR42u3Z0QkAIAgFwLf/0rZAH0EkVCe8BQ5E1FRVfk4AAAAAAAAAAAAAAAAAYJJXCgAAAAAAAAAAAAAAAABsgwAA7AFc2+8AAAAAAOAgQPcIAwAAAAAAAAAAAAAAAAAAAAA4iAAAAAAAAM9RAAAAAAAAYDkDqPj3453jOwwAAAAASUVORK5CYII=" },
            { "dot", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABOUlEQVR42u3b3Q2DIBiFYUfoKIzgKI7gJozAKIzgCIzgCKcx4a6/AirgexKv2tjwVFDhY5A03PkYAAAAAAAAOP4wkmZJTpKXFPSaED9z8bumdYCtAfZDY/9NiOcwLQFM8Z8sHR/PXS3AeFDD30GMNQE84mV6dmz87UsBtr656LosueNDbuNXXZ81ByFnoKst01kARvXGHA1Qy2VfrDvsHe0X1Z9lz91hD4BVO7GlAUa1l7EkgG8QwJcCmNRuphIAvmEAnwtg1H5MDoDtAMDmAIQOAEIqQA+X/89u8A1g7ghgTgFwHQG4FADfEYBPAQgdAYQUgN4CAAAAMAhyG+RBiEdhXoZ4HWZChCkxJkWZFmdhhKUxFkdZHqdAghIZiqQok6NQklJZiqUpl2fDBFtm2DQFAAAAAHDP4wndyxd5LS7knwAAAABJRU5ErkJggg==" },
            { "bang", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAnElEQVR42u3ZsQ3AIAwEQEZjBI/EpozipKBMQYqkMIf0oqA7CduIlpnt5DQAAAAAAAAAAAAA/2R3AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3+MAAACoABD3PlbiJICemfOh8s91Vhqgb7TAXhlgbgDMqgDxYhCKigDjBcAA4AoogtqgQcgo7DEEAAAAAAAAAPguFxIIXNzdzXNBAAAAAElFTkSuQmCC" },
            // O mesmo ✓ do OrigemZWorkshop (`check`): é PNG nosso, já
            // desenhado, e o jogador o lê como "já é seu".
            { "check", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAADz0lEQVR42u2bz2sTURDHZ7IRi/iDVCh4EQX/AaEtFC8qPXnVowdRSq/17qH/Qa+iKHr3KIp4EgRBD4J6UcGTCpa2WEHQJtmPB+fJuCTN22TTZtMdWBJ2k81+v+/NfGfmvYhUVllllVVWWWV71XTcAAEqIok7lapquidGE0i6nK+N/QwAElVtA1MickFEjovIdxF5oqrvAVVVxnrkgavAN/6338BKmAnmImMFvm6vVxzopjtSO3ezlzuUEXzNXqeATaANtDIzIAW27P25bKyolTzaC9AQkYcictguJR3inIpIKiLXsveplRh83eTttojMiEhrGzxq106EW5R9BiSq2rTgdlFEmiJS7/GdVEQ2Sq9+LugtuIDXy0IMuOzvUWbw8wao7aJ8NwsEvQD2l1YKndZPA2sGvt0DfFCEl8AkoGUFX7NjEvjkRj8WfKO0OUAYNTteZMB1s0DOqqXGXeuEMoAPfn8rMuilRsBPYLa04O3B99nrciaabwc+fObKuER8L3exEX/JE1jmiD9noNMc4G8VOvJAAtTtSIYtI67AOQmsR8pdAP+0sLJ3O80clpw4uTsKvIqM+OH6G/teLc/zdQP4r3sCzInIecu1X4vIY8vDE1VtF1zgqKqmNpLzVuDUe+T3Yp2fs6r6duDncmXmJPCoA+PvgJmiI2yfcheOuULkzqZ9DThiGVSYYr7DArBRJAlO7pZyFDjhMwuFDYYbhWXXT+vmc4WQ0KGltRUR8YPWLxcqdzYDJoCPPaJvuwgSnNzNWuaWp7q7F8AXokzO948CP5yfEUHCmbwkZPp5q30UOAcKre4cAQeBr5HJR9uNSrQvOrlrZGJNzG99Glp156bkncjcO9uU6ElCpsB5EBn0gjuuAdNDK3BCBgWcsqkdMzLBVVoxJDiSb+as7gDmh17gON+cMVcojAQ38ou7Knc5SDjmfLTZJwn7uvTzmjnkbmXHS1s3VRsFkDDRRz8v/NaDQuVuABKe90nCokut++rn7Won17lDPUeeng1e14FnA/TzdreZ6UcgJwnZZCqNJG1j5Pp5Jo9JnyS0Iqa97+ddGsl+3oAkMBb9vCGRMJx+3g6TsDUg+Kel2sbShYRWRKDrJHev+unnjQoJQSZXcqzY+gJnHThZ9rW7JLOI0YuE4vt5I7SMFbOS0zSSFkq9fBXR3Pyd0f8U+GXv75d6+SrHai4dip+XFvTq47hx0QfGG8BnB3wTuAtM+jacjONu8bC6BBwSkdPyd//eB1X9kl19kr20e3snFlhH6v8CBjboO3tm735llVVWWWWVjb79AVFUcsSCjjxVAAAAAElFTkSuQmCC" },
        };

        /// <summary>Nome do ícone → CRC no FileStorage. Vazio até o boot.</summary>
        private readonly Dictionary<string, string> _icons = new Dictionary<string, string>();

        private void StoreIcons()
        {
            if (CommunityEntity.ServerInstance == null || CommunityEntity.ServerInstance.net == null) return;

            foreach (KeyValuePair<string, string> pair in IconPng)
            {
                try
                {
                    byte[] bytes = Convert.FromBase64String(pair.Value);
                    uint crc = FileStorage.server.Store(bytes, FileStorage.Type.png,
                                                        CommunityEntity.ServerInstance.net.ID);
                    _icons[pair.Key] = crc.ToString(CultureInfo.InvariantCulture);
                }
                catch (Exception cause)
                {
                    PrintWarning("O ícone " + pair.Key + " não foi guardado: " + cause.Message);
                }
            }
        }

        // ============================================================
        //  §8  A SESSÃO E OS COMANDOS DA TELA
        //
        //  ####  O ESTADO MORA AQUI, E OS COMANDOS SÓ O MUDAM  ####
        //
        //  Cada jogador com o menu aberto tem uma `MenuSession`. Um
        //  comando da tela confere o token, muda o estado e pede o
        //  redesenho SÓ das regiões afetadas. Nenhum argumento é
        //  confiável: tudo o que chega é validado contra a temporada e o
        //  progresso vivos.
        //
        //  ####  AS REGIÕES  ####
        //
        //      OZPass          véu (camada Overall, cursor)
        //      OZPass.Win      a janela: moldura, divisórias, rodapé
        //      OZPass.Head     temporada, contagem, nível, XP, passe, caixa
        //      OZPass.Track    a trilha que rola
        //      OZPass.Foot     RESGATAR TUDO e a mensagem
        //      OZPass.Box      a caixa de pendências, quando aberta
        //
        //  O cabeçalho INTEIRO é uma região — inclusive o "X" e o título.
        //  No menu de skins a raiz do cabeçalho precisou ser recortada
        //  para não cobrir o botão de fechar; aqui o recorte não existe
        //  porque a região é o cabeçalho todo, e o "X" é filho dela.
        //  Custa alguns elementos a mais por redesenho e tira uma classe
        //  inteira de bug de sobreposição.
        //
        //  Cada raiz de região leva `destroyUi` com o próprio nome: o
        //  cliente troca a velha pela nova no mesmo RPC, sem piscar.
        // ============================================================

        private const string UiRoot = "OZPass";
        private const string UiWindow = "OZPass.Win";
        private const string UiHead = "OZPass.Head";
        private const string UiTrack = "OZPass.Track";
        private const string UiFoot = "OZPass.Foot";
        private const string UiBox = "OZPass.Box";

        [Flags]
        private enum Region
        {
            None = 0,
            Window = 1,
            Head = 2,
            Track = 4,
            Foot = 8,
            Box = 16,
            AllButWindow = Head | Track | Foot | Box,
            All = Window | AllButWindow,
        }

        private class MenuSession
        {
            public string Token = "";

            /// <summary>A página da trilha quando a rolagem está desligada.</summary>
            public int Page;

            /// <summary>A caixa de pendências está aberta na tela.</summary>
            public bool BoxOpen;

            /// <summary>A caixa existe no cliente. Evita um `destroyUi` por abertura de menu.</summary>
            public bool BoxDrawn;

            /// <summary>Há um pedido no ar: os botões ficam mudos até a resposta.</summary>
            public bool Busy;

            public float NextCommand;
            public string Message = "";
            public bool MessageOk;
            public Timer FlashTimer;

            /// <summary>
            /// O otimismo do clique: (nível, faixa) que o jogador pediu e que
            /// o agente ainda não confirmou. A carga de progresso desfaz.
            /// </summary>
            public readonly Dictionary<int, int> OptimisticFree = new Dictionary<int, int>();
            public readonly Dictionary<int, int> OptimisticPaid = new Dictionary<int, int>();
        }

        private readonly Dictionary<ulong, MenuSession> _menus = new Dictionary<ulong, MenuSession>();

        /// <summary>
        /// Quando cada jogador pode abrir o menu de novo.
        ///
        /// O porteiro dos outros comandos (`SessionOf`) não alcança a
        /// ABERTURA, que é o único comando sem token — e abrir custa ~100 KB
        /// de desenho, três vezes o que custa no menu de skins. Um laço de
        /// `open`/`close` no F1 seria banda de graça.
        /// </summary>
        private readonly Dictionary<ulong, float> _nextOpen = new Dictionary<ulong, float>();

        /// <summary>Uma abertura a cada meio segundo, por jogador.</summary>
        private const float OpenCooldownSeconds = 0.5f;

        /// <summary>Quantos níveis a trilha mostra por página quando a rolagem está desligada.</summary>
        private const int PageSize = TrackColumns * 2;

        /// <summary>Hook público para o OrigemZUI: fecha o passe quando o menu principal abre.</summary>
        [HookMethod("ClosePassMenu")]
        public void ClosePassMenu(BasePlayer player)
        {
            CloseMenu(player);
        }

        /// <summary>Hook público: o menu do passe está aberto para este jogador?</summary>
        [HookMethod("IsPassMenuOpen")]
        public bool IsPassMenuOpen(BasePlayer player)
        {
            return player != null && _menus.ContainsKey(player.userID);
        }

        [PluginReference("OrigemZUI")]
        private Plugin _mainMenu;

        /// <summary>
        /// Fecha o menu principal antes de abrir este.
        ///
        /// O OrigemZUI não tem hook de fechar; ele tem o
        /// `origemz.ui.close &lt;steamId&gt;` de servidor, que destrói a raiz
        /// pelo nome e descarta a sessão. Se um dia ele ganhar o hook
        /// `CloseMainMenu(BasePlayer)`, ele passa a valer primeiro.
        /// </summary>
        private void CloseMainMenu(BasePlayer player)
        {
            if (_mainMenu == null || !_mainMenu.IsLoaded) return;

            try
            {
                if (_mainMenu.Call("CloseMainMenu", player) != null) return;

                ConsoleSystem.Run(ConsoleSystem.Option.Server.Quiet(), MainMenuCloseCommand, player.UserIDString);
            }
            catch (Exception cause)
            {
                PrintWarning("Não consegui fechar o menu principal de " + player.UserIDString + ": " + cause.Message);
            }
        }

        [ChatCommand("passe")]
        private void ChatPasse(BasePlayer player, string command, string[] args)
        {
            ToggleMenu(player);
        }

        [ChatCommand("bp")]
        private void ChatBp(BasePlayer player, string command, string[] args)
        {
            ToggleMenu(player);
        }

        /// <summary>O mesmo comando fecha, como o `/menu` do OrigemZUI.</summary>
        private void ToggleMenu(BasePlayer player)
        {
            if (player == null) return;

            if (_menus.ContainsKey(player.userID))
            {
                CloseMenu(player);
                return;
            }

            OpenMenu(player);
        }

        private void OpenMenu(BasePlayer player)
        {
            if (player == null || !player.IsConnected) return;

            if (player.IsDead() || player.IsWounded())
            {
                Tell(player, "Você não pode abrir o passe agora.");
                return;
            }

            if (_menus.ContainsKey(player.userID)) return;

            float now = Time.realtimeSinceStartup;
            float next;
            if (_nextOpen.TryGetValue(player.userID, out next) && now < next) return;
            _nextOpen[player.userID] = now + OpenCooldownSeconds;

            MenuSession session = new MenuSession
            {
                Token = Guid.NewGuid().ToString("N").Substring(0, 16),
            };

            _menus[player.userID] = session;

            CloseMainMenu(player);
            Redraw(player, session, Region.All);

            // ####  O XP AQUI PODE TER MEIO MINUTO  ####
            //
            // O agente recebe as estatísticas em lotes de 60 s (02 §1).
            // Abrir a tela é o momento em que a idade do dado aparece, então
            // é o momento de pedir carga nova. Sem resposta casada: é aviso,
            // não pergunta.
            Push("open", new JObject { ["steamId"] = player.UserIDString });
        }

        /// <summary>Fecha e descarta a sessão.</summary>
        private void CloseMenu(BasePlayer player)
        {
            if (player == null) return;

            MenuSession session;
            if (_menus.TryGetValue(player.userID, out session))
            {
                _menus.Remove(player.userID);
                if (session.FlashTimer != null) session.FlashTimer.Destroy();
            }

            // Pelo NOME, e sempre: é o que livra quem ficou com um resto na
            // tela mesmo sem sessão.
            if (player.IsConnected)
            {
                CuiHelper.DestroyUi(player, UiRoot);
            }
        }

        private void RedrawAllMenus(Region regions)
        {
            foreach (KeyValuePair<ulong, MenuSession> pair in new List<KeyValuePair<ulong, MenuSession>>(_menus))
            {
                BasePlayer player = BasePlayer.FindByID(pair.Key);
                if (player == null || !player.IsConnected)
                {
                    _menus.Remove(pair.Key);
                    continue;
                }

                Redraw(player, pair.Value, regions);
            }
        }

        /// <summary>
        /// Quem mandou, e se o token confere. Recusa em SILÊNCIO: o que
        /// chega aqui pode ser um comando digitado no F1 por alguém
        /// tentando resgatar a trilha inteira.
        /// </summary>
        private MenuSession SessionOf(ConsoleSystem.Arg arg, out BasePlayer player)
        {
            player = null;
            if (arg == null || arg.Connection == null) return null;

            player = arg.Player();
            if (player == null) return null;

            MenuSession session;
            if (!_menus.TryGetValue(player.userID, out session)) return null;
            if (arg.GetString(0) != session.Token) return null;

            // ####  UM COMANDO A CADA 80 ms  ####
            //
            // Cada comando redesenha dezenas de KB. Um laço no F1 viraria
            // trabalho de servidor e banda à toa; um clique humano nunca
            // chega a isso.
            float now = Time.realtimeSinceStartup;
            if (now < session.NextCommand) return null;
            session.NextCommand = now + CommandCooldownSeconds;

            return session;
        }

        /// <summary>
        /// Abre o menu. Do CLIENTE (o card da home, o botão do inventário)
        /// vem sem argumento; do SERVIDOR vem com o steamId, que é como o
        /// agente abre a tela para alguém.
        /// </summary>
        [ConsoleCommand(MenuOpenCommand)]
        private void CmdMenuOpen(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                OpenMenu(arg.Player());
                return;
            }

            string steamId = arg.GetString(0);
            if (!IsSteamId(steamId))
            {
                arg.ReplyWith(Fail("INVALID_ARGS", "Use: " + MenuOpenCommand + " <steamId>"));
                return;
            }

            BasePlayer target = FindOnline(steamId);
            if (target == null)
            {
                arg.ReplyWith(Fail("NOT_ONLINE", "O jogador não está online."));
                return;
            }

            OpenMenu(target);
            arg.ReplyWith("{\"ok\":true}");
        }

        /// <summary>
        /// Fechar não exige token: fechar a própria tela é sempre seguro, e
        /// é a saída de quem ficou com o menu preso.
        /// </summary>
        [ConsoleCommand(MenuCloseCommand)]
        private void CmdMenuClose(ConsoleSystem.Arg arg)
        {
            if (arg.Connection == null) return;

            BasePlayer player = arg.Player();
            if (player != null) CloseMenu(player);
        }

        /// <summary>A paginação só aparece com a rolagem desligada; o comando existe do mesmo jeito.</summary>
        [ConsoleCommand(MenuPageCommand)]
        private void CmdMenuPage(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            session.Page = Math.Max(0, arg.GetInt(1, 0));
            Redraw(player, session, Region.Track);
        }

        [ConsoleCommand(MenuClaimCommand)]
        private void CmdMenuClaim(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            if (session.Busy) return;

            int number = arg.GetInt(1, 0);
            string lane = arg.GetString(2) == LanePaid ? LanePaid : LaneFree;

            Level level = LevelOf(number);
            if (level == null) return;

            Frame frame = Prepare(player);

            // ####  O PLUGIN DECIDE ANTES DE GRITAR  ####
            //
            // A faixa que não está disponível não vira pedido: o agente
            // recusaria de qualquer jeito, e um pedido por clique perdido
            // vira console cheio de linha que ninguém lê.
            if (StateOf(frame, session, level, lane) != StateAvailable) return;

            Mark(session, number, lane, StatePending);
            session.Busy = true;

            Request(player, session, "claim", new JObject
            {
                ["steamId"] = player.UserIDString,
                ["level"] = number,
                ["lane"] = lane,
            });

            Redraw(player, session, Region.Track | Region.Foot);
        }

        [ConsoleCommand(MenuClaimAllCommand)]
        private void CmdMenuClaimAll(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            if (session.Busy) return;

            Frame frame = Prepare(player);
            List<Level> ready = Claimable(frame, session);
            if (ready.Count == 0) return;

            // ####  O LOTE É DO AGENTE, NÃO DAQUI  ####
            //
            // Um pedido só, e não N: quem sabe quanto cabe na mochila é o
            // agente (02 §6.2), e o lote é parcial por natureza — cabendo 6
            // de 17, entregam-se as 6 e as 11 continuam devendo. Mandar 17
            // pedidos faria 17 respostas disputando a mesma faixa do rodapé.
            foreach (Level level in ready)
            {
                if (StateOf(frame, session, level, LaneFree) == StateAvailable)
                {
                    Mark(session, level.Number, LaneFree, StatePending);
                }

                if (StateOf(frame, session, level, LanePaid) == StateAvailable)
                {
                    Mark(session, level.Number, LanePaid, StatePending);
                }
            }

            session.Busy = true;
            Request(player, session, "claimAll", new JObject { ["steamId"] = player.UserIDString });

            Redraw(player, session, Region.Track | Region.Foot);
        }

        /// <summary>
        /// Abre e fecha a caixa de pendências.
        ///
        /// ####  O PONTO SOME AO ABRIR, NÃO AO RECEBER  ####
        ///
        /// *Ter pendência* e *saber que tem* são coisas diferentes (01
        /// §7.1). O ponto é a marca de "ainda não olhou", então ele morre
        /// aqui, no clique — e o agente é avisado para gravar, porque o
        /// jogador que reabre o jogo não pode ver o ponto de novo.
        /// </summary>
        [ConsoleCommand(MenuBoxCommand)]
        private void CmdMenuBox(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            session.BoxOpen = !session.BoxOpen;

            if (session.BoxOpen)
            {
                Progress progress;
                if (_progress.TryGetValue(player.UserIDString, out progress) && !progress.BoxSeen)
                {
                    progress.BoxSeen = true;
                    Request(player, session, "box", new JObject { ["steamId"] = player.UserIDString });
                }
            }

            Redraw(player, session, Region.Head | Region.Box);
        }

        /// <summary>
        /// "Resgatar tudo" dentro da caixa.
        ///
        /// ####  ELE EXISTE PORQUE A CAIXA NÃO ENTREGAVA  ####
        ///
        /// Até 18/09/2026 a caixa mostrava a promessa e não havia como
        /// pegá-la: o jogador liberava espaço e a recompensa continuava
        /// lá. Quem pergunta de novo se cabe e entrega é o AGENTE — daqui
        /// sai só o pedido, como em todo o resto desta tela.
        /// </summary>
        [ConsoleCommand(MenuRetryCommand)]
        private void CmdMenuRetry(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            if (session.Busy) return;

            // ####  O PLUGIN DECIDE ANTES DE GRITAR  ####
            //
            // Caixa vazia não vira pedido: o agente responderia "a sua
            // caixa está vazia", e um pedido por clique perdido vira
            // console cheio de linha que ninguém lê.
            Frame frame = Prepare(player);
            if (WaitingCount(frame) == 0) return;

            session.Busy = true;
            Request(player, session, "retry", new JObject { ["steamId"] = player.UserIDString });

            Redraw(player, session, Region.Box | Region.Foot);
        }

        [ConsoleCommand(MenuBuyCommand)]
        private void CmdMenuBuy(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            if (session.Busy) return;

            Frame frame = Prepare(player);
            if (!CanBuy(frame)) return;

            session.Busy = true;
            Request(player, session, "buy", new JObject { ["steamId"] = player.UserIDString });

            Redraw(player, session, Region.Head | Region.Foot);
        }

        /// <summary>
        /// Manda um pedido ao agente e arma o relógio da desistência.
        ///
        /// Sem o relógio, um agente que caiu deixaria o jogador olhando um
        /// botão mudo para sempre — e ele clicaria de novo, e de novo.
        /// </summary>
        private void Request(BasePlayer player, MenuSession session, string kind, JObject data)
        {
            if (_secret.Length == 0)
            {
                session.Busy = false;
                Flash(player, session, "O servidor ainda está sincronizando o passe. Tente em instantes.", false);
                return;
            }

            string requestId = Guid.NewGuid().ToString("N").Substring(0, 16);
            data["requestId"] = requestId;

            ulong userId = player.userID;
            PendingRequest request = new PendingRequest
            {
                SteamId = player.UserIDString,
                Kind = kind,
            };

            request.Timeout = timer.Once(RequestTimeoutSeconds, delegate
            {
                if (!_requests.Remove(requestId)) return;

                BasePlayer again = BasePlayer.FindByID(userId);
                MenuSession live;
                if (again == null || !again.IsConnected || !_menus.TryGetValue(userId, out live)) return;

                live.Busy = false;
                Flash(again, live, "O servidor não respondeu. Tente de novo.", false);
            });

            _requests[requestId] = request;

            Push(kind, data);
        }

        /// <summary>
        /// A faixa de mensagem do rodapé, que some sozinha.
        ///
        /// Redesenha o rodapé E a trilha: a resposta de um resgate muda o
        /// estado das faixas, e mostrar a frase "pronto" sobre um card que
        /// continua dizendo "resgatar" seria pior que não mostrar nada.
        /// </summary>
        private void Flash(BasePlayer player, MenuSession session, string message, bool ok)
        {
            session.Message = message;
            session.MessageOk = ok;

            if (session.FlashTimer != null) session.FlashTimer.Destroy();

            ulong userId = player.userID;
            session.FlashTimer = timer.Once(FlashSeconds, delegate
            {
                MenuSession live;
                if (!_menus.TryGetValue(userId, out live) || live != session) return;

                live.Message = "";
                BasePlayer again = BasePlayer.FindByID(userId);
                if (again != null && again.IsConnected) Redraw(again, live, Region.Foot);
            });

            Redraw(player, session, Region.Track | Region.Foot);
        }

        /// <summary>O otimismo do clique, que a próxima carga de progresso desfaz.</summary>
        private static void Mark(MenuSession session, int level, string lane, int state)
        {
            if (lane == LanePaid)
            {
                session.OptimisticPaid[level] = state;
            }
            else
            {
                session.OptimisticFree[level] = state;
            }
        }

        // ============================================================
        //  §9  DO ESTADO PARA O QUE SE DESENHA
        //
        //  As "views" são dados puros: o desenho (§10) não toca em
        //  jogador, temporada nem progresso. É isso que deixa o
        //  `origemz.passe.bytes` medir o pior caso com dados fictícios,
        //  sem servidor no ar.
        // ============================================================

        /// <summary>Desenhado quando ninguém ainda disse o que é deste jogador. Nunca é cadeado.</summary>
        private const int StateSyncing = 4;

        /// <summary>O que um redesenho precisa saber, calculado uma vez.</summary>
        private class Frame
        {
            public Season Season;

            /// <summary>`null` = ninguém disse ainda. Diferente de "não tem nada".</summary>
            public Progress Progress;

            public string SteamId = "";

            public bool Known
            {
                get { return Progress != null; }
            }
        }

        private Frame Prepare(BasePlayer player)
        {
            Frame frame = new Frame { Season = _season, SteamId = player.UserIDString };

            Progress progress;
            if (_progress.TryGetValue(frame.SteamId, out progress))
            {
                frame.Progress = progress;
            }

            return frame;
        }

        private Level LevelOf(int number)
        {
            foreach (Level level in _season.Levels)
            {
                if (level.Number == number) return level;
            }

            return null;
        }

        private static Reward RewardOf(Level level, string lane)
        {
            return lane == LanePaid ? level.Paid : level.Free;
        }

        /// <summary>A faixa existe nesta temporada e neste nível?</summary>
        private static bool LaneVisible(Season season, Level level, string lane)
        {
            if (lane == LanePaid && !season.PaidLane) return false;
            if (lane == LaneFree && !season.FreeLane) return false;

            return RewardOf(level, lane).Has;
        }

        /// <summary>
        /// O estado de uma faixa, na ordem em que as fontes mandam.
        ///
        /// ####  O QUE O AGENTE NÃO MANDOU, A REGRA DIZ  ####
        ///
        /// A carga de progresso só traz EXCEÇÃO (o que já foi resgatado, o
        /// que está devendo). O resto é derivado aqui pela tabela do 01
        /// §4.1 — e derivar é obrigatório, não economia: a trilha inteira
        /// em toda carga seria uma segunda fonte para a mesma verdade, e
        /// duas fontes divergem no primeiro caso de borda.
        /// </summary>
        private static int StateOf(Frame frame, MenuSession session, Level level, string lane)
        {
            // 1. O clique que acabou de acontecer. Ele vale até a carga do
            //    agente chegar e mandar o contrário.
            Dictionary<int, int> optimistic = lane == LanePaid ? session.OptimisticPaid : session.OptimisticFree;
            int state;
            if (optimistic != null && optimistic.TryGetValue(level.Number, out state)) return state;

            if (!frame.Known) return StateSyncing;

            // 2. A exceção que o agente mandou.
            Dictionary<int, int> claims = lane == LanePaid ? frame.Progress.Paid : frame.Progress.Free;
            if (claims.TryGetValue(level.Number, out state)) return state;

            // 3. A regra.
            if (lane == LanePaid && !frame.Progress.HasPass) return StateLocked;
            if (level.Number > frame.Progress.Level) return StateLocked;

            return StateAvailable;
        }

        /// <summary>Os níveis com ao menos uma faixa pronta para levar.</summary>
        private List<Level> Claimable(Frame frame, MenuSession session)
        {
            List<Level> result = new List<Level>();
            if (!frame.Known) return result;

            foreach (Level level in _season.Levels)
            {
                bool free = LaneVisible(_season, level, LaneFree) &&
                            StateOf(frame, session, level, LaneFree) == StateAvailable;
                bool paid = LaneVisible(_season, level, LanePaid) &&
                            StateOf(frame, session, level, LanePaid) == StateAvailable;

                if (free || paid) result.Add(level);
            }

            return result;
        }

        /// <summary>Quantas FAIXAS estão prontas — é o número do botão, e ele conta recompensas.</summary>
        private int ClaimableCount(Frame frame, MenuSession session)
        {
            int count = 0;
            if (!frame.Known) return 0;

            foreach (Level level in _season.Levels)
            {
                if (LaneVisible(_season, level, LaneFree) &&
                    StateOf(frame, session, level, LaneFree) == StateAvailable) count++;

                if (LaneVisible(_season, level, LanePaid) &&
                    StateOf(frame, session, level, LanePaid) == StateAvailable) count++;
            }

            return count;
        }

        /// <summary>
        /// Quantas recompensas ESPERAM na caixa.
        ///
        /// Diferente do `ClaimableCount`, que olha só a trilha: o que já
        /// foi resgatado e não coube não está mais disponível em faixa
        /// nenhuma, e era por isso que o rodapé dizia "NADA PARA
        /// RESGATAR" com o prêmio do jogador guardado.
        /// </summary>
        private static int WaitingCount(Frame frame)
        {
            return frame.Known ? frame.Progress.Pending.Count : 0;
        }

        private static bool CanBuy(Frame frame)
        {
            if (!frame.Season.Has || !frame.Season.PaidLane) return false;
            if (!frame.Season.Purchasable) return false;
            if (!frame.Known) return false;

            return !frame.Progress.HasPass;
        }

        // ---- as views ----------------------------------------------

        private class HeadView
        {
            public string Token = "";
            public string SeasonName = "";
            public string ServerName = "";
            public string Remaining = "";
            public string LevelText = "";
            public string XpText = "";
            public float XpFill;
            public string PassLabel = "";
            public string PassColor = "";
            public string BuyText = "";
            public bool CanBuy;
            public bool Busy;

            /// <summary>Quantos itens esperam na caixa. 0 = o ícone nem aparece.</summary>
            public int PendingCount;

            /// <summary>O ponto de notificação: há pendência E ele ainda não olhou.</summary>
            public bool PendingDot;

            public string PendingTip = "";
            public bool BoxOpen;
            public bool Syncing;

            /// <summary>Nome do ícone → CRC; pode faltar (aí vai texto).</summary>
            public Dictionary<string, string> Icons = new Dictionary<string, string>();
        }

        private class LaneView
        {
            public bool Has;
            public string Label = "";
            public int ItemId;
            /// <summary>0 = sem skin: o ícone vai SEM `SkinId` (armadilha 3).</summary>
            public ulong SkinId;
            public string Icon = "";

            /// <summary>`coins`, `kit`, `points`, `vip`… Decide o rótulo de quem não tem ícone.</summary>
            public string Kind = "";

            public int State;
            public bool Paid;
            public bool Milestone;
            /// <summary>O motivo, no mouse. Só onde ele muda a decisão de alguém.</summary>
            public string Tip = "";
        }

        private class CardView
        {
            public int Level;
            public string LevelText = "";
            /// <summary>Só o nível atual tem moldura acesa (03 §3.1, regra 3).</summary>
            public bool Current;
            public bool Milestone;
            public readonly LaneView Free = new LaneView();
            public readonly LaneView Paid = new LaneView();
        }

        private class TrackView
        {
            public string Token = "";
            public bool Scroll;
            public int Page;
            public int Pages = 1;
            /// <summary>A linha (0-based) em que a trilha abre. Ver `OpenAtCurrentLevel`.</summary>
            public int OpenRow;
            public string Empty = "";
            public readonly List<CardView> Cards = new List<CardView>();
            public Dictionary<string, string> Icons = new Dictionary<string, string>();
        }

        private class FootView
        {
            public string Token = "";

            /// <summary>De qual servidor é a trilha. Sem isto, a 1ª queixa é "meu nível sumiu" (01 §1.4).</summary>
            public string ServerName = "";

            /// <summary>Quantas FAIXAS da trilha estão prontas para resgatar.</summary>
            public int Count;

            /// <summary>
            /// Quantas recompensas esperam na CAIXA.
            ///
            /// O botão conta as duas coisas: com pendência esperando ele
            /// não pode dizer "nada para resgatar" (defeito de 18/09/2026).
            /// </summary>
            public int Waiting;

            public bool Busy;
            public string Message = "";
            public bool MessageOk;
            public string Note = "";
        }

        private class BoxRow
        {
            public string Label = "";
            /// <summary>`full` (não coube) ou `season` (sobrou do mês passado).</summary>
            public string Origin = "";
        }

        private class BoxView
        {
            public string Token = "";
            public readonly List<BoxRow> Rows = new List<BoxRow>();

            /// <summary>Quantas linhas ficaram de fora do desenho. Elas continuam devendo.</summary>
            public int More;

            /// <summary>Um pedido do jogador está em andamento: o botão vira "aguarde".</summary>
            public bool Busy;

            public string Empty = "";
        }

        private HeadView ComputeHead(Frame frame, MenuSession session)
        {
            Season season = frame.Season;

            HeadView view = new HeadView
            {
                Token = session.Token,
                SeasonName = season.Has ? season.Name : "SEM TEMPORADA",
                ServerName = season.ServerName,
                Icons = _icons,
                BoxOpen = session.BoxOpen,
                Busy = session.Busy,
                Syncing = !frame.Known,
            };

            view.Remaining = RemainingText(season.EndsAt);

            if (!frame.Known)
            {
                view.LevelText = "NÍVEL —";
                view.XpText = "sincronizando…";
                view.PassLabel = "SINCRONIZANDO";
                view.PassColor = ColMuted;
                return view;
            }

            Progress progress = frame.Progress;

            view.LevelText = "NÍVEL " + progress.Level;

            if (progress.XpNeeded <= 0)
            {
                // Passar do último nível não é erro (01 §2): a tela diz que
                // acabou, em vez de fingir um nível que não existe.
                view.XpText = "trilha concluída · " + Thousands(progress.Xp) + " XP";
                view.XpFill = 1f;
            }
            else
            {
                view.XpText = Thousands(progress.XpInto) + " / " + Thousands(progress.XpNeeded) + " XP";
                view.XpFill = Mathf.Clamp01((float)progress.XpInto / progress.XpNeeded);
            }

            if (!season.PaidLane)
            {
                view.PassLabel = "";
            }
            else if (progress.HasPass)
            {
                view.PassLabel = "PASSE ATIVO";
                view.PassColor = ColOlive;
            }
            else
            {
                view.PassLabel = "PASSE GRÁTIS";
                view.PassColor = ColMuted;
            }

            view.CanBuy = CanBuy(frame) && !session.Busy;
            if (CanBuy(frame))
            {
                view.BuyText = season.PriceLabel.Length > 0
                    ? "ATIVAR O PASSE POR " + season.PriceLabel
                    : "ATIVAR O PASSE";
            }

            view.PendingCount = progress.Pending.Count;
            view.PendingDot = progress.Pending.Count > 0 && !progress.BoxSeen;
            view.PendingTip = PendingTip(progress);

            return view;
        }

        /// <summary>
        /// A dica do ícone da caixa, em UMA linha.
        ///
        /// Uma linha porque a quebra dentro do `CuiTooltipComponent` nunca
        /// foi medida neste projeto, e um tooltip que vira um bloco ilegível
        /// seria pior que um resumo. A lista inteira mora no painel da
        /// caixa, que é o que o clique abre.
        /// </summary>
        private static string PendingTip(Progress progress)
        {
            if (progress.Pending.Count == 0) return "";

            StringBuilder text = new StringBuilder();
            text.Append(progress.Pending.Count == 1 ? "1 recompensa esperando: " : progress.Pending.Count +
                        " recompensas esperando: ");

            int shown = Math.Min(3, progress.Pending.Count);
            for (int i = 0; i < shown; i++)
            {
                if (i > 0) text.Append(" · ");
                text.Append(Shorten(progress.Pending[i].Label, 28));
            }

            if (progress.Pending.Count > shown)
            {
                text.Append(" · e mais " + (progress.Pending.Count - shown));
            }

            text.Append(". Clique para ver.");

            return text.ToString();
        }

        private TrackView ComputeTrack(Frame frame, MenuSession session)
        {
            Season season = frame.Season;

            TrackView view = new TrackView
            {
                Token = session.Token,
                Scroll = _config.TrackScroll,
                Icons = _icons,
            };

            if (!season.Has)
            {
                view.Empty = "Nenhuma temporada de passe está aberta neste servidor.";
                return view;
            }

            List<Level> levels = season.Levels;

            int from = 0;
            int to = levels.Count;

            if (!view.Scroll)
            {
                view.Pages = Math.Max(1, (levels.Count + PageSize - 1) / PageSize);
                view.Page = Math.Min(Math.Max(0, session.Page), view.Pages - 1);
                from = view.Page * PageSize;
                to = Math.Min(levels.Count, from + PageSize);
            }

            int current = frame.Known ? frame.Progress.Level : 0;

            for (int i = from; i < to; i++)
            {
                Level level = levels[i];

                CardView card = new CardView
                {
                    Level = level.Number,
                    LevelText = "NÍVEL " + level.Number,
                    Current = level.Number == current,
                    Milestone = level.Free.Milestone || level.Paid.Milestone,
                };

                FillLane(frame, session, level, LaneFree, card.Free);
                FillLane(frame, session, level, LanePaid, card.Paid);

                view.Cards.Add(card);
            }

            // A linha em que a trilha abre. `current` é 1-based e pode ser 0
            // (ninguém subiu ainda), e a linha anterior entra junto para o
            // jogador ver de onde veio.
            if (view.Scroll && _config.OpenAtCurrentLevel && current > 1)
            {
                int index = Math.Max(0, current - 1);
                view.OpenRow = Math.Max(0, index / TrackColumns - 1);
            }

            return view;
        }

        private void FillLane(Frame frame, MenuSession session, Level level, string lane, LaneView view)
        {
            Season season = frame.Season;

            view.Paid = lane == LanePaid;

            if (!LaneVisible(season, level, lane))
            {
                return;
            }

            Reward reward = RewardOf(level, lane);

            view.Has = true;
            view.Label = reward.Label;
            view.ItemId = reward.ItemId;
            view.SkinId = reward.SkinId;
            view.Icon = reward.Icon;
            view.Kind = reward.Kind;
            view.Milestone = reward.Milestone;
            view.State = StateOf(frame, session, level, lane);

            if (view.State != StateLocked) return;

            // ####  BLOQUEADO PRECISA DIZER POR QUÊ  ####
            //
            // Um cadeado mudo faz o jogador achar que o passe engoliu o
            // prêmio dele. E o motivo "você não comprou" é, literalmente, o
            // argumento de venda (01 §4.1).
            if (reward.Dlc)
            {
                view.Tip = "Esta skin é de uma DLC da Facepunch: só quem tem a DLC pode usá-la.";
            }
            else if (lane == LanePaid && frame.Known && !frame.Progress.HasPass)
            {
                view.Tip = "Ative o passe para levar esta recompensa — ela fica guardada até lá.";
            }
            else if (frame.Known)
            {
                view.Tip = "Chegue ao nível " + level.Number + " para levar.";

                if (level.Xp > 0 && level.Xp > frame.Progress.Xp)
                {
                    view.Tip += " Faltam " + Thousands(level.Xp - frame.Progress.Xp) + " XP.";
                }
            }
        }

        private FootView ComputeFoot(Frame frame, MenuSession session)
        {
            return new FootView
            {
                Token = session.Token,
                Count = ClaimableCount(frame, session),
                Waiting = WaitingCount(frame),
                Busy = session.Busy,
                ServerName = frame.Season.ServerName,
                Message = session.Message,
                MessageOk = session.MessageOk,
                Note = frame.Season.Note,
            };
        }

        private BoxView ComputeBox(Frame frame, MenuSession session)
        {
            BoxView view = new BoxView { Token = session.Token, Busy = session.Busy };

            if (!frame.Known)
            {
                view.Empty = "Sincronizando…";
                return view;
            }

            if (frame.Progress.Pending.Count == 0)
            {
                view.Empty = "Nada esperando. Tudo o que você resgatou já foi entregue.";
                return view;
            }

            // ####  A CAIXA NÃO TEM PRAZO, MAS TEM TETO DE DESENHO  ####
            //
            // A pendência não vence (02 §6.4), então esta lista pode crescer
            // por meses. O `Pack` corta ENTRE regiões e não dentro de uma, e
            // a caixa é uma região só: 300 linhas passariam de um AddUI
            // inteiro, sem nada avisando. O teto corta o DESENHO, nunca a
            // promessa — o que não aparece continua devendo, e a última
            // linha diz quanto é.
            int shown = Math.Min(BoxMaxRows, frame.Progress.Pending.Count);

            for (int i = 0; i < shown; i++)
            {
                PendingRow row = frame.Progress.Pending[i];
                view.Rows.Add(new BoxRow { Label = row.Label, Origin = row.Origin });
            }

            view.More = frame.Progress.Pending.Count - shown;

            return view;
        }

        // ---- a única porta de desenho ------------------------------

        /// <summary>
        /// Desenha as regiões pedidas.
        ///
        /// A abertura vai em DOIS grupos: janela, cabeçalho e rodapé num;
        /// a trilha e a caixa no outro. Um grupo que passe de 40 KB é
        /// quebrado pelo `Pack`, elemento por elemento, sem nunca mandar
        /// filho antes do pai.
        /// </summary>
        private void Redraw(BasePlayer player, MenuSession session, Region regions)
        {
            if (player == null || !player.IsConnected) return;

            // ####  QUEM DESENHA DEPOIS FICA POR CIMA  ####
            //
            // Recriar a trilha a põe na frente da caixa que já estava na
            // tela. Então a caixa aberta é redesenhada junto — senão ela
            // continuaria existindo, atrás da trilha, e o jogador acharia
            // que o clique dela parou de funcionar.
            if ((regions & Region.Track) != 0 && session.BoxOpen)
            {
                regions |= Region.Box;
            }

            Frame frame = Prepare(player);

            List<string> first = new List<string>();
            List<string> second = new List<string>();

            if ((regions & Region.Window) != 0) first.Add(BuildWindow(session.Token));
            if ((regions & Region.Head) != 0) first.Add(BuildHead(ComputeHead(frame, session)));
            if ((regions & Region.Foot) != 0) first.Add(BuildFoot(ComputeFoot(frame, session)));
            if ((regions & Region.Track) != 0) second.AddRange(BuildTrack(ComputeTrack(frame, session)));

            if ((regions & Region.Box) != 0)
            {
                if (session.BoxOpen)
                {
                    second.AddRange(BuildBox(ComputeBox(frame, session)));
                    session.BoxDrawn = true;
                }
                else if (session.BoxDrawn)
                {
                    // Fechada não é vazia: um painel de tamanho zero
                    // continuaria na tela, e a raiz de uma região bloqueia
                    // clique onde está. Só destrói o que existe — senão toda
                    // abertura de menu gastaria um RPC com uma caixa que
                    // ninguém abriu.
                    CuiHelper.DestroyUi(player, UiBox);
                    session.BoxDrawn = false;
                }
            }

            foreach (string json in Pack(first, AddUiByteLimit)) CuiHelper.AddUi(player, json);
            foreach (string json in Pack(second, AddUiByteLimit)) CuiHelper.AddUi(player, json);
        }

        /// <summary>
        /// Junta arrays JSON de elementos, em ordem, enquanto couberem no
        /// limite. A ordem importa: o pai precisa chegar antes dos filhos.
        /// </summary>
        private static List<string> Pack(List<string> arrays, int limit)
        {
            List<string> result = new List<string>();
            StringBuilder current = new StringBuilder();
            int currentBytes = 0;

            foreach (string array in arrays)
            {
                string body = array.Substring(1, array.Length - 2);
                if (body.Length == 0) continue;

                int bytes = Encoding.UTF8.GetByteCount(body);

                if (current.Length > 0 && currentBytes + bytes + 3 > limit)
                {
                    result.Add("[" + current + "]");
                    current.Length = 0;
                    currentBytes = 0;
                }

                if (current.Length > 0)
                {
                    current.Append(',');
                    currentBytes++;
                }

                current.Append(body);
                currentBytes += bytes;
            }

            if (current.Length > 0) result.Add("[" + current + "]");

            return result;
        }

        // ============================================================
        //  §10  O DESENHO
        //
        //  Medidas em pixels da base 1280×720 (core/src/game/ui-geometry.ts),
        //  traduzidas para âncoras RELATIVAS ao pai: a janela escala com a
        //  resolução. Origem no canto de CIMA à esquerda de cada caixa; a
        //  conversão para o Y do Unity (que cresce para cima) mora só em
        //  `Rect`.
        //
        //  Nomes: só recebe nome o elemento que tem filho (ou tooltip). O
        //  resto vai sem nome — o cliente dá um padrão — e isso é o que
        //  cabe uma trilha de 30 níveis em três envios.
        // ============================================================

        // Os tokens de core/src/game/ui-widgets.ts:26-48, que são os de
        // panel/src/app/globals.css. SE MUDAREM LÁ, MUDAM AQUI. Copiados do
        // OrigemZWorkshop para a cara do passe ser a mesma do resto do menu.
        private static readonly string ColBg = Hex("#0F0F0F");
        private static readonly string ColSurface = Hex("#1B1B1B");
        private static readonly string ColSurface2 = Hex("#262626");
        private static readonly string ColBorder = Hex("#2E2E2E");
        private static readonly string ColText = Hex("#E8E8E8");
        private static readonly string ColMuted = Hex("#9A9A9A");
        private static readonly string ColRust = Hex("#C43F2C");
        private static readonly string ColOlive = Hex("#6B7F5B");
        private static readonly string ColAmber = Hex("#E6B265");

        private const string ColTransparent = "0 0 0 0";

        /// <summary>O véu de ui-preset-main-menu.ts:132 (#000000D1).</summary>
        private const string ColVeil = "0 0 0 0.82";

        private const string ColIconDim = "1 1 1 0.3";

        /// <summary>O fundo de uma faixa bloqueada: quase preto, e o ícone apagado por cima.</summary>
        private static readonly string ColLockedFill = Hex("#141414");

        /// <summary>O fundo de uma faixa já levada: verde bem escuro, para o ✓ não brigar com o texto.</summary>
        private static readonly string ColClaimedFill = Hex("#18200F");

        /// <summary>
        /// O fundo da faixa PAGA.
        ///
        /// ####  ELA PRECISA SE LER COMO PAGA ANTES DA LETRA MIUDA  ####
        ///
        /// O dono viu a tela no jogo (18/09/2026) e disse que nao dava
        /// para saber qual faixa era a paga: ela tinha um "PASSE" de 9
        /// pontos num canto, e mais nada. E ela e justamente a que
        /// vende o passe -- se o jogador nao percebe que aquilo e o
        /// pago, o cadeado nao significa nada.
        ///
        /// O tom quente resolve isso sem custar elemento nenhum: e a
        /// mesma cor de fundo trocada. A barra de acento que vem junto
        /// custa um elemento por card, e e a linguagem que o projeto
        /// ja usa -- a barrinha antes de todo titulo do painel.
        /// </summary>
        private static readonly string ColPaidFill = Hex("#241B10");

        /// <summary>O mesmo fundo, para quem ja levou: o verde do resgate vence o ambar.</summary>
        private static readonly string ColPaidLockedFill = Hex("#1C1509");

        /// <summary>O fundo do card do nível atual, dentro da moldura acesa.</summary>
        private static readonly string ColCurrentFill = Hex("#241A18");

        private const string BlurMaterial = "assets/content/ui/uibackgroundblur.mat";
        private const string FontBold = "RobotoCondensed-Bold.ttf";
        private const string FontRegular = "RobotoCondensed-Regular.ttf";

        /// <summary>A mesma cor com outro alpha ("r g b a" do CUI).</summary>
        private static string Faded(string color, float alpha)
        {
            // `Split(char[])` e não `Split(' ')`: a sobrecarga de um char só
            // existe no netstandard mas não no .NET Framework, e é o que
            // separa "compila" de "roda" quando este arquivo é medido fora
            // do servidor (`MeasureWorstCase`).
            string[] parts = color.Split(new[] { ' ' });
            if (parts.Length < 3) return color;
            return parts[0] + " " + parts[1] + " " + parts[2] + " " + F(alpha);
        }

        // ---- a janela ----------------------------------------------

        private const float WinWidth = 1240f;
        private const float WinHeight = 640f;

        /// <summary>A faixa do título, do 03 §3.</summary>
        private const float TitleHeight = 52f;

        /// <summary>A faixa do nível e da barra de XP, logo abaixo do título.</summary>
        private const float ProgressHeight = 56f;

        private const float HeadHeight = TitleHeight + ProgressHeight;
        private const float FooterHeight = 56f;
        private const float BodyHeight = WinHeight - HeadHeight - FooterHeight;

        // ---- a trilha ----------------------------------------------

        // ####  CINCO POR LINHA, E MAIS TRILHA NA TELA  ####
        //
        // Pedido do dono depois de ver a tela no jogo (18/09/2026). A
        // largura util nao muda -- 1162 px --, entao a quinta coluna
        // sai da largura do card: 5 * 221 + 4 * 14 = 1161.
        //
        // A faixa tambem encolheu (76 -> 64), e e dai que vem "mais
        // niveis": a area rolavel tem 476 px, e com o card em 152 em
        // vez de 176 cabem ~2,8 linhas em vez de ~2,5. Com as cinco
        // colunas, sao ~14 niveis na tela contra os 10 de antes.
        //
        // O piso dos 64 px e o icone de marco, que tem 56: abaixo
        // disso ele encosta na borda da faixa.
        private const int TrackColumns = 5;
        private const float TrackPad = 12f;
        private const float CardWidth = 221f;
        private const float CardGap = 14f;
        private const float LevelStrip = 24f;

        /// <summary>O marco ganha TAMANHO, e não só cor (03 §3.1, regra 5): a tarja cresce e o ícone também.</summary>
        private const float MilestoneExtra = 8f;

        private const float LaneHeight = 64f;
        private const float CardHeight = LevelStrip + 2 * LaneHeight;
        private static readonly float CardsWidth = TrackColumns * CardWidth + (TrackColumns - 1) * CardGap;

        /// <summary>A faixa da direita que a barra de rolagem ocupa, fora dos cards.</summary>
        private const float ScrollGutter = 16f;

        /// <summary>A folga no topo e no pé do conteúdo rolável, do tamanho da moldura do card.</summary>
        private const float ScrollInset = 2f;

        // ---- a caixa de pendências ---------------------------------

        private const float BoxWidth = 420f;
        private const float BoxRowHeight = 34f;
        private const float BoxHeadHeight = 34f;
        private const float BoxMaxHeight = 320f;

        /// <summary>Quantas pendências a caixa DESENHA. Ver `ComputeBox`: o teto é do desenho, não da promessa.</summary>
        private const int BoxMaxRows = 60;

        /// <summary>Uma caixa-pai: nome e tamanho em pixels.</summary>
        private class Box
        {
            public string Name;
            public float W;
            public float H;

            public Box(string name, float w, float h)
            {
                Name = name;
                W = w;
                H = h;
            }
        }

        /// <summary>O contêiner de uma região, com nomes curtos para os filhos que precisam de nome.</summary>
        private class Canvas
        {
            public readonly CuiElementContainer Ui = new CuiElementContainer();
            private readonly string _prefix;
            private int _next;

            public Canvas(string prefix)
            {
                _prefix = prefix;
            }

            public string NextName()
            {
                _next++;
                return _prefix + _next.ToString(CultureInfo.InvariantCulture);
            }

            public string Json()
            {
                return CuiHelper.ToJson(Ui);
            }

            /// <summary>
            /// Um array JSON por elemento, na ordem. É o que deixa o `Pack`
            /// dividir UMA região em vários AddUI (a trilha de 30 níveis passa
            /// de 40 KB) sem nunca mandar um filho antes do pai.
            /// </summary>
            public List<string> Parts()
            {
                List<string> parts = new List<string>(Ui.Count);
                foreach (CuiElement element in Ui)
                {
                    CuiElementContainer single = new CuiElementContainer();
                    single.Add(element);
                    parts.Add(CuiHelper.ToJson(single));
                }

                return parts;
            }
        }

        private static CuiRectTransformComponent Rect(Box parent, float x, float y, float w, float h)
        {
            return new CuiRectTransformComponent
            {
                AnchorMin = F(x / parent.W) + " " + F(1f - (y + h) / parent.H),
                AnchorMax = F((x + w) / parent.W) + " " + F(1f - y / parent.H),
            };
        }

        private static string Panel(Canvas canvas, Box parent, float x, float y, float w, float h, string color,
                                    string name = null)
        {
            CuiElement element = new CuiElement { Name = name, Parent = parent.Name };
            element.Components.Add(new CuiImageComponent { Color = color });
            element.Components.Add(Rect(parent, x, y, w, h));
            canvas.Ui.Add(element);
            return name;
        }

        private static void Label(Canvas canvas, Box parent, float x, float y, float w, float h, string text,
                                  int size, string color, TextAnchor align, bool bold)
        {
            if (string.IsNullOrEmpty(text)) return;

            CuiElement element = new CuiElement { Parent = parent.Name };
            element.Components.Add(new CuiTextComponent
            {
                Text = text,
                FontSize = size,
                Color = color,
                Align = align,
                Font = bold ? FontBold : FontRegular,
            });
            element.Components.Add(Rect(parent, x, y, w, h));
            canvas.Ui.Add(element);
        }

        /// <summary>Um botão sem texto; o texto e o resto entram como filhos.</summary>
        private static string Button(Canvas canvas, Box parent, float x, float y, float w, float h, string color,
                                     string command, string name)
        {
            CuiElement element = new CuiElement { Name = name, Parent = parent.Name };
            element.Components.Add(new CuiButtonComponent { Color = color, Command = command });
            element.Components.Add(Rect(parent, x, y, w, h));
            canvas.Ui.Add(element);
            return name;
        }

        /// <summary>Botão com um rótulo centrado.</summary>
        private static string TextButton(Canvas canvas, Box parent, float x, float y, float w, float h,
                                         string color, string command, string text, int size, string textColor)
        {
            string name = Button(canvas, parent, x, y, w, h, color, command, canvas.NextName());
            Label(canvas, new Box(name, w, h), 0, 0, w, h, text, size, textColor, TextAnchor.MiddleCenter, true);
            return name;
        }

        /// <summary>
        /// O botão que NÃO é um botão (`deadButton`, ui-widgets.ts:237): um
        /// painel com o rótulo, para o lugar dizer por que não dá.
        /// </summary>
        private static void DeadButton(Canvas canvas, Box parent, float x, float y, float w, float h,
                                       string text, int size)
        {
            string name = Panel(canvas, parent, x, y, w, h, ColSurface2, canvas.NextName());
            Label(canvas, new Box(name, w, h), 0, 0, w, h, text, size, ColMuted, TextAnchor.MiddleCenter, true);
        }

        /// <summary>
        /// A dica que o CLIENTE mostra ao passar o mouse
        /// (`CuiTooltipComponent`, Oxide 2.0.7716). Pendurada no elemento de
        /// nome `name`, que já precisa estar no canvas.
        ///
        /// É o que só existe com a tela no plugin, e é metade do motivo de
        /// este arquivo existir (03 §1).
        /// </summary>
        private static void Tip(Canvas canvas, string name, string text)
        {
            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(text)) return;

            for (int i = canvas.Ui.Count - 1; i >= 0; i--)
            {
                if (canvas.Ui[i].Name != name) continue;

                canvas.Ui[i].Components.Add(new CuiTooltipComponent { Text = text });
                return;
            }
        }

        /// <summary>
        /// O ícone de um item, desenhado pelo CLIENTE a partir do par
        /// (item, skin). Skin 0 = o `SkinId` fica no padrão e NÃO sai no
        /// JSON (armadilha 3 do cabeçalho).
        /// </summary>
        private static void Icon(Canvas canvas, Box parent, float x, float y, float w, float h, int itemId,
                                 ulong skin, string color)
        {
            CuiImageComponent image = new CuiImageComponent { ItemId = itemId, Color = color };
            if (skin != 0uL)
            {
                image.SkinId = skin;
            }

            CuiElement element = new CuiElement { Parent = parent.Name };
            element.Components.Add(image);
            element.Components.Add(Rect(parent, x, y, w, h));
            canvas.Ui.Add(element);
        }

        /// <summary>Um PNG do FileStorage, pelo CRC. Sem o CRC, nada é desenhado.</summary>
        private static string Png(Canvas canvas, Box parent, float x, float y, float w, float h, string crc,
                                  string color, string name = null)
        {
            if (string.IsNullOrEmpty(crc)) return null;

            CuiElement element = new CuiElement { Name = name, Parent = parent.Name };
            element.Components.Add(new CuiRawImageComponent { Png = crc, Color = color });
            element.Components.Add(Rect(parent, x, y, w, h));
            canvas.Ui.Add(element);
            return name;
        }

        /// <summary>O CRC de um ícone nosso, ou "" quando o FileStorage ainda não respondeu.</summary>
        private static string IconCrc(Dictionary<string, string> icons, string key)
        {
            string crc;
            return icons != null && icons.TryGetValue(key, out crc) ? crc : "";
        }

        /// <summary>A raiz de uma região: nome fixo e `destroyUi` com o próprio nome.</summary>
        private static Box RegionRoot(Canvas canvas, string name, float x, float y, float w, float h, string color)
        {
            Box window = new Box(UiWindow, WinWidth, WinHeight);
            CuiElement element = new CuiElement { Name = name, Parent = UiWindow, DestroyUi = name };
            element.Components.Add(new CuiImageComponent { Color = color });
            element.Components.Add(Rect(window, x, y, w, h));
            canvas.Ui.Add(element);
            return new Box(name, w, h);
        }

        /// <summary>
        /// Uma área que ROLA na vertical, dentro de `parent`, e devolve a
        /// caixa do CONTEÚDO (altura inteira), onde os filhos se posicionam.
        ///
        /// ####  A RECEITA MEDIDA NO JOGO EM 17/09/2026  ####
        ///
        /// Copiada do `ScrollArea` do OrigemZWorkshop (:4506).
        /// `CuiScrollViewComponent` com o conteúdo ancorado no topo e
        /// crescendo para baixo, em fração da área visível (âncora mínima
        /// negativa), para tudo continuar relativo. A barra ocupa a borda
        /// direita: quem desenha dentro deixa `ScrollGutter` livre, e
        /// `ScrollInset` de respiro em cima e embaixo, senão a moldura da
        /// primeira linha é recortada.
        ///
        /// `startOffset` é o que este arquivo acrescenta: quantos pixels a
        /// área já nasce rolada, deslocando as DUAS âncoras do conteúdo.
        /// Ver `OpenAtCurrentLevel` — é o único pedaço desta receita que
        /// ainda não foi visto num cliente.
        /// </summary>
        private static Box ScrollArea(Canvas canvas, Box parent, float x, float y, float w, float h,
                                      float contentHeight, bool autoHide, float startOffset)
        {
            float height = Math.Max(h, contentHeight);
            float offset = Math.Max(0f, Math.Min(startOffset, height - h));
            string name = canvas.NextName();

            CuiElement scroll = new CuiElement { Name = name, Parent = parent.Name };
            scroll.Components.Add(new CuiScrollViewComponent
            {
                Vertical = true,
                Horizontal = false,
                MovementType = UnityEngine.UI.ScrollRect.MovementType.Clamped,
                Elasticity = 0.25f,
                Inertia = true,
                DecelerationRate = 0.3f,
                ScrollSensitivity = 24f,
                ContentTransform = new CuiRectTransform
                {
                    AnchorMin = "0 " + F(1f - height / h + offset / h),
                    AnchorMax = "1 " + F(1f + offset / h),
                    OffsetMin = "0 0",
                    OffsetMax = "0 0",
                },
                VerticalScrollbar = new CuiScrollbar
                {
                    Size = 6f,
                    AutoHide = autoHide,
                    HandleColor = ColRust,
                    HighlightColor = ColText,
                    PressedColor = ColText,
                    TrackColor = ColSurface,
                },
            });
            scroll.Components.Add(Rect(parent, x, y, w, h));
            canvas.Ui.Add(scroll);

            return new Box(name, w, height);
        }

        /// <summary>Um "‹ 1 / 2 ›". `command` recebe a página no fim.</summary>
        private static void Pager(Canvas canvas, Box parent, float x, float y, float w, float h, int page,
                                  int pages, string command, float buttonWidth)
        {
            if (page > 0)
            {
                TextButton(canvas, parent, x, y, buttonWidth, h, ColSurface2, command + " " + (page - 1),
                           "‹ ANTERIOR", 11, ColText);
            }
            else
            {
                DeadButton(canvas, parent, x, y, buttonWidth, h, "‹ ANTERIOR", 11);
            }

            Label(canvas, parent, x + buttonWidth, y, w - 2 * buttonWidth, h, (page + 1) + " / " + pages, 11,
                  ColMuted, TextAnchor.MiddleCenter, false);

            if (page < pages - 1)
            {
                TextButton(canvas, parent, x + w - buttonWidth, y, buttonWidth, h, ColSurface2,
                           command + " " + (page + 1), "PRÓXIMA ›", 11, ColText);
            }
            else
            {
                DeadButton(canvas, parent, x + w - buttonWidth, y, buttonWidth, h, "PRÓXIMA ›", 11);
            }
        }

        // ---- a janela ----------------------------------------------

        private static string BuildWindow(string token)
        {
            Canvas canvas = new Canvas("OZP.W");

            // O véu: tela inteira, com cursor, na camada do menu principal.
            // Ele é ESCURO, e não transparente — um painel transparente de
            // tela cheia engole o clique no Unity sem nada explicando.
            CuiElement veil = new CuiElement { Name = UiRoot, Parent = "Overall", DestroyUi = UiRoot };
            veil.Components.Add(new CuiImageComponent { Color = ColVeil, Material = BlurMaterial });
            veil.Components.Add(new CuiRectTransformComponent { AnchorMin = "0 0", AnchorMax = "1 1" });
            veil.Components.Add(new CuiNeedsCursorComponent());
            canvas.Ui.Add(veil);

            // A janela centrada, em âncoras, na base 1280×720.
            Box screen = new Box(UiRoot, 1280f, 720f);
            CuiElement window = new CuiElement { Name = UiWindow, Parent = UiRoot };
            window.Components.Add(new CuiImageComponent { Color = ColBg });
            window.Components.Add(Rect(screen, (1280f - WinWidth) / 2f, (720f - WinHeight) / 2f, WinWidth, WinHeight));
            canvas.Ui.Add(window);

            Box win = new Box(UiWindow, WinWidth, WinHeight);

            // As divisórias. O cabeçalho e o rodapé são regiões próprias:
            // aqui só fica o que nunca muda.
            Panel(canvas, win, 0, HeadHeight - 1, WinWidth, 1, ColBorder);
            Panel(canvas, win, 0, WinHeight - FooterHeight, WinWidth, 1, ColBorder);

            return canvas.Json();
        }

        // ---- o cabeçalho -------------------------------------------

        private static string BuildHead(HeadView view)
        {
            Canvas canvas = new Canvas("OZP.H");
            Box head = RegionRoot(canvas, UiHead, 0, 0, WinWidth, HeadHeight, ColSurface);

            // O acento de 2 px do `titleBar`, ao lado do texto.
            Panel(canvas, head, 16, 15, 2, 22, ColRust);
            Label(canvas, head, 26, 0, 660, TitleHeight, "PASSE DE BATALHA · " + view.SeasonName.ToUpperInvariant(),
                  20, ColText, TextAnchor.MiddleLeft, true);

            if (view.PassLabel.Length > 0)
            {
                Label(canvas, head, 690, 0, 200, TitleHeight, view.PassLabel, 12,
                      view.PassColor.Length > 0 ? view.PassColor : ColMuted, TextAnchor.MiddleRight, true);
            }

            Label(canvas, head, 900, 0, 230, TitleHeight, view.Remaining, 12, ColMuted, TextAnchor.MiddleRight, false);

            // ####  A CAIXA DE PENDÊNCIAS (03 §6)  ####
            //
            // Três estados: sem nada, o ícone não aparece; com pendência e
            // não visto, ele acende COM o ponto; visto, ele acende sem o
            // ponto. O ponto é a marca de "ainda não olhou" — não de "ainda
            // não recebeu".
            if (view.PendingCount > 0)
            {
                string boxName = Button(canvas, head, 1148, 10, 32, 32, view.BoxOpen ? ColRust : ColSurface2,
                                        MenuBoxCommand + " " + view.Token, canvas.NextName());
                Box boxBtn = new Box(boxName, 32, 32);

                string crc = IconCrc(view.Icons, "box");
                if (crc.Length > 0)
                {
                    Png(canvas, boxBtn, 6, 6, 20, 20, crc, view.BoxOpen ? ColText : ColAmber);
                }
                else
                {
                    Label(canvas, boxBtn, 0, 0, 32, 32, "C", 13, ColAmber, TextAnchor.MiddleCenter, true);
                }

                if (view.PendingDot)
                {
                    string dot = IconCrc(view.Icons, "dot");
                    if (dot.Length > 0)
                    {
                        Png(canvas, boxBtn, 21, 1, 10, 10, dot, ColRust);
                    }
                    else
                    {
                        Panel(canvas, boxBtn, 21, 1, 10, 10, ColRust);
                    }
                }

                Tip(canvas, boxName, view.PendingTip);
            }

            // O fechar: "X", como o do menu principal.
            TextButton(canvas, head, WinWidth - 48, 10, 32, 32, ColSurface2, MenuCloseCommand + " " + view.Token,
                       "X", 14, ColText);

            // ---- a faixa do nível e do XP ----

            Panel(canvas, head, 0, TitleHeight, WinWidth, 1, ColBorder);
            Panel(canvas, head, 0, TitleHeight + 1, WinWidth, ProgressHeight - 1, ColBg);

            Label(canvas, head, 26, TitleHeight, 150, ProgressHeight, view.LevelText, 18, ColText,
                  TextAnchor.MiddleLeft, true);

            // A barra: trilho escuro e o preenchido em vermelho. Vermelho é
            // ACENTO — a leitura da barra é o comprimento, e o número ao
            // lado diz o mesmo em letras (03 §3.1, regra 4).
            float barY = TitleHeight + (ProgressHeight - 10) / 2f;
            Panel(canvas, head, 186, barY, 520, 10, ColSurface2);
            if (view.XpFill > 0f)
            {
                Panel(canvas, head, 186, barY, 520 * Mathf.Clamp01(view.XpFill), 10, ColRust);
            }

            Label(canvas, head, 716, TitleHeight, 200, ProgressHeight, view.XpText, 12, ColMuted,
                  TextAnchor.MiddleLeft, false);

            if (view.BuyText.Length > 0)
            {
                if (view.CanBuy)
                {
                    TextButton(canvas, head, 926, TitleHeight + 12, 298, 32, ColRust,
                               MenuBuyCommand + " " + view.Token, view.BuyText, 12, ColText);
                }
                else
                {
                    DeadButton(canvas, head, 926, TitleHeight + 12, 298, 32, view.BuyText, 12);
                }
            }

            return canvas.Json();
        }

        // ---- a trilha ----------------------------------------------

        private static List<string> BuildTrack(TrackView view)
        {
            Canvas canvas = new Canvas("OZP.T");
            Box track = RegionRoot(canvas, UiTrack, 0, HeadHeight, WinWidth, BodyHeight, ColTransparent);

            if (view.Cards.Count == 0)
            {
                Label(canvas, track, TrackPad, 0, WinWidth - 2 * TrackPad, BodyHeight,
                      view.Empty.Length > 0 ? view.Empty : "Nada para mostrar.", 14, ColMuted,
                      TextAnchor.MiddleCenter, false);
                return canvas.Parts();
            }

            bool paged = !view.Scroll && view.Pages > 1;
            float pagerHeight = paged ? 36f : 0f;
            float viewportHeight = BodyHeight - 2 * TrackPad - pagerHeight;
            float viewportWidth = WinWidth - 2 * TrackPad;
            int rows = (view.Cards.Count + TrackColumns - 1) / TrackColumns;
            float needed = rows * CardHeight + Math.Max(0, rows - 1) * CardGap + 2 * ScrollInset;

            Box area = track;
            float left = (viewportWidth - CardsWidth) / 2f + TrackPad;
            float top = TrackPad;

            if (view.Scroll)
            {
                float contentHeight = Math.Max(viewportHeight, needed);
                float offset = view.OpenRow * (CardHeight + CardGap);

                area = ScrollArea(canvas, track, TrackPad, TrackPad, viewportWidth, viewportHeight,
                                  contentHeight, false, offset);

                // Os filhos se posicionam no CONTEÚDO, que tem a altura
                // inteira; a goteira da barra sai da largura útil.
                left = Math.Max(0f, (viewportWidth - ScrollGutter - CardsWidth) / 2f);
                top = ScrollInset;
            }

            for (int i = 0; i < view.Cards.Count; i++)
            {
                float x = left + (i % TrackColumns) * (CardWidth + CardGap);
                float y = top + (i / TrackColumns) * (CardHeight + CardGap);

                CardBox(canvas, area, x, y, view.Cards[i], view.Token, view.Icons);
            }

            if (paged)
            {
                Pager(canvas, track, TrackPad, BodyHeight - TrackPad - 28, viewportWidth, 28, view.Page, view.Pages,
                      MenuPageCommand + " " + view.Token, 140);
            }

            return canvas.Parts();
        }

        /// <summary>
        /// Um card: a tarja do nível, a faixa GRÁTIS em cima e a PAGA
        /// embaixo.
        ///
        /// A ordem não é estética: é o arranjo que o dono desenhou e o que o
        /// estudo do Hungry Shark World defende — o grátis acima, para quem
        /// não paga se sentir atendido, e o pago logo abaixo, no caminho do
        /// olho (03 §3).
        /// </summary>
        private static void CardBox(Canvas canvas, Box parent, float x, float y, CardView card, string token,
                                    Dictionary<string, string> icons)
        {
            // ####  SÓ O NÍVEL ATUAL TEM MOLDURA ACESA  ####
            //
            // É o que faz a trilha ter um "você está aqui" sem depender de
            // cor sozinha: a moldura é geometria, e ela só existe num card.
            string border = card.Current ? ColRust : card.Milestone ? ColAmber : null;
            string fill = card.Current ? ColCurrentFill : ColSurface;

            string name = Panel(canvas, parent, x, y, CardWidth, CardHeight, border ?? fill, canvas.NextName());
            Box box = new Box(name, CardWidth, CardHeight);

            if (border != null)
            {
                name = Panel(canvas, box, 2, 2, CardWidth - 4, CardHeight - 4, fill, canvas.NextName());
                box = new Box(name, CardWidth - 4, CardHeight - 4);
            }

            float strip = card.Milestone ? LevelStrip + MilestoneExtra : LevelStrip;
            float lane = (box.H - strip) / 2f;

            Panel(canvas, box, 0, 0, box.W, strip, card.Current ? ColRust : ColSurface2);
            Label(canvas, box, 0, 0, box.W, strip, card.LevelText, card.Milestone ? 14 : 12,
                  card.Current ? ColText : ColMuted, TextAnchor.MiddleCenter, true);

            LaneBox(canvas, box, 0, strip, box.W, lane, card.Free, card.Level, LaneFree, token, icons);

            // A divisória entre as duas faixas: 1 px, e é ela que diz que são
            // duas coisas e não uma lista.
            Panel(canvas, box, 8, strip + lane, box.W - 16, 1, ColBorder);

            LaneBox(canvas, box, 0, strip + lane, box.W, lane, card.Paid, card.Level, LanePaid, token, icons);
        }

        /// <summary>
        /// Uma faixa do card.
        ///
        /// ####  NUNCA SÓ A COR (03 §3.1, regra 1)  ####
        ///
        /// Cada estado tem uma FORMA: cadeado para bloqueado, ✓ para
        /// resgatado, ! para disponível, reticências para esperando. A cor
        /// acompanha, mas quem não a distingue lê o ícone do mesmo jeito.
        /// </summary>
        private static void LaneBox(Canvas canvas, Box parent, float x, float y, float w, float h, LaneView lane,
                                    int level, string key, string token, Dictionary<string, string> icons)
        {
            if (!lane.Has)
            {
                // A faixa existe e não dá nada neste nível. O traço é o que
                // diz isso: um vazio sem marca pareceria erro de carga.
                Label(canvas, parent, x, y, w, h, "—", 12, Faded(ColMuted, 0.4f), TextAnchor.MiddleCenter, false);
                return;
            }

            bool dim = lane.State == StateLocked || lane.State == StateSyncing;
            bool live = lane.State == StateAvailable;

            // A faixa paga tem fundo proprio: ver ColPaidFill. O verde
            // do resgate vence o ambar, porque "ja levou" e a resposta
            // mais util quando as duas coisas sao verdade.
            string fill = lane.State == StateClaimed ? ColClaimedFill
                : dim ? (lane.Paid ? ColPaidLockedFill : ColLockedFill)
                : lane.Paid ? ColPaidFill
                : ColSurface2;

            string name;
            if (live)
            {
                // A faixa inteira é o botão: o alvo é grande, e o card não
                // precisa de um botãozinho que some em 280 px de largura.
                name = Button(canvas, parent, x + 6, y + 4, w - 12, h - 8, fill,
                              MenuClaimCommand + " " + token + " " + level + " " + key, canvas.NextName());
            }
            else
            {
                name = Panel(canvas, parent, x + 6, y + 4, w - 12, h - 8, fill, canvas.NextName());
            }

            Box box = new Box(name, w - 12, h - 8);

            float iconSize = lane.Milestone ? 56f : 44f;
            float iconY = (box.H - iconSize) / 2f;

            if (lane.ItemId != 0)
            {
                Icon(canvas, box, 8, iconY, iconSize, iconSize, lane.ItemId, lane.SkinId, dim ? ColIconDim : "1 1 1 1");
            }
            else if (lane.Icon.Length > 0)
            {
                Png(canvas, box, 8, iconY, iconSize, iconSize, lane.Icon, dim ? ColIconDim : "1 1 1 1");
            }
            else
            {
                // Sem item e sem PNG: o tipo vira a arte. É o caso de OZCoin
                // e de recompensa que o agente ainda não ilustrou — e uma
                // sigla diz mais que um símbolo genérico.
                Label(canvas, box, 8, iconY, iconSize, iconSize, KindMark(lane.Kind), 14,
                      dim ? ColMuted : ColAmber, TextAnchor.MiddleCenter, true);
            }

            float textX = 8 + iconSize + 8;
            Label(canvas, box, textX, 0, box.W - textX - 30, box.H, Shorten(lane.Label, 34), 12,
                  dim ? ColMuted : ColText, TextAnchor.MiddleLeft, false);

            // ####  A FAIXA PAGA APARECE MESMO SEM O PASSE  ####
            //
            // Apagada e com selo, nunca escondida: o gancho de conversão é o
            // jogador ver o que está deixando na mesa (03 §3.1, regra 2).
            if (lane.Paid)
            {
                // A barra de acento na borda esquerda -- um elemento, e a
                // mesma linguagem da barrinha que abre todo titulo do
                // painel. Ela e o que se ve de relance; o "PASSE" abaixo
                // e para quem ja parou para ler.
                Panel(canvas, box, 0, 0, 3, box.H, dim ? Faded(ColAmber, 0.45f) : ColAmber, canvas.NextName());

                Label(canvas, box, textX, box.H - 16, 60, 14, "PASSE", 10, dim ? Faded(ColAmber, 0.6f) : ColAmber,
                      TextAnchor.MiddleLeft, true);
            }

            Badge(canvas, box, box.W - 28, (box.H - 20) / 2f, lane.State, icons);

            if (lane.Tip.Length > 0)
            {
                Tip(canvas, name, lane.Tip);
            }
        }

        /// <summary>A sigla de quem não tem ícone. Curta: ela mora num quadrado de 44 px.</summary>
        private static string KindMark(string kind)
        {
            switch (kind)
            {
                case "coins": return "OZ";
                case "kit": return "KIT";
                case "points": return "PTS";
                case "vip": return "VIP";
                case "skin": return "SKIN";
                default: return "★";
            }
        }

        /// <summary>A marca do estado, em 20×20. Um elemento por faixa — a régua de bytes não permite mais.</summary>
        private static void Badge(Canvas canvas, Box parent, float x, float y, int state,
                                  Dictionary<string, string> icons)
        {
            switch (state)
            {
                case StateClaimed:
                {
                    string crc = IconCrc(icons, "check");
                    if (crc.Length > 0) Png(canvas, parent, x, y, 20, 20, crc, ColOlive);
                    else Label(canvas, parent, x, y, 20, 20, "V", 12, ColOlive, TextAnchor.MiddleCenter, true);
                    break;
                }

                case StateAvailable:
                {
                    string crc = IconCrc(icons, "bang");
                    if (crc.Length > 0) Png(canvas, parent, x + 4, y, 12, 20, crc, ColAmber);
                    else Label(canvas, parent, x, y, 20, 20, "!", 14, ColAmber, TextAnchor.MiddleCenter, true);
                    break;
                }

                case StatePending:
                    Label(canvas, parent, x - 10, y, 30, 20, "…", 14, ColAmber, TextAnchor.MiddleCenter, true);
                    break;

                case StateSyncing:
                    Label(canvas, parent, x - 10, y, 30, 20, "· · ·", 10, ColMuted, TextAnchor.MiddleCenter, false);
                    break;

                default:
                {
                    string crc = IconCrc(icons, "lock");
                    if (crc.Length > 0) Png(canvas, parent, x + 1, y, 18, 20, crc, ColMuted);
                    else Label(canvas, parent, x, y, 20, 20, "X", 12, ColMuted, TextAnchor.MiddleCenter, true);
                    break;
                }
            }
        }

        // ---- o rodapé ----------------------------------------------

        private static string BuildFoot(FootView view)
        {
            Canvas canvas = new Canvas("OZP.F");
            Box foot = RegionRoot(canvas, UiFoot, 0, WinHeight - FooterHeight, WinWidth, FooterHeight, ColSurface);

            if (view.Message.Length > 0)
            {
                Label(canvas, foot, 16, 0, 420, FooterHeight, view.Message, 12,
                      view.MessageOk ? ColOlive : ColAmber, TextAnchor.MiddleLeft, false);
            }
            else if (view.Note.Length > 0)
            {
                Label(canvas, foot, 16, 0, 420, FooterHeight, view.Note, 11, ColMuted, TextAnchor.MiddleLeft, false);
            }

            float x = (WinWidth - 320) / 2f;

            if (view.Busy)
            {
                DeadButton(canvas, foot, x, 11, 320, 34, "AGUARDE…", 13);
            }
            else if (view.Count > 0)
            {
                // ####  O BOTÃO QUE EXISTE POR CAUSA DA RECLAMAÇÃO Nº 1  ####
                //
                // "after every game you have to probably click 20 times just
                // to claim all the season pass rewards" (03 §2). Quem compra
                // no nível 17 pede 17 de uma vez, e o agente entrega o que
                // couber.
                TextButton(canvas, foot, x, 11, 320, 34, ColRust, MenuClaimAllCommand + " " + view.Token,
                           "RESGATAR TUDO (" + view.Count + ")", 13, ColText);
            }
            else if (view.Waiting > 0)
            {
                // ####  O BOTÃO CONTA A CAIXA, E NÃO SÓ A TRILHA  ####
                //
                // O que foi resgatado e não coube saiu da trilha e ficou
                // esperando. Até 18/09/2026 o rodapé olhava só a trilha e
                // dizia "NADA PARA RESGATAR" com o prêmio do jogador
                // guardado — que foi exatamente a queixa do dono.
                TextButton(canvas, foot, x, 11, 320, 34, ColRust, MenuRetryCommand + " " + view.Token,
                           "PEGAR O QUE ESTÁ NA CAIXA (" + view.Waiting + ")", 13, ColText);
            }
            else
            {
                DeadButton(canvas, foot, x, 11, 320, 34, "NADA PARA RESGATAR", 13);
            }

            // ####  DE QUAL SERVIDOR É ESTA TRILHA  ####
            //
            // O XP, o nível e o passe comprado são POR SERVIDOR (01 §1.4).
            // Sem esta linha, quem joga em dois servidores abre o segundo e
            // conclui que o passe perdeu o nível dele.
            if (view.ServerName.Length > 0)
            {
                Label(canvas, foot, WinWidth - 436, 0, 420, FooterHeight,
                      "trilha do servidor " + view.ServerName + " · o XP e o nível são deste servidor", 11,
                      ColMuted, TextAnchor.MiddleRight, false);
            }

            return canvas.Json();
        }

        // ---- a caixa de pendências ---------------------------------

        private static List<string> BuildBox(BoxView view)
        {
            Canvas canvas = new Canvas("OZP.B");

            int rows = Math.Max(1, view.Rows.Count + (view.More > 0 ? 1 : 0));
            float needed = BoxHeadHeight + rows * BoxRowHeight + 12f;
            float height = Math.Min(BoxMaxHeight, needed);

            Box box = RegionRoot(canvas, UiBox, WinWidth - BoxWidth - 16, HeadHeight + 10, BoxWidth, height, ColBorder);

            string inner = Panel(canvas, box, 1, 1, BoxWidth - 2, height - 2, ColSurface, canvas.NextName());
            Box body = new Box(inner, BoxWidth - 2, height - 2);

            Panel(canvas, body, 0, 0, body.W, 2, ColRust);
            Label(canvas, body, 12, 2, body.W - 206, BoxHeadHeight, "O QUE ESTÁ ESPERANDO", 12, ColText,
                  TextAnchor.MiddleLeft, true);
            TextButton(canvas, body, body.W - 34, 6, 24, 24, ColSurface2, MenuBoxCommand + " " + view.Token,
                       "X", 11, ColMuted);

            // ####  A CAIXA PRECISA TER COMO ENTREGAR  ####
            //
            // Ela mostrava a promessa e não havia como pegá-la: o dono
            // liberava espaço e a recompensa continuava lá (18/09/2026).
            // Quem pergunta de novo se cabe é o agente; daqui sai o
            // pedido.
            if (view.Rows.Count > 0)
            {
                if (view.Busy)
                {
                    DeadButton(canvas, body, body.W - 180, 6, 140, 24, "AGUARDE…", 11);
                }
                else
                {
                    TextButton(canvas, body, body.W - 180, 6, 140, 24, ColRust,
                               MenuRetryCommand + " " + view.Token, "RESGATAR TUDO", 11, ColText);
                }
            }

            if (view.Rows.Count == 0)
            {
                Label(canvas, body, 12, BoxHeadHeight, body.W - 24, body.H - BoxHeadHeight, view.Empty, 11,
                      ColMuted, TextAnchor.UpperLeft, false);
                return canvas.Parts();
            }

            float viewport = body.H - BoxHeadHeight - 8;
            float content = (view.Rows.Count + (view.More > 0 ? 1 : 0)) * BoxRowHeight;

            Box area = body;
            float rowWidth = body.W - 24;
            float top = BoxHeadHeight;

            if (content > viewport)
            {
                area = ScrollArea(canvas, body, 12, BoxHeadHeight, body.W - 24, viewport, content, false, 0f);
                rowWidth = area.W - ScrollGutter;
                top = 0f;
            }

            for (int i = 0; i < view.Rows.Count; i++)
            {
                float y = top + i * BoxRowHeight;
                float x = area == body ? 12f : 0f;

                Label(canvas, area, x, y, rowWidth - 150, BoxRowHeight, Shorten(view.Rows[i].Label, 30), 12,
                      ColText, TextAnchor.MiddleLeft, false);

                // ####  AS DUAS ORIGENS PRECISAM FICAR DISTINGUÍVEIS  ####
                //
                // "não coube" e "sobrou do mês passado" produzem a mesma
                // linha e têm histórias diferentes (02 §6.4). Sem isso, o
                // jogador não sabe se perdeu alguma coisa ou se só faltou
                // espaço.
                bool season = view.Rows[i].Origin == "season";
                Label(canvas, area, x + rowWidth - 150, y, 150, BoxRowHeight,
                      season ? "da temporada anterior" : "não coube na mochila", 10,
                      season ? ColAmber : ColMuted, TextAnchor.MiddleRight, false);
            }

            if (view.More > 0)
            {
                Label(canvas, area, area == body ? 12f : 0f, top + view.Rows.Count * BoxRowHeight, rowWidth,
                      BoxRowHeight, "e mais " + view.More + " esperando", 11, ColMuted, TextAnchor.MiddleLeft, false);
            }

            return canvas.Parts();
        }

        // ============================================================
        //  §11  origemz.passe.bytes  -  o pior caso, medido
        //
        //  Monta a tela com dados FICTÍCIOS no pior caso — a trilha
        //  inteira, rótulos longos, tudo com ícone e selo — e devolve o
        //  tamanho do JSON de cada região e de cada `AddUI` da abertura.
        //  Não depende de jogador, de temporada nem de servidor no ar: é
        //  o que responde "cabe?" ANTES de ir ao jogo (03 §4.2).
        // ============================================================

        [ConsoleCommand(BytesCommand)]
        private void CmdBytes(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                BasePlayer player = arg.Player();
                if (player == null || !IsAdmin(player)) return;
            }

            int levels = arg.HasArgs(1) ? Math.Max(1, Math.Min(200, arg.GetInt(0, 30))) : 30;
            arg.ReplyWith(MeasureWorstCase(levels));
        }

        /// <summary>
        /// Público e estático de propósito: um teste fora do servidor pode
        /// chamá-lo sem instanciar o plugin.
        /// </summary>
        public static string MeasureWorstCase()
        {
            return MeasureWorstCase(30);
        }

        public static string MeasureWorstCase(int levels)
        {
            const string token = "0123456789abcdef";
            const string longLabel = "Fuzil Semiautomático Brasa Incandescente ×2";
            const int itemId = -1812555177;
            const ulong skin = 3802433262uL;

            // CRCs do tamanho dos de verdade: o número é o que viaja.
            Dictionary<string, string> icons = new Dictionary<string, string>
            {
                { "lock", "2942806813" },
                { "box", "2942806814" },
                { "dot", "2942806815" },
                { "bang", "2942806816" },
                { "check", "2942806817" },
            };

            HeadView head = new HeadView
            {
                Token = token,
                SeasonName = "SETEMBRO DE 2026",
                ServerName = "ORIGEMZ PVP 1",
                Remaining = "faltam 13 dias",
                LevelText = "NÍVEL 999",
                XpText = "999.999 / 999.999 XP",
                XpFill = 0.8f,
                PassLabel = "PASSE GRÁTIS",
                PassColor = ColMuted,
                BuyText = "ATIVAR O PASSE POR 2.500 OZCOIN",
                CanBuy = true,
                PendingCount = 9,
                PendingDot = true,
                PendingTip = "9 recompensas esperando: " + longLabel + " · " + longLabel + " · " + longLabel +
                             " · e mais 6. Clique para ver.",
                Icons = icons,
            };

            TrackView track = new TrackView { Token = token, Scroll = true, Icons = icons, OpenRow = 3 };

            for (int i = 1; i <= levels; i++)
            {
                CardView card = new CardView
                {
                    Level = i,
                    LevelText = "NÍVEL " + i,
                    Current = i == 17,
                    Milestone = i % 10 == 0,
                };

                // O pior caso de BYTES é toda faixa com rótulo longo, ícone,
                // selo e dica — e a dica é o que carrega mais texto.
                FillWorst(card.Free, longLabel, itemId, skin, false, i % 10 == 0,
                          i <= 17 ? (i % 3 == 0 ? StateClaimed : StateAvailable) : StateLocked);
                FillWorst(card.Paid, longLabel, itemId, skin, true, i % 10 == 0, StateLocked);

                card.Paid.Tip = "Ative o passe para levar esta recompensa — ela fica guardada até lá.";
                card.Free.Tip = i > 17 ? "Chegue ao nível " + i + " para levar." : "";

                track.Cards.Add(card);
            }

            FootView foot = new FootView
            {
                Token = token,
                ServerName = "ORIGEMZ PVP 1",
                // `Count` zerado de propósito: o botão da CAIXA tem o
                // rótulo mais longo dos dois, e o pior caso é o maior.
                Count = 0,
                Waiting = 99,
                Message = "Entreguei 6 de 17: faltou espaço na mochila para o resto, e ele continua esperando.",
                MessageOk = true,
                Note = "Trilha do servidor ORIGEMZ PVP 1 · o XP e o nível são deste servidor.",
            };

            // A caixa cheia até o teto de desenho, e ainda devendo: é o pior
            // caso dela, e é o que prova que o teto de `ComputeBox` basta.
            BoxView boxView = new BoxView { Token = token, More = 12 };
            for (int i = 0; i < BoxMaxRows; i++)
            {
                boxView.Rows.Add(new BoxRow { Label = longLabel, Origin = i % 2 == 0 ? "full" : "season" });
            }

            string window = BuildWindow(token);
            string headJson = BuildHead(head);
            string footJson = BuildFoot(foot);
            List<string> boxParts = BuildBox(boxView);
            string boxJson = Pack(boxParts, int.MaxValue)[0];
            List<string> trackParts = BuildTrack(track);
            string trackJson = Pack(trackParts, int.MaxValue)[0];

            // A abertura como o `Redraw` a manda: a trilha sai elemento por
            // elemento e o `Pack` corta no limite. Medir a região inteira num
            // AddUI só acusaria um estouro que não acontece.
            List<string> firstParts = new List<string> { window, headJson, footJson };
            List<string> secondParts = new List<string>(trackParts);
            secondParts.AddRange(boxParts);

            List<string> first = Pack(firstParts, AddUiByteLimit);
            List<string> second = Pack(secondParts, AddUiByteLimit);

            JObject regions = new JObject
            {
                ["window"] = Bytes(window),
                ["head"] = Bytes(headJson),
                ["track"] = Bytes(trackJson),
                ["foot"] = Bytes(footJson),
                ["box"] = Bytes(boxJson),
            };

            JArray sends = new JArray();
            int largest = 0;

            foreach (string json in first)
            {
                sends.Add(Bytes(json));
                largest = Math.Max(largest, Bytes(json));
            }

            foreach (string json in second)
            {
                sends.Add(Bytes(json));
                largest = Math.Max(largest, Bytes(json));
            }

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["levels"] = levels,
                ["limit"] = AddUiByteLimit,
                ["regions"] = regions,
                ["open"] = sends,
                ["sends"] = sends.Count,
                ["bytesPerLevel"] = levels > 0 ? Bytes(trackJson) / levels : 0,
                ["openUnderLimit"] = largest < AddUiByteLimit,
            };

            return reply.ToString(Formatting.None);
        }

        private static void FillWorst(LaneView lane, string label, int itemId, ulong skin, bool paid,
                                      bool milestone, int state)
        {
            lane.Has = true;
            lane.Label = label;
            lane.ItemId = itemId;
            lane.SkinId = skin;
            lane.Paid = paid;
            lane.Milestone = milestone;
            lane.State = state;
        }

        private static int Bytes(string text)
        {
            return Encoding.UTF8.GetByteCount(text);
        }

        // ============================================================
        //  §12  AUXILIARES
        // ============================================================

        private bool IsAdmin(BasePlayer player)
        {
            return player != null &&
                   (player.IsAdmin || permission.UserHasPermission(player.UserIDString, AdminPermission));
        }

        /// <summary>O jogador, só se estiver conectado.</summary>
        private static BasePlayer FindOnline(string steamId)
        {
            ulong userId;
            if (!ulong.TryParse(steamId, NumberStyles.None, CultureInfo.InvariantCulture, out userId))
            {
                return null;
            }

            BasePlayer player = BasePlayer.FindByID(userId);
            return player != null && player.IsConnected ? player : null;
        }

        private static bool IsSteamId(string text)
        {
            if (string.IsNullOrEmpty(text) || text.Length != 17 || !text.StartsWith("7656")) return false;

            foreach (char ch in text)
            {
                if (ch < '0' || ch > '9') return false;
            }

            return true;
        }

        private void Tell(BasePlayer player, string text)
        {
            if (player != null && player.IsConnected)
            {
                player.ChatMessage(text);
            }
        }

        private static string Shorten(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length <= max ? text : text.Substring(0, max - 1) + "…";
        }

        /// <summary>
        /// "faltam 13 dias".
        ///
        /// O contador é o que cria urgência (03 §2), e ele é calculado AQUI
        /// a partir do `endsAt` — não desce pronto do agente. Um texto
        /// pronto envelheceria entre duas cargas e diria "faltam 13 dias"
        /// no último dia do mês.
        /// </summary>
        private static string RemainingText(long endsAt)
        {
            if (endsAt <= 0) return "";

            long left = endsAt - NowMs();
            if (left <= 0) return "a temporada terminou";

            if (left >= DayMs)
            {
                long days = (long)Math.Ceiling(left / (double)DayMs);
                return days == 1 ? "falta 1 dia" : "faltam " + days + " dias";
            }

            long hours = (long)Math.Ceiling(left / 3600000d);
            if (hours >= 2) return "faltam " + hours + " horas";

            long minutes = Math.Max(1L, (long)Math.Ceiling(left / 60000d));
            return minutes == 1 ? "falta 1 minuto" : "faltam " + minutes + " minutos";
        }

        /// <summary>
        /// "48400" vira "48.400".
        ///
        /// Escrito à mão de propósito: `ToString("N0")` depende da cultura
        /// instalada no Mono do servidor, e um separador diferente por
        /// máquina é o tipo de coisa que ninguém vê até a captura de tela.
        /// </summary>
        private static string Thousands(long value)
        {
            string digits = Math.Abs(value).ToString(CultureInfo.InvariantCulture);
            StringBuilder result = new StringBuilder(digits.Length + digits.Length / 3);

            for (int i = 0; i < digits.Length; i++)
            {
                if (i > 0 && (digits.Length - i) % 3 == 0) result.Append('.');
                result.Append(digits[i]);
            }

            return (value < 0 ? "-" : "") + result;
        }

        private static string Hex(string hex)
        {
            int r = int.Parse(hex.Substring(1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            int g = int.Parse(hex.Substring(3, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            int b = int.Parse(hex.Substring(5, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);

            return F(r / 255f) + " " + F(g / 255f) + " " + F(b / 255f) + " 1";
        }

        private static string F(float value)
        {
            return value.ToString("0.####", CultureInfo.InvariantCulture);
        }

        private static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        /// <summary>
        /// O aviso para o agente, sempre FORA do frame do comando.
        ///
        /// Um `Puts` disparado dentro do handler entra na resposta casada do
        /// RCON e a quebra (MEDIDO no OrigemZTeam, 15/09/2026). Todo push
        /// daqui espera 0,1 s — inclusive os que nascem de um clique, porque
        /// o clique também é um comando de console.
        /// </summary>
        private void Push(string kind, JObject data)
        {
            if (string.IsNullOrEmpty(_secret)) return;

            data["kind"] = kind;
            data["secret"] = _secret;

            string line = Marker + data.ToString(Formatting.None);

            timer.Once(0.1f, delegate { Puts(line); });
        }

        private static string Fail(string error, string message)
        {
            JObject payload = new JObject
            {
                ["ok"] = false,
                ["error"] = error,
                ["message"] = message,
            };

            return payload.ToString(Formatting.None);
        }

        /// <summary>Base64 → objeto JSON, ou `null`.</summary>
        private static JObject DecodePayload(string encoded)
        {
            if (string.IsNullOrEmpty(encoded)) return null;

            try
            {
                string json = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
                return JObject.Parse(json);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Texto de um campo; nulo e ausente valem string vazia.</summary>
        private static string Text(JObject body, string key)
        {
            JToken token = body[key];
            if (token == null || token.Type == JTokenType.Null) return "";

            return token.ToString();
        }

        private static int Int(JObject body, string key)
        {
            int value;
            return int.TryParse(Text(body, key), NumberStyles.Integer, CultureInfo.InvariantCulture, out value)
                ? value
                : 0;
        }

        private static long Long(JObject body, string key)
        {
            long value;
            return long.TryParse(Text(body, key), NumberStyles.Integer, CultureInfo.InvariantCulture, out value)
                ? value
                : 0L;
        }

        private static bool Flag(JObject body, string key, bool fallback)
        {
            JToken token = body[key];
            if (token == null || token.Type == JTokenType.Null) return fallback;

            try
            {
                return token.ToObject<bool>();
            }
            catch (Exception)
            {
                return fallback;
            }
        }
    }
}
