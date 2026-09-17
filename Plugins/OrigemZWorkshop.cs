// ============================================================
//  OrigemZWorkshop  -  as skins da OrigemZ, escolhidas pelo jogador.
//
//  ####  O QUE ELE FAZ, EM UMA FIGURA  ####
//
//      CADASTRO
//        /skin add "metal.facemask" "3802433262"      (admin)
//              ↓  confere item, número e duplicado aqui
//        #OZWORKSHOP#{"kind":"add",…}  →  agente
//              ↓  confere na Steam e grava no MESMO banco do painel
//        origemz.workshop.reply  →  a frase no chat do admin
//        origemz.workshop.sync   →  a skin já aparece na caixa
//
//      APLICAÇÃO
//        /skin          abre a caixa: o jogador põe o item, escolhe
//                       a skin na grade e tira o MESMO item pintado
//        /skin neve     pinta o que ele está vestindo (e a barra de
//                       atalhos) com as skins da coleção "neve"
//
//  ####  O ITEM É O MESMO OBJETO, E É ISSO QUE NÃO PERDE NADA  ####
//
//  Decisão do dono, 16/09/2026: preservar quantidade, condição,
//  munição, acessórios e o resto, sem duplicar e sem perder.
//
//  Este plugin NUNCA cria nem destrói item. Ele troca o número
//  `item.skin` do objeto que já existe — o mesmo `ApplySkinToItem`
//  da bancada de reparo (`RepairBench.cs:370-380`, MEDIDO em
//  16/09/2026). Tudo o que o item carrega continua nele porque ele
//  não foi trocado por outro. O caminho da vanilla que RECRIA o item
//  é só o do "redirect skin" (`RepairBench.cs:207-355`), e item de
//  redirect é recusado na porta da caixa.
//
//  O que sobra de risco é a caixa em si: um item dentro de um
//  container que não é de ninguém. Ver §6, "A CAIXA DEVOLVE SEMPRE".
//
//  ####  O SERVIDOR NUNCA SERVE A ARTE  ####
//
//  Ele manda um número de 64 bits e só. Quem não baixou a peça do
//  Workshop vê o item vanilla — e não há nada que este arquivo
//  possa fazer a respeito.
//
// ============================================================
//  ####  O CATÁLOGO É DO AGENTE; ESTE ARQUIVO GUARDA UMA CÓPIA  ####
//
//  A carga desce inteira pelo `origemz.workshop.sync` a cada boot e
//  a cada mudança no painel. A cópia em disco
//  (`oxide/data/OrigemZWorkshop/cache.json`) existe para uma coisa:
//  o servidor que reinicia com o agente fora do ar continuar com a
//  caixa funcionando. Ela é REESCRITA INTEIRA a cada carga — não há
//  edição local que possa divergir do banco —, e nunca guarda o
//  segredo.
//
//  ####  A CARGA VEM EM PEDAÇOS  ####
//
//      origemz.workshop.sync <lote> <i> <n> <pedaço base64>
//
//  Os pedaços do mesmo lote são juntados em ordem, e o catálogo só é
//  trocado quando o último chega. Lote incompleto é descartado: o
//  plugin fica com a carga velha, inteira. O formato antigo, de um
//  argumento só, continua aceito.
//
//  O Base64 não é capricho: MEDIDO no servidor, o parser de console
//  do Rust COME AS ASPAS de um JSON cru. Ver core/src/game/plugin-push.ts.
//
// ============================================================
//  ####  QUEM PODE USAR UMA SKIN  ####
//
//  Qualquer um destes libera — é um OU:
//
//    - a skin, ou a coleção dela, está marcada "para todos";
//    - o jogador tem a permissão da skin, ou a da coleção dela;
//    - há um acesso vivo para ele, ou para um grupo Oxide dele, na
//      skin ou na coleção dela;
//    - ele tem `origemzworkshop.admin`.
//
//  Acesso revogado ou vencido NÃO despinta o que já foi pintado: o
//  item pode estar numa caixa do outro lado do mapa, e seguir item
//  pelo mundo não cabe nesta feature. A partir dali ele só não
//  consegue pintar de novo.
//
// ============================================================
//  ####  ARMADILHAS MEDIDAS  ####
//
//  1. SKIN DIFERENTE NÃO EMPILHA (`Item.cs:1482`). Pintar uma pilha
//     de 100 pedras pinta as 100 — e elas não juntam mais com pedra
//     vanilla. É o jogo.
//
//  2. SKIN É GLOBAL, NÃO É POR ESPECTADOR (`Item.cs:1833`). A
//     proteção do modo streamer é DO PORTADOR: o item dele fica sem
//     skin enquanto ele está no ar. Ver §7.
//
//  3. REDIRECT SKIN É OUTRO ITEM (`ItemManager.cs:329-345`). Um id
//     de definição de inventário do Steam troca o ITEM inteiro; ele é
//     recusado no cadastro (`RejectsInventoryId`) e o item de redirect
//     é recusado na caixa.
//
//  4. NÃO HÁ VALIDAÇÃO DE POSSE server-side. O servidor aceita
//     QUALQUER `ulong`. O direito de uso é o do bloco acima.
//
// ============================================================
//  ####  O CONTRATO COM O AGENTE  ####
//
//  AGENTE → PLUGIN (resposta CASADA no POST /rcon):
//
//      origemz.workshop.sync <lote> <i> <n> <b64>  → {"ok":true,…}
//      origemz.workshop.status                     → {"ok":true,"skins":N,…}
//      origemz.workshop.reply <b64>                → {"ok":true}
//
//  PLUGIN → AGENTE, pelo console:
//
//      #OZWORKSHOP#{"kind":"ready"}                         SEM segredo
//      #OZWORKSHOP#{"kind":"applied","secret":…,"count":N}
//      #OZWORKSHOP#{"kind":"add","secret":…,"requestId":…,
//                   "steamId":…,"playerName":…,"shortname":…,"skinId":…}
//
//  Os campos são os de core/src/types/workshop.ts. Todo push que não
//  seja o `ready` carrega o segredo do `sync`: sem ele, um jogador
//  digita o marcador no chat e forja um cadastro.
//
//  E NENHUM `Puts` sai no frame em que um comando responde: ele
//  entra na resposta casada e a transforma em algo que não é JSON.
//  Por isso todo push passa por `timer.Once`.
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
    [Info("OrigemZWorkshop", "OrigemZ", "0.2.0")]
    [Description("Caixa de skins, coleções e cadastro de skins do Steam Workshop da OrigemZ.")]
    public class OrigemZWorkshop : RustPlugin
    {
        private const string Marker = "#OZWORKSHOP#";
        private const string SyncCommand = "origemz.workshop.sync";
        private const string StatusCommand = "origemz.workshop.status";
        private const string ReplyCommand = "origemz.workshop.reply";

        // Os botões da caixa. Digitados pelo CLIENTE, então conferem
        // tudo de novo: um jogador pode mandá-los pelo F1 com qualquer
        // argumento.
        private const string PickCommand = "origemz.skin.pick";
        private const string ResetCommand = "origemz.skin.reset";
        private const string PageCommand = "origemz.skin.page";

        private const string ChatCommandName = "skin";
        private const string AdminPermission = "origemzworkshop.admin";
        private const string CacheFile = "OrigemZWorkshop/cache";

        private const string UiRoot = "OZWorkshop.Box";

        /// <summary>Células da grade por página: 5 colunas × 3 linhas.</summary>
        private const int Columns = 5;
        private const int Rows = 3;
        private const int PageSize = Columns * Rows;

        /// <summary>Quanto o `/skin add` espera a resposta do agente.</summary>
        private const float AddTimeoutSeconds = 20f;

        private const string ColorGold = "0.77 0.71 0.33 1";
        private const string ColorText = "0.92 0.90 0.86 1";
        private const string ColorMuted = "0.62 0.60 0.56 1";

        // ============================================================
        //  §1  O CATÁLOGO
        // ============================================================

        private class SkinEntry
        {
            public int Id;
            public string Label = "";
            /// <summary>O item BASE do jogo, minúsculo.</summary>
            public string Shortname = "";
            /// <summary>`ulong`: não cabe em inteiro com sinal, e por isso viaja como texto.</summary>
            public ulong SkinId;
            /// <summary>Vazio = sem permissão própria. NÃO quer dizer "para todos".</summary>
            public string Permission = "";
            /// <summary>0 = avulsa.</summary>
            public int CollectionId;
            public bool OpenToAll;
            public bool HideInStreamer;
        }

        private class CollectionEntry
        {
            public int Id;
            public string Slug = "";
            public string Label = "";
            public string Permission = "";
            public bool OpenToAll;
        }

        private class GrantEntry
        {
            public bool ToGroup;
            /// <summary>SteamID64, ou o nome do grupo do Oxide.</summary>
            public string Subject = "";
            public bool ToCollection;
            public int TargetId;
            /// <summary>Epoch ms. 0 = permanente.</summary>
            public long ExpiresAt;
        }

        /// <summary>
        /// A carga inteira, já indexada.
        ///
        /// É montada NOVA a cada `sync` e só então trocada: limpar a
        /// velha antes e falhar no meio deixaria o servidor sem
        /// catálogo — e o agente acreditando que mandou um.
        /// </summary>
        private class Catalog
        {
            public readonly Dictionary<int, SkinEntry> ById = new Dictionary<int, SkinEntry>();

            /// <summary>shortname → as skins daquele item, em ordem de nome.</summary>
            public readonly Dictionary<string, List<SkinEntry>> ByShortname =
                new Dictionary<string, List<SkinEntry>>();

            /// <summary>
            /// workshop id → a entrada. É o que reconhece o que é NOSSO
            /// num item que já está na mochila, para o modo streamer não
            /// apagar uma skin que o jogador comprou.
            /// </summary>
            public readonly Dictionary<ulong, SkinEntry> BySkinId = new Dictionary<ulong, SkinEntry>();

            public readonly Dictionary<int, CollectionEntry> CollectionById =
                new Dictionary<int, CollectionEntry>();

            public readonly Dictionary<string, CollectionEntry> CollectionBySlug =
                new Dictionary<string, CollectionEntry>();

            /// <summary>id da coleção → shortname → a skin daquele item.</summary>
            public readonly Dictionary<int, Dictionary<string, SkinEntry>> CollectionItems =
                new Dictionary<int, Dictionary<string, SkinEntry>>();

            /// <summary>SteamID → os acessos daquele jogador.</summary>
            public readonly Dictionary<string, List<GrantEntry>> PlayerGrants =
                new Dictionary<string, List<GrantEntry>>();

            public readonly List<GrantEntry> GroupGrants = new List<GrantEntry>();

            public int GrantCount;
        }

        private Catalog _catalog = new Catalog();

        /// <summary>SteamID de quem está escondendo a logo agora, segundo o agente.</summary>
        private readonly HashSet<string> _streamers = new HashSet<string>();

        /// <summary>
        /// SteamID → (uid do item → a skin que a proteção do streamer
        /// TIROU dele), para vestir de volta quando ele sair do ar.
        ///
        /// Guarda o NÚMERO, e não só o uid: agora um item pode ter
        /// qualquer uma das várias skins do mesmo shortname, e o
        /// catálogo sozinho não diz qual era.
        ///
        /// Reload perde a lista — e perde no lado certo: o que some é
        /// a RESTAURAÇÃO (cosmética), nunca a PROTEÇÃO.
        /// </summary>
        private readonly Dictionary<string, Dictionary<ulong, ulong>> _strippedByPlayer =
            new Dictionary<string, Dictionary<ulong, ulong>>();

        /// <summary>O segredo do `sync`. Vazio = nenhum push sai daqui.</summary>
        private string _secret = "";

        // O lote de pedaços em montagem.
        private string _batchId = "";
        private int _batchExpected;
        private int _batchTotal;
        private readonly StringBuilder _batchData = new StringBuilder();

        /// <summary>
        /// Os itens que aceitam skin do Workshop, segundo o próprio
        /// jogo (`Skinnable.All`). `null` = o jogo não deu uma lista em
        /// que se possa confiar, e a conferência fica desligada.
        /// </summary>
        private HashSet<string> _skinnable;

        private readonly List<Item> _scratch = new List<Item>();

        // ============================================================
        //  §2  O BOOT
        // ============================================================

        private void Init()
        {
            // Registrada aqui, e não pelo catálogo: sem ela o admin não
            // consegue cadastrar a PRIMEIRA skin pelo jogo.
            permission.RegisterPermission(AdminPermission, this);
        }

        private void OnServerInitialized()
        {
            LoadSkinnables();
            LoadCache();

            // O handshake. Sem segredo de propósito: é ele que PEDE a
            // carga, e o segredo só existe depois que ela chega.
            Puts(Marker + "{\"kind\":\"ready\"}");
        }

        private void Unload()
        {
            // ####  NENHUM ITEM FICA PRESO NUMA CAIXA QUE VAI SUMIR  ####
            //
            // O container da caixa não é salvo com o mundo. Descarregar
            // o plugin (ou desligar o servidor, que descarrega todos)
            // com um item lá dentro seria o item sumindo.
            foreach (SkinBox box in new List<SkinBox>(_boxes.Values))
            {
                CloseBox(box, false);
            }

            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                CuiHelper.DestroyUi(player, UiRoot);
            }

            foreach (PendingAdd pending in _pendingAdds.Values)
            {
                if (pending.Timeout != null) pending.Timeout.Destroy();
            }

            _pendingAdds.Clear();
        }

        /// <summary>
        /// Monta o conjunto de itens que aceitam skin do Workshop.
        ///
        /// ####  A CONVENÇÃO É CONFERIDA ANTES DE SER USADA  ####
        ///
        /// MEDIDO no server01 em 16/09/2026: o `ItemName` do asset é o
        /// shortname (`metal.facemask`, `rifle.ak`, `rock`, `hoodie`
        /// casam; `stones` não aceita skin), e 160 entradas casam com
        /// itens reais. Mesmo assim o conjunto só é usado se ao menos
        /// parte dele casar: um update do Rust que mude a convenção
        /// faria esta conferência recusar TODO cadastro, em silêncio.
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
        //  §3  A CARGA  -  origemz.workshop.sync
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
                    encoded = CollectChunk(arg);

                    if (encoded == null)
                    {
                        return; // a resposta já foi dada
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

                string json = DecodeBase64(encoded);
                if (json == null)
                {
                    arg.ReplyWith(Fail("INVALID_BASE64", "O payload não é Base64 válido."));
                    return;
                }

                JObject payload;
                try
                {
                    payload = JObject.Parse(json);
                }
                catch (Exception)
                {
                    arg.ReplyWith(Fail("INVALID_JSON", "O payload não é JSON válido."));
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
        /// Guarda um pedaço. Devolve o base64 inteiro quando o lote
        /// fechou, ou `null` quando ainda falta (e já respondeu).
        /// </summary>
        private string CollectChunk(ConsoleSystem.Arg arg)
        {
            string batch = arg.GetString(0);
            int index = arg.GetInt(1, -1);
            int total = arg.GetInt(2, -1);
            string piece = arg.GetString(3);

            if (string.IsNullOrEmpty(batch) || index < 0 || total < 1 || index >= total || total > 200)
            {
                arg.ReplyWith(Fail("INVALID_ARGS", "Pedaço fora do contrato."));
                return null;
            }

            if (index == 0)
            {
                _batchId = batch;
                _batchExpected = 0;
                _batchTotal = total;
                _batchData.Length = 0;
            }

            // Pedaço de outro lote, ou fora de ordem: o lote em montagem
            // é descartado. O agente manda tudo de novo na próxima vez.
            if (batch != _batchId || index != _batchExpected || total != _batchTotal)
            {
                _batchId = "";
                _batchData.Length = 0;
                arg.ReplyWith(Fail("OUT_OF_ORDER", "Pedaço " + index + "/" + total + " fora de ordem."));
                return null;
            }

            _batchData.Append(piece);
            _batchExpected++;

            if (_batchExpected < _batchTotal)
            {
                JObject reply = new JObject
                {
                    ["ok"] = true,
                    ["pending"] = true,
                    ["part"] = index,
                };

                arg.ReplyWith(reply.ToString(Formatting.None));
                return null;
            }

            string whole = _batchData.ToString();
            _batchId = "";
            _batchData.Length = 0;

            return whole;
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

            // A caixa aberta de quem está com ela na mão reflete a carga
            // nova: uma skin que saiu não pode continuar clicável.
            foreach (SkinBox box in _boxes.Values)
            {
                DrawBox(box);
            }

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["count"] = next.ById.Count,
                ["collections"] = next.CollectionById.Count,
                ["grants"] = next.GrantCount,
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

            JArray collections = payload["collections"] as JArray;
            if (collections != null)
            {
                foreach (JToken token in collections)
                {
                    JObject row = token as JObject;
                    if (row == null) continue;

                    CollectionEntry entry = new CollectionEntry
                    {
                        Id = Int(row, "id"),
                        Slug = Text(row, "slug").ToLowerInvariant(),
                        Label = Text(row, "label"),
                        Permission = Text(row, "permission").ToLowerInvariant(),
                        OpenToAll = Flag(row, "openToAll", false),
                    };

                    if (entry.Id <= 0 || entry.Slug.Length == 0 || next.CollectionBySlug.ContainsKey(entry.Slug))
                    {
                        skipped.Add("coleção " + entry.Slug + "=invalid");
                        continue;
                    }

                    RegisterIfMissing(entry.Permission);
                    next.CollectionById[entry.Id] = entry;
                    next.CollectionBySlug[entry.Slug] = entry;
                    next.CollectionItems[entry.Id] = new Dictionary<string, SkinEntry>();
                }
            }

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

            foreach (List<SkinEntry> list in next.ByShortname.Values)
            {
                list.Sort((a, b) => string.Compare(a.Label, b.Label, StringComparison.OrdinalIgnoreCase));
            }

            JArray grants = payload["grants"] as JArray;
            if (grants != null)
            {
                foreach (JToken token in grants)
                {
                    JObject row = token as JObject;
                    if (row == null) continue;

                    GrantEntry grant = new GrantEntry
                    {
                        ToGroup = Text(row, "subjectType") == "group",
                        Subject = Text(row, "subject"),
                        ToCollection = Text(row, "targetType") == "collection",
                        TargetId = Int(row, "targetId"),
                        ExpiresAt = Long(row, "expiresAt"),
                    };

                    if (grant.Subject.Length == 0 || grant.TargetId <= 0)
                    {
                        continue;
                    }

                    if (grant.ToGroup)
                    {
                        grant.Subject = grant.Subject.ToLowerInvariant();
                        next.GroupGrants.Add(grant);
                    }
                    else
                    {
                        List<GrantEntry> list;
                        if (!next.PlayerGrants.TryGetValue(grant.Subject, out list))
                        {
                            list = new List<GrantEntry>();
                            next.PlayerGrants[grant.Subject] = list;
                        }

                        list.Add(grant);
                    }

                    next.GrantCount++;
                }
            }

            return next;
        }

        /// <summary>
        /// Lê uma skin. Devolve `null` se ela entrou, ou o motivo da
        /// recusa — um número errado não dá erro no jogo, o item só
        /// fica vanilla e ninguém descobre por quê.
        /// </summary>
        private string ReadSkin(JObject row, Catalog next)
        {
            string shortname = Text(row, "shortname").ToLowerInvariant();
            if (shortname.Length == 0) return "no_shortname";

            ItemDefinition def = ItemManager.FindItemDefinition(shortname);
            if (def == null) return "unknown_item";

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
                Label = Text(row, "label"),
                Shortname = shortname,
                SkinId = skinId,
                Permission = Text(row, "permission").ToLowerInvariant(),
                CollectionId = Int(row, "collectionId"),
                OpenToAll = Flag(row, "openToAll", false),
                HideInStreamer = Flag(row, "hideInStreamer", true),
            };

            if (entry.Label.Length == 0)
            {
                entry.Label = def.displayName.english;
            }

            // Coleção que não veio na carga (desligada, ou sem nada
            // aqui): a skin entra avulsa.
            if (entry.CollectionId > 0)
            {
                Dictionary<string, SkinEntry> items;
                if (!next.CollectionItems.TryGetValue(entry.CollectionId, out items))
                {
                    entry.CollectionId = 0;
                }
                else if (items.ContainsKey(shortname))
                {
                    return "duplicate_in_collection";
                }
                else
                {
                    items[shortname] = entry;
                }
            }

            RegisterIfMissing(entry.Permission);

            next.ById[id] = entry;

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

        /// <summary>
        /// Registrar duas vezes é aviso no console do Oxide, e a carga
        /// chega a cada reconexão de RCON. Permissão que SAIU do
        /// catálogo não tem API de remoção: fica inerte até o reload.
        /// </summary>
        private void RegisterIfMissing(string perm)
        {
            if (string.IsNullOrEmpty(perm)) return;

            if (!permission.PermissionExists(perm, this))
            {
                permission.RegisterPermission(perm, this);
            }
        }

        /// <summary>
        /// O número é um id de DEFINIÇÃO DE INVENTÁRIO do Steam, e não
        /// um workshop id? `ItemManager.TrySkinChangeItem` faz o mesmo
        /// cast `(int)` — acima de `int.MaxValue` ele nem procura.
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
                // O diretório LANÇA quando não abre. Não dá para
                // reprovar o cadastro do admin por causa disso.
                return false;
            }
        }

        // ---- a cópia em disco ------------------------------------

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

                ApplySync(JObject.Parse(data.Payload), false);
                Puts("Catálogo carregado do disco (" + _catalog.ById.Count + " skins). O agente " +
                     "manda a carga atual assim que conectar.");
            }
            catch (Exception cause)
            {
                PrintWarning("A cópia do catálogo em disco não abriu (" + cause.Message + "): " +
                             "a caixa fica vazia até o agente mandar a carga.");
            }
        }

        // ============================================================
        //  §4  status e reply
        // ============================================================

        [ConsoleCommand(StatusCommand)]
        private void CmdStatus(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["skins"] = _catalog.ById.Count,
                ["collections"] = _catalog.CollectionById.Count,
                ["grants"] = _catalog.GrantCount,
                ["streamers"] = _streamers.Count,
                ["openBoxes"] = _boxes.Count,
            };

            arg.ReplyWith(reply.ToString(Formatting.None));
        }

        /// <summary>A resposta do agente a um `/skin add`.</summary>
        [ConsoleCommand(ReplyCommand)]
        private void CmdReply(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            string json = arg.HasArgs(1) ? DecodeBase64(arg.GetString(0)) : null;
            if (json == null)
            {
                arg.ReplyWith(Fail("INVALID_ARGS", "Use: " + ReplyCommand + " <base64>"));
                return;
            }

            JObject body;
            try
            {
                body = JObject.Parse(json);
            }
            catch (Exception)
            {
                arg.ReplyWith(Fail("INVALID_JSON", "O payload não é JSON válido."));
                return;
            }

            string requestId = Text(body, "requestId");
            string steamId = Text(body, "steamId");
            bool ok = Flag(body, "ok", false);
            string message = Text(body, "message");

            PendingAdd pending;
            if (_pendingAdds.TryGetValue(requestId, out pending))
            {
                _pendingAdds.Remove(requestId);
                if (pending.Timeout != null) pending.Timeout.Destroy();
            }

            BasePlayer player = FindPlayer(steamId);
            if (player != null && player.IsConnected)
            {
                Tell(player, (ok ? "<color=#9fd67a>" : "<color=#e0776b>") + Escape(message) + "</color>");
            }

            arg.ReplyWith("{\"ok\":true}");
        }

        // ============================================================
        //  §5  O COMANDO /skin
        // ============================================================

        [ChatCommand(ChatCommandName)]
        private void CmdSkin(BasePlayer player, string command, string[] args)
        {
            if (player == null) return;

            if (args == null || args.Length == 0)
            {
                OpenBox(player);
                return;
            }

            string verb = args[0].Trim().ToLowerInvariant();

            if (verb == "add" || verb == "adicionar")
            {
                AddFromGame(player, args);
                return;
            }

            if (verb == "ajuda" || verb == "help" || verb == "lista" || verb == "list")
            {
                ShowHelp(player);
                return;
            }

            ApplyCollection(player, verb);
        }

        private void ShowHelp(BasePlayer player)
        {
            StringBuilder text = new StringBuilder();
            text.Append("<color=" + HexGold + ">Skins</color>\n");
            text.Append("/skin — abre a caixa: coloque o item e escolha a skin.\n");
            text.Append("/skin <coleção> — pinta o que você veste e a barra de atalhos.\n");

            List<string> mine = new List<string>();
            foreach (CollectionEntry collection in _catalog.CollectionById.Values)
            {
                if (CanUseCollection(player.UserIDString, collection))
                {
                    mine.Add("/skin " + collection.Slug + " (" + Escape(collection.Label) + ")");
                }
            }

            text.Append(mine.Count == 0
                ? "Nenhuma coleção liberada para você neste servidor."
                : "Suas coleções: " + string.Join(", ", mine.ToArray()));

            if (IsAdmin(player))
            {
                text.Append("\nAdmin: /skin add \"shortname\" \"workshop_id\"");
            }

            Tell(player, text.ToString());
        }

        // ---- /skin add ---------------------------------------------

        private class PendingAdd
        {
            public string SteamId = "";
            public Timer Timeout;
        }

        private readonly Dictionary<string, PendingAdd> _pendingAdds = new Dictionary<string, PendingAdd>();

        private bool IsAdmin(BasePlayer player)
        {
            return player.IsAdmin || permission.UserHasPermission(player.UserIDString, AdminPermission);
        }

        /// <summary>
        /// `/skin add "shortname" "workshop_id"`.
        ///
        /// Confere aqui tudo o que o jogo sabe — o item existe, aceita
        /// skin, o número é um workshop id, a marca ainda não está no
        /// catálogo — e manda o resto ao agente, que confere a Steam e
        /// grava no MESMO banco do painel. Este plugin nunca grava a
        /// skin sozinho: a cópia local só muda quando a carga volta.
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

            ItemDefinition def = ItemManager.FindItemDefinition(shortname);
            if (def == null)
            {
                Tell(player, "O item \"" + Escape(shortname) + "\" não existe. Use o shortname do jogo " +
                             "(ex.: metal.facemask, rifle.ak).");
                return;
            }

            if (def.isRedirectOf != null)
            {
                Tell(player, "\"" + shortname + "\" é uma variante de \"" + def.isRedirectOf.shortname +
                             "\". Cadastre a skin no item original.");
                return;
            }

            if (_skinnable != null && !_skinnable.Contains(shortname))
            {
                Tell(player, "\"" + shortname + "\" não aceita skin do Workshop.");
                return;
            }

            ulong skinId;
            if (!ulong.TryParse(rawId, NumberStyles.None, CultureInfo.InvariantCulture, out skinId) ||
                skinId == 0uL || rawId.StartsWith("0"))
            {
                Tell(player, "\"" + Escape(rawId) + "\" não é um Workshop ID. É o número no fim da URL " +
                             "da oficina: ...filedetails/?id=<número>.");
                return;
            }

            if (RejectsInventoryId(skinId))
            {
                Tell(player, rawId + " é um item do inventário Steam, e não um Workshop ID.");
                return;
            }

            List<SkinEntry> sameItem;
            if (_catalog.ByShortname.TryGetValue(shortname, out sameItem))
            {
                foreach (SkinEntry existing in sameItem)
                {
                    if (existing.SkinId == skinId)
                    {
                        Tell(player, "Essa skin já está cadastrada: \"" + Escape(existing.Label) +
                                     "\" (#" + existing.Id + ").");
                        return;
                    }
                }
            }

            if (string.IsNullOrEmpty(_secret))
            {
                Tell(player, "O agente ainda não conectou neste servidor. Tente de novo em instantes.");
                return;
            }

            string requestId = Guid.NewGuid().ToString("N").Substring(0, 16);
            string steamId = player.UserIDString;

            PendingAdd pending = new PendingAdd { SteamId = steamId };
            pending.Timeout = timer.Once(AddTimeoutSeconds, () =>
            {
                _pendingAdds.Remove(requestId);

                BasePlayer again = FindPlayer(steamId);
                if (again != null && again.IsConnected)
                {
                    Tell(again, "<color=#e0776b>O agente não respondeu ao cadastro de " + shortname + " " +
                                rawId + ". Confira no painel antes de tentar de novo.</color>");
                }
            });

            _pendingAdds[requestId] = pending;

            JObject data = new JObject
            {
                ["requestId"] = requestId,
                ["steamId"] = steamId,
                ["playerName"] = player.displayName ?? "",
                ["shortname"] = shortname,
                ["skinId"] = skinId.ToString(CultureInfo.InvariantCulture),
            };

            Push("add", data);

            Tell(player, "Cadastrando " + Escape(def.displayName.english) + " / " + rawId +
                         "… conferindo o Workshop ID na Steam.");
        }

        // ---- /skin <coleção> ---------------------------------------

        /// <summary>
        /// Pinta o que o jogador VESTE, e a barra de atalhos, com as
        /// skins da coleção.
        ///
        /// A barra entra porque uma coleção pode ter arma: sem ela, a
        /// AK da "neve" nunca seria pintada por este comando.
        /// </summary>
        private void ApplyCollection(BasePlayer player, string slug)
        {
            CollectionEntry collection;
            if (!_catalog.CollectionBySlug.TryGetValue(slug, out collection))
            {
                Tell(player, "Não existe a coleção \"" + Escape(slug) + "\" neste servidor. " +
                             "Use /skin ajuda para ver as suas.");
                return;
            }

            string steamId = player.UserIDString;

            if (!CanUseCollection(steamId, collection))
            {
                Tell(player, "Você não tem acesso à coleção \"" + Escape(collection.Label) + "\".");
                return;
            }

            if (player.IsDead() || player.inventory == null)
            {
                return;
            }

            Dictionary<string, SkinEntry> items;
            if (!_catalog.CollectionItems.TryGetValue(collection.Id, out items) || items.Count == 0)
            {
                Tell(player, "A coleção \"" + Escape(collection.Label) + "\" está vazia neste servidor.");
                return;
            }

            bool onAir = _streamers.Contains(steamId);
            int changed = 0;
            int already = 0;
            int hidden = 0;

            _scratch.Clear();
            _scratch.AddRange(player.inventory.containerWear.itemList);
            _scratch.AddRange(player.inventory.containerBelt.itemList);

            for (int i = 0; i < _scratch.Count; i++)
            {
                Item item = _scratch[i];
                if (item == null || item.info == null || item.info.isRedirectOf != null) continue;

                SkinEntry entry;
                if (!items.TryGetValue(item.info.shortname, out entry)) continue;

                if (item.skin == entry.SkinId)
                {
                    already++;
                    continue;
                }

                if (onAir && entry.HideInStreamer)
                {
                    hidden++;
                    continue;
                }

                ApplySkinToItem(item, entry.SkinId);
                changed++;
            }

            _scratch.Clear();

            StringBuilder text = new StringBuilder();
            text.Append("<color=" + HexGold + ">" + Escape(collection.Label) + "</color>: ");
            text.Append(changed == 1 ? "1 item alterado." : changed + " itens alterados.");

            if (already > 0)
            {
                text.Append(" " + already + (already == 1 ? " já estava" : " já estavam") + " com a skin.");
            }

            if (hidden > 0)
            {
                text.Append(" " + hidden + " ficou sem a skin porque você está em modo streamer.");
            }

            if (changed == 0 && already == 0 && hidden == 0)
            {
                List<string> names = new List<string>();
                foreach (string shortname in items.Keys)
                {
                    ItemDefinition def = ItemManager.FindItemDefinition(shortname);
                    names.Add(def == null ? shortname : def.displayName.english);
                }

                text.Append(" Vista ou coloque na barra: " + string.Join(", ", names.ToArray()) + ".");
            }

            Tell(player, text.ToString());
        }

        // ============================================================
        //  §6  A CAIXA
        //
        //  ####  A CAIXA DEVOLVE SEMPRE  ####
        //
        //  O container da caixa não é de entidade nenhuma e não é salvo
        //  com o mundo. Todo caminho que fecha a caixa passa por
        //  `CloseBox`, e ele devolve o que estiver dentro: para a
        //  mochila, para a barra e, sem espaço, para o chão aos pés do
        //  jogador. Os caminhos são:
        //
        //    - o jogador fecha o painel         OnPlayerLootEnd
        //    - morre / desconecta / cai          os hooks abaixo
        //    - o plugin descarrega               Unload
        //    - qualquer outro jeito de o jogo
        //      largar o painel                   o relógio de 1 s
        //
        //  O relógio é a rede de segurança: ele não sabe POR QUE o
        //  container saiu da lista de loot do jogador, só que saiu.
        //
        //  ####  POR QUE O `entitySource` É O RelationshipManager  ####
        //
        //  O painel de loot do cliente precisa de uma entidade que ele
        //  conheça e que o servidor aceite como "lootável". Uma caixa
        //  de madeira spawnada abaixo do mapa funciona, mas é uma
        //  entidade de verdade: pode ser salva, decair ou ser achada.
        //  O `RelationshipManager.ServerInstance` existe sempre, é
        //  visto por todos, e é o que o Vanish usa em produção para o
        //  mesmo truque (Plugins/Vanish.cs:828-832). Com
        //  `PositionChecks = false` a distância não fecha o painel.
        // ============================================================

        private class SkinBox
        {
            public BasePlayer Player;
            public ulong UserId;
            public ItemContainer Container;
            public int Page;
            public Timer Watch;
            public bool Closing;
            /// <summary>Onde soltar o item se o jogador sumir.</summary>
            public Vector3 LastPosition;
            public float NextRefuseTip;
        }

        private readonly Dictionary<ulong, SkinBox> _boxes = new Dictionary<ulong, SkinBox>();

        private void OpenBox(BasePlayer player)
        {
            if (player.IsDead() || player.IsSleeping() || player.IsWounded() || player.inventory == null)
            {
                Tell(player, "Você não pode abrir a caixa de skins agora.");
                return;
            }

            SkinBox previous;
            if (_boxes.TryGetValue(player.userID, out previous))
            {
                CloseBox(previous, true);
            }

            ItemContainer container = new ItemContainer();
            container.ServerInitialize(null, 1);
            container.GiveUID();
            container.allowedContents = ItemContainer.ContentsType.Generic;

            SkinBox box = new SkinBox
            {
                Player = player,
                UserId = player.userID,
                Container = container,
                LastPosition = player.transform.position,
            };

            container.canAcceptItem = (who, item, slot) => CanPutInBox(box, item);
            container.onItemAddedRemoved = (item, added) =>
            {
                // O jogo ainda está no meio do movimento: desenhar no
                // próximo frame, com o container já assentado.
                box.Page = 0;
                NextTick(() => DrawBox(box));
            };

            _boxes[player.userID] = box;

            PlayerLoot loot = player.inventory.loot;
            loot.Clear();
            loot.PositionChecks = false;
            loot.entitySource = RelationshipManager.ServerInstance;
            loot.itemSource = null;
            loot.AddContainer(container);
            loot.MarkDirty();
            loot.SendImmediate();

            player.ClientRPC(RpcTarget.Player("RPC_OpenLootPanel", player), "generic_resizable");

            box.Watch = timer.Every(1f, () => WatchBox(box));

            DrawBox(box);
        }

        private void WatchBox(SkinBox box)
        {
            BasePlayer player = box.Player;

            if (player != null && !player.IsDestroyed)
            {
                box.LastPosition = player.transform.position;
            }

            if (player == null || player.IsDestroyed || !player.IsConnected || player.IsDead() ||
                player.inventory == null || !player.inventory.loot.containers.Contains(box.Container))
            {
                CloseBox(box, false);
            }
        }

        /// <summary>
        /// A porta da caixa: só entra item que tem skin que ESTE
        /// jogador pode aplicar.
        ///
        /// O jogo chama isto a cada tentativa de soltar o item — a
        /// dica no chat tem um intervalo para não virar enxurrada.
        /// </summary>
        private bool CanPutInBox(SkinBox box, Item item)
        {
            if (box.Closing || item == null || item.info == null) return false;

            string refusal = null;

            if (item.info.isRedirectOf != null)
            {
                refusal = "Este item é uma variante especial e não aceita skin da caixa.";
            }
            else if (CountUsable(box.Player, item.info.shortname) == 0)
            {
                refusal = "Nenhuma skin sua para " + item.info.displayName.english + ".";
            }

            if (refusal == null) return true;

            if (box.Player != null && Time.realtimeSinceStartup >= box.NextRefuseTip)
            {
                box.NextRefuseTip = Time.realtimeSinceStartup + 2f;
                Tell(box.Player, refusal);
            }

            return false;
        }

        private void CloseBox(SkinBox box, bool closePanel)
        {
            if (box.Closing) return;

            box.Closing = true;

            SkinBox current;
            if (_boxes.TryGetValue(box.UserId, out current) && current == box)
            {
                _boxes.Remove(box.UserId);
            }

            if (box.Watch != null) box.Watch.Destroy();

            BasePlayer player = box.Player;

            if (player != null && !player.IsDestroyed)
            {
                CuiHelper.DestroyUi(player, UiRoot);
            }

            ReturnItems(box);

            if (closePanel && player != null && !player.IsDestroyed && player.inventory != null &&
                player.inventory.loot.containers.Contains(box.Container))
            {
                // Chama OnPlayerLootEnd de novo: o `Closing` segura.
                player.inventory.loot.Clear();
                player.inventory.loot.SendImmediate();
            }

            box.Container.onItemAddedRemoved = null;
            box.Container.canAcceptItem = null;

            // ####  O `Kill` DESTRÓI O QUE ESTIVER DENTRO  ####
            //
            // MEDIDO: `ItemContainer.Kill` termina em `Clear()`, que
            // remove os itens do mundo. Ele só roda com a caixa vazia —
            // e no próximo frame, porque o `OnPlayerLootEnd` chega no
            // meio do `PlayerLoot.Clear`, que ainda percorre a lista.
            ItemContainer container = box.Container;

            NextTick(() =>
            {
                if (container.itemList != null && container.itemList.Count > 0)
                {
                    PrintError("A caixa de skins de " + box.UserId + " fechou com " +
                               container.itemList.Count + " item(ns) dentro: soltando no chão.");

                    foreach (Item left in new List<Item>(container.itemList))
                    {
                        left.Drop(box.LastPosition + Vector3.up, Vector3.zero);
                    }
                }

                if (container.itemList == null || container.itemList.Count == 0)
                {
                    container.Kill();
                }
            });
        }

        /// <summary>
        /// Devolve o que estiver na caixa. NUNCA deixa item dentro.
        ///
        /// A conferência é pelo `parent` depois de cada tentativa, e não
        /// pelo retorno do `GiveItem`: o jogo pode empilhar uma parte e
        /// devolver `false` com o resto ainda aqui dentro.
        /// </summary>
        private void ReturnItems(SkinBox box)
        {
            if (box.Container == null || box.Container.itemList == null) return;

            List<Item> inside = new List<Item>(box.Container.itemList);
            BasePlayer player = box.Player;
            bool canReceive = player != null && !player.IsDestroyed && !player.IsDead() && player.inventory != null;

            foreach (Item item in inside)
            {
                if (item == null) continue;

                if (canReceive)
                {
                    player.inventory.GiveItem(item);
                }

                if (item.parent != box.Container) continue;

                Vector3 position = canReceive ? player.GetDropPosition() : box.LastPosition + Vector3.up;
                Vector3 velocity = canReceive ? player.GetDropVelocity() : Vector3.zero;

                item.Drop(position, velocity);

                if (canReceive)
                {
                    Tell(player, "Sua mochila estava cheia: o item da caixa de skins caiu aos seus pés.");
                }
            }
        }

        private void OnPlayerLootEnd(PlayerLoot loot)
        {
            if (loot == null) return;

            BasePlayer player = loot.baseEntity;
            if (player == null) return;

            SkinBox box;
            if (_boxes.TryGetValue(player.userID, out box) && loot.containers.Contains(box.Container))
            {
                CloseBox(box, false);
            }
        }

        private void OnPlayerDeath(BasePlayer player, HitInfo info)
        {
            // ANTES do cadáver: o item volta para a mochila e cai junto
            // com ela, como qualquer outro.
            CloseBoxOf(player);
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            CloseBoxOf(player);
        }

        private void OnPlayerWound(BasePlayer player, HitInfo info)
        {
            CloseBoxOf(player);
        }

        private void CloseBoxOf(BasePlayer player)
        {
            if (player == null) return;

            SkinBox box;
            if (_boxes.TryGetValue(player.userID, out box))
            {
                CloseBox(box, true);
            }
        }

        // ---- os botões ---------------------------------------------

        [ConsoleCommand(PickCommand)]
        private void CmdPick(ConsoleSystem.Arg arg)
        {
            BasePlayer player = arg.Player();
            SkinBox box = BoxOf(player);
            if (box == null) return;

            Item item = box.Container.GetSlot(0);
            if (item == null || item.info == null) return;

            SkinEntry entry;
            if (!_catalog.ById.TryGetValue(arg.GetInt(0, 0), out entry)) return;

            // O botão pode ter sido desenhado para outro item, ou antes
            // de o acesso cair. Tudo é conferido de novo.
            if (entry.Shortname != item.info.shortname || item.info.isRedirectOf != null) return;

            if (!CanUseSkin(player.UserIDString, entry))
            {
                Tell(player, "Você não tem acesso a esta skin.");
                return;
            }

            if (entry.HideInStreamer && _streamers.Contains(player.UserIDString))
            {
                Tell(player, "Você está em modo streamer: esta skin fica escondida até você sair do ar.");
                return;
            }

            if (item.skin != entry.SkinId)
            {
                ApplySkinToItem(item, entry.SkinId);
            }

            DrawBox(box);
        }

        [ConsoleCommand(ResetCommand)]
        private void CmdReset(ConsoleSystem.Arg arg)
        {
            SkinBox box = BoxOf(arg.Player());
            if (box == null) return;

            Item item = box.Container.GetSlot(0);
            if (item == null || item.skin == 0uL) return;

            ApplySkinToItem(item, 0uL);
            DrawBox(box);
        }

        [ConsoleCommand(PageCommand)]
        private void CmdPage(ConsoleSystem.Arg arg)
        {
            SkinBox box = BoxOf(arg.Player());
            if (box == null) return;

            box.Page = Math.Max(0, arg.GetInt(0, 0));
            DrawBox(box);
        }

        private SkinBox BoxOf(BasePlayer player)
        {
            if (player == null) return null;

            SkinBox box;
            if (!_boxes.TryGetValue(player.userID, out box) || box.Closing) return null;

            return box;
        }

        // ---- a tela ------------------------------------------------

        /// <summary>
        /// As skins daquele item que o jogador pode aplicar.
        /// </summary>
        private List<SkinEntry> UsableSkins(BasePlayer player, string shortname)
        {
            List<SkinEntry> result = new List<SkinEntry>();
            List<SkinEntry> all;

            if (player == null || !_catalog.ByShortname.TryGetValue(shortname, out all)) return result;

            string steamId = player.UserIDString;

            foreach (SkinEntry entry in all)
            {
                if (CanUseSkin(steamId, entry)) result.Add(entry);
            }

            return result;
        }

        private int CountUsable(BasePlayer player, string shortname)
        {
            return UsableSkins(player, shortname).Count;
        }

        /// <summary>
        /// Desenha a grade à ESQUERDA do painel de loot, acima da
        /// mochila.
        ///
        /// ####  A POSIÇÃO FOI ESTIMADA, NÃO MEDIDA NO CLIENTE  ####
        ///
        /// Âncora no pé da tela, centro — o mesmo referencial do
        /// inventário do jogo —, e deslocamentos em pixels da tela de
        /// referência de 1280×720. O painel de loot ocupa a coluna da
        /// direita a partir de x ≈ +192; a grade fica na mesma coluna,
        /// acima do slot da caixa. Se ela encavalar em alguma
        /// resolução, os números a mexer são os de `OffsetMin/Max` do
        /// painel-raiz, e só eles.
        /// </summary>
        private void DrawBox(SkinBox box)
        {
            BasePlayer player = box.Player;
            if (box.Closing || player == null || player.IsDestroyed || !player.IsConnected) return;

            CuiHelper.DestroyUi(player, UiRoot);

            CuiElementContainer ui = new CuiElementContainer();

            string root = ui.Add(new CuiPanel
            {
                Image = { Color = "0.08 0.08 0.08 0.92" },
                RectTransform =
                {
                    AnchorMin = "0.5 0", AnchorMax = "0.5 0",
                    OffsetMin = "192 118", OffsetMax = "572 470",
                },
                CursorEnabled = false,
            }, "Overlay", UiRoot);

            Item item = box.Container.GetSlot(0);

            string title = item == null
                ? "SKINS — coloque um item no slot abaixo"
                : "SKINS — " + item.info.displayName.english.ToUpperInvariant();

            ui.Add(new CuiLabel
            {
                Text = { Text = title, FontSize = 13, Align = TextAnchor.MiddleLeft, Color = ColorGold },
                RectTransform = { AnchorMin = "0.03 0.90", AnchorMax = "0.97 0.99" },
            }, root);

            if (item == null)
            {
                ui.Add(new CuiLabel
                {
                    Text =
                    {
                        Text = "Arraste da mochila o item que quer pintar.\n" +
                               "Só entram itens que têm skin liberada para você.\n\n" +
                               "O item é o MESMO: quantidade, condição, munição e acessórios " +
                               "continuam nele. Feche a caixa para pegá-lo de volta.",
                        FontSize = 11,
                        Align = TextAnchor.MiddleCenter,
                        Color = ColorMuted,
                    },
                    RectTransform = { AnchorMin = "0.05 0.1", AnchorMax = "0.95 0.88" },
                }, root);

                CuiHelper.AddUi(player, ui);
                return;
            }

            List<SkinEntry> options = UsableSkins(player, item.info.shortname);
            int pages = Math.Max(1, (options.Count + PageSize - 1) / PageSize);
            if (box.Page >= pages) box.Page = pages - 1;

            const float gridTop = 0.88f;
            const float gridBottom = 0.12f;
            float cellW = 1f / Columns;
            float cellH = (gridTop - gridBottom) / Rows;

            int start = box.Page * PageSize;
            int end = Math.Min(options.Count, start + PageSize);

            for (int i = start; i < end; i++)
            {
                SkinEntry entry = options[i];
                int n = i - start;
                int col = n % Columns;
                int row = n / Columns;

                float x0 = col * cellW + 0.01f;
                float x1 = (col + 1) * cellW - 0.01f;
                float y1 = gridTop - row * cellH - 0.01f;
                float y0 = gridTop - (row + 1) * cellH + 0.01f;

                bool selected = item.skin == entry.SkinId;

                string cell = ui.Add(new CuiPanel
                {
                    Image = { Color = selected ? "0.77 0.71 0.33 0.35" : "0.2 0.2 0.2 0.8" },
                    RectTransform = { AnchorMin = F(x0) + " " + F(y0), AnchorMax = F(x1) + " " + F(y1) },
                }, root);

                // O ícone com a skin: o CLIENTE desenha a arte do
                // Workshop a partir do par (item, skin).
                ui.Add(new CuiElement
                {
                    Name = CuiHelper.GetGuid(),
                    Parent = cell,
                    Components =
                    {
                        new CuiImageComponent { ItemId = item.info.itemid, SkinId = entry.SkinId },
                        new CuiRectTransformComponent { AnchorMin = "0.18 0.3", AnchorMax = "0.82 0.97" },
                    },
                });

                ui.Add(new CuiLabel
                {
                    Text =
                    {
                        Text = Shorten(entry.Label, 18),
                        FontSize = 8,
                        Align = TextAnchor.MiddleCenter,
                        Color = selected ? ColorGold : ColorText,
                    },
                    RectTransform = { AnchorMin = "0.02 0.02", AnchorMax = "0.98 0.3" },
                }, cell);

                ui.Add(new CuiButton
                {
                    Button = { Command = PickCommand + " " + entry.Id, Color = "0 0 0 0" },
                    RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1" },
                    Text = { Text = "" },
                }, cell);
            }

            // O rodapé: tirar a skin e as páginas.
            ui.Add(new CuiButton
            {
                Button = { Command = ResetCommand, Color = item.skin == 0uL ? "0.2 0.2 0.2 0.5" : "0.45 0.2 0.18 0.9" },
                RectTransform = { AnchorMin = "0.02 0.015", AnchorMax = "0.3 0.1" },
                Text = { Text = "Sem skin", FontSize = 11, Align = TextAnchor.MiddleCenter, Color = ColorText },
            }, root);

            if (pages > 1)
            {
                ui.Add(new CuiButton
                {
                    Button = { Command = PageCommand + " " + (box.Page - 1), Color = "0.2 0.2 0.2 0.9" },
                    RectTransform = { AnchorMin = "0.55 0.015", AnchorMax = "0.66 0.1" },
                    Text = { Text = "<", FontSize = 13, Align = TextAnchor.MiddleCenter, Color = ColorText },
                }, root);

                ui.Add(new CuiLabel
                {
                    Text =
                    {
                        Text = (box.Page + 1) + " / " + pages,
                        FontSize = 11,
                        Align = TextAnchor.MiddleCenter,
                        Color = ColorMuted,
                    },
                    RectTransform = { AnchorMin = "0.66 0.015", AnchorMax = "0.86 0.1" },
                }, root);

                ui.Add(new CuiButton
                {
                    Button = { Command = PageCommand + " " + (box.Page + 1), Color = "0.2 0.2 0.2 0.9" },
                    RectTransform = { AnchorMin = "0.86 0.015", AnchorMax = "0.97 0.1" },
                    Text = { Text = ">", FontSize = 13, Align = TextAnchor.MiddleCenter, Color = ColorText },
                }, root);
            }
            else
            {
                ui.Add(new CuiLabel
                {
                    Text =
                    {
                        Text = options.Count == 1 ? "1 skin" : options.Count + " skins",
                        FontSize = 11,
                        Align = TextAnchor.MiddleRight,
                        Color = ColorMuted,
                    },
                    RectTransform = { AnchorMin = "0.5 0.015", AnchorMax = "0.97 0.1" },
                }, root);
            }

            CuiHelper.AddUi(player, ui);
        }

        // ============================================================
        //  §7  O MODO STREAMER, AO VIVO
        // ============================================================

        /// <summary>
        /// Troca a lista de quem está no ar e age sobre QUEM MUDOU.
        ///
        /// AUSENTE NÃO É VAZIO: `streamers` fora da carga quer dizer
        /// "o agente não me disse", e a lista fica como está.
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
        /// Entrou no ar: tirar dos itens dele o que é NOSSO e está
        /// marcado para sumir. O que é nosso é reconhecido pelo
        /// `BySkinId` — uma skin que ele comprou nunca é tocada.
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
        /// Saiu do ar: vestir de volta SÓ o que nós tiramos, com o
        /// número que cada item tinha. Item que trocou de dono ou virou
        /// pilha com outro some da lista sem drama.
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

                // A skin ainda precisa existir no catálogo: devolver uma
                // que o painel apagou seria o plugin passando por cima.
                if (!_catalog.BySkinId.ContainsKey(skin)) continue;

                ApplySkinToItem(item, skin);
            }

            _scratch.Clear();
        }

        // ============================================================
        //  §8  A REGRA DE ACESSO
        // ============================================================

        private bool CanUseSkin(string steamId, SkinEntry entry)
        {
            if (entry.OpenToAll) return true;
            if (HasPermission(steamId, AdminPermission)) return true;
            if (entry.Permission.Length > 0 && HasPermission(steamId, entry.Permission)) return true;
            if (HasGrant(steamId, false, entry.Id)) return true;

            CollectionEntry collection;
            if (entry.CollectionId > 0 && _catalog.CollectionById.TryGetValue(entry.CollectionId, out collection))
            {
                return CanUseCollection(steamId, collection);
            }

            return false;
        }

        private bool CanUseCollection(string steamId, CollectionEntry collection)
        {
            if (collection.OpenToAll) return true;
            if (HasPermission(steamId, AdminPermission)) return true;
            if (collection.Permission.Length > 0 && HasPermission(steamId, collection.Permission)) return true;

            return HasGrant(steamId, true, collection.Id);
        }

        private bool HasPermission(string steamId, string perm)
        {
            return permission.UserHasPermission(steamId, perm);
        }

        /// <summary>
        /// Um acesso VIVO para o jogador ou para um grupo dele.
        ///
        /// O prazo é conferido aqui, na hora: o agente reenvia a carga
        /// quando um vence, mas o jogador não pode ganhar uma janela se
        /// o RCON estiver caído nesse instante.
        /// </summary>
        private bool HasGrant(string steamId, bool toCollection, int targetId)
        {
            long now = NowMs();

            List<GrantEntry> mine;
            if (_catalog.PlayerGrants.TryGetValue(steamId, out mine))
            {
                foreach (GrantEntry grant in mine)
                {
                    if (Matches(grant, toCollection, targetId, now)) return true;
                }
            }

            foreach (GrantEntry grant in _catalog.GroupGrants)
            {
                if (Matches(grant, toCollection, targetId, now) &&
                    permission.UserHasGroup(steamId, grant.Subject))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool Matches(GrantEntry grant, bool toCollection, int targetId, long now)
        {
            return grant.ToCollection == toCollection &&
                   grant.TargetId == targetId &&
                   (grant.ExpiresAt == 0 || grant.ExpiresAt > now);
        }

        // ============================================================
        //  §9  AUXILIARES
        // ============================================================

        /// <summary>
        /// O padrão da vanilla para trocar a skin de um item que JÁ
        /// existe — `RepairBench.cs:370-380`, MEDIDO em 16/09/2026.
        ///
        /// As quatro linhas importam: sem `MarkDirty` o cliente nunca
        /// vê; sem o `heldEntity` o ÍCONE muda e o modelo na mão fica
        /// o antigo (`HeldEntity.OnItemChanged` não toca em skin).
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
        }

        /// <summary>O jogador, acordado ou dormindo.</summary>
        private BasePlayer FindPlayer(string steamId)
        {
            ulong userId;
            if (!ulong.TryParse(steamId, NumberStyles.None, CultureInfo.InvariantCulture, out userId))
            {
                return null;
            }

            BasePlayer player = BasePlayer.FindByID(userId);
            return player != null ? player : BasePlayer.FindSleeping(userId);
        }

        private const string HexGold = "#c4b554";

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
        /// Um `Puts` disparado dentro do handler entra na resposta
        /// casada do RCON e a quebra (MEDIDO no OrigemZTeam, 15/09/2026).
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

        private static string DecodeBase64(string encoded)
        {
            if (string.IsNullOrEmpty(encoded)) return null;

            try
            {
                return Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
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
