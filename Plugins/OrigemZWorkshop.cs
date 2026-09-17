// ============================================================
//  OrigemZWorkshop  -  as skins da OrigemZ, escolhidas pelo jogador.
//
//  Especificação: Docs/OrigemZWorkshop/02-SKINS-DO-JOGADOR.md (regras)
//  e Docs/OrigemZWorkshop/03-MENU-DE-SKINS.md (a tela).
//
//  ####  O QUE ELE FAZ, EM UMA FIGURA  ####
//
//      CADASTRO (admin)
//        /skin add "rifle.ak" "3802433262"
//              ↓  confere item, número e duplicado aqui
//        #OZWORKSHOP#{"kind":"add",…}   →  agente (Steam + banco)
//        origemz.workshop.reply          →  a frase no chat do admin
//        origemz.workshop.sync           →  a skin entra no catálogo
//
//      POSSE (site, caixa do site, painel, /skin give)
//        origemz.workshop.owned <steamId> …  →  o que ESSE jogador tem
//
//      APLICAÇÃO
//        /skins, /skin    abre o menu (tela cheia, camada Overall)
//        /skin <palavra>  abre o menu já pesquisando
//        APLICAR          troca `item.skin` NO MESMO OBJETO
//
//  A v0.2.0 tinha uma caixa de 1 slot, coleções, permissão por skin e
//  acesso por grupo. A v0.3.0 tira os quatro (decisão do dono,
//  17/09/2026, 02 §1). Com a caixa, some o único lugar em que um item
//  ficava "emprestado" fora do inventário do jogador: agora nada sai
//  de onde está, e o `Unload` não tem item nenhum para devolver.
//
//  ####  O ITEM É O MESMO OBJETO, E É ISSO QUE NÃO PERDE NADA  ####
//
//  Este plugin NUNCA cria nem destrói item. Ele troca o número
//  `item.skin` do objeto que já existe — o `ApplySkinToItem` da
//  bancada de reparo (MEDIDO em 16 e 17/09/2026, 02 §6.1). Tudo o que
//  o item carrega (condição, munição, acessórios, conteúdo da mochila)
//  continua nele porque ele não foi trocado por outro. O caminho da
//  vanilla que RECRIA o item é só o do "redirect skin", e item de
//  redirect é recusado no cadastro e na aplicação.
//
//  ####  O SERVIDOR NUNCA SERVE A ARTE  ####
//
//  Ele manda um número de 64 bits e só. Quem não baixou a peça do
//  Workshop vê o item vanilla.
//
// ============================================================
//  ####  O CATÁLOGO E A POSSE SÃO DO AGENTE; ESTE ARQUIVO GUARDA CÓPIAS  ####
//
//  Duas cargas, as duas INTEIRAS (nunca delta), as duas com cópia em
//  disco SEM o segredo, para o servidor que reinicia com o agente fora
//  do ar continuar funcionando:
//
//      origemz.workshop.sync  <lote> <i> <n> <b64>            → cache.json
//      origemz.workshop.owned <steamId> <lote> <i> <n> <b64>  → owned.json
//
//  Os pedaços do mesmo lote são juntados em ordem, e a troca só
//  acontece quando o último chega. Lote incompleto é descartado e a
//  cópia anterior continua inteira. A posse também aceita a forma
//  curta `origemz.workshop.owned <steamId> <b64>`.
//
//  O Base64 não é capricho: MEDIDO no servidor, o parser de console
//  do Rust COME AS ASPAS de um JSON cru. Ver core/src/game/plugin-push.ts.
//
//  ####  "NÃO TEM NADA" É DIFERENTE DE "NÃO SEI"  ####
//
//  A posse de um jogador só existe em memória depois que o agente a
//  mandou (ou o owned.json a trouxe). Lista vazia = ele não tem nada.
//  Jogador ausente do dicionário = ninguém disse ainda: o menu mostra
//  "sincronizando" no lugar do cadeado, para nunca dizer "bloqueada"
//  sobre uma skin que talvez seja dele (02 §5.3).
//
// ============================================================
//  ####  QUEM PODE APLICAR UMA SKIN (02 §3)  ####
//
//  Qualquer um destes libera — é um OU:
//
//    - a skin está "liberada para todos" (skin da casa);
//    - o jogador tem uma posse VIVA dela (sem prazo, ou prazo futuro);
//    - ele tem `origemzworkshop.admin`.
//
//  A skin original ("Padrão", skin 0) é sempre permitida. Ligada e
//  vinculada ao servidor = estar no catálogo: o agente só manda essas.
//  Posse removida ou vencida NÃO despinta o que já foi pintado.
//
// ============================================================
//  ####  ARMADILHAS MEDIDAS  ####
//
//  1. SKIN DIFERENTE NÃO EMPILHA. Pintar uma pilha pinta a pilha
//     inteira, e ela não junta mais com a vanilla. É o jogo.
//
//  2. SKIN É GLOBAL, NÃO É POR ESPECTADOR. A proteção do modo streamer
//     é DO PORTADOR: o item dele fica sem skin enquanto ele está no ar.
//
//  3. `SkinId = 0` num ícone de item sem skins DERRUBA O JOGADOR
//     (core/src/game/ui-cui.ts:198). O `CuiHelper` do Oxide serializa
//     com `DefaultValueHandling.Ignore` (MEDIDO no Oxide.Rust.dll do
//     server01, 17/09/2026), então um `SkinId` 0 simplesmente não sai
//     no JSON. Mesmo assim, este arquivo nunca o atribui de propósito.
//
//  4. `[ConsoleCommand]` NÃO funciona em CovalencePlugin. Este plugin
//     é RustPlugin, e tem de continuar sendo.
//
//  5. `arg.Args` é `Facepunch.StringView[]`, e não `string[]`. Toda
//     leitura é por `arg.GetString(i)`.
//
//  6. NENHUM `Puts` sai no frame em que um comando do agente responde:
//     ele entra na resposta casada e a transforma em algo que não é
//     JSON. Todo push passa por `timer.Once`.
//
// ============================================================
//  ####  O CONTRATO COM O AGENTE  ####
//
//  AGENTE → PLUGIN (resposta CASADA no POST /rcon):
//
//      origemz.workshop.sync <lote> <i> <n> <b64>             → {"ok":true,"count":N}
//      origemz.workshop.owned <steamId> <lote> <i> <n> <b64>  → {"ok":true,"steamId":…,"count":N}
//      origemz.workshop.status                                → {"ok":true,"skins":N,…}
//      origemz.workshop.reply <b64>                           → {"ok":true}
//
//  PLUGIN → AGENTE, pelo console:
//
//      #OZWORKSHOP#{"kind":"ready"}                            SEM segredo
//      #OZWORKSHOP#{"kind":"applied","secret":…,"count":N}
//      #OZWORKSHOP#{"kind":"add","secret":…,"requestId":…,
//                   "steamId":…,"playerName":…,"shortname":…,"skinId":…}
//      #OZWORKSHOP#{"kind":"give","secret":…,"requestId":…,
//                   "steamId":<admin>,"playerName":…,"targetSteamId":…,
//                   "targetName":…,"shortname":…,"skinId":…,"days":N|null}
//
//  O `give` é respondido pelo mesmo `origemz.workshop.reply`, com o
//  mesmo `requestId`; a frase vai para o ADMIN que digitou (o plugin
//  guarda quem foi pelo requestId, então o `steamId` da resposta pode
//  ser o de qualquer um dos dois).
//
//  Todo push que não seja o `ready` carrega o segredo do `sync`: sem
//  ele, um jogador digita o marcador no chat e forja um cadastro.
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
    [Info("OrigemZWorkshop", "OrigemZ", "0.3.0")]
    [Description("Menu de skins, posse por jogador e cadastro de skins do Steam Workshop da OrigemZ.")]
    public class OrigemZWorkshop : RustPlugin
    {
        private const string Marker = "#OZWORKSHOP#";
        private const string SyncCommand = "origemz.workshop.sync";
        private const string OwnedCommand = "origemz.workshop.owned";
        private const string StatusCommand = "origemz.workshop.status";
        private const string ReplyCommand = "origemz.workshop.reply";
        private const string BytesCommand = "origemz.skins.bytes";

        // Os comandos da tela (03 §5). Digitados pelo CLIENTE, então
        // conferem tudo de novo: um jogador pode mandá-los pelo F1 com
        // qualquer argumento.
        private const string MenuOpenCommand = "origemz.skins.open";
        private const string MenuCloseCommand = "origemz.skins.close";
        private const string MenuCategoryCommand = "origemz.skins.cat";
        private const string MenuItemCommand = "origemz.skins.item";
        private const string MenuPageCommand = "origemz.skins.page";
        private const string MenuPickCommand = "origemz.skins.pick";
        private const string MenuTargetCommand = "origemz.skins.target";
        private const string MenuTargetsCommand = "origemz.skins.targets";
        private const string MenuMineCommand = "origemz.skins.mine";
        private const string MenuSortCommand = "origemz.skins.sort";
        private const string MenuFavoriteCommand = "origemz.skins.fav";

        /// <summary>A "categoria" da lateral que mostra as favoritas do jogador.</summary>
        private const string FavoritesKey = "fav";
        private const string MenuSearchCommand = "origemz.skins.search";
        private const string MenuApplyCommand = "origemz.skins.apply";

        /// <summary>O comando de fechar do OrigemZUI (servidor, com steamId). Ver `CloseMainMenu`.</summary>
        private const string MainMenuCloseCommand = "origemz.ui.close";

        private const string AdminPermission = "origemzworkshop.admin";
        private const string CacheFile = "OrigemZWorkshop/cache";
        private const string OwnedFile = "OrigemZWorkshop/owned";

        /// <summary>
        /// As favoritas de cada jogador: `steamId → ids de skin`. Mora SÓ no
        /// plugin (é preferência de tela, não posse) e por isso vale por
        /// servidor, não na rede. Id que saiu do catálogo é ignorado na hora
        /// de mostrar e podado na próxima gravação.
        /// </summary>
        private const string FavoritesFile = "OrigemZWorkshop/favorites";
        private const int MaxFavoritesPerPlayer = 200;

        /// <summary>Quanto o `/skin add` e o `/skin give` esperam a resposta do agente.</summary>
        private const float RequestTimeoutSeconds = 20f;

        /// <summary>Uma aplicação a cada meio segundo, por jogador (02 §6.2, item 7).</summary>
        private const float ApplyCooldownSeconds = 0.5f;

        /// <summary>Quanto a faixa "Skin aplicada." fica na tela (03 §3.6).</summary>
        private const float FlashSeconds = 2f;

        /// <summary>Quem não entra há 30 dias sai do owned.json (02 §5.3).</summary>
        private const long OwnedRetentionMs = 30L * 24 * 60 * 60 * 1000;

        /// <summary>
        /// O teto de um `AddUI`. O projeto mediu 50.000 como seguro para
        /// o transporte do agente; o RPC direto do plugin não foi medido
        /// (03 §8.4), então a régua aqui é mais curta.
        /// </summary>
        private const int AddUiByteLimit = 40000;

        private const long DayMs = 24L * 60 * 60 * 1000;

        // ============================================================
        //  §1  A CONFIGURAÇÃO
        // ============================================================

        private class PluginConfig
        {
            /// <summary>
            /// O botão SKINS na camada `Inventory` (03 §4.1).
            ///
            /// DESLIGADO por padrão: a medição 0.2 (o botão aparece só com
            /// o inventário aberto, e o clique funciona com o cursor do
            /// inventário) ainda não foi feita com um cliente de verdade.
            /// </summary>
            [JsonProperty("InventoryButton")]
            public bool InventoryButton = false;

            /// <summary>
            /// Onde o botão fica. Padrão: ao lado do botão MISSÕES do próprio
            /// Rust, no alto à esquerda do inventário, da mesma altura
            /// (pedido do dono, 17/09/2026).
            ///
            /// Âncora "0 1" é o canto de CIMA à esquerda; os offsets são em
            /// pixels da base 1280×720, e o Y é negativo porque desce. Se
            /// encavalar com o MISSÕES, mexa só nestes quatro valores.
            /// </summary>
            [JsonProperty("InventoryButtonAnchorMin")]
            public string InventoryButtonAnchorMin = "0 1";

            [JsonProperty("InventoryButtonAnchorMax")]
            public string InventoryButtonAnchorMax = "0 1";

            [JsonProperty("InventoryButtonOffsetMin")]
            public string InventoryButtonOffsetMin = "160 -52";

            [JsonProperty("InventoryButtonOffsetMax")]
            public string InventoryButtonOffsetMax = "255 -30";

            /// <summary>
            /// A grade de skins ROLA (ScrollView do CUI) em vez de paginar de
            /// 12 em 12. Pedido do dono em 17/09/2026, para testar no jogo.
            ///
            /// O projeto anterior derrubou o jogador com ScrollView
            /// (core/src/types/ui-document.ts:23). Se derrubar de novo:
            /// `origemz.skins.scroll 0` no console desliga na hora, sem
            /// recarregar o plugin.
            /// </summary>
            [JsonProperty("GridScroll")]
            public bool GridScroll = true;

            /// <summary>
            /// A lateral rola quando a categoria aberta não cabe, em vez de
            /// paginar os itens. O ScrollView foi medido no jogo em
            /// 17/09/2026 (a grade); `origemz.skins.scroll 0` desliga os dois.
            /// </summary>
            [JsonProperty("SideScroll")]
            public bool SideScroll = true;
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
        //  §2  O CATÁLOGO
        // ============================================================

        private class SkinEntry
        {
            public int Id;
            public string Label = "";
            /// <summary>O item BASE do jogo, minúsculo.</summary>
            public string Shortname = "";
            /// <summary>`ulong`: não cabe em inteiro com sinal, e por isso viaja como texto.</summary>
            public ulong SkinId;
            public string Description = "";
            /// <summary>"" (comum), uncommon, rare, epic ou legendary.</summary>
            public string Rarity = "";
            public int Sort;
            public bool OpenToAll;
            public bool HideInStreamer;

            // Resolvidos aqui, a partir do jogo (02 §5.1: o agente não manda).
            public int ItemId;
            public string ItemName = "";
            public string Category = "";
            /// <summary>Nome da skin + nome do item + shortname, sem acento e minúsculo.</summary>
            public string SearchKey = "";
        }

        private class CategoryInfo
        {
            public string Key = "";
            public string Label = "";
            /// <summary>Os itens da categoria que têm skin, em ordem de nome.</summary>
            public readonly List<string> Shortnames = new List<string>();
        }

        /// <summary>
        /// A carga inteira, já indexada.
        ///
        /// É montada NOVA a cada `sync` e só então trocada: limpar a velha
        /// antes e falhar no meio deixaria o servidor sem catálogo — e o
        /// agente acreditando que mandou um.
        /// </summary>
        private class Catalog
        {
            public readonly Dictionary<int, SkinEntry> ById = new Dictionary<int, SkinEntry>();

            /// <summary>shortname → as skins daquele item, em ordem (sort, nome).</summary>
            public readonly Dictionary<string, List<SkinEntry>> ByShortname =
                new Dictionary<string, List<SkinEntry>>();

            /// <summary>
            /// workshop id → a entrada. É o que reconhece o que é NOSSO num
            /// item que já está na mochila, para o modo streamer não apagar
            /// uma skin que o jogador comprou na Steam.
            /// </summary>
            public readonly Dictionary<ulong, SkinEntry> BySkinId = new Dictionary<ulong, SkinEntry>();

            /// <summary>Todas as skins, em ordem (sort, nome).</summary>
            public readonly List<SkinEntry> Ordered = new List<SkinEntry>();

            /// <summary>Só as categorias que têm skin, na ordem do 03 §3.2.</summary>
            public readonly List<CategoryInfo> Categories = new List<CategoryInfo>();

            public readonly Dictionary<string, CategoryInfo> CategoryByKey =
                new Dictionary<string, CategoryInfo>();

            public string StoreUrl = "";
        }

        private Catalog _catalog = new Catalog();

        /// <summary>SteamID de quem está escondendo a logo agora, segundo o agente.</summary>
        private readonly HashSet<string> _streamers = new HashSet<string>();

        /// <summary>
        /// SteamID → (uid do item → a skin que a proteção do streamer
        /// TIROU dele, ou que ele ESCOLHEU no menu enquanto estava no ar),
        /// para vestir de volta quando ele sair do ar.
        ///
        /// Reload perde a lista — e perde no lado certo: o que some é a
        /// RESTAURAÇÃO (cosmética), nunca a PROTEÇÃO.
        /// </summary>
        private readonly Dictionary<string, Dictionary<ulong, ulong>> _strippedByPlayer =
            new Dictionary<string, Dictionary<ulong, ulong>>();

        /// <summary>O segredo do `sync`. Vazio = nenhum push sai daqui, e nenhuma posse entra.</summary>
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

        /// <summary>O lote do catálogo em montagem.</summary>
        private readonly ChunkBatch _catalogBatch = new ChunkBatch();

        /// <summary>Os lotes de posse em montagem, um por steamId.</summary>
        private readonly Dictionary<string, ChunkBatch> _ownedBatches = new Dictionary<string, ChunkBatch>();

        /// <summary>
        /// Os itens que aceitam skin do Workshop, segundo o próprio jogo
        /// (`Skinnable.All`). `null` = o jogo não deu uma lista em que se
        /// possa confiar, e a conferência fica desligada.
        /// </summary>
        private HashSet<string> _skinnable;

        private readonly List<Item> _scratch = new List<Item>();

        /// <summary>
        /// As categorias do menu, na ordem da tela (03 §3.2). A chave é o
        /// nome do `ItemCategory` (MEDIDO no decompilado, 17/09/2026);
        /// qualquer outra cai em OUTROS.
        /// </summary>
        private static readonly string[][] CategoryTable =
        {
            new[] { "Weapon", "ARMAS" },
            new[] { "Attire", "ROUPAS" },
            new[] { "Tool", "FERRAMENTAS" },
            new[] { "Construction", "CONSTRUÇÃO" },
            new[] { "Items", "ITENS" },
            new[] { "Traps", "ARMADILHAS" },
            new[] { "Electrical", "ELÉTRICA" },
            new[] { "Medical", "MEDICAMENTOS" },
            new[] { "Ammunition", "MUNIÇÃO" },
            new[] { "Resources", "RECURSOS" },
            new[] { "Food", "COMIDA" },
            new[] { "Fun", "DIVERSÃO" },
            new[] { "Misc", "OUTROS" },
        };

        private const string OtherCategory = "Misc";

        private static string CategoryKeyOf(ItemDefinition def)
        {
            string name = def.category.ToString();

            for (int i = 0; i < CategoryTable.Length; i++)
            {
                if (CategoryTable[i][0] == name) return name;
            }

            return OtherCategory;
        }

        // ============================================================
        //  §3  O BOOT E O FIM
        // ============================================================

        private void Init()
        {
            // Registrada aqui: sem ela o admin não consegue cadastrar a
            // PRIMEIRA skin pelo jogo.
            permission.RegisterPermission(AdminPermission, this);
        }

        private void OnServerInitialized()
        {
            LoadSkinnables();
            LoadCache();
            LoadOwned();
            LoadFavorites();
            StoreIcons();

            if (_config.InventoryButton)
            {
                foreach (BasePlayer player in BasePlayer.activePlayerList)
                {
                    DrawInventoryButton(player);
                }
            }

            // O handshake. Sem segredo de propósito: é ele que PEDE as
            // cargas, e o segredo só existe depois que o catálogo chega.
            Puts(Marker + "{\"kind\":\"ready\"}");
        }

        private void Unload()
        {
            // ####  NADA FICA PENDURADO  ####
            //
            // Sem a caixa, não há item fora do inventário para devolver.
            // O que sobra é a tela, os relógios e a cópia da posse.
            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                if (player == null) continue;

                CuiHelper.DestroyUi(player, UiRoot);
                CuiHelper.DestroyUi(player, UiInventoryButton);
            }

            foreach (MenuSession session in _menus.Values)
            {
                if (session.FlashTimer != null) session.FlashTimer.Destroy();
            }

            _menus.Clear();

            foreach (PendingRequest pending in _pendingRequests.Values)
            {
                if (pending.Timeout != null) pending.Timeout.Destroy();
            }

            _pendingRequests.Clear();

            if (_ownedSaveTimer != null)
            {
                _ownedSaveTimer.Destroy();
                _ownedSaveTimer = null;
            }

            if (_ownedDirty)
            {
                SaveOwned();
            }
        }

        private void OnPlayerConnected(BasePlayer player)
        {
            if (player == null) return;

            TouchOwned(player.UserIDString);

            if (_config.InventoryButton)
            {
                // O cliente ainda está montando a tela no instante da
                // conexão; o botão entra um pouco depois.
                ulong userId = player.userID;
                timer.Once(3f, () =>
                {
                    BasePlayer again = BasePlayer.FindByID(userId);
                    if (again != null && again.IsConnected) DrawInventoryButton(again);
                });
            }
        }

        private void OnPlayerRespawned(BasePlayer player)
        {
            if (player != null && _config.InventoryButton)
            {
                DrawInventoryButton(player);
            }
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player == null) return;

            CloseMenu(player, false);
            TouchOwned(player.UserIDString);
            _ownedBatches.Remove(player.UserIDString);
            _nextApply.Remove(player.userID);
        }

        private void OnPlayerDeath(BasePlayer player, HitInfo info)
        {
            CloseMenu(player, true);
        }

        private void OnPlayerWound(BasePlayer player, HitInfo info)
        {
            CloseMenu(player, true);
        }

        /// <summary>
        /// Monta o conjunto de itens que aceitam skin do Workshop.
        ///
        /// MEDIDO no server01 em 16/09/2026: o `ItemName` do asset é o
        /// shortname, e 160 entradas casam com itens reais. Mesmo assim o
        /// conjunto só é usado se ao menos parte dele casar: um update do
        /// Rust que mude a convenção faria esta conferência recusar TODO
        /// cadastro, em silêncio.
        /// </summary>
        private void LoadSkinnables()
        {
            _skinnable = null;

            try
            {
                if (Skinnable.All == null || Skinnable.All.Length == 0)
                {
                    return;
                }

                HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                foreach (Skinnable entry in Skinnable.All)
                {
                    if (entry == null || string.IsNullOrEmpty(entry.ItemName))
                    {
                        continue;
                    }

                    if (ItemManager.FindItemDefinition(entry.ItemName) != null)
                    {
                        names.Add(entry.ItemName);
                    }
                }

                if (names.Count >= 10)
                {
                    _skinnable = names;
                    Puts("Itens que aceitam skin do Workshop: " + names.Count + ".");
                }
                else
                {
                    PrintWarning("Skinnable.All tem " + Skinnable.All.Length + " entradas, mas só " +
                                 names.Count + " casam com shortnames: a conferência de item " +
                                 "que aceita skin fica desligada.");
                }
            }
            catch (Exception cause)
            {
                PrintWarning("Não consegui ler Skinnable.All (" + cause.Message + "): a conferência " +
                             "de item que aceita skin fica desligada.");
            }
        }

        // ============================================================
        //  §4  A CARGA DO CATÁLOGO  -  origemz.workshop.sync
        // ============================================================

        [ConsoleCommand(SyncCommand)]
        private void CmdSync(ConsoleSystem.Arg arg)
        {
            // Jogador digitando no F1. O comando carrega o segredo do
            // agente: não tem resposta para ele, nem uma de erro.
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                string encoded;

                if (arg.HasArgs(4))
                {
                    string reply = CollectChunk(_catalogBatch, arg.GetString(0), arg.GetInt(1, -1),
                                                arg.GetInt(2, -1), arg.GetString(3), out encoded);
                    if (reply != null)
                    {
                        arg.ReplyWith(reply);
                        return;
                    }
                }
                else if (arg.HasArgs(1))
                {
                    // O formato de um argumento só, de um agente antigo.
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

                arg.ReplyWith(ApplySync(payload, true));
            }
            catch (Exception cause)
            {
                arg.ReplyWith(Fail("EXCEPTION", cause.Message));
            }
        }

        /// <summary>
        /// Guarda um pedaço. Devolve `null` quando o lote fechou (e
        /// `whole` traz o base64 inteiro), ou a resposta a dar agora.
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

            // Pedaço de outro lote, ou fora de ordem: o lote em montagem
            // é descartado. O agente manda tudo de novo na próxima vez.
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
        /// Troca o catálogo inteiro pelo que chegou.
        ///
        /// `fromAgent` = veio do console, e não do disco. Só a do agente
        /// traz segredo, é gravada em disco e é confirmada.
        /// </summary>
        private string ApplySync(JObject payload, bool fromAgent)
        {
            List<string> skipped = new List<string>();
            Catalog next = ReadCatalog(payload, skipped);

            _catalog = next;

            if (fromAgent)
            {
                _secret = Text(payload, "secret");
                ApplyStreamerList(payload);
                SaveCache(payload);
            }

            // O menu aberto reflete a carga nova: uma skin que saiu não
            // pode continuar clicável (03 §7).
            RedrawAllMenus(Region.All);

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["count"] = next.ById.Count,
            };

            if (fromAgent)
            {
                JObject applied = new JObject { ["count"] = next.ById.Count };
                if (skipped.Count > 0)
                {
                    // Em TEXTO: o `WorkshopPush` do agente só tem
                    // `message`, e um campo novo faria o zod recusar.
                    applied["message"] = "recusadas: " + string.Join(", ", skipped.ToArray());
                }

                Push("applied", applied);
            }

            return reply.ToString(Formatting.None);
        }

        private Catalog ReadCatalog(JObject payload, List<string> skipped)
        {
            Catalog next = new Catalog();
            next.StoreUrl = Text(payload, "storeUrl").Trim();

            JArray skins = payload["skins"] as JArray;
            if (skins != null)
            {
                foreach (JToken token in skins)
                {
                    JObject row = token as JObject;
                    if (row == null) continue;

                    string reason = ReadSkin(row, next);
                    if (reason != null)
                    {
                        skipped.Add(Text(row, "shortname") + "/" + Text(row, "skinId") + "=" + reason);
                    }
                }
            }

            Comparison<SkinEntry> order = CompareSkins;

            next.Ordered.Sort(order);
            foreach (List<SkinEntry> list in next.ByShortname.Values)
            {
                list.Sort(order);
            }

            // As categorias, na ordem da tabela, só com o que existe aqui.
            Dictionary<string, CategoryInfo> found = new Dictionary<string, CategoryInfo>();
            foreach (KeyValuePair<string, List<SkinEntry>> pair in next.ByShortname)
            {
                string key = pair.Value[0].Category;

                CategoryInfo info;
                if (!found.TryGetValue(key, out info))
                {
                    info = new CategoryInfo { Key = key };
                    found[key] = info;
                }

                info.Shortnames.Add(pair.Key);
            }

            for (int i = 0; i < CategoryTable.Length; i++)
            {
                CategoryInfo info;
                if (!found.TryGetValue(CategoryTable[i][0], out info)) continue;

                info.Label = CategoryTable[i][1];

                Dictionary<string, List<SkinEntry>> byShortname = next.ByShortname;
                info.Shortnames.Sort((a, b) => string.Compare(byShortname[a][0].ItemName,
                                                              byShortname[b][0].ItemName,
                                                              StringComparison.OrdinalIgnoreCase));

                next.Categories.Add(info);
                next.CategoryByKey[info.Key] = info;
            }

            return next;
        }

        /// <summary>Ordem da grade: `sort` do catálogo, depois o nome (02 §4.1).</summary>
        private static int CompareSkins(SkinEntry a, SkinEntry b)
        {
            int bySort = a.Sort.CompareTo(b.Sort);
            if (bySort != 0) return bySort;

            int byLabel = string.Compare(a.Label, b.Label, StringComparison.OrdinalIgnoreCase);
            return byLabel != 0 ? byLabel : a.Id.CompareTo(b.Id);
        }

        /// <summary>
        /// Lê uma skin. Devolve `null` se ela entrou, ou o motivo da recusa
        /// — um número errado não dá erro no jogo, o item só fica vanilla
        /// e ninguém descobre por quê.
        /// </summary>
        private string ReadSkin(JObject row, Catalog next)
        {
            string shortname = Text(row, "shortname").ToLowerInvariant();
            if (shortname.Length == 0) return "no_shortname";

            ItemDefinition def = ItemManager.FindItemDefinition(shortname);
            if (def == null) return "unknown_item";
            if (def.isRedirectOf != null) return "redirect_item";

            ulong skinId;
            if (!ulong.TryParse(Text(row, "skinId"), NumberStyles.None, CultureInfo.InvariantCulture, out skinId) ||
                skinId == 0uL)
            {
                return "bad_skin_id";
            }

            if (RejectsInventoryId(skinId)) return "inventory_definition_id";

            int id = Int(row, "id");
            if (id <= 0 || next.ById.ContainsKey(id)) return "bad_id";

            SkinEntry entry = new SkinEntry
            {
                Id = id,
                Label = Text(row, "label").Trim(),
                Shortname = shortname,
                SkinId = skinId,
                Description = Text(row, "description").Trim(),
                Rarity = NormalizeRarity(Text(row, "rarity")),
                Sort = Int(row, "sort"),
                OpenToAll = Flag(row, "openToAll", false),
                HideInStreamer = Flag(row, "hideInStreamer", true),
                ItemId = def.itemid,
                ItemName = def.displayName != null ? def.displayName.english : shortname,
                Category = CategoryKeyOf(def),
            };

            if (entry.Label.Length == 0)
            {
                entry.Label = entry.ItemName;
            }

            entry.SearchKey = Fold(entry.Label) + " " + Fold(entry.ItemName) + " " + shortname;

            next.ById[id] = entry;
            next.Ordered.Add(entry);

            List<SkinEntry> sameItem;
            if (!next.ByShortname.TryGetValue(shortname, out sameItem))
            {
                sameItem = new List<SkinEntry>();
                next.ByShortname[shortname] = sameItem;
            }

            sameItem.Add(entry);

            if (!next.BySkinId.ContainsKey(skinId))
            {
                next.BySkinId[skinId] = entry;
            }

            return null;
        }

        private static string NormalizeRarity(string raw)
        {
            string value = (raw ?? "").Trim().ToLowerInvariant();

            switch (value)
            {
                case "uncommon":
                case "rare":
                case "epic":
                case "legendary":
                    return value;
                default:
                    // "common", vazio ou desconhecido: sem borda (03 §2).
                    return "";
            }
        }

        /// <summary>
        /// O número é um id de DEFINIÇÃO DE INVENTÁRIO do Steam, e não um
        /// workshop id? `ItemManager.TrySkinChangeItem` faz o mesmo cast
        /// `(int)` — acima de `int.MaxValue` ele nem procura.
        /// </summary>
        private bool RejectsInventoryId(ulong skinId)
        {
            if (skinId > int.MaxValue) return false;

            try
            {
                return ItemSkinDirectory.FindByInventoryDefinitionId((int)skinId).id != 0;
            }
            catch (Exception)
            {
                // O diretório LANÇA quando não abre. Não dá para reprovar
                // o cadastro do admin por causa disso.
                return false;
            }
        }

        // ---- a cópia do catálogo em disco --------------------------

        private class CacheData
        {
            public long SavedAt;
            public string Payload = "";
        }

        private void SaveCache(JObject payload)
        {
            try
            {
                JObject copy = (JObject)payload.DeepClone();
                copy.Remove("secret");

                CacheData data = new CacheData
                {
                    SavedAt = NowMs(),
                    Payload = copy.ToString(Formatting.None),
                };

                Interface.Oxide.DataFileSystem.WriteObject(CacheFile, data);
            }
            catch (Exception cause)
            {
                PrintWarning("Não consegui gravar a cópia do catálogo: " + cause.Message);
            }
        }

        private void LoadCache()
        {
            try
            {
                if (!Interface.Oxide.DataFileSystem.ExistsDatafile(CacheFile)) return;

                CacheData data = Interface.Oxide.DataFileSystem.ReadObject<CacheData>(CacheFile);
                if (data == null || string.IsNullOrEmpty(data.Payload)) return;

                // Uma cópia da v0.2.0 ainda traz coleções e acessos: os
                // campos são ignorados, e as skins entram.
                ApplySync(JObject.Parse(data.Payload), false);
                Puts("Catálogo carregado do disco (" + _catalog.ById.Count + " skins). O agente " +
                     "manda a carga atual assim que conectar.");
            }
            catch (Exception cause)
            {
                PrintWarning("A cópia do catálogo em disco não abriu (" + cause.Message + "): " +
                             "o menu fica vazio até o agente mandar a carga.");
            }
        }

        // ============================================================
        //  §5  A POSSE  -  origemz.workshop.owned
        // ============================================================

        private class OwnedRecord
        {
            /// <summary>id da skin (do agente) → expira em (epoch ms; 0 = permanente).</summary>
            public readonly Dictionary<int, long> Skins = new Dictionary<int, long>();

            /// <summary>A última vez que o jogador foi visto (ou que a carga chegou). Epoch ms.</summary>
            public long LastSeen;
        }

        /// <summary>
        /// SteamID → o que ele tem. AUSENTE = "não sei" (02 §5.3).
        /// </summary>
        private readonly Dictionary<string, OwnedRecord> _owned = new Dictionary<string, OwnedRecord>();

        private bool _ownedDirty;
        private Timer _ownedSaveTimer;

        [ConsoleCommand(OwnedCommand)]
        private void CmdOwned(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                string steamId = arg.GetString(0);
                if (!IsSteamId(steamId))
                {
                    arg.ReplyWith(Fail("INVALID_ARGS",
                        "Use: " + OwnedCommand + " <steamId> <lote> <i> <n> <base64>"));
                    return;
                }

                string encoded;

                if (arg.HasArgs(5))
                {
                    ChunkBatch state;
                    if (!_ownedBatches.TryGetValue(steamId, out state))
                    {
                        state = new ChunkBatch();
                        _ownedBatches[steamId] = state;
                    }

                    string reply = CollectChunk(state, arg.GetString(1), arg.GetInt(2, -1),
                                                arg.GetInt(3, -1), arg.GetString(4), out encoded);
                    if (reply != null)
                    {
                        if (state.Id.Length == 0) _ownedBatches.Remove(steamId);
                        arg.ReplyWith(reply);
                        return;
                    }

                    _ownedBatches.Remove(steamId);
                }
                else if (arg.HasArgs(2))
                {
                    encoded = arg.GetString(1);
                }
                else
                {
                    arg.ReplyWith(Fail("INVALID_ARGS",
                        "Use: " + OwnedCommand + " <steamId> <lote> <i> <n> <base64>"));
                    return;
                }

                JObject payload = DecodePayload(encoded);
                if (payload == null)
                {
                    arg.ReplyWith(Fail("INVALID_PAYLOAD", "O payload não é Base64 de um objeto JSON."));
                    return;
                }

                // O mesmo segredo do último `sync`: sem ele, qualquer um com
                // acesso ao console dava skin a si mesmo. Posse que chega
                // ANTES do catálogo é recusada — o agente reenvia no
                // próximo gatilho.
                string secret = Text(payload, "secret");
                if (_secret.Length == 0 || secret != _secret)
                {
                    arg.ReplyWith(Fail(_secret.Length == 0 ? "NO_CATALOG" : "BAD_SECRET",
                        "A posse precisa do segredo do último " + SyncCommand + "."));
                    return;
                }

                JArray skins = payload["skins"] as JArray;
                if (skins == null)
                {
                    // Ausente não é vazio: sem a lista, não há o que trocar.
                    arg.ReplyWith(Fail("INVALID_PAYLOAD", "Falta a lista \"skins\"."));
                    return;
                }

                OwnedRecord record = new OwnedRecord { LastSeen = NowMs() };

                foreach (JToken token in skins)
                {
                    JObject row = token as JObject;
                    if (row == null) continue;

                    int id = Int(row, "id");
                    if (id <= 0) continue;

                    long expiresAt = Math.Max(0L, Long(row, "expiresAt"));

                    // Duas linhas da mesma skin (não deveria haver): vale a
                    // mais generosa, como na regra de renovação do 02 §4.2.
                    long previous;
                    if (record.Skins.TryGetValue(id, out previous))
                    {
                        expiresAt = previous == 0 || expiresAt == 0 ? 0 : Math.Max(previous, expiresAt);
                    }

                    record.Skins[id] = expiresAt;
                }

                _owned[steamId] = record;
                ScheduleOwnedSave();

                // O momento em que o jogador comprou no site e está olhando
                // o menu: o cadeado some agora (03 §7).
                BasePlayer player = FindOnline(steamId);
                if (player != null)
                {
                    MenuSession session;
                    if (_menus.TryGetValue(player.userID, out session))
                    {
                        Redraw(player, session, Region.AllButWindow);
                    }
                }

                JObject ok = new JObject
                {
                    ["ok"] = true,
                    ["steamId"] = steamId,
                    ["count"] = record.Skins.Count,
                };

                arg.ReplyWith(ok.ToString(Formatting.None));
            }
            catch (Exception cause)
            {
                arg.ReplyWith(Fail("EXCEPTION", cause.Message));
            }
        }

        /// <summary>Marca o jogador como visto agora, se a posse dele é conhecida.</summary>
        private void TouchOwned(string steamId)
        {
            OwnedRecord record;
            if (_owned.TryGetValue(steamId, out record))
            {
                record.LastSeen = NowMs();
                ScheduleOwnedSave();
            }
        }

        /// <summary>
        /// Grava daqui a pouco, e uma vez só: no `ready` o agente manda a
        /// posse de todos os online em sequência.
        /// </summary>
        private void ScheduleOwnedSave()
        {
            _ownedDirty = true;

            if (_ownedSaveTimer != null) return;

            _ownedSaveTimer = timer.Once(5f, () =>
            {
                _ownedSaveTimer = null;
                SaveOwned();
            });
        }

        private class OwnedFileSkin
        {
            public int Id;
            public long ExpiresAt;
        }

        private class OwnedFileEntry
        {
            public long LastSeen;
            public List<OwnedFileSkin> Skins = new List<OwnedFileSkin>();
        }

        private class OwnedFileData
        {
            public long SavedAt;
            public Dictionary<string, OwnedFileEntry> Players = new Dictionary<string, OwnedFileEntry>();
        }

        /// <summary>
        /// Grava o owned.json — SEM o segredo, sem posse vencida, e sem
        /// quem não entra há 30 dias (que também sai da memória: quando
        /// ele voltar, o agente manda a posse dele na entrada).
        /// </summary>
        private void SaveOwned()
        {
            _ownedDirty = false;

            try
            {
                long now = NowMs();
                OwnedFileData data = new OwnedFileData { SavedAt = now };
                List<string> stale = new List<string>();

                foreach (KeyValuePair<string, OwnedRecord> pair in _owned)
                {
                    if (now - pair.Value.LastSeen > OwnedRetentionMs && FindOnline(pair.Key) == null)
                    {
                        stale.Add(pair.Key);
                        continue;
                    }

                    OwnedFileEntry entry = new OwnedFileEntry { LastSeen = pair.Value.LastSeen };

                    foreach (KeyValuePair<int, long> skin in pair.Value.Skins)
                    {
                        if (skin.Value != 0 && skin.Value <= now) continue;
                        // Skin que saiu do catálogo não volta a ser lida: não guardar.
                        if (_catalog != null && _catalog.ById.Count > 0 && !_catalog.ById.ContainsKey(skin.Key)) continue;

                        entry.Skins.Add(new OwnedFileSkin { Id = skin.Key, ExpiresAt = skin.Value });
                    }

                    data.Players[pair.Key] = entry;
                }

                foreach (string steamId in stale)
                {
                    _owned.Remove(steamId);
                }

                Interface.Oxide.DataFileSystem.WriteObject(OwnedFile, data);
            }
            catch (Exception cause)
            {
                PrintWarning("Não consegui gravar a cópia da posse: " + cause.Message);
            }
        }

        // ####  OS ÍCONES DO MENU MORAM AQUI, EM PNG  ####
        //
        // Nenhum sprite do jogo foi confirmado no servidor (os bundles são
        // compactados), e um caminho errado vira um quadrado branco. Estes
        // são nossos: 64x64, brancos sobre transparente, tingidos pelo CUI.
        // Vão para o FileStorage no boot, e o CUI os pede pelo CRC. O
        // FileStorage indexa por conteúdo: gravar de novo os mesmos bytes
        // devolve o mesmo CRC.
        private static readonly Dictionary<string, string> IconPng = new Dictionary<string, string>
        {
            { "list", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACCElEQVR42u2YsYrVUBCGv0mujXKFLRYEwU7Ex/AJtLBY2UIb7cQnsLPSFxBfQCwVhAUry622XsTSwk6w0t3kt5mjIXs3JO7dG5H/g3DPTXImc+ZM5pz8YIwxxhgzEkkhKf6X8cSEgddAGxFa9X+gXzXlOeucq4ho1zbrnfZWDmpSv5mytTpzBkiqIqKVtAM8Bm4AX4HXwAvgJ0A/EyRFREjSTeDKDJl9GBFfiv9/G8E6f59qNe8l1f1IS6qyVryUdKx5+C7p4dhMODV9JF2XdCSpycG02f6RD9rN+xa9oD3P680MRzfod7p+9RmKTLl2G1gALVBnelXZFnDvT8wUEdFIWgIPsk+xtcmjBo7Tv0eMGOQQyzR0GpdKADrnFsCFqSvNOdSBFri4wr9RASgd9tKYekaaPL9XbGXRq4FvwMe0f5SzsemjyUx4O2GyTxbBLGZvOu9Uk3VAkj7nsvh7c1TakrYl7WteXklaDBXBGLmOL4FnwH3gckb4A/AkIj6VJW/FErgE7gLXNvg6FD8OIuJd1591bCyuSrqVa/vgZudf2C6P8SEmGKoioumdi6FNRt5TzzX+rr9n/hbo7evXt882xlgQsSBiQcSCiAURCyIWRCyIWBCxIGJBxIKIBRELIsYYCyIWRCyIWBCxIGJBxIKIBRELIhZELIhYELEgYkHEGGOMMeZc+AXAd5RwCl2rEwAAAABJRU5ErkJggg==" },
            { "gem", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAADwklEQVR42u2bz4scVRDHP9UzKxgEnYhXYc8xCpIRxcuKCznoSXJRD5LDGvDkn5D/wGuIIMGj5CQKBsXEUyTrXU+ak4eYnxDJupnprwfrwbOdGWZmu1+/Hrtg6D3szqvvt96r+la9Xuitt9566623/61ZHV8iyVpx3kytM9gW+LrWtqM6YGaSVABPA6prVy1a1tc4MLNHwYfkBDj75g59D7yUiIBAwgPgTTP7TVJhZmXq7Tf050W1Z/uSRpKKpEdR0pY/P3ZHHksqE38Ofe3LwackJESRP+MOHLpDbVgg4ZPYtybBD/x5StJdSdMWwSvafZK0tw4JtgL4wn98BvgJ2AZKoGi7EkfJ93Uzuy5pYGbTZf64WCPjf+3gpxmAj4Mo4CtJ22Y2jQJ2dAKAwhm9ALwKTIBBRoq2cAKOA19IOvZP3GpIilHSO1c5czla8O1SLUkxAr9bKXc5W6gM5+OSvXISDIlE0kngKjBa8di0aRNgCJw1s0uShmY2WZqAKIGMHPxJT3oDumGhN3gEvGFmN+ZVBpvXYXmT8w1wGvjLGe2SlR6wW8ALZnZnVs9gc6JfAJ8D727I3OMXYAf4A1DcPQ6r4M2slPQy8DzwnZNhHQY/AZ4C3jKzzzzAynbIkcVIzAnY6njkq/Y4+cygczsgygEvAu8BDz1PqM4hasJSaF6+nwR+NLMvq5Vg+N/drwK4CZwA3t6QQP8OzEyAtmDQ+QRwDXgNOOigDpi6z3eAHTP7eSkdUDkKI+AKMO6YEgxzinvAaTPbX1oJziHhhw7J4RDhA4/8/qJeoFhw61I6a/eA953NQbRArolPjusjB781D/yqc8CxzwHls8DcrDzqfHCZucBY0p9OwDTTYci5RibE0V3AB77QJKPhSAB/odHxeLQT9jKaEAXwF4OPjfYyM26FDjMYf4XboUHjjZwkm3Ev2MagdOLPG9H9YJpxnZNQtEjCv8BXxnikJCGUyMsJj0MA/2tr4GO16J+RRyN2sAkLpfeupFOxTmnzFZlwFJomIWiP25LGWYCfoRafk3SrARLK6Pt2l7nwaJOEV2qWzGX0PXtJ3gOoqW+4XYNknqXv8+5GI6G0W4NkXumeLycSqpJ5nTdJJkklboPHYZ2+oarvi07eVUTH4fwKQin8zrfJ9H1GfUMscZ9Nqu8T9Q2fLiBhEr/82KrEbYoEf16fQUIscbc7Ue6O0Dccr0jmGPx4I8HP6Rv2o52w+eBnlMdtSfedhHc6JXRqJGFH0odZ6/sU/+2xMdl+zcQ4oLfeeuutJfsbOmrjD4R+QIsAAAAASUVORK5CYII=" },
            { "grid", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABkElEQVR42u2ZPU7DQBSEv+ckEgIpd4ADUUAqRMd50nEOKgqQaCipuQh9foaCtRRZJGRtZx2RGcmKZNlvVt+uN9o3YFmWZZ2uYt8HJVVA1dFPEbE6Bp+8aj+DOnitUj5ZK0BSFRFrSVfANTBN7+27epR+l8BbRHxIiojQED6tKEq6l/SlfjRvzlApn6wVkF4UcAl8AufAImff+GWGKmAE3EbEk6RRun9wn217wi46VVo+NxuDmgDjltckDW4NPAzgQy6AWtNUMOjnX6cCLhrfbUmfbACrngbVrDmUTzaAvge1rWYpn2wA/1oGYAAGYAAGYAAGYAAGYAB/d1r60npgn70B1AVeNw4Wy3TCanstk+fzhn8pn04tsbn607ukM0khKUr6dG2KzoC7js3KF+AxIhbNhmUpn7Yrodez+rZ6pXzaBiOjjptVPZurXTNSyqfWuEW3NTomNjoSHydDToacDDkZcjLkZAgnQ06G3A8wAAMwAAMwAAMwAAMwAANwMuRkyMmQkyEnQyeVDFmWZVmnrG+IYzXYQPTZVgAAAABJRU5ErkJggg==" },
            { "check", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAADz0lEQVR42u2bz2sTURDHZ7IRi/iDVCh4EQX/AaEtFC8qPXnVowdRSq/17qH/Qa+iKHr3KIp4EgRBD4J6UcGTCpa2WEHQJtmPB+fJuCTN22TTZtMdWBJ2k81+v+/NfGfmvYhUVllllVVWWWV71XTcAAEqIok7lapquidGE0i6nK+N/QwAElVtA1MickFEjovIdxF5oqrvAVVVxnrkgavAN/6338BKmAnmImMFvm6vVxzopjtSO3ezlzuUEXzNXqeATaANtDIzIAW27P25bKyolTzaC9AQkYcictguJR3inIpIKiLXsveplRh83eTttojMiEhrGzxq106EW5R9BiSq2rTgdlFEmiJS7/GdVEQ2Sq9+LugtuIDXy0IMuOzvUWbw8wao7aJ8NwsEvQD2l1YKndZPA2sGvt0DfFCEl8AkoGUFX7NjEvjkRj8WfKO0OUAYNTteZMB1s0DOqqXGXeuEMoAPfn8rMuilRsBPYLa04O3B99nrciaabwc+fObKuER8L3exEX/JE1jmiD9noNMc4G8VOvJAAtTtSIYtI67AOQmsR8pdAP+0sLJ3O80clpw4uTsKvIqM+OH6G/teLc/zdQP4r3sCzInIecu1X4vIY8vDE1VtF1zgqKqmNpLzVuDUe+T3Yp2fs6r6duDncmXmJPCoA+PvgJmiI2yfcheOuULkzqZ9DThiGVSYYr7DArBRJAlO7pZyFDjhMwuFDYYbhWXXT+vmc4WQ0KGltRUR8YPWLxcqdzYDJoCPPaJvuwgSnNzNWuaWp7q7F8AXokzO948CP5yfEUHCmbwkZPp5q30UOAcKre4cAQeBr5HJR9uNSrQvOrlrZGJNzG99Glp156bkncjcO9uU6ElCpsB5EBn0gjuuAdNDK3BCBgWcsqkdMzLBVVoxJDiSb+as7gDmh17gON+cMVcojAQ38ou7Knc5SDjmfLTZJwn7uvTzmjnkbmXHS1s3VRsFkDDRRz8v/NaDQuVuABKe90nCokut++rn7Won17lDPUeeng1e14FnA/TzdreZ6UcgJwnZZCqNJG1j5Pp5Jo9JnyS0Iqa97+ddGsl+3oAkMBb9vCGRMJx+3g6TsDUg+Kel2sbShYRWRKDrJHev+unnjQoJQSZXcqzY+gJnHThZ9rW7JLOI0YuE4vt5I7SMFbOS0zSSFkq9fBXR3Pyd0f8U+GXv75d6+SrHai4dip+XFvTq47hx0QfGG8BnB3wTuAtM+jacjONu8bC6BBwSkdPyd//eB1X9kl19kr20e3snFlhH6v8CBjboO3tm735llVVWWWWVjb79AVFUcsSCjjxVAAAAAElFTkSuQmCC" },
            { "star", "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAE00lEQVR42u2az2scZRjHv+/skiK6jSjFbjx4iq3NQdpDgz0oWEogHgxVQ7FCaaj3/gEWF/wDCt4b8KJ/QC4VQZAW9KAFT6beBJtSKdImKITszMdDnxffDrPZme3szGZ3H1hmmEze53ne5/v8fEeqkQAHOE1pwshbHZgFXg2fVU1RTXvg+a5I+szuG5OEgMiu3wEPgEMTEw8C+B8FHvGElu1ZYxJcwCv5iaRZSUhanUT4/8T/dB94oc5gWLXyC8AukAB7tgkX7W/NcXYBz++ypBlJsSRv8Yt2TcY6AAJNYNOsHhsKAB4D7ardIKpQeR/83pY0b5aODAGxpMOSzlVdE1TqAs45JF0yvllQv2RxIhnX3H8E+Mtgn/A0+YD4ehgwxwUBHtLvSTpiFk77eSypKen9KmWragM8pD+0wifTQ+z6wVhlgyD3zwP/9oB/6Aa7wEJVbhBV3Pk9l8r9ynCDGasT6uxWy0WA/Xzp26U3xXbdBGYOfFnscz+waMrF9Cf/3ukqOsRmRrrKC7s81mkCSPrI1u3mWD8xuT4FfrY18vAib0C2eiS3EmXUAPckHc3JE3vngaR2KOzQEAA45xzAYUnvSPrHAlIjY2edPXtT0ouBwFkISSS9Jqm9z3vqsf4rkm4Afxhq2GezHkn6Nfjf9Hpel+cl/eCc2/Y6N1PpKjbFvhhGJTzAu5dLluGapO9NV3oKBbwlaV3ScUm7hhTXo7jJo8yggSwu4NtRBjq6kg5J2pS05pz7sa9VgKZzrgu8JOlrSUuBsgclL4fyfivpY+fc3163Iq2rgE6QorqMPoUydrJ0KjK88GXsErBli+6NsPJeti1gKSjE3LOkMZ8p2sDNjEnOKFASFFk3g8lSOfPFlEtcHzGXCGW4PjDk89b0dr8KPBwBl/C8HwKraTmHVdk1g/b2dk0uEUL+NjBf6Ug92IRmDS7xFORDWepoc/2sbw3YTrW0wyC/9jawls5Wtc357f4UcGeIm+DXvAOcChBY/8wg2IQWsGE+2i0Z9omt3SoT8lFJ8/6ulZk7Vl4PwyruCSu3k7ukLblD29cVrJ2es8ajVaD9Vc5hh5O0I+m4c27L8xyVoagvOs6Z8nHJKPA9favs47OoRAtJ0rsFx1O183Alwn9W0m8Fpz+DuMF9SW845x6X4QZRiSg6aconQwyCifE4WZb8UYkoWh7gSCu2qQ0FBx3LZSG4jFwaWzFytoBQ2K+RUi7KudlnjWdcKwKAyHzwmKSFDKWyqGuKRJK+ktQxRaIcaPBT6gVJxyz2RKNQAV7N0RqH1eE94EKwzmLqq7E4Rwt8tZYmqMfJ70afbjDcmG+sYBLQSHWWnwfv7vXpBjeq/JBiv68+5oJOMClg9WaPidMi8EvqnDC9pu8I52r7tjA4+FzpYf39rO76dJYt4Msea4W8Vur6xDbcgPWUkLmsnnP+uATczUCD57Ve5wY4O8MPBSxk9ZxzhtkMNPiNuFvLdwSB9c+YMN1nsXoBNPweuEDXeJ+pHAWBdTop3x/Y6jnR8LLxCGNBp/J0GKS/WybIn2VZPScaLhhPgFuVpsNA+ROB1dtlWr0PGhrBSZVHw4nKNiEQ4DxwZZhW7+eCdn8FOF9nHIjqKERSh7f1lMO15N8RlGFKU5rSlKZ0UOk/Xz+dVnb1HhEAAAAASUVORK5CYII=" },
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

        private Dictionary<string, HashSet<int>> _favorites = new Dictionary<string, HashSet<int>>();

        private void LoadFavorites()
        {
            try
            {
                if (!Interface.Oxide.DataFileSystem.ExistsDatafile(FavoritesFile)) return;

                Dictionary<string, List<int>> data =
                    Interface.Oxide.DataFileSystem.ReadObject<Dictionary<string, List<int>>>(FavoritesFile);
                if (data == null) return;

                foreach (KeyValuePair<string, List<int>> pair in data)
                {
                    if (!IsSteamId(pair.Key) || pair.Value == null) continue;
                    _favorites[pair.Key] = new HashSet<int>(pair.Value);
                }
            }
            catch (Exception cause)
            {
                PrintWarning("As favoritas não abriram (" + cause.Message + "): começando vazio.");
                _favorites = new Dictionary<string, HashSet<int>>();
            }
        }

        private void SaveFavorites()
        {
            Dictionary<string, List<int>> data = new Dictionary<string, List<int>>();

            foreach (KeyValuePair<string, HashSet<int>> pair in _favorites)
            {
                List<int> ids = new List<int>();
                foreach (int id in pair.Value)
                {
                    // Enquanto o catálogo não chegou, não se sabe o que saiu dele.
                    if (_catalog.ById.Count == 0 || _catalog.ById.ContainsKey(id)) ids.Add(id);
                }

                if (ids.Count > 0) data[pair.Key] = ids;
            }

            try
            {
                Interface.Oxide.DataFileSystem.WriteObject(FavoritesFile, data);
            }
            catch (Exception cause)
            {
                PrintWarning("Não consegui gravar as favoritas: " + cause.Message);
            }
        }

        private void LoadOwned()
        {
            try
            {
                if (!Interface.Oxide.DataFileSystem.ExistsDatafile(OwnedFile)) return;

                OwnedFileData data = Interface.Oxide.DataFileSystem.ReadObject<OwnedFileData>(OwnedFile);
                if (data == null || data.Players == null) return;

                foreach (KeyValuePair<string, OwnedFileEntry> pair in data.Players)
                {
                    if (!IsSteamId(pair.Key) || pair.Value == null) continue;

                    OwnedRecord record = new OwnedRecord { LastSeen = pair.Value.LastSeen };

                    if (pair.Value.Skins != null)
                    {
                        foreach (OwnedFileSkin skin in pair.Value.Skins)
                        {
                            if (skin != null && skin.Id > 0) record.Skins[skin.Id] = Math.Max(0L, skin.ExpiresAt);
                        }
                    }

                    _owned[pair.Key] = record;
                }

                Puts("Posse carregada do disco (" + _owned.Count + " jogadores).");
            }
            catch (Exception cause)
            {
                PrintWarning("A cópia da posse em disco não abriu (" + cause.Message + "): cada " +
                             "jogador fica em \"sincronizando\" até o agente mandar a posse dele.");
            }
        }

        // ============================================================
        //  §6  status e reply
        // ============================================================

        [ConsoleCommand(StatusCommand)]
        private void CmdStatus(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["skins"] = _catalog.ById.Count,
                ["categories"] = _catalog.Categories.Count,
                ["ownedPlayers"] = _owned.Count,
                ["streamers"] = _streamers.Count,
                ["openMenus"] = _menus.Count,
                ["inventoryButton"] = _config.InventoryButton,
            };

            arg.ReplyWith(reply.ToString(Formatting.None));
        }

        /// <summary>A resposta do agente a um `/skin add` ou `/skin give`.</summary>
        [ConsoleCommand(ReplyCommand)]
        private void CmdReply(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            JObject body = arg.HasArgs(1) ? DecodePayload(arg.GetString(0)) : null;
            if (body == null)
            {
                arg.ReplyWith(Fail("INVALID_ARGS", "Use: " + ReplyCommand + " <base64>"));
                return;
            }

            string requestId = Text(body, "requestId");
            bool ok = Flag(body, "ok", false);
            string message = Text(body, "message");

            // Quem PEDIU é quem ouve a resposta: no `give`, o admin. Sem o
            // pedido pendente (venceu o prazo ou o plugin recarregou) não há
            // como saber quem perguntou: o `steamId` do corpo, no `give`, é o
            // do ALVO, e a frase iria para a pessoa errada. Fica só no log.
            PendingRequest pending;
            if (string.IsNullOrEmpty(requestId) || !_pendingRequests.TryGetValue(requestId, out pending))
            {
                PrintWarning("Resposta sem pedido pendente (" + (string.IsNullOrEmpty(requestId) ? "sem id" : requestId) + "): " + message);
                arg.ReplyWith("{\"ok\":true}");
                return;
            }

            _pendingRequests.Remove(requestId);
            if (pending.Timeout != null) pending.Timeout.Destroy();

            BasePlayer player = FindOnline(pending.SteamId);
            if (player != null)
            {
                Tell(player, (ok ? "<color=#9fd67a>" : "<color=#e0776b>") + Escape(message) + "</color>");
            }

            arg.ReplyWith("{\"ok\":true}");
        }

        // ============================================================
        //  §7  A REGRA DE ACESSO (02 §3)
        // ============================================================

        private enum Access
        {
            /// <summary>Posse viva.</summary>
            Owned,
            /// <summary>Skin da casa.</summary>
            Free,
            /// <summary>`origemzworkshop.admin`.</summary>
            Admin,
            /// <summary>"Não sei": a posse deste jogador ainda não chegou.</summary>
            Syncing,
            Locked,
        }

        /// <summary>Quem está olhando, resolvido uma vez por desenho.</summary>
        private class Viewer
        {
            public string SteamId = "";
            public bool Admin;
            /// <summary>`null` = "não sei".</summary>
            public OwnedRecord Owned;
            public long Now;
            public bool OnAir;
            /// <summary>Nunca nulo.</summary>
            public HashSet<int> Favorites;
        }

        private static readonly HashSet<int> NoFavorites = new HashSet<int>();

        private HashSet<int> FavoritesOf(string steamId)
        {
            HashSet<int> set;
            return _favorites.TryGetValue(steamId, out set) ? set : NoFavorites;
        }

        private Viewer ViewerOf(BasePlayer player)
        {
            string steamId = player.UserIDString;

            OwnedRecord owned;
            _owned.TryGetValue(steamId, out owned);

            return new Viewer
            {
                SteamId = steamId,
                // O mesmo critério do /skin add e do /skin give: admin nativo
                // do servidor ou a permissão. Dois critérios confundiam o teste.
                Admin = IsAdmin(player),
                Owned = owned,
                Favorites = FavoritesOf(steamId),
                Now = NowMs(),
                OnAir = _streamers.Contains(steamId),
            };
        }

        /// <summary>
        /// A regra, com a explicação. `expiresAt` só vale para `Owned`
        /// (0 = permanente).
        ///
        /// O prazo é conferido aqui, na hora: o agente reenvia a posse
        /// quando uma vence, mas o jogador não pode ganhar uma janela se o
        /// RCON estiver caído nesse instante.
        /// </summary>
        private static Access AccessOf(Viewer viewer, SkinEntry entry, out long expiresAt)
        {
            expiresAt = 0;

            if (viewer.Owned != null)
            {
                long expiry;
                if (viewer.Owned.Skins.TryGetValue(entry.Id, out expiry) && (expiry == 0 || expiry > viewer.Now))
                {
                    expiresAt = expiry;
                    return Access.Owned;
                }
            }

            if (entry.OpenToAll) return Access.Free;
            if (viewer.Admin) return Access.Admin;

            return viewer.Owned == null ? Access.Syncing : Access.Locked;
        }

        private static bool IsUsable(Access access)
        {
            return access == Access.Owned || access == Access.Free || access == Access.Admin;
        }

        /// <summary>
        /// O jogador TEM a skin: posse viva ou skin da casa. Diferente de
        /// `CanUse`, que também é verdade para o admin. É o que conta nas
        /// telas ("obtidas", "só as minhas", o cadeado): o admin vê o mesmo
        /// que um jogador veria, e continua podendo aplicar tudo.
        /// </summary>
        private static bool Obtained(Viewer viewer, SkinEntry entry)
        {
            long ignored;
            Access access = AccessOf(viewer, entry, out ignored);
            return access == Access.Owned || access == Access.Free;
        }

        private static bool CanUse(Viewer viewer, SkinEntry entry)
        {
            long ignored;
            return IsUsable(AccessOf(viewer, entry, out ignored));
        }

        // ============================================================
        //  §8  APLICAR (02 §6)
        // ============================================================

        /// <summary>
        /// O padrão da vanilla para trocar a skin de um item que JÁ existe
        /// — `RepairBench.ApplySkinToItem`, MEDIDO em 16 e 17/09/2026.
        ///
        /// As quatro linhas importam: sem `MarkDirty` o cliente nunca vê;
        /// sem o `heldEntity` o ÍCONE muda e o modelo na mão fica o antigo
        /// (`HeldEntity.OnItemChanged` não toca em skin).
        ///
        /// ####  ROUPA VESTIDA: A MEDIÇÃO 0.3 ESTÁ PENDENTE  ####
        ///
        /// Não se sabe se o `MarkDirty` basta para OUTROS jogadores verem a
        /// roupa nova (02 §6.3). Até a fase 0 medir, o item em
        /// `containerWear` (roupa e mochila vestidas) também dispara o
        /// `SendNetworkUpdate` do jogador: é barato e cobre o caso. Se a
        /// medição mostrar que é desnecessário, sai; se mostrar que não
        /// basta, é aqui que se mexe.
        /// </summary>
        private void ApplySkinToItem(Item item, ulong skin)
        {
            if (item == null || item.skin == skin) return;

            item.skin = skin;
            item.MarkDirty();

            BaseEntity held = item.GetHeldEntity();
            if (held != null)
            {
                held.skinID = skin;
                held.SendNetworkUpdate();
            }

            BasePlayer owner = item.GetOwnerPlayer();
            if (owner != null && owner.inventory != null && item.parent == owner.inventory.containerWear)
            {
                owner.SendNetworkUpdate();
            }
        }

        /// <summary>
        /// A skin que o item "tem" do ponto de vista do jogador: com o modo
        /// streamer ligado, um item nosso fica com skin 0 e a escolha dele
        /// mora no `_strippedByPlayer`.
        /// </summary>
        private ulong EffectiveSkin(string steamId, Item item)
        {
            if (item.skin == 0uL)
            {
                Dictionary<ulong, ulong> stripped;
                ulong chosen;
                if (_strippedByPlayer.TryGetValue(steamId, out stripped) &&
                    stripped.TryGetValue(item.uid.Value, out chosen))
                {
                    return chosen;
                }
            }

            return item.skin;
        }

        /// <summary>Uma instância do item no inventário do jogador, e onde ela está.</summary>
        private class Instance
        {
            public Item Item;
            public string Where = "";
        }

        /// <summary>
        /// As instâncias daquele item que o jogador tem, na ordem do 03
        /// §3.6: mão, barra, roupa, principal, e dentro da mochila VESTIDA.
        ///
        /// É também a conferência de posse do item (02 §6.2, item 2): o
        /// que não está nesta lista não é dele — nunca vale uma caixa do
        /// mundo, nem uma mochila guardada no inventário.
        /// </summary>
        private List<Instance> CollectInstances(BasePlayer player, string shortname)
        {
            List<Instance> result = new List<Instance>();
            if (player == null || player.inventory == null || string.IsNullOrEmpty(shortname)) return result;

            PlayerInventory inventory = player.inventory;
            Item active = player.GetActiveItem();

            if (active != null && active.info != null && active.info.shortname == shortname &&
                active.parent == inventory.containerBelt)
            {
                result.Add(new Instance { Item = active, Where = "Na mão" });
            }

            AddInstances(result, inventory.containerBelt, shortname, active, "Barra");
            AddInstances(result, inventory.containerWear, shortname, null, "Roupa");
            AddInstances(result, inventory.containerMain, shortname, null, "Inventário");

            if (inventory.containerWear != null && inventory.containerWear.itemList != null)
            {
                foreach (Item worn in inventory.containerWear.itemList)
                {
                    if (worn == null || worn.contents == null) continue;

                    AddInstances(result, worn.contents, shortname, null, "Mochila");
                }
            }

            return result;
        }

        private static void AddInstances(List<Instance> result, ItemContainer container, string shortname,
                                         Item skip, string where)
        {
            if (container == null || container.itemList == null) return;

            List<Item> sorted = new List<Item>(container.itemList);
            sorted.Sort((a, b) => a.position.CompareTo(b.position));

            foreach (Item item in sorted)
            {
                if (item == null || item == skip || item.info == null || item.info.shortname != shortname) continue;

                string label = where == "Barra" ? "Barra " + (item.position + 1) : where;
                result.Add(new Instance { Item = item, Where = label });
            }
        }

        /// <summary>
        /// Aplica a escolha da sessão, com as conferências do 02 §6.2, na
        /// ordem. Devolve a mensagem para a tela; `ok` diz a cor dela.
        /// </summary>
        private string TryApply(BasePlayer player, MenuSession session, out bool ok)
        {
            ok = false;

            // 1. vivo, acordado e não ferido
            if (player.IsDead() || player.IsSleeping() || player.IsWounded() || player.inventory == null)
            {
                return "Você não pode aplicar skin agora.";
            }

            if (!session.HasPick)
            {
                return "Escolha uma skin na grade.";
            }

            SkinEntry entry = null;
            string shortname = session.Shortname;
            ulong skin = 0uL;

            if (session.PickId > 0)
            {
                if (!_catalog.ById.TryGetValue(session.PickId, out entry))
                {
                    return "Essa skin não está mais neste servidor.";
                }

                shortname = entry.Shortname;
                skin = entry.SkinId;
            }

            // 2. o item existe e é dele
            Instance target = null;
            foreach (Instance instance in CollectInstances(player, shortname))
            {
                if (instance.Item.uid.Value == session.TargetUid)
                {
                    target = instance;
                    break;
                }
            }

            if (target == null)
            {
                session.TargetUid = 0;
                return "Esse item não está mais com você.";
            }

            Item item = target.Item;

            // 3. o item é o da skin
            if (item.info.shortname != shortname)
            {
                return "Essa skin não é deste item.";
            }

            // 4. a skin está no catálogo e o jogador pode usá-la (a 0 sempre passa)
            Viewer viewer = ViewerOf(player);
            if (entry != null)
            {
                long ignored;
                Access access = AccessOf(viewer, entry, out ignored);
                if (!IsUsable(access))
                {
                    return access == Access.Syncing
                        ? "Suas skins ainda estão carregando. Tente em instantes."
                        : "Você ainda não tem esta skin.";
                }
            }

            // 5. não é item de redirect
            if (item.info.isRedirectOf != null)
            {
                return "Este item é uma variante especial e não aceita skin.";
            }

            // 6. já está com essa skin
            if (EffectiveSkin(viewer.SteamId, item) == skin)
            {
                return "Já aplicada.";
            }

            // 7. trava de frequência
            float now = Time.realtimeSinceStartup;
            // Por jogador, e não por sessão: fechar e reabrir o menu criava
            // uma sessão nova com o relógio zerado e furava a trava.
            float next;
            if (_nextApply.TryGetValue(player.userID, out next) && now < next)
            {
                return "Calma: uma aplicação a cada meio segundo.";
            }

            _nextApply[player.userID] = now + ApplyCooldownSeconds;

            // ####  MODO STREAMER: A ESCOLHA É GUARDADA, NÃO VESTIDA  ####
            //
            // 02 §6.3, decidido pela frente D: com o /streamer ligado, uma
            // skin marcada para sumir não vai para o item. Ela entra no
            // MESMO `_strippedByPlayer` que o `HideFrom` usa, e o item fica
            // com skin 0; o `RestoreTo` a veste quando ele sair do ar. Sem
            // segundo mecanismo. Qualquer outra escolha feita no ar tira o
            // item dessa lista, para a saída do ar não desfazê-la.
            Dictionary<ulong, ulong> stripped;
            _strippedByPlayer.TryGetValue(viewer.SteamId, out stripped);

            if (viewer.OnAir && entry != null && entry.HideInStreamer)
            {
                if (stripped == null)
                {
                    stripped = new Dictionary<ulong, ulong>();
                    _strippedByPlayer[viewer.SteamId] = stripped;
                }

                stripped[item.uid.Value] = skin;
                ApplySkinToItem(item, 0uL);

                ok = true;
                return "Skin guardada: ela aparece quando você desligar o modo streamer.";
            }

            if (stripped != null)
            {
                stripped.Remove(item.uid.Value);
            }

            ApplySkinToItem(item, skin);

            ok = true;
            return "Skin aplicada.";
        }

        // ============================================================
        //  §9  O MODO STREAMER, AO VIVO
        // ============================================================

        /// <summary>
        /// Troca a lista de quem está no ar e age sobre QUEM MUDOU.
        ///
        /// AUSENTE NÃO É VAZIO: `streamers` fora da carga quer dizer "o
        /// agente não me disse", e a lista fica como está.
        /// </summary>
        private void ApplyStreamerList(JObject payload)
        {
            JArray list = payload["streamers"] as JArray;
            if (list == null) return;

            HashSet<string> next = new HashSet<string>();
            foreach (JToken token in list)
            {
                string id = token == null ? "" : token.ToString();
                if (id.Length > 0) next.Add(id);
            }

            List<string> turnedOn = new List<string>();
            List<string> turnedOff = new List<string>();

            foreach (string id in next)
            {
                if (!_streamers.Contains(id)) turnedOn.Add(id);
            }

            foreach (string id in _streamers)
            {
                if (!next.Contains(id)) turnedOff.Add(id);
            }

            _streamers.Clear();
            _streamers.UnionWith(next);

            foreach (string id in turnedOn) HideFrom(id);
            foreach (string id in turnedOff) RestoreTo(id);
        }

        /// <summary>
        /// Entrou no ar: tirar dos itens dele o que é NOSSO e está marcado
        /// para sumir. O que é nosso é reconhecido pelo `BySkinId` — uma
        /// skin que ele comprou na Steam nunca é tocada.
        /// </summary>
        private void HideFrom(string steamId)
        {
            BasePlayer player = FindPlayer(steamId);
            if (player == null || player.inventory == null) return;

            Dictionary<ulong, ulong> stripped;
            if (!_strippedByPlayer.TryGetValue(steamId, out stripped))
            {
                stripped = new Dictionary<ulong, ulong>();
                _strippedByPlayer[steamId] = stripped;
            }

            _scratch.Clear();
            player.inventory.GetAllItems(_scratch);

            foreach (Item item in _scratch)
            {
                if (item == null || item.skin == 0uL) continue;

                SkinEntry entry;
                if (!_catalog.BySkinId.TryGetValue(item.skin, out entry) || !entry.HideInStreamer) continue;

                stripped[item.uid.Value] = item.skin;
                ApplySkinToItem(item, 0uL);
            }

            _scratch.Clear();
        }

        /// <summary>
        /// Saiu do ar: vestir de volta SÓ o que nós tiramos (ou o que ele
        /// escolheu no ar), com o número que cada item tinha. Item que
        /// trocou de dono ou virou pilha com outro some da lista sem drama.
        /// </summary>
        private void RestoreTo(string steamId)
        {
            Dictionary<ulong, ulong> stripped;
            if (!_strippedByPlayer.TryGetValue(steamId, out stripped)) return;

            _strippedByPlayer.Remove(steamId);

            BasePlayer player = FindPlayer(steamId);
            if (player == null || player.inventory == null) return;

            _scratch.Clear();
            player.inventory.GetAllItems(_scratch);

            foreach (Item item in _scratch)
            {
                if (item == null || item.skin != 0uL) continue;

                ulong skin;
                if (!stripped.TryGetValue(item.uid.Value, out skin)) continue;

                // A skin ainda precisa existir no catálogo: devolver uma que
                // o painel apagou seria o plugin passando por cima.
                if (!_catalog.BySkinId.ContainsKey(skin)) continue;

                ApplySkinToItem(item, skin);
            }

            _scratch.Clear();
        }

        // ============================================================
        //  §10  OS COMANDOS DE CHAT (02 §7)
        // ============================================================

        [ChatCommand("skins")]
        private void CmdSkinsChat(BasePlayer player, string command, string[] args)
        {
            if (player == null) return;

            ToggleMenu(player);
        }

        [ChatCommand("skin")]
        private void CmdSkinChat(BasePlayer player, string command, string[] args)
        {
            if (player == null) return;

            if (args == null || args.Length == 0)
            {
                ToggleMenu(player);
                return;
            }

            string verb = args[0].Trim().ToLowerInvariant();

            if (verb == "add" || verb == "adicionar")
            {
                AddFromGame(player, args);
                return;
            }

            if (verb == "give" || verb == "dar")
            {
                GiveFromGame(player, args);
                return;
            }

            if (verb == "ajuda" || verb == "help")
            {
                ShowHelp(player);
                return;
            }

            // Qualquer outra palavra: o menu, já pesquisando (02 §7).
            string query = string.Join(" ", args).Trim().Trim('"');
            OpenMenu(player, query);
        }

        private void ShowHelp(BasePlayer player)
        {
            StringBuilder text = new StringBuilder();
            text.Append("<color=#C43F2C>Skins</color>\n");
            text.Append("/skins ou /skin — abre o menu de skins (com o item da mão já escolhido).\n");
            text.Append("/skin <nome> — abre o menu pesquisando esse nome.\n");
            text.Append("No menu: escolha a categoria, o item e a skin; embaixo, em qual dos seus " +
                        "itens aplicar.\n");
            text.Append("Skins podem ser obtidas em eventos e no nosso site.");

            if (IsAdmin(player))
            {
                text.Append("\n<color=#E6B265>Admin</color>:\n");
                text.Append("/skin add \"shortname\" \"workshop_id\" — cadastra a skin neste servidor.\n");
                text.Append("/skin give <steamId|nome> \"shortname\" \"workshop_id\" [dias] — dá a skin " +
                            "a um jogador (sem dias = permanente).");
            }

            Tell(player, text.ToString());
        }

        // ---- /skin add e /skin give --------------------------------

        private class PendingRequest
        {
            /// <summary>Quem pediu, e quem ouve a resposta.</summary>
            public string SteamId = "";
            public Timer Timeout;
        }

        private readonly Dictionary<string, PendingRequest> _pendingRequests =
            new Dictionary<string, PendingRequest>();

        /// <summary>Quando cada jogador pode aplicar de novo (02 §6.2, item 7).</summary>
        private readonly Dictionary<ulong, float> _nextApply = new Dictionary<ulong, float>();

        private bool IsAdmin(BasePlayer player)
        {
            return player.IsAdmin || permission.UserHasPermission(player.UserIDString, AdminPermission);
        }

        /// <summary>
        /// Confere o par item + workshop id com o que o jogo sabe. Devolve a
        /// definição, ou `null` depois de já ter explicado ao admin.
        /// </summary>
        private ItemDefinition CheckItemAndId(BasePlayer player, string shortname, string rawId, out ulong skinId)
        {
            skinId = 0uL;

            ItemDefinition def = ItemManager.FindItemDefinition(shortname);
            if (def == null)
            {
                Tell(player, "O item \"" + Escape(shortname) + "\" não existe. Use o shortname do jogo " +
                             "(ex.: metal.facemask, rifle.ak).");
                return null;
            }

            if (def.isRedirectOf != null)
            {
                Tell(player, "\"" + shortname + "\" é uma variante de \"" + def.isRedirectOf.shortname +
                             "\". Use o item original.");
                return null;
            }

            if (_skinnable != null && !_skinnable.Contains(shortname))
            {
                Tell(player, "\"" + shortname + "\" não aceita skin do Workshop.");
                return null;
            }

            if (!ulong.TryParse(rawId, NumberStyles.None, CultureInfo.InvariantCulture, out skinId) ||
                skinId == 0uL || rawId.StartsWith("0"))
            {
                Tell(player, "\"" + Escape(rawId) + "\" não é um Workshop ID. É o número no fim da URL " +
                             "da oficina: ...filedetails/?id=<número>.");
                return null;
            }

            if (RejectsInventoryId(skinId))
            {
                Tell(player, rawId + " é um item do inventário Steam, e não um Workshop ID.");
                return null;
            }

            return def;
        }

        private SkinEntry FindCatalogSkin(string shortname, ulong skinId)
        {
            List<SkinEntry> sameItem;
            if (_catalog.ByShortname.TryGetValue(shortname, out sameItem))
            {
                foreach (SkinEntry existing in sameItem)
                {
                    if (existing.SkinId == skinId) return existing;
                }
            }

            return null;
        }

        /// <summary>
        /// `/skin add "shortname" "workshop_id"`, como na v0.2.0 (01 §2).
        ///
        /// Confere aqui tudo o que o jogo sabe e manda o resto ao agente,
        /// que confere a Steam e grava no MESMO banco do painel. Este
        /// plugin nunca grava a skin sozinho.
        /// </summary>
        private void AddFromGame(BasePlayer player, string[] args)
        {
            if (!IsAdmin(player))
            {
                Tell(player, "Você não tem permissão para cadastrar skins.");
                return;
            }

            if (args.Length != 3)
            {
                Tell(player, "Uso: /skin add \"shortname_do_item\" \"workshop_id\"\n" +
                             "Exemplo: /skin add \"metal.facemask\" \"3802433262\"");
                return;
            }

            string shortname = args[1].Trim().Trim('"').ToLowerInvariant();
            string rawId = args[2].Trim().Trim('"');

            ulong skinId;
            ItemDefinition def = CheckItemAndId(player, shortname, rawId, out skinId);
            if (def == null) return;

            SkinEntry existing = FindCatalogSkin(shortname, skinId);
            if (existing != null)
            {
                Tell(player, "Essa skin já está cadastrada: \"" + Escape(existing.Label) +
                             "\" (#" + existing.Id + ").");
                return;
            }

            if (string.IsNullOrEmpty(_secret))
            {
                Tell(player, "O agente ainda não conectou neste servidor. Tente de novo em instantes.");
                return;
            }

            JObject data = new JObject
            {
                ["steamId"] = player.UserIDString,
                ["playerName"] = player.displayName ?? "",
                ["shortname"] = shortname,
                ["skinId"] = skinId.ToString(CultureInfo.InvariantCulture),
            };

            SendRequest(player, "add", data, "o cadastro de " + shortname + " " + rawId);

            Tell(player, "Cadastrando " + Escape(def.displayName.english) + " / " + rawId +
                         "… conferindo o Workshop ID na Steam.");
        }

        /// <summary>
        /// `/skin give <steamId|nome> "shortname" "workshop_id" [dias]` (02 §7).
        ///
        /// Quem grava é o agente, pelo MESMO `grantOwnership` do painel e
        /// do site: duas implementações da regra de renovação divergiriam
        /// no primeiro bug (02 §4.2).
        ///
        /// Decisão da frente D: a skin precisa estar no catálogo DESTE
        /// servidor. Dar uma skin que o jogador não consegue ver aqui é
        /// quase sempre engano de digitação; o painel continua cobrindo o
        /// caso de rede.
        /// </summary>
        private void GiveFromGame(BasePlayer player, string[] args)
        {
            if (!IsAdmin(player))
            {
                Tell(player, "Você não tem permissão para dar skins.");
                return;
            }

            if (args.Length != 4 && args.Length != 5)
            {
                Tell(player, "Uso: /skin give <steamId|nome> \"shortname\" \"workshop_id\" [dias]\n" +
                             "Exemplo: /skin give Fulano \"rifle.ak\" \"3802433262\" 30");
                return;
            }

            string who = args[1].Trim().Trim('"');
            string shortname = args[2].Trim().Trim('"').ToLowerInvariant();
            string rawId = args[3].Trim().Trim('"');

            int? days = null;
            if (args.Length == 5)
            {
                string rawDays = args[4].Trim().Trim('"').ToLowerInvariant();
                int parsed;

                if (rawDays == "perm" || rawDays == "permanente" || rawDays == "0")
                {
                    days = null;
                }
                else if (int.TryParse(rawDays, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) &&
                         parsed >= 1 && parsed <= 3650)
                {
                    days = parsed;
                }
                else
                {
                    Tell(player, "\"" + Escape(rawDays) + "\" não é um prazo. Use um número de dias " +
                                 "(1 a 3650), ou deixe em branco para permanente.");
                    return;
                }
            }

            string targetId;
            string targetName;
            if (!ResolveTarget(player, who, out targetId, out targetName)) return;

            ulong skinId;
            if (CheckItemAndId(player, shortname, rawId, out skinId) == null) return;

            SkinEntry entry = FindCatalogSkin(shortname, skinId);
            if (entry == null)
            {
                Tell(player, "Essa skin não está no catálogo deste servidor. Cadastre antes com " +
                             "/skin add \"" + shortname + "\" \"" + rawId + "\".");
                return;
            }

            if (string.IsNullOrEmpty(_secret))
            {
                Tell(player, "O agente ainda não conectou neste servidor. Tente de novo em instantes.");
                return;
            }

            JObject data = new JObject
            {
                // steamId/playerName são do ADMIN (a resposta volta para ele);
                // quem recebe vai em targetSteamId. É o schema do agente
                // (workshopGiveRequestSchema, core/src/types/workshop.ts).
                ["steamId"] = player.UserIDString,
                ["playerName"] = player.displayName ?? "",
                ["targetSteamId"] = targetId,
                ["targetName"] = targetName ?? "",
                ["shortname"] = shortname,
                ["skinId"] = skinId.ToString(CultureInfo.InvariantCulture),
                ["days"] = days.HasValue ? new JValue(days.Value) : JValue.CreateNull(),
            };

            SendRequest(player, "give", data, "a entrega de " + entry.Label + " para " + targetName);

            Tell(player, "Dando \"" + Escape(entry.Label) + "\" a " + Escape(targetName) +
                         (days.HasValue ? " por " + days.Value + " dia(s)" : " (permanente)") + "…");
        }

        /// <summary>
        /// SteamID64 direto (mesmo offline), ou um nome entre os online e
        /// os dormindo. Nome exato vence; senão, "contém", e só se for um.
        /// </summary>
        private bool ResolveTarget(BasePlayer admin, string who, out string steamId, out string name)
        {
            steamId = "";
            name = "";

            if (IsSteamId(who))
            {
                steamId = who;
                BasePlayer known = FindPlayer(who);
                name = known != null ? known.displayName : who;
                return true;
            }

            if (who.Length < 2)
            {
                Tell(admin, "Diga o SteamID64 ou pelo menos 2 letras do nome.");
                return false;
            }

            List<BasePlayer> exact = new List<BasePlayer>();
            List<BasePlayer> partial = new List<BasePlayer>();
            HashSet<ulong> seen = new HashSet<ulong>();

            CollectByName(BasePlayer.activePlayerList, who, exact, partial, seen);
            CollectByName(BasePlayer.sleepingPlayerList, who, exact, partial, seen);

            List<BasePlayer> matches = exact.Count > 0 ? exact : partial;

            if (matches.Count == 0)
            {
                Tell(admin, "Nenhum jogador online ou dormindo com o nome \"" + Escape(who) + "\". " +
                            "Use o SteamID64.");
                return false;
            }

            if (matches.Count > 1)
            {
                List<string> names = new List<string>();
                for (int i = 0; i < matches.Count && i < 5; i++)
                {
                    names.Add(Escape(matches[i].displayName) + " (" + matches[i].UserIDString + ")");
                }

                Tell(admin, "Mais de um jogador casa com \"" + Escape(who) + "\": " +
                            string.Join(", ", names.ToArray()) + ". Use o SteamID64.");
                return false;
            }

            steamId = matches[0].UserIDString;
            name = matches[0].displayName;
            return true;
        }

        private static void CollectByName(IEnumerable<BasePlayer> source, string query, List<BasePlayer> exact,
                                          List<BasePlayer> partial, HashSet<ulong> seen)
        {
            if (source == null) return;

            foreach (BasePlayer candidate in source)
            {
                if (candidate == null || string.IsNullOrEmpty(candidate.displayName)) continue;
                if (!seen.Add(candidate.userID)) continue;

                if (string.Equals(candidate.displayName, query, StringComparison.OrdinalIgnoreCase))
                {
                    exact.Add(candidate);
                }
                else if (candidate.displayName.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    partial.Add(candidate);
                }
            }
        }

        /// <summary>Manda um pedido ao agente e espera a resposta por 20 s.</summary>
        private void SendRequest(BasePlayer player, string kind, JObject data, string what)
        {
            string requestId = Guid.NewGuid().ToString("N").Substring(0, 16);
            string steamId = player.UserIDString;

            PendingRequest pending = new PendingRequest { SteamId = steamId };
            pending.Timeout = timer.Once(RequestTimeoutSeconds, () =>
            {
                _pendingRequests.Remove(requestId);

                BasePlayer again = FindOnline(steamId);
                if (again != null)
                {
                    Tell(again, "<color=#e0776b>O agente não respondeu sobre " + Escape(what) +
                                ". Confira no painel antes de tentar de novo.</color>");
                }
            });

            _pendingRequests[requestId] = pending;

            data["requestId"] = requestId;
            Push(kind, data);
        }

        // ============================================================
        //  §11  O MENU  -  estado e ciclo de vida (03)
        //
        //  ####  O ESTADO MORA AQUI, E OS COMANDOS SÓ O MUDAM  ####
        //
        //  Cada jogador com o menu aberto tem uma `MenuSession`. Um
        //  comando da tela confere o token, muda o estado e pede o
        //  redesenho SÓ das regiões afetadas (03 §6). Nenhum argumento é
        //  confiável: tudo o que chega é validado contra o catálogo, a
        //  posse e o inventário vivo.
        //
        //  ####  AS REGIÕES  ####
        //
        //      OZSkins            véu (camada Overall, cursor)
        //      OZSkins.Win        a janela: moldura, título, rodapé, fechar
        //      OZSkins.Head       contador, "só as minhas", faixa do streamer
        //      OZSkins.Side       lateral em sanfona
        //      OZSkins.Grid       grade + paginação + pesquisa
        //      OZSkins.Detail     detalhe da skin
        //      OZSkins.Targets    "aplicar em" + botão
        //
        //  O 03 §6 fala em cinco regiões. A frente D separou a parte VIVA
        //  do cabeçalho (`Head`): o contador muda quando a posse chega, e
        //  redesenhar a janela inteira por causa dele custaria as seis.
        //
        //  Cada raiz de região leva `destroyUi` com o próprio nome: o
        //  cliente troca a velha pela nova no mesmo RPC, sem piscar.
        // ============================================================

        private const string UiRoot = "OZSkins";
        private const string UiWindow = "OZSkins.Win";
        private const string UiHead = "OZSkins.Head";
        private const string UiSide = "OZSkins.Side";
        private const string UiGrid = "OZSkins.Grid";
        private const string UiDetail = "OZSkins.Detail";
        private const string UiTargets = "OZSkins.Targets";
        private const string UiInventoryButton = "OZSkins.InvBtn";

        [Flags]
        private enum Region
        {
            None = 0,
            Window = 1,
            Head = 2,
            Side = 4,
            Grid = 8,
            Detail = 16,
            Targets = 32,
            AllButWindow = Head | Side | Grid | Detail | Targets,
            All = Window | AllButWindow,
        }

        private class MenuSession
        {
            public string Token = "";

            /// <summary>"" = TODAS.</summary>
            public string Category = "";
            public int SidePage;

            /// <summary>"" = nenhum item escolhido (a grade mistura itens).</summary>
            public string Shortname = "";
            public int GridPage;

            public bool HasPick;
            /// <summary>0 = Padrão (skin 0) do `Shortname`.</summary>
            public int PickId;

            /// <summary>`item.uid.Value` do alvo em "Aplicar em"; 0 = nenhum.</summary>
            public ulong TargetUid;
            public int TargetPage;

            public bool Mine;
            /// <summary>A grade ordenada por raridade (lendária primeiro) em vez da ordem do catálogo.</summary>
            public bool ByRarity;
            public string Search = "";

            public float NextCommand;
            public string Message = "";
            public bool MessageOk;
            public Timer FlashTimer;
        }

        private readonly Dictionary<ulong, MenuSession> _menus = new Dictionary<ulong, MenuSession>();

        private const int GridColumns = 4;
        private const int GridRows = 3;
        private const int GridPageSize = GridColumns * GridRows;
        private const int TargetsPageSize = 4;

        /// <summary>
        /// Quantas células a grade ROLÁVEL leva por página. Acima disto o
        /// paginador volta a aparecer: cada célula custa ~2,3 KB, e uma
        /// grade infinita num AddUI só não foi medida.
        /// </summary>
        private const int ScrollPageSize = 48;

        /// <summary>Quantos alvos o "Aplicar em" mostra de uma vez quando rola.</summary>
        private const int TargetsScrollMax = 40;
        private const string ScrollCommand = "origemz.skins.scroll";
        private const float CommandCooldownSeconds = 0.08f;
        private const int SearchMinLength = 2;
        private const int SearchMaxLength = 40;

        /// <summary>
        /// Hook público para o OrigemZUI (frente F): fecha o menu de skins
        /// quando o menu principal abre (03 §7, última linha).
        ///
        ///     Interface.CallHook("CloseSkinsMenu", player)
        ///     // ou: plugins.Find("OrigemZWorkshop")?.Call("CloseSkinsMenu", player)
        /// </summary>
        [HookMethod("CloseSkinsMenu")]
        public void CloseSkinsMenu(BasePlayer player)
        {
            CloseMenu(player, false);
        }

        /// <summary>Hook público: o menu de skins está aberto para este jogador?</summary>
        [HookMethod("IsSkinsMenuOpen")]
        public bool IsSkinsMenuOpen(BasePlayer player)
        {
            return player != null && _menus.ContainsKey(player.userID);
        }

        [PluginReference("OrigemZUI")]
        private Plugin _mainMenu;

        /// <summary>
        /// Fecha o menu principal antes de abrir este (03 §7).
        ///
        /// O OrigemZUI (v. de 17/09/2026) NÃO tem hook de fechar; ele tem o
        /// `origemz.ui.close <steamId>` de servidor, que destrói a raiz
        /// pelo nome e descarta a sessão — e é o que se usa aqui, sem
        /// mexer naquele plugin (é a frente F). Se um dia ele ganhar o hook
        /// `CloseMainMenu(BasePlayer)`, ele passa a valer primeiro.
        /// </summary>
        private void CloseMainMenu(BasePlayer player)
        {
            if (_mainMenu == null || !_mainMenu.IsLoaded) return;

            try
            {
                if (_mainMenu.Call("CloseMainMenu", player) != null) return;

                // Quiet: a resposta do comando não vai para o console.
                ConsoleSystem.Run(ConsoleSystem.Option.Server.Quiet(), MainMenuCloseCommand, player.UserIDString);
            }
            catch (Exception cause)
            {
                PrintWarning("Não consegui fechar o menu principal de " + player.UserIDString + ": " + cause.Message);
            }
        }

        /// <summary>O mesmo comando fecha (03 §3.1), como o `/menu` do OrigemZUI.</summary>
        private void ToggleMenu(BasePlayer player)
        {
            if (_menus.ContainsKey(player.userID))
            {
                CloseMenu(player, false);
                return;
            }

            OpenMenu(player, null);
        }

        /// <summary>
        /// Abre o menu (ou, se já aberto, aplica a pesquisa). `search` nulo
        /// = pré-seleção pelo item da mão (03 §4).
        /// </summary>
        private void OpenMenu(BasePlayer player, string search)
        {
            if (player == null || !player.IsConnected) return;

            if (player.IsDead() || player.IsWounded())
            {
                Tell(player, "Você não pode abrir o menu de skins agora.");
                return;
            }

            MenuSession session;
            if (_menus.TryGetValue(player.userID, out session))
            {
                if (search != null)
                {
                    SetSearch(session, search);
                    Redraw(player, session, Region.Side | Region.Grid | Region.Detail | Region.Targets);
                }

                return;
            }

            session = new MenuSession { Token = Guid.NewGuid().ToString("N").Substring(0, 16) };

            if (search != null)
            {
                SetSearch(session, search);
            }
            else
            {
                PreselectHeldItem(player, session);
            }

            _menus[player.userID] = session;

            CloseMainMenu(player);
            Redraw(player, session, Region.All);
        }

        /// <summary>
        /// O item "selecionado no inventário" o servidor não vê (03 §4): o
        /// que ele sabe é o item da MÃO. Se ele tem skin no catálogo, abre
        /// nele, com a skin atual escolhida e ele como alvo.
        /// </summary>
        private void PreselectHeldItem(BasePlayer player, MenuSession session)
        {
            Item held = player.GetActiveItem();
            if (held == null || held.info == null || !_catalog.ByShortname.ContainsKey(held.info.shortname)) return;

            SelectItem(player, session, held.info.shortname);
            session.TargetUid = held.uid.Value;
        }

        private void SelectItem(BasePlayer player, MenuSession session, string shortname)
        {
            List<SkinEntry> skins = _catalog.ByShortname[shortname];

            session.Category = skins[0].Category;
            session.Shortname = shortname;
            session.GridPage = 0;
            session.Search = "";
            session.TargetUid = 0;
            session.TargetPage = 0;

            // A lateral abre na página em que o item está.
            CategoryInfo info;
            if (_catalog.CategoryByKey.TryGetValue(session.Category, out info))
            {
                Viewer viewer = ViewerOf(player);
                List<string> visible = VisibleItems(viewer, session, info);
                int index = Math.Max(0, visible.IndexOf(shortname));
                int perPage = SideItemsPerPage(CountVisibleCategories(viewer, session));
                session.SidePage = index / perPage;
            }

            // A skin escolhida: a que o alvo provável já veste, ou Padrão.
            session.HasPick = true;
            session.PickId = 0;

            List<Instance> instances = CollectInstances(player, shortname);
            if (instances.Count > 0)
            {
                ulong current = EffectiveSkin(player.UserIDString, instances[0].Item);
                foreach (SkinEntry entry in skins)
                {
                    if (entry.SkinId == current)
                    {
                        session.PickId = entry.Id;
                        break;
                    }
                }
            }
        }

        private static void SetSearch(MenuSession session, string raw)
        {
            string text = (raw ?? "").Trim();
            if (text.Length > SearchMaxLength) text = text.Substring(0, SearchMaxLength);

            // Menos de 2 letras limpa o filtro (03 §3.4).
            session.Search = text.Length >= SearchMinLength ? text : "";
            session.Category = "";
            session.SidePage = 0;
            session.Shortname = "";
            session.GridPage = 0;

            // "Padrão" só existe com um item escolhido.
            if (session.HasPick && session.PickId == 0) session.HasPick = false;
        }

        /// <summary>
        /// Fecha e descarta a sessão. `quiet` = o jogador não precisa de
        /// explicação (morreu, caiu).
        /// </summary>
        private void CloseMenu(BasePlayer player, bool quiet)
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

        // ---- os comandos da tela (03 §5) ---------------------------

        /// <summary>
        /// Quem mandou, e se o token confere. Recusa em SILÊNCIO: o que
        /// chega aqui pode ser um comando digitado no F1.
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
            // Cada comando redesenha até ~36 KB. Um laço no F1 viraria
            // trabalho de servidor e banda à toa; um clique humano nunca
            // chega a isso.
            float now = Time.realtimeSinceStartup;
            if (now < session.NextCommand) return null;
            session.NextCommand = now + CommandCooldownSeconds;

            return session;
        }

        /// <summary>O botão SKINS do inventário: abre sem token (é a abertura que cria um).</summary>
        [ConsoleCommand(MenuOpenCommand)]
        private void CmdMenuOpen(ConsoleSystem.Arg arg)
        {
            if (arg.Connection == null) return;

            BasePlayer player = arg.Player();
            if (player == null || _menus.ContainsKey(player.userID)) return;

            OpenMenu(player, null);
        }

        /// <summary>
        /// Fechar não exige token: fechar a própria tela é sempre seguro, e
        /// é a saída de quem ficou com o menu preso (`origemz.skins.close`
        /// no F1). Decisão da frente D.
        /// </summary>
        [ConsoleCommand(MenuCloseCommand)]
        private void CmdMenuClose(ConsoleSystem.Arg arg)
        {
            if (arg.Connection == null) return;

            BasePlayer player = arg.Player();
            if (player != null) CloseMenu(player, false);
        }

        [ConsoleCommand(MenuCategoryCommand)]
        private void CmdMenuCategory(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            string key = arg.GetString(1);
            bool hasPage = arg.HasArgs(3);
            int page = Math.Max(0, arg.GetInt(2, 0));

            if (key == "all" || key == FavoritesKey)
            {
                session.Category = key == FavoritesKey ? FavoritesKey : "";
                session.SidePage = 0;
                session.Shortname = "";
                session.GridPage = 0;
                session.Search = "";
                session.HasPick = false;
                Redraw(player, session, Region.Side | Region.Grid | Region.Detail | Region.Targets);
                return;
            }

            if (!_catalog.CategoryByKey.ContainsKey(key)) return;

            // A paginação da lateral: só a lateral muda.
            if (hasPage && key == session.Category && session.Search.Length == 0)
            {
                session.SidePage = page;
                Redraw(player, session, Region.Side);
                return;
            }

            session.Category = key;
            session.SidePage = hasPage ? page : 0;
            session.Shortname = "";
            session.GridPage = 0;
            session.Search = "";
            session.HasPick = false;
            Redraw(player, session, Region.Side | Region.Grid | Region.Detail | Region.Targets);
        }

        [ConsoleCommand(MenuItemCommand)]
        private void CmdMenuItem(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            string shortname = arg.GetString(1).ToLowerInvariant();
            if (!_catalog.ByShortname.ContainsKey(shortname)) return;

            SelectItem(player, session, shortname);
            Redraw(player, session, Region.Side | Region.Grid | Region.Detail | Region.Targets);
        }

        [ConsoleCommand(MenuPageCommand)]
        private void CmdMenuPage(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            session.GridPage = Math.Max(0, arg.GetInt(1, 0));
            Redraw(player, session, Region.Grid);
        }

        [ConsoleCommand(MenuPickCommand)]
        private void CmdMenuPick(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            int id = arg.GetInt(1, -1);

            if (id == 0)
            {
                if (session.Shortname.Length == 0) return;
            }
            else
            {
                SkinEntry entry;
                if (!_catalog.ById.TryGetValue(id, out entry)) return;

                // Um clique numa skin de OUTRO item (grade misturada) muda
                // o alvo: o de antes não serve para ela.
                string previous = PickShortname(session);
                if (previous != entry.Shortname)
                {
                    session.TargetUid = 0;
                    session.TargetPage = 0;
                }
            }

            session.HasPick = true;
            session.PickId = id;
            session.Message = "";
            Redraw(player, session, Region.Grid | Region.Detail | Region.Targets);
        }

        [ConsoleCommand(MenuTargetCommand)]
        private void CmdMenuTarget(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            ulong uid;
            if (!ulong.TryParse(arg.GetString(1), NumberStyles.None, CultureInfo.InvariantCulture, out uid)) return;

            // Só vale um uid que está na lista deste jogador; o resto é
            // conferido de novo na hora de aplicar.
            bool found = false;
            foreach (Instance instance in CollectInstances(player, PickShortname(session)))
            {
                if (instance.Item.uid.Value == uid)
                {
                    found = true;
                    break;
                }
            }

            if (!found) return;

            session.TargetUid = uid;
            session.Message = "";
            Redraw(player, session, Region.Grid | Region.Targets);
        }

        [ConsoleCommand(MenuTargetsCommand)]
        private void CmdMenuTargets(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            session.TargetPage = Math.Max(0, arg.GetInt(1, 0));
            Redraw(player, session, Region.Targets);
        }

        [ConsoleCommand(MenuMineCommand)]
        private void CmdMenuMine(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            session.Mine = arg.GetInt(1, 0) == 1;
            session.SidePage = 0;
            session.GridPage = 0;
            Redraw(player, session, Region.AllButWindow);
        }

        [ConsoleCommand(MenuFavoriteCommand)]
        private void CmdMenuFavorite(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            int id = arg.GetInt(1, 0);
            if (id <= 0 || !_catalog.ById.ContainsKey(id)) return;

            HashSet<int> set;
            if (!_favorites.TryGetValue(player.UserIDString, out set))
            {
                set = new HashSet<int>();
                _favorites[player.UserIDString] = set;
            }

            if (!set.Remove(id))
            {
                if (set.Count >= MaxFavoritesPerPlayer) return;
                set.Add(id);
            }

            SaveFavorites();
            Redraw(player, session, Region.Side | Region.Grid | Region.Detail);
        }

        [ConsoleCommand(MenuSortCommand)]
        private void CmdMenuSort(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            session.ByRarity = arg.GetInt(1, 0) == 1;
            session.GridPage = 0;
            Redraw(player, session, Region.Head | Region.Grid);
        }

        [ConsoleCommand(MenuSearchCommand)]
        private void CmdMenuSearch(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            // O cliente anexa o texto CRU ao comando: tudo depois do token.
            string text = RestOfLine(arg, 1);
            if (text == session.Search) return;

            SetSearch(session, text);
            Redraw(player, session, Region.Side | Region.Grid | Region.Detail | Region.Targets);
        }

        [ConsoleCommand(MenuApplyCommand)]
        private void CmdMenuApply(ConsoleSystem.Arg arg)
        {
            BasePlayer player;
            MenuSession session = SessionOf(arg, out player);
            if (session == null) return;

            bool ok;
            string message = TryApply(player, session, out ok);
            Flash(player, session, message, ok);

            // Mesmo na recusa a grade muda: "o item sumiu" troca o alvo, e
            // o "Aplicada" da célula é o do alvo.
            Redraw(player, session, Region.Grid | Region.Targets);
        }

        /// <summary>A faixa de resultado em "Aplicar em", que some sozinha em 2 s.</summary>
        private void Flash(BasePlayer player, MenuSession session, string message, bool ok)
        {
            session.Message = message ?? "";
            session.MessageOk = ok;

            if (session.FlashTimer != null) session.FlashTimer.Destroy();

            ulong userId = player.userID;
            session.FlashTimer = timer.Once(FlashSeconds, () =>
            {
                session.FlashTimer = null;

                MenuSession current;
                if (!_menus.TryGetValue(userId, out current) || current != session || session.Message != message) return;

                session.Message = "";
                BasePlayer again = BasePlayer.FindByID(userId);
                if (again != null && again.IsConnected) Redraw(again, session, Region.Targets);
            });
        }

        /// <summary>
        /// O que ainda existe no estado da sessão, depois de uma carga nova
        /// (03 §7): categoria, item ou skin que sumiram voltam para TODAS.
        /// </summary>
        private void Normalize(MenuSession session)
        {
            if (session.Shortname.Length > 0 && !_catalog.ByShortname.ContainsKey(session.Shortname))
            {
                session.Shortname = "";
                session.Category = "";
                session.HasPick = false;
            }

            if (session.Category.Length > 0 && session.Category != FavoritesKey &&
                !_catalog.CategoryByKey.ContainsKey(session.Category))
            {
                session.Category = "";
                session.Shortname = "";
            }

            if (session.HasPick)
            {
                if (session.PickId == 0 ? session.Shortname.Length == 0 : !_catalog.ById.ContainsKey(session.PickId))
                {
                    session.HasPick = false;
                }
            }
        }

        private string PickShortname(MenuSession session)
        {
            if (!session.HasPick) return "";
            if (session.PickId == 0) return session.Shortname;

            SkinEntry entry;
            return _catalog.ById.TryGetValue(session.PickId, out entry) ? entry.Shortname : "";
        }

        // ============================================================
        //  §12  O MENU  -  do estado para o que se desenha
        //
        //  As "views" são dados puros: o desenho (§13) não toca em
        //  jogador, catálogo nem inventário. É isso que deixa o
        //  `origemz.skins.bytes` medir o pior caso com dados fictícios.
        // ============================================================

        private class HeadView
        {
            public string Token = "";
            public int Usable;
            public int Total;
            public bool Mine;
            public bool ByRarity;
            public bool OnAir;
            /// <summary>Nome do ícone → CRC; pode faltar (aí vai texto).</summary>
            public Dictionary<string, string> Icons = new Dictionary<string, string>();
        }

        private class SideItem
        {
            public string Shortname = "";
            public string Name = "";
            public int ItemId;
            public int Usable;
            public int Total;
            public bool Active;
        }

        private class SideCategory
        {
            public string Key = "";
            public string Label = "";
            public int Count;
            public bool Open;
            public int Page;
            public int Pages = 1;
            public readonly List<SideItem> Items = new List<SideItem>();
        }

        private class SideView
        {
            public string Token = "";
            /// <summary>A lateral rola (config `SideScroll`) em vez de paginar a categoria aberta.</summary>
            public bool Scroll;
            public bool AllActive;
            public int AllCount;
            public bool FavActive;
            public int FavCount;
            public readonly List<SideCategory> Categories = new List<SideCategory>();
        }

        private class GridCell
        {
            /// <summary>0 = Padrão.</summary>
            public int PickId;
            public int ItemId;
            /// <summary>0 = sem skin: o ícone vai SEM `SkinId` (armadilha 3).</summary>
            public ulong SkinId;
            public string Label = "";
            /// <summary>"" quando a grade não mistura itens.</summary>
            public string ItemName = "";
            public string Rarity = "";
            public string State = "";
            public string StateColor = "";
            public bool Locked;
            public bool Syncing;
            public bool Picked;
            public bool Applied;
            public bool Favorite;
        }

        private class GridView
        {
            public string Token = "";
            /// <summary>Nome do ícone → CRC; pode faltar (aí a estrela vira texto).</summary>
            public Dictionary<string, string> Icons = new Dictionary<string, string>();
            /// <summary>A grade rola (config `GridScroll`) em vez de paginar de 12 em 12.</summary>
            public bool Scroll;
            public readonly List<GridCell> Cells = new List<GridCell>();
            public int Page;
            public int Pages = 1;
            public string Search = "";
            public string Empty = "";
        }

        private class DetailView
        {
            public bool Has;
            public int ItemId;
            public ulong SkinId;
            public string Label = "";
            public string Sub = "";
            public string Rarity = "";
            public string State = "";
            public string StateColor = "";
            public string Expiry = "";
            public string ExpiryColor = "";
            public string Description = "";
            public string Note = "";
            public string NoteColor = "";
            /// <summary>0 = Padrão, que não se favorita.</summary>
            public int PickId;
            public bool Favorite;
            public string Token = "";
        }

        private class TargetRow
        {
            public ulong Uid;
            public int ItemId;
            public ulong SkinId;
            public string Where = "";
            /// <summary>0..1; negativo = item sem condição.</summary>
            public float Condition = -1f;
            /// <summary>Negativo = não é arma de pente.</summary>
            public int Ammo = -1;
            public bool Applied;
            public bool Selected;
            /// <summary>Quantidade da PILHA. Aplicar pinta a pilha inteira: é um item só.</summary>
            public int Amount = 1;
        }

        private class TargetsView
        {
            public string Token = "";
            public string ItemName = "";
            public string Empty = "";
            public readonly List<TargetRow> Rows = new List<TargetRow>();
            public int Page;
            public int Pages = 1;
            /// <summary>A lista de alvos rola (config `SideScroll`) em vez de paginar de 4 em 4.</summary>
            public bool Scroll;
            public string Button = "";
            public bool ButtonLive;
            public string Message = "";
            public bool MessageOk;
        }

        /// <summary>O que um redesenho precisa saber do jogador, calculado uma vez.</summary>
        private class Frame
        {
            public Viewer Viewer;
            public string PickShortname = "";
            public SkinEntry Pick;
            public List<Instance> Instances = new List<Instance>();
            /// <summary>Índice do alvo em `Instances`; -1 = nenhum.</summary>
            public int TargetIndex = -1;
        }

        private Frame Prepare(BasePlayer player, MenuSession session)
        {
            Normalize(session);

            Frame frame = new Frame { Viewer = ViewerOf(player) };
            frame.PickShortname = PickShortname(session);

            if (session.HasPick && session.PickId > 0)
            {
                _catalog.ById.TryGetValue(session.PickId, out frame.Pick);
            }

            frame.Instances = CollectInstances(player, frame.PickShortname);

            for (int i = 0; i < frame.Instances.Count; i++)
            {
                if (frame.Instances[i].Item.uid.Value == session.TargetUid)
                {
                    frame.TargetIndex = i;
                    break;
                }
            }

            // Pré-seleção (03 §3.6): o da mão, se for desse item — ele é o
            // primeiro da lista —, senão o primeiro.
            if (frame.TargetIndex < 0)
            {
                if (frame.Instances.Count > 0)
                {
                    frame.TargetIndex = 0;
                    session.TargetUid = frame.Instances[0].Item.uid.Value;
                    session.TargetPage = 0;
                }
                else
                {
                    session.TargetUid = 0;
                }
            }

            return frame;
        }

        private static bool Visible(Viewer viewer, MenuSession session, SkinEntry entry)
        {
            return !session.Mine || Obtained(viewer, entry);
        }

        private List<string> VisibleItems(Viewer viewer, MenuSession session, CategoryInfo info)
        {
            List<string> result = new List<string>();

            foreach (string shortname in info.Shortnames)
            {
                foreach (SkinEntry entry in _catalog.ByShortname[shortname])
                {
                    if (Visible(viewer, session, entry))
                    {
                        result.Add(shortname);
                        break;
                    }
                }
            }

            return result;
        }

        private int CountVisibleCategories(Viewer viewer, MenuSession session)
        {
            int count = 0;
            foreach (CategoryInfo info in _catalog.Categories)
            {
                if (VisibleItems(viewer, session, info).Count > 0) count++;
            }

            return count;
        }

        // ---- a lateral: medidas ------------------------------------

        private const float SideWidth = 210f;
        private const float BodyHeight = 560f;
        private const float SideRow = 28f;
        private const float SideGap = 2f;
        private const float SidePager = 24f;

        /// <summary>Quantos itens a categoria aberta mostra de uma vez quando a lateral rola.</summary>
        private const int SideScrollMaxItems = 60;

        /// <summary>
        /// Quantos itens cabem na categoria aberta sem ScrollView (a medição
        /// 0.1 não foi feita): o que sobra da altura depois das linhas de
        /// categoria e do paginador, entre 3 e 8.
        /// </summary>
        private static int SideItemsPerPage(int visibleCategories)
        {
            float used = 16f + (1 + visibleCategories) * (SideRow + SideGap) + SidePager + 4f;
            int fit = (int)Math.Floor((BodyHeight - used) / (SideRow + SideGap));
            return Math.Max(3, Math.Min(8, fit));
        }

        private HeadView ComputeHead(Frame frame, MenuSession session)
        {
            HeadView view = new HeadView
            {
                Token = session.Token,
                Mine = session.Mine,
                ByRarity = session.ByRarity,
                OnAir = frame.Viewer.OnAir,
                Icons = _icons,
            };

            foreach (SkinEntry entry in _catalog.Ordered)
            {
                view.Total++;
                if (Obtained(frame.Viewer, entry)) view.Usable++;
            }

            return view;
        }

        private SideView ComputeSide(Frame frame, MenuSession session)
        {
            Viewer viewer = frame.Viewer;
            bool searching = session.Search.Length > 0;

            SideView view = new SideView
            {
                Token = session.Token,
                AllActive = searching || session.Category.Length == 0,
                FavActive = !searching && session.Category == FavoritesKey,
            };

            foreach (int favorite in viewer.Favorites)
            {
                SkinEntry entry;
                if (_catalog.ById.TryGetValue(favorite, out entry) && Visible(viewer, session, entry)) view.FavCount++;
            }

            List<CategoryInfo> shown = new List<CategoryInfo>();
            List<List<string>> shownItems = new List<List<string>>();

            foreach (CategoryInfo info in _catalog.Categories)
            {
                List<string> items = VisibleItems(viewer, session, info);
                if (items.Count == 0) continue;

                shown.Add(info);
                shownItems.Add(items);
            }

            view.Scroll = _config.SideScroll;

            // Rolando, a categoria aberta vem inteira (com um teto, para a
            // região não crescer sem limite).
            int perPage = view.Scroll ? SideScrollMaxItems : SideItemsPerPage(shown.Count);

            for (int c = 0; c < shown.Count; c++)
            {
                CategoryInfo info = shown[c];
                SideCategory category = new SideCategory
                {
                    Key = info.Key,
                    Label = info.Label,
                    Open = !searching && session.Category == info.Key,
                };

                foreach (string shortname in shownItems[c])
                {
                    foreach (SkinEntry entry in _catalog.ByShortname[shortname])
                    {
                        if (Visible(viewer, session, entry)) category.Count++;
                    }
                }

                view.AllCount += category.Count;

                if (category.Open)
                {
                    List<string> items = shownItems[c];
                    category.Pages = Math.Max(1, (items.Count + perPage - 1) / perPage);
                    session.SidePage = Math.Min(Math.Max(0, session.SidePage), category.Pages - 1);
                    category.Page = session.SidePage;

                    int end = Math.Min(items.Count, (category.Page + 1) * perPage);
                    for (int i = category.Page * perPage; i < end; i++)
                    {
                        List<SkinEntry> skins = _catalog.ByShortname[items[i]];
                        SideItem item = new SideItem
                        {
                            Shortname = items[i],
                            Name = skins[0].ItemName,
                            ItemId = skins[0].ItemId,
                            Total = skins.Count,
                            Active = session.Shortname == items[i],
                        };

                        foreach (SkinEntry entry in skins)
                        {
                            if (Obtained(viewer, entry)) item.Usable++;
                        }

                        category.Items.Add(item);
                    }
                }

                view.Categories.Add(category);
            }

            return view;
        }

        /// <summary>
        /// Lendária primeiro, sem raridade por último. ESTÁVEL: dentro da mesma
        /// raridade continua a ordem do catálogo (`sort`, depois o nome). O
        /// `List.Sort` do .NET não é estável, então a posição original
        /// desempata.
        /// </summary>
        private static void SortByRarity(List<SkinEntry> list)
        {
            Dictionary<SkinEntry, int> position = new Dictionary<SkinEntry, int>(list.Count);
            for (int i = 0; i < list.Count; i++) position[list[i]] = i;

            list.Sort((a, b) =>
            {
                int byRarity = RarityRank(b.Rarity).CompareTo(RarityRank(a.Rarity));
                return byRarity != 0 ? byRarity : position[a].CompareTo(position[b]);
            });
        }

        private static int RarityRank(string rarity)
        {
            switch (rarity)
            {
                case "legendary": return 5;
                case "epic": return 4;
                case "rare": return 3;
                case "uncommon": return 2;
                case "common": return 1;
                default: return 0;
            }
        }

        private GridView ComputeGrid(Frame frame, MenuSession session)
        {
            Viewer viewer = frame.Viewer;
            GridView view = new GridView { Token = session.Token, Search = session.Search, Icons = _icons };

            List<SkinEntry> list = new List<SkinEntry>();
            bool withDefault = false;
            bool mixed = true;

            if (session.Search.Length > 0)
            {
                string needle = Fold(session.Search);
                foreach (SkinEntry entry in _catalog.Ordered)
                {
                    if (Visible(viewer, session, entry) && entry.SearchKey.IndexOf(needle, StringComparison.Ordinal) >= 0)
                    {
                        list.Add(entry);
                    }
                }

                view.Empty = "Nenhuma skin com \"" + session.Search + "\".";
            }
            else if (session.Shortname.Length > 0)
            {
                mixed = false;
                withDefault = true;
                foreach (SkinEntry entry in _catalog.ByShortname[session.Shortname])
                {
                    if (Visible(viewer, session, entry)) list.Add(entry);
                }
            }
            else if (session.Category == FavoritesKey)
            {
                foreach (SkinEntry entry in _catalog.Ordered)
                {
                    if (viewer.Favorites.Contains(entry.Id) && Visible(viewer, session, entry)) list.Add(entry);
                }

                view.Empty = "Nenhuma favorita ainda. Escolha uma skin e toque em FAVORITAR no detalhe.";
            }
            else
            {
                foreach (SkinEntry entry in _catalog.Ordered)
                {
                    if ((session.Category.Length == 0 || entry.Category == session.Category) &&
                        Visible(viewer, session, entry))
                    {
                        list.Add(entry);
                    }
                }

                view.Empty = _catalog.Ordered.Count == 0
                    ? "Nenhuma skin neste servidor ainda."
                    : "Você ainda não tem skins aqui. Desligue \"só as minhas\" para ver todas.";
            }

            if (session.ByRarity) SortByRarity(list);

            int count = list.Count + (withDefault ? 1 : 0);
            view.Scroll = _config.GridScroll;
            int pageSize = view.Scroll ? ScrollPageSize : GridPageSize;
            view.Pages = Math.Max(1, (count + pageSize - 1) / pageSize);
            session.GridPage = Math.Min(Math.Max(0, session.GridPage), view.Pages - 1);
            view.Page = session.GridPage;

            Item target = frame.TargetIndex >= 0 ? frame.Instances[frame.TargetIndex].Item : null;
            ulong targetSkin = target != null ? EffectiveSkin(viewer.SteamId, target) : 0uL;
            string targetShortname = target != null ? target.info.shortname : "";

            int start = view.Page * pageSize;
            int end = Math.Min(count, start + pageSize);

            for (int i = start; i < end; i++)
            {
                int index = withDefault ? i - 1 : i;

                if (index < 0)
                {
                    List<SkinEntry> sameItem = _catalog.ByShortname[session.Shortname];
                    view.Cells.Add(new GridCell
                    {
                        PickId = 0,
                        ItemId = sameItem[0].ItemId,
                        Label = "Padrão",
                        State = targetShortname == session.Shortname && targetSkin == 0uL ? "Aplicada" : "Padrão",
                        StateColor = targetShortname == session.Shortname && targetSkin == 0uL ? ColOlive : ColMuted,
                        Picked = session.HasPick && session.PickId == 0,
                        Applied = targetShortname == session.Shortname && targetSkin == 0uL,
                    });
                    continue;
                }

                SkinEntry entry = list[index];
                GridCell cell = new GridCell
                {
                    PickId = entry.Id,
                    ItemId = entry.ItemId,
                    SkinId = entry.SkinId,
                    Label = entry.Label,
                    ItemName = mixed ? entry.ItemName : "",
                    Rarity = entry.Rarity,
                    Picked = session.HasPick && session.PickId == entry.Id,
                    Applied = targetShortname == entry.Shortname && targetSkin == entry.SkinId,
                    Favorite = viewer.Favorites.Contains(entry.Id),
                };

                long expiresAt;
                Access access = AccessOf(viewer, entry, out expiresAt);
                DescribeCell(cell, access, expiresAt, viewer.Now);
                view.Cells.Add(cell);
            }

            return view;
        }

        /// <summary>O estado da célula (03 §3.3), na ordem de precedência da tabela.</summary>
        private static void DescribeCell(GridCell cell, Access access, long expiresAt, long now)
        {
            if (cell.Applied && IsUsable(access))
            {
                cell.State = "Aplicada";
                cell.StateColor = ColOlive;
                return;
            }

            switch (access)
            {
                case Access.Owned:
                    if (expiresAt > 0 && expiresAt - now <= 7 * DayMs)
                    {
                        cell.State = "Expira em " + Remaining(expiresAt - now);
                        cell.StateColor = ColAmber;
                    }
                    else
                    {
                        cell.State = "Obtida";
                        cell.StateColor = ColText;
                    }

                    break;
                case Access.Free:
                    cell.State = "Grátis";
                    cell.StateColor = ColText;
                    break;
                case Access.Admin:
                    // Escurecida e com cadeado, como para qualquer jogador; o
                    // admin só continua podendo aplicar.
                    cell.State = "Não obtida (admin)";
                    cell.StateColor = ColMuted;
                    cell.Locked = true;
                    break;
                case Access.Syncing:
                    cell.State = "Sincronizando";
                    cell.StateColor = ColMuted;
                    cell.Syncing = true;
                    break;
                default:
                    cell.State = "Não obtida";
                    cell.StateColor = ColMuted;
                    cell.Locked = true;
                    break;
            }
        }

        private DetailView ComputeDetail(Frame frame, MenuSession session)
        {
            DetailView view = new DetailView();
            if (!session.HasPick) return view;

            view.Has = true;

            if (frame.Pick == null)
            {
                List<SkinEntry> sameItem = _catalog.ByShortname[session.Shortname];
                view.ItemId = sameItem[0].ItemId;
                view.Label = "Padrão";
                view.Sub = sameItem[0].ItemName + " · original";
                view.State = "Sempre disponível";
                view.StateColor = ColOlive;
                view.Description = "A aparência original do item, sem skin.";
                return view;
            }

            SkinEntry entry = frame.Pick;
            view.PickId = entry.Id;
            view.Favorite = frame.Viewer.Favorites.Contains(entry.Id);
            view.Token = session.Token;
            view.ItemId = entry.ItemId;
            view.SkinId = entry.SkinId;
            view.Label = entry.Label;
            view.Rarity = entry.Rarity;
            view.Sub = entry.ItemName;
            view.Description = entry.Description;

            long expiresAt;
            Access access = AccessOf(frame.Viewer, entry, out expiresAt);
            long now = frame.Viewer.Now;

            switch (access)
            {
                case Access.Owned:
                    view.State = "Obtida";
                    view.StateColor = ColOlive;
                    if (expiresAt == 0)
                    {
                        view.Expiry = "Permanente";
                        view.ExpiryColor = ColMuted;
                    }
                    else
                    {
                        view.Expiry = "Expira em " + Remaining(expiresAt - now) + " (" + DateOf(expiresAt) + ")";
                        view.ExpiryColor = expiresAt - now <= 7 * DayMs ? ColAmber : ColMuted;
                    }

                    break;
                case Access.Free:
                    view.State = "Grátis";
                    view.StateColor = ColOlive;
                    view.Expiry = "Skin da casa: liberada para todos";
                    view.ExpiryColor = ColMuted;
                    break;
                case Access.Admin:
                    view.State = "Não obtida";
                    view.StateColor = ColMuted;
                    view.Expiry = "Você é admin: pode aplicar mesmo assim";
                    view.ExpiryColor = ColAmber;
                    break;
                case Access.Syncing:
                    view.State = "Sincronizando";
                    view.StateColor = ColMuted;
                    view.Note = "Carregando suas skins…";
                    view.NoteColor = ColMuted;
                    break;
                default:
                    view.State = "Bloqueada";
                    view.StateColor = ColRust;
                    // Sem link clicável: o CUI não abre navegador (03 §3.5).
                    view.Note = _catalog.StoreUrl.Length > 0
                        ? "Disponível na loja: " + _catalog.StoreUrl
                        : "Disponível na loja do site";
                    view.NoteColor = ColAmber;
                    break;
            }

            if (view.Note.Length == 0 && frame.Viewer.OnAir && entry.HideInStreamer)
            {
                view.Note = "Com o modo streamer ligado, esta skin fica escondida.";
                view.NoteColor = ColAmber;
            }

            return view;
        }

        private TargetsView ComputeTargets(Frame frame, MenuSession session)
        {
            TargetsView view = new TargetsView
            {
                Token = session.Token,
                Message = session.Message,
                MessageOk = session.MessageOk,
            };

            if (!session.HasPick || frame.PickShortname.Length == 0)
            {
                view.Empty = "Escolha uma skin na grade para ver onde aplicar.";
                view.Button = "ESCOLHA UMA SKIN";
                return view;
            }

            List<SkinEntry> sameItem = _catalog.ByShortname[frame.PickShortname];
            view.ItemName = sameItem[0].ItemName;
            ulong pickSkin = frame.Pick != null ? frame.Pick.SkinId : 0uL;
            string steamId = frame.Viewer.SteamId;

            // Rolando, a lista vem inteira (com teto): um jogador pode ter
            // dezenas do mesmo item, e paginar de 4 em 4 vira trabalho.
            view.Scroll = _config.SideScroll;
            int perPage = view.Scroll ? TargetsScrollMax : TargetsPageSize;

            view.Pages = Math.Max(1, (frame.Instances.Count + perPage - 1) / perPage);
            session.TargetPage = Math.Min(Math.Max(0, session.TargetPage), view.Pages - 1);
            view.Page = session.TargetPage;

            int end = Math.Min(frame.Instances.Count, (view.Page + 1) * perPage);
            for (int i = view.Page * perPage; i < end; i++)
            {
                Item item = frame.Instances[i].Item;
                TargetRow row = new TargetRow
                {
                    Uid = item.uid.Value,
                    ItemId = item.info.itemid,
                    SkinId = item.skin,
                    Where = frame.Instances[i].Where,
                    Applied = EffectiveSkin(steamId, item) == pickSkin,
                    Selected = i == frame.TargetIndex,
                    Amount = item.amount,
                };

                if (item.hasCondition && item.maxCondition > 0f)
                {
                    row.Condition = Mathf.Clamp01(item.condition / item.maxCondition);
                }

                BaseProjectile gun = item.GetHeldEntity() as BaseProjectile;
                if (gun != null && gun.primaryMagazine != null)
                {
                    row.Ammo = gun.primaryMagazine.contents;
                }

                view.Rows.Add(row);
            }

            if (frame.Instances.Count == 0)
            {
                view.Empty = "Você não tem um(a) " + view.ItemName + " no inventário.";
            }

            // O texto do botão acompanha o motivo (03 §3.6).
            if (frame.Pick != null)
            {
                long ignored;
                Access access = AccessOf(frame.Viewer, frame.Pick, out ignored);
                if (access == Access.Locked)
                {
                    view.Button = "BLOQUEADA";
                    return view;
                }

                if (access == Access.Syncing)
                {
                    view.Button = "SINCRONIZANDO";
                    return view;
                }
            }

            if (frame.TargetIndex < 0)
            {
                view.Button = "APLICAR";
                return view;
            }

            if (EffectiveSkin(steamId, frame.Instances[frame.TargetIndex].Item) == pickSkin)
            {
                view.Button = "JÁ APLICADA";
                return view;
            }

            view.Button = "APLICAR";
            view.ButtonLive = true;
            return view;
        }

        /// <summary>
        /// Desenha as regiões pedidas. A abertura vai em DOIS `AddUI` (03
        /// §6): janela, cabeçalho, lateral e detalhe num; grade e "aplicar
        /// em" no outro. Um grupo que passe de 40 KB é quebrado.
        /// </summary>
        private void Redraw(BasePlayer player, MenuSession session, Region regions)
        {
            if (player == null || !player.IsConnected) return;

            Frame frame = Prepare(player, session);

            List<string> first = new List<string>();
            List<string> second = new List<string>();

            if ((regions & Region.Window) != 0) first.Add(BuildWindow(session.Token));
            if ((regions & Region.Head) != 0) first.Add(BuildHead(ComputeHead(frame, session)));
            if ((regions & Region.Side) != 0) first.AddRange(BuildSide(ComputeSide(frame, session)));
            if ((regions & Region.Detail) != 0) first.Add(BuildDetail(ComputeDetail(frame, session)));
            if ((regions & Region.Grid) != 0) second.AddRange(BuildGrid(ComputeGrid(frame, session)));
            if ((regions & Region.Targets) != 0) second.Add(BuildTargets(ComputeTargets(frame, session)));

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
        //  §13  O MENU  -  o desenho
        //
        //  Medidas em pixels da base 1280×720 (core/src/game/ui-geometry.ts),
        //  traduzidas para âncoras RELATIVAS ao pai: a janela escala com a
        //  resolução. Origem no canto de CIMA à esquerda de cada caixa; a
        //  conversão para o Y do Unity (que cresce para cima) mora só em
        //  `Rect`.
        //
        //  Nomes: só recebe nome o elemento que tem filho. O resto vai sem
        //  nome — o cliente dá um padrão — e isso economiza bytes.
        // ============================================================

        // Os tokens de core/src/game/ui-widgets.ts:26-48 (objeto `C`), que
        // são os de panel/src/app/globals.css. SE MUDAREM LÁ, MUDAM AQUI.
        private static readonly string ColBg = Hex("#0F0F0F");
        private static readonly string ColSurface = Hex("#1B1B1B");
        private static readonly string ColSurface2 = Hex("#262626");
        private static readonly string ColBorder = Hex("#2E2E2E");
        private static readonly string ColText = Hex("#E8E8E8");
        private static readonly string ColMuted = Hex("#9A9A9A");
        private static readonly string ColRust = Hex("#C43F2C");
        private static readonly string ColOlive = Hex("#6B7F5B");
        private static readonly string ColAmber = Hex("#E6B265");

        /// <summary>Célula/linha escolhida: um cinza acima do `surface2`.</summary>
        private static readonly string ColPicked = Hex("#343434");
        /// <summary>Célula aplicada: "fundo com acento" (03 §3.3), escuro o bastante para o texto.</summary>
        private static readonly string ColAppliedFill = Hex("#3A1F1A");
        private static readonly string ColTransparent = "0 0 0 0";
        /// <summary>O véu de ui-preset-main-menu.ts:132 (#000000D1).</summary>
        private const string ColVeil = "0 0 0 0.82";
        private const string ColIconDim = "1 1 1 0.3";
        private static readonly string ColLockedFill = Hex("#141414");

        /// <summary>A mesma cor com outro alpha ("r g b a" do CUI).</summary>
        private static string Faded(string color, float alpha)
        {
            string[] parts = color.Split(' ');
            if (parts.Length < 3) return color;
            return parts[0] + " " + parts[1] + " " + parts[2] + " " + F(alpha);
        }
        private const string BlurMaterial = "assets/content/ui/uibackgroundblur.mat";
        private const string FontBold = "RobotoCondensed-Bold.ttf";
        private const string FontRegular = "RobotoCondensed-Regular.ttf";

        /// <summary>
        /// A borda por raridade (03 §2: a cor é de quem desenha, numa tabela
        /// só). `common` fica sem borda.
        /// </summary>
        private static string RarityColor(string rarity)
        {
            switch (rarity)
            {
                case "uncommon": return RarityUncommon;
                case "rare": return RarityRare;
                case "epic": return RarityEpic;
                case "legendary": return RarityLegendary;
                default: return null;
            }
        }

        /// <summary>O fundo da célula: a cor da raridade, bem escura, para o ícone continuar legível.</summary>
        private static string RarityFill(string rarity)
        {
            switch (rarity)
            {
                case "uncommon": return Hex("#1E3319");
                case "rare": return Hex("#172B47");
                case "epic": return Hex("#2E1B45");
                case "legendary": return Hex("#4A2A0E");
                default: return ColSurface2;
            }
        }

        private static readonly string RarityUncommon = Hex("#4E9A3F");
        private static readonly string RarityRare = Hex("#3C78C8");
        private static readonly string RarityEpic = Hex("#8A4FC7");
        private static readonly string RarityLegendary = Hex("#D9822B");

        private static string RarityLabel(string rarity)
        {
            switch (rarity)
            {
                case "uncommon": return "Incomum";
                case "rare": return "Rara";
                case "epic": return "Épica";
                case "legendary": return "Lendária";
                default: return "Comum";
            }
        }

        /// <summary>
        /// A janela, na base 1280×720: 1240 × 640, centrada. Era 1200; a
        /// grade rolável precisou de 40 px a mais para a barra não cobrir a
        /// quarta coluna (visto no jogo em 17/09/2026).
        /// </summary>
        private const float WinWidth = 1240f;
        private const float WinHeight = 640f;
        private const float HeaderHeight = 52f;
        private const float FooterHeight = 28f;
        private const float GridWidth = 600f;

        /// <summary>A faixa da direita que a barra de rolagem ocupa, fora das células.</summary>
        private const float ScrollGutter = 16f;

        /// <summary>A folga no topo e no pé do conteúdo rolável, do tamanho da borda de seleção.</summary>
        private const float ScrollInset = 2f;

        /// <summary>A largura das quatro colunas de células, sem margem.</summary>
        private static readonly float CellsWidth = GridColumns * CellWidth + (GridColumns - 1) * CellGap;
        private const float RightWidth = 430f;
        private const float DetailHeight = 250f;

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
            /// dividir UMA região em vários AddUI (a grade rolável passa de
            /// 40 KB) sem nunca mandar um filho antes do pai.
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
        /// A dica que o CLIENTE mostra ao passar o mouse (`CuiTooltipComponent`,
        /// tipo "Tooltip", Oxide 2.0.7716). Pendurada no elemento de nome
        /// `name`, que já precisa estar no canvas.
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

        /// <summary>
        /// O cadeado, desenhado com três painéis: arco, vão do arco e corpo.
        ///
        /// ####  POR QUE NÃO UM SPRITE  ####
        ///
        /// O 03 §3.3 sugere `assets/icons/lock.png`, mas o caminho não se
        /// confirma daqui: as DLLs do server01 citam só `close.png`,
        /// `device_add.png`, `embrella.png`, `explosion_sprite.png`,
        /// `facepunch.png` e `fun.png` (varredura de 17/09/2026), e os
        /// sprites moram nos bundles do CLIENTE. Um sprite inexistente
        /// desenha um quadrado branco. Os três painéis funcionam em
        /// qualquer cliente; trocar por sprite é a medição 0.5.
        ///
        /// `hole` é a cor do que está atrás (o vão é pintado, não vazado).
        /// </summary>
        private static void Lock(Canvas canvas, Box parent, float x, float y, float scale, string color, string hole)
        {
            Panel(canvas, parent, x + 4f * scale, y, 12f * scale, 12f * scale, color);
            Panel(canvas, parent, x + 7f * scale, y + 3f * scale, 6f * scale, 9f * scale, hole);
            Panel(canvas, parent, x, y + 9f * scale, 20f * scale, 13f * scale, color);
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
        /// Um "‹ 1 / 2 ›". `command` recebe a página no fim; nas pontas o
        /// botão fica apagado.
        /// </summary>
        private static void Pager(Canvas canvas, Box parent, float x, float y, float w, float h, int page,
                                  int pages, string command, float buttonWidth, string prevText, string nextText,
                                  string middle, string middleColor)
        {
            if (page > 0)
            {
                TextButton(canvas, parent, x, y, buttonWidth, h, ColSurface2, command + " " + (page - 1),
                           prevText, 11, ColText);
            }
            else
            {
                DeadButton(canvas, parent, x, y, buttonWidth, h, prevText, 11);
            }

            Label(canvas, parent, x + buttonWidth, y, w - 2 * buttonWidth, h,
                  middle ?? (page + 1) + " / " + pages, 11, middleColor ?? ColMuted, TextAnchor.MiddleCenter,
                  middle != null);

            if (page < pages - 1)
            {
                TextButton(canvas, parent, x + w - buttonWidth, y, buttonWidth, h, ColSurface2,
                           command + " " + (page + 1), nextText, 11, ColText);
            }
            else
            {
                DeadButton(canvas, parent, x + w - buttonWidth, y, buttonWidth, h, nextText, 11);
            }
        }

        // ---- a janela ----------------------------------------------

        private static string BuildWindow(string token)
        {
            Canvas canvas = new Canvas("OZSk.W");

            // O véu: tela inteira, com cursor, na camada do menu principal.
            CuiElement veil = new CuiElement { Name = UiRoot, Parent = "Overall", DestroyUi = UiRoot };
            veil.Components.Add(new CuiImageComponent { Color = ColVeil, Material = BlurMaterial });
            veil.Components.Add(new CuiRectTransformComponent { AnchorMin = "0 0", AnchorMax = "1 1" });
            veil.Components.Add(new CuiNeedsCursorComponent());
            canvas.Ui.Add(veil);

            // A janela centrada, em âncoras (03 §8.6), na base 1280×720.
            Box screen = new Box(UiRoot, 1280f, 720f);
            CuiElement window = new CuiElement { Name = UiWindow, Parent = UiRoot };
            window.Components.Add(new CuiImageComponent { Color = ColBg });
            window.Components.Add(Rect(screen, (1280f - WinWidth) / 2f, (720f - WinHeight) / 2f, WinWidth, WinHeight));
            canvas.Ui.Add(window);

            Box win = new Box(UiWindow, WinWidth, WinHeight);

            // O cabeçalho, com o acento de 2 px do `titleBar` ao lado do texto.
            Panel(canvas, win, 0, 0, WinWidth, HeaderHeight, ColSurface);
            Panel(canvas, win, 0, HeaderHeight, WinWidth, 1, ColBorder);
            Panel(canvas, win, 16, 15, 2, 22, ColRust);
            Label(canvas, win, 26, 0, 120, HeaderHeight, "SKINS", 20, ColText, TextAnchor.MiddleLeft, true);

            // O fechar: "X", como o do menu principal (ui-preset-main-menu.ts:746).
            TextButton(canvas, win, WinWidth - 48, 10, 32, 32, ColSurface2, MenuCloseCommand + " " + token,
                       "X", 14, ColText);

            // As divisórias das três colunas.
            Panel(canvas, win, SideWidth, HeaderHeight, 1, BodyHeight, ColBorder);
            Panel(canvas, win, SideWidth + GridWidth, HeaderHeight, 1, BodyHeight, ColBorder);
            Panel(canvas, win, SideWidth + GridWidth, HeaderHeight + DetailHeight, RightWidth, 1, ColBorder);

            // O rodapé.
            Panel(canvas, win, 0, WinHeight - FooterHeight, WinWidth, FooterHeight, ColSurface);
            Label(canvas, win, 16, WinHeight - FooterHeight, WinWidth - 32, FooterHeight,
                  "Skins podem ser obtidas em eventos e no nosso site",
                  11, ColMuted, TextAnchor.MiddleLeft, false);

            return canvas.Json();
        }

        // ---- o cabeçalho vivo --------------------------------------

        private static string BuildHead(HeadView view)
        {
            Canvas canvas = new Canvas("OZSk.H");

            // Só a faixa entre o título e o fechar: a raiz de uma região
            // bloqueia clique onde está, e não pode cobrir o "X".
            // 150 → 1180 na janela de 1240: o "X" começa em 1192.
            Box head = RegionRoot(canvas, UiHead, 150, 0, 1030, HeaderHeight, ColTransparent);

            if (view.OnAir)
            {
                Label(canvas, head, 0, 0, 320, HeaderHeight,
                      "Modo streamer ligado: skins com logo ficam escondidas até você desligar.",
                      10, ColAmber, TextAnchor.MiddleLeft, true);
            }

            Label(canvas, head, 560, 0, 270, HeaderHeight,
                  view.Usable + " de " + view.Total + " obtidas", 12, ColMuted, TextAnchor.MiddleRight, false);

            // ####  SÓ ÍCONES, COM A DICA NO MOUSE  ####
            //
            // Pedido do dono (17/09/2026): os controles ocupavam o cabeçalho.
            // A dica diz o que cada um faz; sem o ícone (FileStorage ainda
            // vazio), cai para uma letra.
            IconSegmented(canvas, head, 850, view.Icons,
                          new[] { "list", "gem" }, new[] { "P", "R" },
                          new[] { "Ordem do catálogo", "Ordenar por raridade: Lendária primeiro" },
                          view.ByRarity ? 1 : 0, MenuSortCommand + " " + view.Token);

            IconSegmented(canvas, head, 940, view.Icons,
                          new[] { "grid", "check" }, new[] { "T", "M" },
                          new[] { "Mostrar todas as skins", "Mostrar só as que você tem (e as liberadas para todos)" },
                          view.Mine ? 1 : 0, MenuMineCommand + " " + view.Token);

            return canvas.Json();
        }

        /// <summary>
        /// Botões quadrados colados, só com ícone, o ativo em vermelho. O
        /// comando recebe o índice no fim; a dica diz o que cada um faz.
        /// </summary>
        private static void IconSegmented(Canvas canvas, Box parent, float x, Dictionary<string, string> icons,
                                          string[] names, string[] fallback, string[] tips, int active,
                                          string command)
        {
            const float size = 30f;
            float y = (HeaderHeight - size) / 2f;

            for (int i = 0; i < names.Length; i++)
            {
                bool on = i == active;
                float cx = x + i * (size + 1f);
                string name = Button(canvas, parent, cx, y, size, size, on ? ColRust : ColSurface2,
                                     command + " " + i, canvas.NextName());
                Box box = new Box(name, size, size);

                string crc;
                if (icons != null && icons.TryGetValue(names[i], out crc))
                {
                    CuiElement image = new CuiElement { Parent = name };
                    image.Components.Add(new CuiRawImageComponent
                    {
                        Png = crc,
                        Color = on ? ColText : ColMuted,
                    });
                    image.Components.Add(Rect(box, 7, 7, size - 14, size - 14));
                    canvas.Ui.Add(image);
                }
                else
                {
                    Label(canvas, box, 0, 0, size, size, fallback[i], 12, on ? ColText : ColMuted,
                          TextAnchor.MiddleCenter, true);
                }

                Tip(canvas, name, tips[i]);
            }
        }

        // ---- a lateral ---------------------------------------------

        private static List<string> BuildSide(SideView view)
        {
            Canvas canvas = new Canvas("OZSk.S");
            Box side = RegionRoot(canvas, UiSide, 0, HeaderHeight, SideWidth, BodyHeight, ColTransparent);

            // A altura do que vai ser desenhado, para saber se precisa rolar.
            float needed = 8f + 2 * (SideRow + SideGap);
            foreach (SideCategory category in view.Categories)
            {
                needed += SideRow + SideGap;
                if (!category.Open) continue;
                needed += category.Items.Count * (SideRow + SideGap);
                if (category.Pages > 1) needed += SidePager + 4f;
            }
            needed += 8f;

            Box area = side;
            float x = 8f;
            float w = SideWidth - 16f;

            if (view.Scroll && needed > BodyHeight)
            {
                area = ScrollArea(canvas, side, 0, 0, SideWidth, BodyHeight, needed, true);
                w = SideWidth - 8f - ScrollGutter;
            }

            float y = 8f;

            SideHeader(canvas, area, x, y, w, "FAVORITOS", view.FavCount, view.FavActive,
                       MenuCategoryCommand + " " + view.Token + " " + FavoritesKey);
            y += SideRow + SideGap;

            SideHeader(canvas, area, x, y, w, "TODAS", view.AllCount, view.AllActive,
                       MenuCategoryCommand + " " + view.Token + " all");
            y += SideRow + SideGap;

            foreach (SideCategory category in view.Categories)
            {
                SideHeader(canvas, area, x, y, w, (category.Open ? "–  " : "+  ") + category.Label,
                           category.Count, category.Open, MenuCategoryCommand + " " + view.Token + " " + category.Key);
                y += SideRow + SideGap;

                if (!category.Open) continue;

                foreach (SideItem item in category.Items)
                {
                    SideItemRow(canvas, area, x, y, w, item, view.Token);
                    y += SideRow + SideGap;
                }

                if (category.Pages > 1)
                {
                    Pager(canvas, area, x + 12, y, w - 12, SidePager, category.Page, category.Pages,
                          MenuCategoryCommand + " " + view.Token + " " + category.Key, 36, "‹", "›", null, null);
                    y += SidePager + 4f;
                }
            }

            return canvas.Parts();
        }

        /// <summary>
        /// Uma área que ROLA na vertical, dentro de `parent`, e devolve a caixa
        /// do CONTEÚDO (altura inteira), onde os filhos se posicionam.
        ///
        /// ####  A RECEITA MEDIDA NO JOGO EM 17/09/2026  ####
        ///
        /// `CuiScrollViewComponent` do Oxide 2.0.7716 com o conteúdo ancorado
        /// no topo e crescendo para baixo, em fração da área visível (âncora
        /// mínima negativa), para tudo continuar relativo. A barra ocupa a
        /// borda direita da área: quem desenha dentro deixa `ScrollGutter`
        /// livre. O projeto anterior derrubou o cliente com ScrollView; esta
        /// receita não derrubou (ver core/src/types/ui-document.ts).
        /// </summary>
        private static Box ScrollArea(Canvas canvas, Box parent, float x, float y, float w, float h,
                                      float contentHeight, bool autoHide)
        {
            float height = Math.Max(h, contentHeight);
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
                    AnchorMin = "0 " + F(1f - height / h),
                    AnchorMax = "1 1",
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

        private static void SideHeader(Canvas canvas, Box parent, float x, float y, float w, string text, int count,
                                       bool active, string command)
        {
            string name = Button(canvas, parent, x, y, w, SideRow, active ? ColSurface2 : ColSurface, command,
                                 canvas.NextName());
            Box row = new Box(name, w, SideRow);

            if (active)
            {
                Panel(canvas, row, 0, 0, 2, SideRow, ColRust);
            }

            Label(canvas, row, 10, 0, w - 60, SideRow, text, 12, active ? ColText : ColMuted, TextAnchor.MiddleLeft, true);
            Label(canvas, row, w - 50, 0, 42, SideRow, count.ToString(CultureInfo.InvariantCulture), 11, ColMuted,
                  TextAnchor.MiddleRight, false);
        }

        /// <summary>O item ativo é PAINEL com acento, e não botão (ui-ranking-screen.ts:1169).</summary>
        private static void SideItemRow(Canvas canvas, Box parent, float x, float y, float w, SideItem item, string token)
        {
            float left = x + 12f;
            float width = w - 12f;
            string name = item.Active
                ? Panel(canvas, parent, left, y, width, SideRow, ColPicked, canvas.NextName())
                : Button(canvas, parent, left, y, width, SideRow, ColTransparent,
                         MenuItemCommand + " " + token + " " + item.Shortname, canvas.NextName());

            Box row = new Box(name, width, SideRow);

            if (item.Active)
            {
                Panel(canvas, row, 0, 0, 2, SideRow, ColRust);
            }

            Icon(canvas, row, 6, 3, 22, 22, item.ItemId, 0uL, "1 1 1 1");
            Label(canvas, row, 34, 0, width - 80, SideRow, Shorten(item.Name, 18), 11,
                  item.Active ? ColText : ColMuted, TextAnchor.MiddleLeft, item.Active);
            Label(canvas, row, width - 48, 0, 42, SideRow, item.Usable + "/" + item.Total, 10, ColMuted,
                  TextAnchor.MiddleRight, false);
        }

        // ---- a grade -----------------------------------------------

        private const float CellWidth = 128f;
        private const float CellHeight = 146f;
        private const float CellGap = 8f;
        private const float GridPad = 12f;

        private static List<string> BuildGrid(GridView view)
        {
            Canvas canvas = new Canvas("OZSk.G");
            Box grid = RegionRoot(canvas, UiGrid, SideWidth, HeaderHeight, GridWidth, BodyHeight, ColTransparent);

            float gridBottom = GridPad + GridRows * CellHeight + (GridRows - 1) * CellGap;
            bool paged = view.Pages > 1;

            if (view.Cells.Count == 0)
            {
                Label(canvas, grid, GridPad, GridPad, GridWidth - 2 * GridPad, 3 * CellHeight, view.Empty, 13,
                      ColMuted, TextAnchor.MiddleCenter, false);
            }

            if (view.Scroll)
            {
                // ####  A GRADE ROLÁVEL  ####
                //
                // A área visível vai do topo até a pesquisa (ou até o
                // paginador, se houver mais de uma página). O conteúdo é
                // ancorado no TOPO da área e cresce para baixo: âncora
                // mínima negativa, em fração da área visível, para tudo
                // continuar relativo e escalar com a resolução.
                float viewportBottom = paged ? gridBottom : gridBottom + 36f;
                float viewportHeight = viewportBottom - GridPad;
                float viewportWidth = GridWidth - 2 * GridPad;
                int rows = (view.Cells.Count + GridColumns - 1) / GridColumns;
                // ScrollInset em cima e embaixo: a área rolável recorta o que
                // passa da borda, e a borda de seleção (2 px) da primeira linha
                // sumia (visto no jogo em 17/09/2026).
                float contentHeight = Math.Max(viewportHeight,
                                               rows * CellHeight + Math.Max(0, rows - 1) * CellGap +
                                               2 * ScrollInset);

                Box content = ScrollArea(canvas, grid, GridPad, GridPad, viewportWidth, viewportHeight,
                                         contentHeight, false);

                // Os filhos se posicionam no CONTEÚDO, que tem a altura inteira.
                float left = Math.Max(0f, (viewportWidth - ScrollGutter - CellsWidth) / 2f);

                for (int i = 0; i < view.Cells.Count; i++)
                {
                    float cx = left + (i % GridColumns) * (CellWidth + CellGap);
                    float cy = ScrollInset + (i / GridColumns) * (CellHeight + CellGap);
    GridCellBox(canvas, content, cx, cy, view.Cells[i], view.Token, view.Icons);
                }

                if (paged)
                {
                    Pager(canvas, grid, GridPad, gridBottom + 8, GridWidth - 2 * GridPad, 28, view.Page, view.Pages,
                          MenuPageCommand + " " + view.Token, 130, "‹ ANTERIOR", "PRÓXIMA ›", null, null);
                }
            }
            else
            {
                float left = (GridWidth - CellsWidth) / 2f;

                for (int i = 0; i < view.Cells.Count; i++)
                {
                    float cx = left + (i % GridColumns) * (CellWidth + CellGap);
                    float cy = GridPad + (i / GridColumns) * (CellHeight + CellGap);
                    GridCellBox(canvas, grid, cx, cy, view.Cells[i], view.Token, view.Icons);
                }

                Pager(canvas, grid, GridPad, gridBottom + 8, GridWidth - 2 * GridPad, 28, view.Page, view.Pages,
                      MenuPageCommand + " " + view.Token, 130, "‹ ANTERIOR", "PRÓXIMA ›", null, null);
            }

            // A pesquisa (03 §3.4): o cliente anexa o texto ao comando
            // quando o campo perde o foco ou no Enter.
            float searchY = gridBottom + 46;
            string bar = Panel(canvas, grid, GridPad, searchY, GridWidth - 2 * GridPad, 36, ColSurface2,
                               canvas.NextName());
            Box search = new Box(bar, GridWidth - 2 * GridPad, 36);

            Label(canvas, search, 10, 0, 80, 36, "PESQUISAR", 11, ColMuted, TextAnchor.MiddleLeft, true);
            Panel(canvas, search, 92, 6, search.W - 140, 24, ColBg);

            CuiElement input = new CuiElement { Parent = bar };
            input.Components.Add(new CuiInputFieldComponent
            {
                Text = view.Search,
                FontSize = 12,
                Font = FontRegular,
                Align = TextAnchor.MiddleLeft,
                Color = ColText,
                CharsLimit = SearchMaxLength,
                Command = MenuSearchCommand + " " + view.Token,
                // ####  SEM ISTO O CAMPO NÃO ACEITA TECLA  ####
                // (core/src/game/ui-cui.ts:377): o teclado continua preso
                // ao personagem sem o `needsKeyboard`.
                NeedsKeyboard = true,
            });
            input.Components.Add(Rect(search, 100, 6, search.W - 156, 24));
            canvas.Ui.Add(input);

            if (view.Search.Length > 0)
            {
                // O "X" limpa: o mesmo comando, sem texto.
                TextButton(canvas, search, search.W - 40, 6, 28, 24, ColSurface, MenuSearchCommand + " " + view.Token,
                           "X", 12, ColText);
            }

            return canvas.Parts();
        }

        private static void GridCellBox(Canvas canvas, Box grid, float x, float y, GridCell cell, string token,
                                        Dictionary<string, string> icons)
        {
            // ####  A COR DA RARIDADE É O FUNDO DA CÉLULA  ####
            //
            // Pedido do dono (17/09/2026): o fundo e a faixa de baixo levam a
            // cor da raridade, e a raridade vira uma linha de texto. A
            // escolha e o "aplicado" passam a ser a BORDA (branca e verde),
            // para não brigar com a cor.
            // ####  SKIN QUE O JOGADOR NÃO TEM: A CÉLULA INTEIRA ESCURECE  ####
            //
            // Pedido do dono (17/09/2026): mostrar todas, com as que ele não
            // tem apagadas e com cadeado. O fundo vira quase preto e a cor da
            // raridade só sobra, fraca, na faixa de baixo.
            bool dim = cell.Locked || cell.Syncing;
            string rarity = RarityColor(cell.Rarity);
            string fill = dim ? ColLockedFill
                : rarity != null ? RarityFill(cell.Rarity)
                : cell.Picked ? ColPicked : ColSurface2;
            string border = cell.Applied ? ColOlive : cell.Picked ? ColText : null;

            string name = Button(canvas, grid, x, y, CellWidth, CellHeight, border ?? fill,
                                 MenuPickCommand + " " + token + " " + cell.PickId, canvas.NextName());
            Box box = new Box(name, CellWidth, CellHeight);

            if (border != null)
            {
                Panel(canvas, box, 2, 2, CellWidth - 4, CellHeight - 4, fill);
            }

            if (rarity != null)
            {
                Panel(canvas, box, 2, CellHeight - 6, CellWidth - 4, 4, dim ? Faded(rarity, 0.35f) : rarity);
            }
            else if (cell.Picked)
            {
                Panel(canvas, box, 2, CellHeight - 5, CellWidth - 4, 3, ColRust);
            }

            Icon(canvas, box, 28, 8, 72, 72, cell.ItemId, cell.SkinId, dim ? ColIconDim : "1 1 1 1");

            if (cell.Favorite)
            {
                // Uma estrela, e não a etiqueta "FAV" (pedido do dono,
                // 17/09/2026). É PNG nosso: o glifo "★" pode não existir na
                // RobotoCondensed, e sprite do jogo não foi confirmado.
                string crc;
                if (icons != null && icons.TryGetValue("star", out crc))
                {
                    string starName = canvas.NextName();
                    CuiElement star = new CuiElement { Name = starName, Parent = box.Name };
                    star.Components.Add(new CuiRawImageComponent { Png = crc, Color = ColAmber });
                    star.Components.Add(Rect(box, 8, 8, 18, 18));
                    canvas.Ui.Add(star);
                    Tip(canvas, starName, "Favorita: ela aparece em FAVORITOS, no topo da lateral");
                }
                else
                {
                    string favName = Panel(canvas, box, 6, 8, 30, 14, ColAmber, canvas.NextName());
                    Label(canvas, new Box(favName, 30, 14), 0, 0, 30, 14, "FAV", 9, ColBg,
                          TextAnchor.MiddleCenter, true);
                    Tip(canvas, favName, "Favorita: ela aparece em FAVORITOS, no topo da lateral");
                }
            }

            if (dim)
            {
                Lock(canvas, box, CellWidth - 30, 8, 1.1f, cell.Locked ? ColText : ColMuted, fill);
                Tip(canvas, name, cell.Locked
                    ? "Você não tem esta skin. Obtenha em eventos ou no nosso site."
                    : "Carregando suas skins…");
            }

            bool mixed = cell.ItemName.Length > 0;
            float line = 82f;
            Label(canvas, box, 6, line, CellWidth - 12, 16, Shorten(cell.Label, 20), 11, dim ? ColMuted : ColText,
                  TextAnchor.MiddleCenter, true);
            line += 16f;

            if (mixed)
            {
                Label(canvas, box, 6, line, CellWidth - 12, 13, Shorten(cell.ItemName, 22), 9, ColMuted,
                      TextAnchor.MiddleCenter, false);
                line += 13f;
            }

            if (cell.PickId != 0)
            {
                Label(canvas, box, 6, line, CellWidth - 12, 14, RarityLabel(cell.Rarity), 10,
                      rarity == null ? ColMuted : dim ? Faded(rarity, 0.6f) : rarity, TextAnchor.MiddleCenter, true);
                line += 14f;
            }

            Label(canvas, box, 6, line, CellWidth - 12, 16, cell.State, 10, cell.StateColor,
                  TextAnchor.MiddleCenter, false);
        }

        // ---- o detalhe ---------------------------------------------

        private static string BuildDetail(DetailView view)
        {
            Canvas canvas = new Canvas("OZSk.D");
            Box detail = RegionRoot(canvas, UiDetail, SideWidth + GridWidth + 1, HeaderHeight, RightWidth - 1,
                                    DetailHeight, ColTransparent);

            if (!view.Has)
            {
                Label(canvas, detail, 16, 16, detail.W - 32, DetailHeight - 32,
                      "Escolha uma skin na grade para ver os detalhes.", 12, ColMuted, TextAnchor.MiddleCenter, false);
                return canvas.Json();
            }

            string border = RarityColor(view.Rarity);
            if (border != null)
            {
                Panel(canvas, detail, 16, 16, 110, 110, border);
            }

            Panel(canvas, detail, 18, 18, 106, 106, ColSurface2);
            Icon(canvas, detail, 26, 26, 90, 90, view.ItemId, view.SkinId, "1 1 1 1");

            float tx = 140f;
            float tw = detail.W - tx - 16f;

            Label(canvas, detail, tx, 18, tw, 26, Shorten(view.Label, 30), 18, ColText, TextAnchor.MiddleLeft, true);
            Label(canvas, detail, tx, 44, tw, 16, view.Sub, 12, ColMuted, TextAnchor.MiddleLeft, false);
            if (view.SkinId != 0uL)
            {
                Label(canvas, detail, tx, 62, tw, 16, RarityLabel(view.Rarity).ToUpperInvariant(), 11,
                      RarityColor(view.Rarity) ?? ColMuted, TextAnchor.MiddleLeft, true);
            }
            Label(canvas, detail, tx, 82, tw, 18, view.State, 12, view.StateColor, TextAnchor.MiddleLeft, true);
            Label(canvas, detail, tx, 102, tw, 18, view.Expiry, 11, view.ExpiryColor, TextAnchor.MiddleLeft, false);

            // Até 3 linhas: o limite do agente é 280 caracteres (02 §4.1).
            Label(canvas, detail, 16, 136, detail.W - 32, 58, Shorten(view.Description, 280), 11, ColText,
                  TextAnchor.UpperLeft, false);

            Label(canvas, detail, 16, 200, detail.W - 32 - 150, 36, view.Note, 11, view.NoteColor,
                  TextAnchor.MiddleLeft, true);

            if (view.PickId != 0)
            {
                string fav = TextButton(canvas, detail, detail.W - 16 - 140, 204, 140, 28,
                           view.Favorite ? ColAmber : ColSurface2,
                           MenuFavoriteCommand + " " + view.Token + " " + view.PickId,
                           view.Favorite ? "DESFAVORITAR" : "FAVORITAR", 11, view.Favorite ? ColBg : ColText);
                Tip(canvas, fav, "As favoritas aparecem em FAVORITOS, no topo da lateral");
            }

            return canvas.Json();
        }

        // ---- "aplicar em" ------------------------------------------

        private const float TargetRowHeight = 44f;
        private const float TargetRowGap = 6f;

        private static string BuildTargets(TargetsView view)
        {
            Canvas canvas = new Canvas("OZSk.T");
            float top = HeaderHeight + DetailHeight + 1;
            Box targets = RegionRoot(canvas, UiTargets, SideWidth + GridWidth + 1, top, RightWidth - 1,
                                     BodyHeight - DetailHeight - 1, ColTransparent);

            float x = 16f;
            float w = targets.W - 32f;

            Label(canvas, targets, x, 10, 200, 20, "APLICAR EM", 12, ColMuted, TextAnchor.MiddleLeft, true);
            Label(canvas, targets, x + 200, 10, w - 200, 20, Shorten(view.ItemName, 28), 11, ColMuted,
                  TextAnchor.MiddleRight, false);

            float y = 36f;
            float listHeight = TargetsPageSize * (TargetRowHeight + TargetRowGap);

            if (view.Rows.Count == 0)
            {
                Label(canvas, targets, x, y, w, 60, view.Empty, 12, ColMuted, TextAnchor.MiddleCenter, false);
            }
            else if (view.Scroll)
            {
                float contentHeight = view.Rows.Count * (TargetRowHeight + TargetRowGap) + 2 * ScrollInset;
                Box area = ScrollArea(canvas, targets, x, y, w, listHeight, contentHeight, true);
                float rowWidth = contentHeight > listHeight ? w - ScrollGutter : w;
                float ry = ScrollInset;

                foreach (TargetRow row in view.Rows)
                {
                    TargetRowBox(canvas, area, 0, ry, rowWidth, row, view.Token);
                    ry += TargetRowHeight + TargetRowGap;
                }
            }
            else
            {
                foreach (TargetRow row in view.Rows)
                {
                    TargetRowBox(canvas, targets, x, y, w, row, view.Token);
                    y += TargetRowHeight + TargetRowGap;
                }
            }

            // A faixa de resultado ocupa o meio do paginador (ou o lugar
            // dele, com uma página só).
            float pagerY = 36f + listHeight;
            string messageColor = view.MessageOk ? ColOlive : ColAmber;
            string message = view.Message.Length > 0 ? view.Message : null;

            if (view.Pages > 1)
            {
                Pager(canvas, targets, x, pagerY, w, 24, view.Page, view.Pages,
                      MenuTargetsCommand + " " + view.Token, 60, "‹", "›", message, messageColor);
            }
            else if (message != null)
            {
                Label(canvas, targets, x, pagerY, w, 24, message, 11, messageColor, TextAnchor.MiddleCenter, true);
            }

            float buttonY = pagerY + 30f;
            if (view.ButtonLive)
            {
                TextButton(canvas, targets, x, buttonY, w, 34, ColRust, MenuApplyCommand + " " + view.Token,
                           view.Button, 14, ColText);
            }
            else
            {
                DeadButton(canvas, targets, x, buttonY, w, 34, view.Button, 14);
            }

            return canvas.Json();
        }

        /// <summary>Uma cor por lugar do item, para o olho achar a linha (pedido do dono, 17/09/2026).</summary>
        private static string WhereColor(string where)
        {
            if (where.StartsWith("Na mão", StringComparison.Ordinal)) return ColAmber;
            if (where.StartsWith("Barra", StringComparison.Ordinal)) return RarityRare;
            if (where.StartsWith("Roupa", StringComparison.Ordinal)) return RarityEpic;
            if (where.StartsWith("Mochila", StringComparison.Ordinal)) return RarityLegendary;
            if (where.StartsWith("Inventário", StringComparison.Ordinal)) return RarityUncommon;
            return ColText;
        }

        private static void TargetRowBox(Canvas canvas, Box parent, float x, float y, float w, TargetRow row, string token)
        {
            string name = Button(canvas, parent, x, y, w, TargetRowHeight, row.Selected ? ColPicked : ColSurface2,
                                 MenuTargetCommand + " " + token + " " + row.Uid.ToString(CultureInfo.InvariantCulture),
                                 canvas.NextName());
            Box box = new Box(name, w, TargetRowHeight);

            if (row.Selected)
            {
                Panel(canvas, box, 0, 0, 2, TargetRowHeight, ColRust);
            }

            // O ícone com a skin ATUAL do item.
            Icon(canvas, box, 8, 4, 36, 36, row.ItemId, row.SkinId, "1 1 1 1");
            Label(canvas, box, 52, 4, 160, 18, row.Where, 12, WhereColor(row.Where), TextAnchor.MiddleLeft, true);

            // ####  PILHA É UM ITEM SÓ  ####
            //
            // O Rust junta itens iguais numa pilha, e a pilha é UM objeto: a
            // lista mostra uma linha, e aplicar pinta as unidades todas. Sem
            // este "x8" parece que as outras desapareceram.
            if (row.Amount > 1)
            {
                string badge = Panel(canvas, box, 8, 26, 34, 14, ColSurface, canvas.NextName());
                Label(canvas, new Box(badge, 34, 14), 0, 0, 34, 14,
                      "x" + row.Amount.ToString(CultureInfo.InvariantCulture), 9, ColText,
                      TextAnchor.MiddleCenter, true);
                Tip(canvas, badge, "Pilha de " + row.Amount + ": a skin vale para as " + row.Amount + " unidades");
            }

            if (row.Condition >= 0f)
            {
                const float barWidth = 120f;
                string barColor = row.Condition > 0.5f ? ColOlive : row.Condition > 0.2f ? ColAmber : ColRust;
                Panel(canvas, box, 52, 28, barWidth, 6, ColBorder);
                if (row.Condition > 0f)
                {
                    Panel(canvas, box, 52, 28, Math.Max(1f, barWidth * row.Condition), 6, barColor);
                }
            }

            string right = row.Ammo >= 0 ? row.Ammo + (row.Ammo == 1 ? " bala" : " balas") : "";
            if (row.Applied)
            {
                right = right.Length > 0 ? right + "\nAplicada" : "Aplicada";
            }

            Label(canvas, box, w - 150, 2, 140, 40, right, 11, row.Applied ? ColOlive : ColMuted,
                  TextAnchor.MiddleRight, row.Applied);
        }

        // ---- o botão do inventário (03 §4.1) -----------------------

        /// <summary>
        /// O botão SKINS na camada `Inventory`, que o CLIENTE só mostra com o
        /// inventário aberto (memória: a camada do CUI só o cliente
        /// resolve). Atrás da config `InventoryButton`, desligada: a
        /// medição 0.2 não foi feita. NUNCA em `Hud`/`Overlay`, que ficam
        /// na tela o tempo todo.
        /// </summary>
        private void DrawInventoryButton(BasePlayer player)
        {
            if (player == null || !player.IsConnected) return;

            CuiElementContainer ui = new CuiElementContainer();

            CuiElement button = new CuiElement { Name = UiInventoryButton, Parent = "Inventory", DestroyUi = UiInventoryButton };
            button.Components.Add(new CuiButtonComponent { Color = ColRust, Command = MenuOpenCommand });
            button.Components.Add(new CuiRectTransformComponent
            {
                AnchorMin = _config.InventoryButtonAnchorMin,
                AnchorMax = _config.InventoryButtonAnchorMax,
                OffsetMin = _config.InventoryButtonOffsetMin,
                OffsetMax = _config.InventoryButtonOffsetMax,
            });
            ui.Add(button);

            CuiElement text = new CuiElement { Parent = UiInventoryButton };
            text.Components.Add(new CuiTextComponent
            {
                Text = "SKINS",
                FontSize = 12,
                Font = FontBold,
                Align = TextAnchor.MiddleCenter,
                Color = ColText,
            });
            text.Components.Add(new CuiRectTransformComponent { AnchorMin = "0 0", AnchorMax = "1 1" });
            ui.Add(text);

            CuiHelper.AddUi(player, ui);
        }

        // ============================================================
        //  §14  origemz.skins.bytes  -  o pior caso, medido
        //
        //  Monta cada região com dados FICTÍCIOS no pior caso do 05 §6
        //  (a categoria mais cheia aberta, 12 células com nome longo, 4
        //  alvos) e devolve o tamanho do JSON de cada uma e dos dois
        //  `AddUI` da abertura. Não depende de jogador nem de catálogo.
        // ============================================================

        /// <summary>
        /// `origemz.skins.scroll 0|1`: liga e desliga a grade rolável na hora
        /// e redesenha quem estiver com o menu aberto. Sem argumento, só diz
        /// o estado. Servidor, RCON ou admin.
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
                _config.GridScroll = arg.GetString(0) == "1" || arg.GetString(0).ToLowerInvariant() == "true";
                _config.SideScroll = _config.GridScroll;
                SaveConfig();
                RedrawAllMenus(Region.Grid | Region.Side);
            }

            arg.ReplyWith("{\"ok\":true,\"gridScroll\":" + (_config.GridScroll ? "true" : "false") +
                          ",\"sideScroll\":" + (_config.SideScroll ? "true" : "false") + "}");
        }

        [ConsoleCommand(BytesCommand)]
        private void CmdBytes(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                BasePlayer player = arg.Player();
                if (player == null || !IsAdmin(player)) return;
            }

            arg.ReplyWith(MeasureWorstCase());
        }

        /// <summary>
        /// Público e estático de propósito: um teste fora do servidor pode
        /// chamá-lo sem instanciar o plugin.
        /// </summary>
        public static string MeasureWorstCase()
        {
            const string token = "0123456789abcdef";
            const string longName = "Brasa Incandescente do Deserto Vermelho Edição 2026";
            const string longItem = "Semi-Automatic Rifle Custom";
            const ulong skin = 3802433262uL;
            const int itemId = -1812555177;

            HeadView head = new HeadView { Token = token, Usable = 999, Total = 9999, Mine = true, OnAir = true };

            SideView side = new SideView { Token = token, AllCount = 9999 };
            for (int c = 0; c < CategoryTable.Length; c++)
            {
                SideCategory category = new SideCategory
                {
                    Key = CategoryTable[c][0],
                    Label = CategoryTable[c][1],
                    Count = 999,
                    Open = c == 0,
                    Page = 1,
                    Pages = 3,
                };

                side.Categories.Add(category);
            }

            // A categoria aberta com o máximo de itens por página. Com as 13
            // categorias à mostra cabem menos; o pior caso em bytes é o teto
            // de 8 itens, então as duas situações são somadas aqui.
            for (int i = 0; i < 8; i++)
            {
                side.Categories[0].Items.Add(new SideItem
                {
                    Shortname = "rifle.semiauto.custom" + i,
                    Name = longItem,
                    ItemId = itemId,
                    Usable = 99,
                    Total = 99,
                    Active = i == 3,
                });
            }

            GridView grid = new GridView { Token = token, Page = 5, Pages = 12, Search = "brasa incandescente do deserto vermel" };
            for (int i = 0; i < GridPageSize; i++)
            {
                grid.Cells.Add(new GridCell
                {
                    PickId = 99990 + i,
                    ItemId = itemId,
                    SkinId = skin,
                    Label = longName,
                    ItemName = longItem,
                    Rarity = "legendary",
                    State = "Sincronizando",
                    StateColor = ColMuted,
                    Locked = true,
                    Picked = i == 0,
                });
            }

            DetailView detail = new DetailView
            {
                Has = true,
                ItemId = itemId,
                SkinId = skin,
                Label = longName,
                Sub = longItem + " · Lendária",
                Rarity = "legendary",
                State = "Bloqueada",
                StateColor = ColRust,
                Expiry = "Expira em 6d (23/09/2026)",
                ExpiryColor = ColAmber,
                Description = new string('x', 280),
                Note = "Disponível na loja: https://origemz.com.br/loja/skins/categoria/armas/rifles",
                NoteColor = ColAmber,
            };

            TargetsView targets = new TargetsView
            {
                Token = token,
                ItemName = longItem,
                Page = 1,
                Pages = 3,
                Button = "JÁ APLICADA",
                Message = "Skin guardada: ela aparece quando você desligar o modo streamer.",
                MessageOk = true,
            };

            for (int i = 0; i < TargetsPageSize; i++)
            {
                targets.Rows.Add(new TargetRow
                {
                    Uid = 18446744073709551000uL + (ulong)i,
                    ItemId = itemId,
                    SkinId = skin,
                    Where = "Inventário",
                    Condition = 0.33f,
                    Ammo = 128,
                    Applied = true,
                    Selected = i == 0,
                });
            }

            string window = BuildWindow(token);
            string headJson = BuildHead(head);
            string sideJson = Pack(BuildSide(side), int.MaxValue)[0];
            string gridJson = Pack(BuildGrid(grid), int.MaxValue)[0];
            string detailJson = BuildDetail(detail);
            string targetsJson = BuildTargets(targets);

            // A abertura como o Redraw a manda: grade e lateral saem elemento
            // por elemento, e o Pack corta no limite. Medir a região inteira
            // num AddUI só acusaria um estouro que não acontece.
            List<string> firstParts = new List<string> { window, headJson };
            firstParts.AddRange(BuildSide(side));
            firstParts.Add(detailJson);
            List<string> secondParts = BuildGrid(grid);
            secondParts.Add(targetsJson);

            List<string> first = Pack(firstParts, AddUiByteLimit);
            List<string> second = Pack(secondParts, AddUiByteLimit);

            JObject regions = new JObject
            {
                ["window"] = Bytes(window),
                ["head"] = Bytes(headJson),
                ["side"] = Bytes(sideJson),
                ["grid"] = Bytes(gridJson),
                ["detail"] = Bytes(detailJson),
                ["targets"] = Bytes(targetsJson),
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

            bool under = true;
            foreach (JProperty property in regions.Properties())
            {
                if ((int)property.Value >= AddUiByteLimit) under = false;
            }

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["limit"] = AddUiByteLimit,
                ["regions"] = regions,
                ["open"] = sends,
                ["regionsUnderLimit"] = under,
                ["openUnderLimit"] = largest < AddUiByteLimit,
            };

            return reply.ToString(Formatting.None);
        }

        private static int Bytes(string text)
        {
            return Encoding.UTF8.GetByteCount(text);
        }

        // ============================================================
        //  §15  AUXILIARES
        // ============================================================

        /// <summary>O jogador, acordado ou dormindo.</summary>
        private static BasePlayer FindPlayer(string steamId)
        {
            ulong userId;
            if (!ulong.TryParse(steamId, NumberStyles.None, CultureInfo.InvariantCulture, out userId))
            {
                return null;
            }

            BasePlayer player = BasePlayer.FindByID(userId);
            return player != null ? player : BasePlayer.FindSleeping(userId);
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

        /// <summary>Texto que veio de fora não pode abrir tag de cor no chat.</summary>
        private static string Escape(string text)
        {
            return string.IsNullOrEmpty(text) ? "" : text.Replace("<", "‹").Replace(">", "›");
        }

        private static string Shorten(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length <= max ? text : text.Substring(0, max - 1) + "…";
        }

        /// <summary>Minúsculo e sem acento, para a pesquisa (03 §3.4).</summary>
        private static string Fold(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";

            string decomposed = text.ToLowerInvariant().Normalize(NormalizationForm.FormD);
            StringBuilder result = new StringBuilder(decomposed.Length);

            foreach (char ch in decomposed)
            {
                if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark)
                {
                    result.Append(ch);
                }
            }

            return result.ToString();
        }

        /// <summary>"3d", "5h" ou "40min".</summary>
        private static string Remaining(long ms)
        {
            if (ms <= 0) return "instantes";
            if (ms >= DayMs) return (long)Math.Ceiling(ms / (double)DayMs) + "d";

            long hours = (long)Math.Ceiling(ms / 3600000d);
            if (hours >= 2) return hours + "h";

            return Math.Max(1L, (long)Math.Ceiling(ms / 60000d)) + "min";
        }

        /// <summary>A data do vencimento, em UTC-3 (o horário do servidor da OrigemZ).</summary>
        private static string DateOf(long epochMs)
        {
            DateTime moment = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(epochMs).AddHours(-3);
            return moment.ToString("dd/MM", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// O que sobrou da linha, do argumento indicado em diante — o
        /// `RestOfLine` do OrigemZUI.cs. `arg.Args` NÃO é string[]: a
        /// leitura é sempre por GetString, e a junção é concatenação.
        /// </summary>
        private static string RestOfLine(ConsoleSystem.Arg arg, int first)
        {
            string text = "";

            for (int i = first; arg.HasArgs(i + 1); i++)
            {
                string piece = arg.GetString(i, "");
                text = text.Length == 0 ? piece : text + " " + piece;
            }

            return text.Trim();
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
        /// RCON e a quebra (MEDIDO no OrigemZTeam, 15/09/2026).
        /// </summary>
        private void Push(string kind, JObject data)
        {
            if (string.IsNullOrEmpty(_secret)) return;

            data["kind"] = kind;
            data["secret"] = _secret;

            string line = Marker + data.ToString(Formatting.None);

            timer.Once(0.1f, () => Puts(line));
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
