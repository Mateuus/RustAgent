// ============================================================
//  OrigemZWorkshop  -  o item que já nasce com a nossa cara.
//
//  ####  O QUE ELE FAZ, EM UMA FIGURA  ####
//
//        o jogador nasce
//              ↓
//        o jogo entrega a pedra e a tocha (GiveDefaultItems)
//              ↓
//        este plugin olha o que caiu na mão dele
//              ↓
//        item no catálogo + jogador com a permissão
//        + (a skin não se esconde no streamer OU ele não está no ar)
//              ↓
//        item.skin = <workshop id da OrigemZ>
//              ↓
//        o CLIENTE do jogador baixa o modelo do Steam Workshop
//
//  O servidor NUNCA serve a arte. Ele manda um número de 64 bits e
//  só. Quem não baixou a peça do Workshop vê o item vanilla — e não
//  há nada que este arquivo possa fazer a respeito.
//
//  ####  ELE NÃO TEM INTERFACE, E ISSO É DECISÃO DO DONO  ####
//
//  Decisão do dono, 16/09/2026: o jogador NÃO aplica skin. Não há
//  menu, não há comando, não há caixa de skin. O item já nasce com
//  ela. Ver Docs/OrigemZWorkshop/00-LEVANTAMENTO.md §6.
//
//  ####  O CATÁLOGO NÃO MORA AQUI  ####
//
//  Ele desce inteiro pelo `origemz.workshop.sync`, a cada boot e a
//  cada mudança no painel. Não há config, não há data file: o padrão
//  do projeto é o estado viajar com o comando (ver
//  core/src/game/plugin-push.ts e core/src/game/koth.ts). Um arquivo
//  em disco aqui seria uma segunda verdade, e ela divergiria do
//  banco no primeiro reload.
//
//  Enquanto o `sync` não chega, o catálogo está VAZIO e nenhum item
//  é carimbado. É o estado seguro: o pior que acontece é o jogador
//  nascer com a pedra do jogo.
//
// ============================================================
//  ####  POR QUE O HOOK É O `OnDefaultItemsReceived` (COM "D")  ####
//
//  MEDIDO em 16/09/2026, decompilando
//  Servers/server01/.../Assembly-CSharp.dll (`PlayerInventory.cs`,
//  protocolo 288):
//
//      :1673  OnDefaultItemsReceive    ← CANCELÁVEL. Não-nulo e a
//                                        vanilla devolve ANTES do
//                                        Strip(): ninguém ganha nada.
//      :1677  Strip()
//      :1678  game mode com loadout → LoadoutPlayer e RETURN
//      :1684  GiveDefaultItemWithSkin("client.rockskin", "rock")
//      :1685  GiveDefaultItemWithSkin("client.torchskin", "torch")
//      :1686  aniversário: cakefiveyear + partyhat
//      :1691  natal: três snowball
//      :1697  OnDefaultItemsReceived   ← só notificação, no fim
//
//  Cancelar o de cima significa assumir TUDO o que está entre as
//  duas linhas: o Strip, o desvio do game mode, a pedra, a tocha, a
//  skin que o PRÓPRIO jogador escolheu no cliente, a posse dela pelo
//  Steam (`CheckSkinOwnership`), o `WorkshopDownload` da
//  PlatformService, o desvio de redirect skin, o bolo, o chapéu e as
//  bolas de neve. Errar qualquer um desses é um jogador nascendo
//  pelado, e o erro só aparece em dezembro.
//
//  Não vale a pena. O que a feature precisa é de UM número num item
//  que já existe, e o `Received` entrega exatamente isso: a vanilla
//  já fez o trabalho dela, e nós reescrevemos o `skin` dos itens que
//  estão no nosso catálogo.
//
//  O preço de não cancelar é conhecido e está pago abaixo, na seção
//  "O CARIMBO É UM RE-SKIN".
//
//  Consequência boa de graça: quando o game mode tem loadout
//  (`:1681`), a vanilla sai por `return` e o `Received` NUNCA é
//  chamado — e não há nada para carimbar mesmo. O mesmo vale para o
//  `respawnWithLoadout` do `BasePlayer.cs:12449-12457`, que faz o
//  `GiveDefaultItems` inteiro não rodar. Nos dois casos este plugin
//  fica quieto, que é o certo.
//
//  ####  QUEM NASCE COM KIT: O OrigemZPlayer PERGUNTA A NÓS  ####
//
//  MEDIDO no repositório em 16/09/2026: o `OrigemZPlayer.cs:262`
//  CANCELA o `OnDefaultItemsReceive` — devolve `true` quando o
//  nível do jogador tem kit e `RemoverItensPadraoDoJogo` está
//  ligado. Nesse caso a vanilla sai em `:1675`, o `Received` de
//  `:1697` nunca dispara, e o §5 deste arquivo não roda. Como
//  quase todo mundo nasce com kit, o catálogo ficaria quase inerte.
//
//  Decisão do dono, 16/09/2026: a skin do catálogo vale TAMBÉM nos
//  itens do kit. O caminho é o kit PERGUNTAR, e não o catálogo
//  carimbar por fora:
//
//      OrigemZPlayer.GiveLoadoutItem
//            ↓  (só quando o loadout não trouxe skin)
//      GetWorkshopSkin(steamId, shortname)   ← o §7 deste arquivo
//            ↓
//      ItemManager.CreateByName(shortname, amount, skin)
//
//  ####  POR QUE A PERGUNTA É AQUI, E NÃO NO AGENTE  ####
//
//  MEDIDO em 16/09/2026: o loadout do agente é POR GRUPO/NÍVEL, e
//  não por jogador — `core/src/loadouts/sync.ts` monta
//  `tiers: { "gold": [...], "normal": [...] }` e empurra UMA carga,
//  que o `OrigemZAgent` guarda em cache e devolve pelo
//  `GetLoadout(tier)`. Não existe, em lugar nenhum do agente, um
//  ponto em que o kit DE UM JOGADOR seja montado.
//
//  E a permissão desta feature é por SKIN e por JOGADOR
//  (`permission.UserHasPermission`), e o modo streamer é estado ao
//  vivo do jogador. Nenhum dos dois cabe numa carga por nível: o
//  agente que preenchesse o `skinId` do kit `gold` estaria dando a
//  skin a todo o grupo, permissão ou não.
//
//  O agente continua DONO do catálogo — ele é quem cadastra, quem
//  decide em que servidores vale e quem empurra a lista pelo
//  `origemz.workshop.sync`. Este plugin é a cópia de leitura, e o
//  §7 só responde perguntas sobre ela.
//
//  ####  UMA FONTE SÓ ESCREVE `item.skin`, E ISTO É COMO  ####
//
//  Os dois caminhos são MUTUAMENTE EXCLUSIVOS por construção do
//  jogo, não por combinação entre plugins:
//
//      kit aplicado → OnDefaultItemsReceive CANCELADO
//                   → OnDefaultItemsReceived NUNCA dispara
//                   → só o kit escreve, e escreve na CRIAÇÃO
//
//      sem kit      → a vanilla roda inteira
//                   → OnDefaultItemsReceived dispara
//                   → só o §5 escreve, e escreve por RE-SKIN
//
//  Não há terceiro caso: o `Received` de `PlayerInventory.cs:1697`
//  é a última linha do mesmo método que o `Receive` de `:1673`
//  cancela. E mesmo na configuração mista (`RemoverItensPadraoDoJogo`
//  desligado com `AplicarKitAoNascer` ligado), os itens são OUTROS
//  objetos — o §5 carimba a pedra que a vanilla criou, o kit cria as
//  peças dele já com a skin. Nenhum item é escrito duas vezes.
//
//  A exceção combinada, e ela é de propósito: o `HideFrom` /
//  `RestoreTo` do §6 alcança TUDO que está na mochila, itens de kit
//  inclusive. É o mesmo plugin agindo, não uma segunda frente, e é o
//  que faz a proteção do streamer continuar valendo depois que o kit
//  entregou a peça.
//
// ============================================================
//  ####  O CARIMBO É UM RE-SKIN, E O PADRÃO É O DO RepairBench  ####
//
//  MEDIDO em 16/09/2026, `RepairBench.cs:370-380`. Trocar a skin de
//  um item que JÁ existe são quatro linhas, e as quatro importam:
//
//      item.skin = skin;          // o valor
//      item.MarkDirty();          // sem isto o cliente NUNCA vê
//      heldEntity.skinID = skin;  // o MODELO NA MÃO é outro objeto
//      heldEntity.SendNetworkUpdate();
//
//  Só `item.skin = X` e nada acontece na tela. `MarkDirty()` sem
//  mexer no `heldEntity` e o ÍCONE muda enquanto o modelo na mão
//  continua o antigo — porque `HeldEntity.OnItemChanged`
//  (`HeldEntity.cs:280-283`) só faz `cachedItem = item;` e não toca
//  em skin nenhuma.
//
//  (Criar o item já com a skin — `ItemManager.CreateByName(nome, 1,
//  skin)` — resolveria os quatro de uma vez, porque `Create`
//  (`ItemManager.cs:304-327`) põe `item.skin` ANTES do
//  `Initialize`, e é o `Initialize` que dispara o
//  `ItemModEntity.OnItemCreated` do `ItemModEntity.cs:42`. Mas criar
//  o item é justamente o que só o hook cancelável permitiria, e o
//  bloco acima explica por que não vamos por ali.)
//
// ============================================================
//  ####  ARMADILHAS MEDIDAS QUE MUDARAM O DESENHO  ####
//
//  1. SKIN DIFERENTE NÃO EMPILHA.  MEDIDO: `Item.cs:1482`, dentro de
//     `CanStack` — `if (item.skin != skin) return false;`. A pedra
//     carimbada NÃO empilha com a pedra vanilla. É por isso que este
//     plugin carimba SÓ o que nasce no `GiveDefaultItems` e não
//     encosta em nada que venha de minério, de craft ou de caixa: um
//     jogador com a permissão acabaria com duas pilhas de pedra na
//     mochila, e isso é um bug visível no primeiro dia.
//
//  2. SKIN É GLOBAL, NÃO É POR ESPECTADOR.  MEDIDO: `Item.Save`
//     (`Item.cs:1819`, `:1833 item.skinid = skin;`) manda UM valor
//     para todo mundo. Não existe para skin o equivalente do
//     `streamerName` (`Item.cs:59`), que é por leitor. Portanto a
//     proteção do modo streamer é DO PORTADOR: o item DELE nasce sem
//     skin. A logo continua nos itens dos OUTROS jogadores no campo
//     de visão dele — e isso precisa estar dito ao dono antes de a
//     tela do painel prometer outra coisa.
//
//  3. REDIRECT SKIN É OUTRO ITEM, NÃO É UMA SKIN.  MEDIDO:
//     `ItemManager.cs:329-345` (`TrySkinChangeItem`) e
//     `PlayerInventory.cs:1713-1726`. Uma "skin" que é redirect
//     troca o ITEM inteiro; escrever `item.skin` com o id dela não
//     funciona. Esse caso só aparece quando o número cadastrado é um
//     id de DEFINIÇÃO DE INVENTÁRIO do Steam, e não um workshop id —
//     e o `sync` abaixo RECUSA esse número, com o motivo
//     `inventory_definition_id`. Ver `RejectsInventoryId`.
//
//  4. NÃO HÁ VALIDAÇÃO DE POSSE.  MEDIDO: `ItemManager.cs` não tem
//     `CallHook` nem `CheckSkinOwnership`. O servidor aceita
//     QUALQUER `ulong` em `item.skin`. O direito de usar a nossa
//     skin é a permissão do Oxide (§7 do levantamento) e mais nada —
//     posse no inventário Steam não entra nisto.
//
// ============================================================
//  ####  O MODO STREAMER VEM DO AGENTE, NÃO DO JOGO  ####
//
//  MEDIDO em 16/09/2026: o modo streamer DO RUST é 100% do cliente.
//  O servidor só lê o que veio no handshake
//  (`ServerMgr.cs:435-439`, `player.GetInfoBool("global.streamermode")`
//  em `BasePlayer.cs:13130`), e não existe aviso em runtime — o
//  `OnClientConvarChange` não existe nesta build. Quem liga a live
//  no meio da partida não é notado por esse caminho.
//
//  O modo streamer que vale aqui é o NOSSO: o jogador digita
//  `/streamer`, o OrigemZUI alterna na hora e o agente grava (ver
//  Plugins/OrigemZUI.cs:3528-3533 e core/src/game/streamer-sync.ts).
//
//  ESTE plugin não fala com o OrigemZUI. A lista de quem está no ar
//  desce no PRÓPRIO `origemz.workshop.sync`, no campo `streamers`:
//
//      { "secret": "...", "skins": [ … ], "streamers": ["7656…"] }
//
//  Duas razões:
//
//  - `[PluginReference]` vira `null` no instante em que o OrigemZUI
//    é descarregado, e o OrigemZUI é o plugin mais recarregado do
//    projeto. Ler dali daria proteção que some sem avisar.
//  - o OrigemZUI hoje não expõe NADA público sobre streamer
//    (varredura de 16/09/2026: nenhum `[HookMethod]`, nenhum
//    `Interface.CallHook`). Usar aquele caminho exigiria editar o
//    arquivo dele — que é de outra frente.
//
//  A fonte da verdade continua sendo uma só: o banco do agente
//  (`core/src/db/streamer-repository.ts`). Este plugin recebe uma
//  CÓPIA de leitura, e a cópia é reescrita inteira a cada `sync`.
//
//  AUSENTE NÃO É VAZIO. `streamers` fora do payload quer dizer "o
//  agente não me disse" e a lista de cá fica como está. `streamers:
//  []` quer dizer "não há ninguém no ar" e a lista é esvaziada. Um
//  agente antigo que não conheça o campo não pode apagar a proteção
//  de quem está transmitindo.
//
// ============================================================
//  ####  O CONTRATO COM O AGENTE  ####
//
//  Marcador: `#OZWORKSHOP#` (livre — varredura de 16/09/2026 no
//  repositório inteiro não achou nenhuma ocorrência).
//
//  AGENTE → PLUGIN, e a resposta volta CASADA no POST /rcon (não
//  sai no console):
//
//      origemz.workshop.sync <base64>   → {"ok":true,"count":N}
//      origemz.workshop.status          → {"ok":true,"skins":N,"streamers":N}
//
//  O Base64 não é capricho: MEDIDO no servidor, o parser de console
//  do Rust COME AS ASPAS de um JSON cru passado como argumento, e a
//  informação se perde antes de o plugin ver. Ver
//  `encodePushPayload` em core/src/game/plugin-push.ts, e o teto de
//  `MAX_PUSH_BYTES = 50_000`.
//
//  PLUGIN → AGENTE, pelo console:
//
//      #OZWORKSHOP#{"kind":"ready"}      ← no boot, SEM segredo
//      #OZWORKSHOP#{"kind":"applied","secret":"…","count":N[,"message":"…"]}
//
//  Os dois `kind` e os campos são os de `WORKSHOP_PUSH_KINDS` e
//  `WorkshopPush` em core/src/types/workshop.ts — que é o arquivo
//  que a outra frente está escrevendo agora. O `message` só aparece
//  quando alguma linha do catálogo foi RECUSADA, e traz o motivo em
//  texto; não há campo novo, de propósito.
//
//  Todo push que não seja o `ready` carrega o segredo que veio no
//  `sync`. Sem isso um jogador digita o marcador no chat e forja
//  evento — ver core/test/koth.test.ts:17-18.
//
//  E NENHUM `Puts` sai no frame em que o comando responde: ele entra
//  na resposta casada e a transforma em `{"ok":true,…}#OZ…{…}`, que
//  não é JSON. Por isso todo push passa por `timer.Once`.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    [Info("OrigemZWorkshop", "OrigemZ", "0.1.0")]
    [Description("Carimba as skins do Steam Workshop da OrigemZ nos itens que o jogador recebe ao nascer.")]
    public class OrigemZWorkshop : RustPlugin
    {
        private const string Marker = "#OZWORKSHOP#";
        private const string SyncCommand = "origemz.workshop.sync";
        private const string StatusCommand = "origemz.workshop.status";

        /// <summary>
        /// A versão da superfície de hook do §7.
        ///
        /// Sobe quando um hook muda de assinatura ou de significado —
        /// nunca por mudança interna. Quem a lê é o OrigemZPlayer, e
        /// ele só AVISA no console: recusar o kit por causa de uma
        /// divergência de versão faria o jogador nascer pelado por um
        /// motivo cosmético.
        /// </summary>
        private const int ApiVersion = 1;

        // ============================================================
        //  §1  O CATÁLOGO, E O ESTADO QUE VEM COM ELE
        // ============================================================

        /// <summary>Uma linha do catálogo, como o painel a cadastrou.</summary>
        private class SkinEntry
        {
            /// <summary>O item BASE do jogo, minúsculo. Ex.: "rock".</summary>
            public string Shortname = "";

            /// <summary>
            /// O workshop id. É `ulong` porque não cabe em inteiro com
            /// sinal — e é por isso que ele viaja como STRING no JSON.
            /// </summary>
            public ulong SkinId;

            /// <summary>A permissão do Oxide, minúscula. Sem ela o item nasce vanilla.</summary>
            public string Permission = "";

            /// <summary>Some da mão de quem está no ar.</summary>
            public bool HideInStreamer;
        }

        /// <summary>
        /// shortname → a entrada que vale para ele.
        ///
        /// ####  UMA SKIN POR ITEM BASE, E ISSO É LIMITAÇÃO  ####
        ///
        /// O carimbo é automático (§6 do levantamento): ninguém
        /// escolhe. Duas skins para o mesmo `rock` não teriam
        /// critério de desempate — então a segunda é RECUSADA no
        /// `sync`, com o motivo `duplicate_shortname`, em vez de uma
        /// delas ganhar por ordem de chegada.
        /// </summary>
        private readonly Dictionary<string, SkinEntry> _byShortname =
            new Dictionary<string, SkinEntry>();

        /// <summary>
        /// workshop id → a entrada.
        ///
        /// É o que permite reconhecer o que é NOSSO num item que já
        /// está na mochila do jogador. Sem isto, tirar a skin no modo
        /// streamer teria de apagar qualquer skin que o item tivesse
        /// — inclusive uma que o próprio jogador comprou.
        /// </summary>
        private readonly Dictionary<ulong, SkinEntry> _bySkinId =
            new Dictionary<ulong, SkinEntry>();

        /// <summary>
        /// SteamID de quem está NO AR agora, segundo o agente.
        ///
        /// A chave é string porque é assim que ela viaja e é assim que
        /// o Oxide identifica jogador (`UserIDString`).
        /// </summary>
        private readonly HashSet<string> _streamers = new HashSet<string>();

        /// <summary>
        /// SteamID → os `uid` de item que a proteção do streamer
        /// DESPIU, para poder vestir de volta quando ele sair do ar.
        ///
        /// ####  POR QUE UMA LISTA, E NÃO UMA VARREDURA  ####
        ///
        /// Ao LIGAR, a varredura é segura: tirar a nossa skin é
        /// reconhecível pelo `_bySkinId` e não destrói nada de
        /// ninguém. Ao DESLIGAR não seria: carimbar tudo que está
        /// com skin 0 poria a logo nas 500 pedras que o jogador
        /// minerou, e quebraria o empilhamento delas (armadilha 1).
        ///
        /// Então o caminho de volta anda só sobre o que nós mesmos
        /// tiramos. Reload do plugin perde esta lista — e perde no
        /// lado certo: o que some é a RESTAURAÇÃO (cosmética), nunca
        /// a PROTEÇÃO (que é o trabalho da feature).
        ///
        /// ####  ELA NÃO É LIMPA NO DISCONNECT, DE PROPÓSITO  ####
        ///
        /// Quem desconecta no Rust vira DORMINDO, com o corpo e o que
        /// está na mão dele parados no mundo. Apagar a lista ali
        /// deixaria o item despido para sempre em quem desligasse a
        /// live estando offline. Quem a limpa é a saída do ar
        /// (`RestoreTo`), e o tamanho dela é o número de streamers
        /// liberados — uma lista curada pelo admin, não o servidor
        /// inteiro.
        /// </summary>
        private readonly Dictionary<string, HashSet<ulong>> _strippedByPlayer =
            new Dictionary<string, HashSet<ulong>>();

        /// <summary>O segredo do `sync`. Vazio = nenhum push sai daqui.</summary>
        private string _secret = "";

        /// <summary>Reaproveitado a cada varredura para não alocar por jogador.</summary>
        private readonly List<Item> _scratch = new List<Item>();

        // ============================================================
        //  §2  O BOOT
        // ============================================================

        private void OnServerInitialized()
        {
            // O handshake. Sem segredo de propósito: é ele que PEDE o
            // catálogo, e o segredo só existe depois que o catálogo
            // chega. Ver o cabeçalho, "O CONTRATO COM O AGENTE".
            Puts(Marker + "{\"kind\":\"ready\"}");
        }

        // ============================================================
        //  §3  origemz.workshop.sync  -  o catálogo INTEIRO
        // ============================================================

        [ConsoleCommand(SyncCommand)]
        private void CmdSync(ConsoleSystem.Arg arg)
        {
            // `arg.Connection != null` é jogador digitando no F1. Este
            // comando carrega o segredo do agente: não tem resposta
            // para ele, nem uma de erro.
            if (arg.Connection != null)
            {
                return;
            }

            if (!arg.HasArgs(1))
            {
                arg.ReplyWith(Fail("INVALID_ARGS", "Use: " + SyncCommand + " <base64>"));
                return;
            }

            string json = DecodeBase64(arg.GetString(0));
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

            try
            {
                arg.ReplyWith(ApplySync(payload));
            }
            catch (Exception cause)
            {
                arg.ReplyWith(Fail("EXCEPTION", cause.Message));
            }
        }

        /// <summary>
        /// Troca o catálogo inteiro pelo que chegou.
        ///
        /// ####  O PAYLOAD É COMPLETO, NUNCA DELTA  ####
        ///
        /// Então o dicionário é montado NOVO e só é trocado no fim.
        /// Limpar antes e falhar no meio deixaria o servidor sem
        /// catálogo nenhum — e o agente acreditando que mandou um.
        /// </summary>
        private string ApplySync(JObject payload)
        {
            _secret = Text(payload, "secret");

            Dictionary<string, SkinEntry> nextByShortname = new Dictionary<string, SkinEntry>();
            Dictionary<ulong, SkinEntry> nextBySkinId = new Dictionary<ulong, SkinEntry>();
            List<string> skipped = new List<string>();

            JArray skins = payload["skins"] as JArray;
            if (skins != null)
            {
                for (int i = 0; i < skins.Count; i++)
                {
                    JObject row = skins[i] as JObject;
                    if (row == null)
                    {
                        continue;
                    }

                    string reason = ReadEntry(row, nextByShortname, nextBySkinId);
                    if (reason != null)
                    {
                        // O motivo vai em TEXTO e não em campo novo: o
                        // `WorkshopPush` de core/src/types/workshop.ts
                        // tem `message`, e inventar um campo fora do
                        // contrato faria o zod do agente recusar a
                        // linha inteira.
                        skipped.Add(Text(row, "shortname") + "=" + reason);
                    }
                }
            }

            _byShortname.Clear();
            foreach (KeyValuePair<string, SkinEntry> entry in nextByShortname)
            {
                _byShortname[entry.Key] = entry.Value;
            }

            _bySkinId.Clear();
            foreach (KeyValuePair<ulong, SkinEntry> entry in nextBySkinId)
            {
                _bySkinId[entry.Key] = entry.Value;
            }

            ApplyStreamerList(payload);

            // A confirmação do que ficou DE PÉ deste lado. Sai sempre,
            // e sempre fora do frame da resposta — ver o cabeçalho.
            JObject applied = new JObject { ["count"] = _byShortname.Count };
            if (skipped.Count > 0)
            {
                applied["message"] = "recusadas: " + string.Join(", ", skipped.ToArray());
            }

            Push("applied", applied);

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["count"] = _byShortname.Count,
            };

            return reply.ToString(Formatting.None);
        }

        /// <summary>
        /// Lê uma linha do catálogo. Devolve `null` se ela entrou, ou
        /// o motivo pelo qual foi recusada.
        ///
        /// Recusar é melhor que aceitar calado: um número errado aqui
        /// não dá erro no jogo — o item simplesmente fica com a cara
        /// vanilla, e ninguém descobre por quê (§2.2 do levantamento).
        /// </summary>
        private string ReadEntry(
            JObject row,
            Dictionary<string, SkinEntry> byShortname,
            Dictionary<ulong, SkinEntry> bySkinId)
        {
            // `enabled` ausente conta como ligado: o campo é a exceção,
            // não a regra.
            JToken enabled = row["enabled"];
            if (enabled != null && enabled.Type != JTokenType.Null && !enabled.ToObject<bool>())
            {
                return null;
            }

            string shortname = Text(row, "shortname").ToLowerInvariant();
            if (shortname.Length == 0)
            {
                return "no_shortname";
            }

            // Um shortname que o jogo não conhece é erro de digitação
            // na tela do painel, e é aqui que ele tem conserto.
            if (ItemManager.FindItemDefinition(shortname) == null)
            {
                return "unknown_item";
            }

            ulong skinId;
            if (!ulong.TryParse(
                    Text(row, "skinId"),
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out skinId) || skinId == 0uL)
            {
                // Skin 0 é indistinguível de item comum — é a mesma
                // trava do CHECK da migração 41.
                return "bad_skin_id";
            }

            if (RejectsInventoryId(skinId))
            {
                return "inventory_definition_id";
            }

            string perm = Text(row, "permission").ToLowerInvariant();
            if (perm.Length == 0)
            {
                // Sem permissão a skin seria de todo mundo, e a decisão
                // do dono (§7) é que ela nunca é.
                return "no_permission";
            }

            if (byShortname.ContainsKey(shortname))
            {
                return "duplicate_shortname";
            }

            SkinEntry entry = new SkinEntry
            {
                Shortname = shortname,
                SkinId = skinId,
                Permission = perm,
                HideInStreamer = Flag(row, "hideInStreamer", false),
            };

            // ####  REGISTRAR DUAS VEZES É AVISO NO CONSOLE  ####
            //
            // O Oxide reclama de permissão repetida, e este `sync`
            // chega a cada reconexão de RCON. A guarda evita encher o
            // log do servidor com o mesmo aviso.
            //
            // O caminho contrário — permissão que SAIU do catálogo —
            // não tem API de remoção no Oxide. Ela fica registrada e
            // inerte (nada mais a consulta), e some sozinha no próximo
            // reload do plugin, porque o registro é refeito só a
            // partir do que o `sync` trouxer.
            if (!permission.PermissionExists(entry.Permission, this))
            {
                permission.RegisterPermission(entry.Permission, this);
            }

            byShortname[shortname] = entry;
            bySkinId[skinId] = entry;

            return null;
        }

        /// <summary>
        /// O número cadastrado é um id de DEFINIÇÃO DE INVENTÁRIO do
        /// Steam em vez de um workshop id?
        ///
        /// MEDIDO em 16/09/2026: `ItemManager.TrySkinChangeItem`
        /// (`ItemManager.cs:329-345`) faz
        /// `ItemSkinDirectory.FindByInventoryDefinitionId((int)skinId)`.
        /// Com um workshop id de verdade ele não acha nada e a skin
        /// passa intacta — que é o que queremos. Achando, ele pode
        /// trocar o ITEM inteiro (redirect skin), e aí escrever
        /// `item.skin` não faz o que o admin espera.
        ///
        /// O `(int)` é o mesmo cast que a vanilla faz: workshop id
        /// maior que `int.MaxValue` nem chega a ser procurado, e por
        /// isso a checagem só vale abaixo desse teto.
        ///
        /// `FindByInventoryDefinitionId` devolve `default(Skin)`
        /// quando não acha (`ItemSkinDirectory.cs:81`), e nele o `id`
        /// é 0.
        /// </summary>
        private bool RejectsInventoryId(ulong skinId)
        {
            if (skinId > int.MaxValue)
            {
                return false;
            }

            try
            {
                return ItemSkinDirectory.FindByInventoryDefinitionId((int)skinId).id != 0;
            }
            catch (Exception)
            {
                // O diretório é um ScriptableObject carregado do
                // FileSystem e ele LANÇA quando não abre. Não dá para
                // reprovar o cadastro do admin por causa disso.
                return false;
            }
        }

        // ============================================================
        //  §4  origemz.workshop.status  -  o agente conferindo
        // ============================================================

        [ConsoleCommand(StatusCommand)]
        private void CmdStatus(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            JObject reply = new JObject
            {
                ["ok"] = true,
                ["skins"] = _byShortname.Count,
                ["streamers"] = _streamers.Count,
            };

            arg.ReplyWith(reply.ToString(Formatting.None));
        }

        // ============================================================
        //  §5  O CARIMBO
        // ============================================================

        /// <summary>
        /// O jogo acabou de entregar os itens de quem nasceu.
        ///
        /// `Interface.CallHook("OnDefaultItemsReceived", this)` em
        /// `PlayerInventory.cs:1697` — o argumento é a
        /// `PlayerInventory`, NÃO o `BasePlayer`.
        /// </summary>
        private void OnDefaultItemsReceived(PlayerInventory inventory)
        {
            if (inventory == null || _byShortname.Count == 0)
            {
                return;
            }

            BasePlayer player = inventory.baseEntity as BasePlayer;
            if (player == null || !player.userID.IsSteamId())
            {
                return;
            }

            bool onAir = _streamers.Contains(player.UserIDString);

            _scratch.Clear();
            inventory.GetAllItems(_scratch);

            for (int i = 0; i < _scratch.Count; i++)
            {
                Item item = _scratch[i];
                if (item == null || item.info == null)
                {
                    continue;
                }

                // ####  A SKIN DO JOGADOR GANHA DA NOSSA  ####
                //
                // MEDIDO: a vanilla já passou por aqui
                // (`PlayerInventory.cs:1698-1733`) e, se o jogador
                // escolheu uma pedra dele no cliente e POSSUI a skin,
                // o item já veio com ela. Sobrescrever seria tomar
                // dele o que ele comprou — e o dono pediu para dar,
                // não para tirar. Skin 0 é "ele não escolheu nada", e
                // é só aí que a nossa entra.
                if (item.skin != 0uL)
                {
                    continue;
                }

                SkinEntry entry = ResolveEntry(player.UserIDString, item.info.shortname, onAir);
                if (entry == null)
                {
                    continue;
                }

                ApplySkinToItem(item, entry.SkinId);
            }

            _scratch.Clear();
        }

        /// <summary>
        /// A regra do carimbo, num lugar só: catálogo, modo streamer
        /// e permissão, nesta ordem. Devolve a entrada que vale para
        /// aquele jogador naquele item, ou `null` quando o item fica
        /// vanilla.
        ///
        /// ####  POR QUE ELA É UM MÉTODO, E NÃO CÓDIGO SOLTO  ####
        ///
        /// Ela tem DOIS chamadores: o `OnDefaultItemsReceived` acima
        /// e o `GetWorkshopSkin` do §7, que o OrigemZPlayer consulta
        /// ao montar o kit. Duas cópias da mesma regra divergiriam na
        /// primeira correção, e a divergência apareceria no jogo como
        /// "a skin vale para quem nasce sem kit e não vale para quem
        /// nasce com" — sintoma que ninguém liga a permissão.
        ///
        /// A ordem das três perguntas não é indiferente: a permissão
        /// é a mais cara (o Oxide percorre os grupos do jogador), e
        /// por isso vem depois das duas de dicionário.
        /// </summary>
        private SkinEntry ResolveEntry(string steamId, string shortname, bool onAir)
        {
            if (string.IsNullOrEmpty(steamId) || string.IsNullOrEmpty(shortname))
            {
                return null;
            }

            SkinEntry entry;
            if (!_byShortname.TryGetValue(shortname.ToLowerInvariant(), out entry))
            {
                return null;
            }

            if (entry.HideInStreamer && onAir)
            {
                return null;
            }

            if (!permission.UserHasPermission(steamId, entry.Permission))
            {
                return null;
            }

            return entry;
        }

        /// <summary>
        /// O padrão canônico da vanilla para trocar a skin de um item
        /// que já existe — `RepairBench.cs:370-380`, MEDIDO em
        /// 16/09/2026.
        ///
        /// As quatro linhas são todas necessárias; o cabeçalho deste
        /// arquivo explica o que cada uma paga.
        /// </summary>
        private void ApplySkinToItem(Item item, ulong skin)
        {
            if (item == null || item.skin == skin)
            {
                return;
            }

            item.skin = skin;
            item.MarkDirty();

            BaseEntity held = item.GetHeldEntity();
            if (held != null)
            {
                held.skinID = skin;
                held.SendNetworkUpdate();
            }
        }

        // ============================================================
        //  §6  O MODO STREAMER, AO VIVO
        // ============================================================

        /// <summary>
        /// Troca a lista de quem está no ar e age sobre QUEM MUDOU.
        ///
        /// Só quem mudou: reaplicar em todo mundo a cada `sync` seria
        /// varrer a mochila do servidor inteiro a cada reconexão de
        /// RCON, para quase sempre não mudar nada.
        /// </summary>
        private void ApplyStreamerList(JObject payload)
        {
            JToken raw = payload["streamers"];

            // AUSENTE NÃO É VAZIO — ver o cabeçalho. Um agente que não
            // conheça o campo não apaga a proteção de quem está
            // transmitindo agora.
            JArray list = raw as JArray;
            if (list == null)
            {
                return;
            }

            HashSet<string> next = new HashSet<string>();
            for (int i = 0; i < list.Count; i++)
            {
                string id = list[i] == null ? "" : list[i].ToString();
                if (id.Length > 0)
                {
                    next.Add(id);
                }
            }

            List<string> turnedOn = new List<string>();
            List<string> turnedOff = new List<string>();

            foreach (string id in next)
            {
                if (!_streamers.Contains(id))
                {
                    turnedOn.Add(id);
                }
            }

            foreach (string id in _streamers)
            {
                if (!next.Contains(id))
                {
                    turnedOff.Add(id);
                }
            }

            _streamers.Clear();
            foreach (string id in next)
            {
                _streamers.Add(id);
            }

            for (int i = 0; i < turnedOn.Count; i++)
            {
                HideFrom(turnedOn[i]);
            }

            for (int i = 0; i < turnedOff.Count; i++)
            {
                RestoreTo(turnedOff[i]);
            }
        }

        /// <summary>
        /// Ele entrou no ar: tirar das mãos dele o que é nosso e está
        /// marcado para sumir.
        ///
        /// A varredura reconhece o que é NOSSO pelo `_bySkinId`, e por
        /// isso nunca encosta numa skin que o jogador comprou.
        /// </summary>
        private void HideFrom(string steamId)
        {
            BasePlayer player = FindPlayer(steamId);
            if (player == null || player.inventory == null)
            {
                return;
            }

            HashSet<ulong> stripped;
            if (!_strippedByPlayer.TryGetValue(steamId, out stripped))
            {
                stripped = new HashSet<ulong>();
                _strippedByPlayer[steamId] = stripped;
            }

            _scratch.Clear();
            player.inventory.GetAllItems(_scratch);

            for (int i = 0; i < _scratch.Count; i++)
            {
                Item item = _scratch[i];
                if (item == null || item.skin == 0uL)
                {
                    continue;
                }

                SkinEntry entry;
                if (!_bySkinId.TryGetValue(item.skin, out entry) || !entry.HideInStreamer)
                {
                    continue;
                }

                stripped.Add(item.uid.Value);
                ApplySkinToItem(item, 0uL);
            }

            _scratch.Clear();
        }

        /// <summary>
        /// Ele saiu do ar: vestir de volta SÓ o que nós tiramos.
        ///
        /// Um item que trocou de dono, foi para uma caixa ou virou
        /// pilha com outro some da lista sem drama — o `uid` deixa de
        /// ser encontrado e a linha é ignorada. Voltar atrás disso
        /// exigiria seguir item pelo mundo, e a feature não vale isso.
        /// </summary>
        private void RestoreTo(string steamId)
        {
            HashSet<ulong> stripped;
            if (!_strippedByPlayer.TryGetValue(steamId, out stripped))
            {
                return;
            }

            _strippedByPlayer.Remove(steamId);

            BasePlayer player = FindPlayer(steamId);
            if (player == null || player.inventory == null)
            {
                return;
            }

            _scratch.Clear();
            player.inventory.GetAllItems(_scratch);

            for (int i = 0; i < _scratch.Count; i++)
            {
                Item item = _scratch[i];
                if (item == null || item.info == null || item.skin != 0uL)
                {
                    continue;
                }

                if (!stripped.Contains(item.uid.Value))
                {
                    continue;
                }

                SkinEntry entry;
                if (!_byShortname.TryGetValue(item.info.shortname, out entry))
                {
                    continue;
                }

                // A permissão é conferida DE NOVO: entre o ligar e o
                // desligar da live o admin pode tê-la revogado, e
                // devolver a skin nesse caso seria o plugin passando
                // por cima do painel.
                if (!permission.UserHasPermission(steamId, entry.Permission))
                {
                    continue;
                }

                ApplySkinToItem(item, entry.SkinId);
            }

            _scratch.Clear();
        }

        /// <summary>
        /// O jogador, acordado ou dormindo.
        ///
        /// O dormindo entra porque o corpo dele fica no mundo com o
        /// que estiver na mão — `FindByID` sozinho
        /// (`BasePlayer.cs:12726`) só olha o `activePlayerLookup`, e
        /// deixaria a logo de pé em quem deslogou logo depois de
        /// entrar no ar.
        /// </summary>
        private BasePlayer FindPlayer(string steamId)
        {
            ulong userId;
            if (!ulong.TryParse(steamId, NumberStyles.None, CultureInfo.InvariantCulture, out userId))
            {
                return null;
            }

            BasePlayer player = BasePlayer.FindByID(userId);
            if (player != null)
            {
                return player;
            }

            return BasePlayer.FindSleeping(userId);
        }

        // ============================================================
        //  §7  A SUPERFÍCIE DE HOOK  -  quem monta item pergunta aqui
        //
        //  Consumida por outro plugin com [PluginReference] +
        //  Call("Nome", ...). Hoje o consumidor é um só: o
        //  `OrigemZPlayer`, ao montar o kit de quem nasce. As três
        //  regras da casa valem para o bloco inteiro (o mesmo
        //  cabeçalho está em OrigemZAgent.cs:3079-3102):
        //
        //   1. NADA AQUI PODE LANÇAR. Exceção que sobe de um
        //      HookMethod vira erro no log do Oxide e a chamada volta
        //      `null` para quem chamou — que quase nunca trata isso.
        //
        //   2. NADA AQUI PODE ESPERAR I/O. O chamador está no caminho
        //      de NASCIMENTO do jogador. Tudo sai de dicionário em
        //      memória, e quem o enche é o `sync` empurrado pelo
        //      agente.
        //
        //   3. O nome do hook sai de `nameof(...)`, nunca de string
        //      digitada: renomear o método com string deixaria o
        //      atributo apontando para o nome velho, e isso só
        //      apareceria em runtime, no servidor.
        // ============================================================

        /// <summary>
        /// O aviso antecipado de mudança incompatível. Ver
        /// `LogWorkshopApiVersion` no OrigemZPlayer.
        /// </summary>
        [HookMethod(nameof(GetApiVersion))]
        private int GetApiVersion()
        {
            return ApiVersion;
        }

        /// <summary>
        /// A skin que ESTE jogador tem direito de receber neste item,
        /// ou `null` quando o item deve nascer vanilla.
        ///
        /// ####  POR QUE TEXTO, E NÃO `ulong`  ####
        ///
        /// O `Call` do Oxide devolve `object`, e o consumidor teria de
        /// acertar o tipo exato do boxing para desempacotar — um
        /// `uint` do outro lado viraria `null` em silêncio. Texto
        /// atravessa sempre, é o formato em que o `skinId` já viaja no
        /// loadout (`core/src/loadouts/items.ts`), e o OrigemZPlayer
        /// já tem o `ParseSkin` que o lê.
        ///
        /// `null` e não `"0"`: o chamador distingue "não tenho skin
        /// para ele" de um zero que viesse de um cadastro estragado.
        ///
        /// ####  ELE NÃO ESCREVE NADA  ####
        ///
        /// Este hook RESPONDE; quem escreve o `item.skin` do kit é o
        /// `ItemManager.CreateByName` do OrigemZPlayer, e ali o item
        /// ainda nem existe. É o que mantém uma fonte só por item —
        /// ver o cabeçalho, "UMA FONTE SÓ ESCREVE item.skin".
        /// </summary>
        [HookMethod(nameof(GetWorkshopSkin))]
        private string GetWorkshopSkin(string steamId, string shortname)
        {
            try
            {
                if (_byShortname.Count == 0 || string.IsNullOrEmpty(steamId))
                {
                    return null;
                }

                SkinEntry entry = ResolveEntry(steamId, shortname, _streamers.Contains(steamId));

                return entry == null ? null : entry.SkinId.ToString(CultureInfo.InvariantCulture);
            }
            catch (Exception cause)
            {
                // Regra 1 do bloco. E o lado seguro é o vanilla: um
                // item sem a nossa skin é um item que o jogador
                // recebe.
                PrintError("GetWorkshopSkin falhou para " + steamId + "/" + shortname + ": " + cause);
                return null;
            }
        }

        // ============================================================
        //  §8  AUXILIARES
        // ============================================================

        /// <summary>
        /// O aviso para o agente, sempre FORA do frame do comando.
        ///
        /// Um `Puts` disparado dentro do handler entra na resposta
        /// casada do RCON e a quebra. Medido no OrigemZTeam em
        /// 15/09/2026, e o OrigemZKoth paga o mesmo pedágio.
        /// </summary>
        private void Push(string kind, JObject data)
        {
            if (string.IsNullOrEmpty(_secret))
            {
                return;
            }

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

        /// <summary>
        /// Base64 não é enfeite: o parser de console do Rust come as
        /// aspas de um JSON cru, e a informação se perde ANTES de
        /// chegar aqui. Ver core/src/game/plugin-push.ts.
        /// </summary>
        private static string DecodeBase64(string encoded)
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
        /// Texto de um campo, com nulo e ausente valendo string vazia.
        ///
        /// Usa `ToString()` de propósito: o `skinId` chega como STRING
        /// no contrato, mas um agente que o mandasse como número
        /// continuaria sendo lido certo.
        /// </summary>
        private static string Text(JObject body, string key)
        {
            JToken token = body[key];
            if (token == null || token.Type == JTokenType.Null)
            {
                return "";
            }

            return token.ToString();
        }

        private static bool Flag(JObject body, string key, bool fallback)
        {
            JToken token = body[key];
            if (token == null || token.Type == JTokenType.Null)
            {
                return fallback;
            }

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
