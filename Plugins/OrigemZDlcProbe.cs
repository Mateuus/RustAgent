using System;
using System.Collections.Generic;
using System.Text;
using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    // ============================================================
    //  OrigemZDlcProbe  -  a regua da trava de DLC do OrigemZWorkshop.
    //
    //  NAO CARREGUE EM PRODUCAO sem precisar: ela le o estado Steam de
    //  outro jogador e roda medicoes em laco. Ela nasceu descartavel e
    //  ficou porque a trava de DLC (Docs/OrigemZWorkshop/02 §3.1)
    //  depende de tres respostas que so o jogo ao vivo da -- e quando
    //  alguma delas mudar, e aqui que se remede em vez de adivinhar.
    //
    //  ####  A PERGUNTA QUE ELA RESPONDE  ####
    //
    //  O dono decidiu que skin de DLC pode ser premio do Passe de
    //  Batalha, desde que so quem tem a DLC a use. Isso respeita a
    //  checagem de posse em vez de burla-la, que e o que as
    //  diretrizes da Facepunch pedem (Docs/BattlePass/03 §9).
    //
    //  Mas ninguem nunca mediu se o SERVIDOR consegue fazer essa
    //  checagem. O que o projeto mediu foi o caminho oposto --
    //  LIBERAR skins, que e developer-only (Docs/OrigemZWorkshop/00
    //  §2.4). Prometer a feature sem esta medicao seria adivinhar.
    //
    //  ####  O QUE O DECOMPILADO JA DIZ  ####
    //
    //  PlayerBlueprints.CheckSkinOwnership(int skinItemId, BasePlayer)
    //  existe e e publico. Ele termina em:
    //
    //      return steamInventory.HasItem(skinItemId);
    //
    //  e o HasItem e assim:
    //
    //      if (!DefaultSkinAccess) return AllSkinsUnlocked;
    //      if (Items == null) return false;
    //      ...percorre Items procurando DefinitionId...
    //
    //  Entao a resposta inteira depende de UMA coisa: o array
    //  `steamInventory.Items` estar preenchido no servidor. Se ele
    //  for null aqui, HasItem devolve false para todo mundo -- e a
    //  feature nao bloquearia so quem nao tem a DLC: bloquearia
    //  TODOS, inclusive quem comprou. Um falso negativo silencioso.
    //
    //  ####  O QUE ELA NAO FAZ  ####
    //
    //  Nao da, nao tira e nao altera nada. So le e responde.
    // ============================================================
    [Info("OrigemZDlcProbe", "OrigemZ", "0.2.0")]
    [Description("Sonda: o servidor enxerga a posse de skin/DLC do jogador, e quanto custa perguntar?")]
    public class OrigemZDlcProbe : RustPlugin
    {
        // ####  A RESPOSTA VOLTA CASADA, NAO NO CONSOLE  ####
        //
        // O POST /rcon devolve o `Reply` do comando e ele some do
        // buffer do console. Procurar a resposta no console faz o
        // comando parecer mudo. Por isso tudo sai por ReplyWith.
        [ConsoleCommand("origemz.dlcprobe")]
        private void CmdProbe(ConsoleSystem.Arg arg)
        {
            // Só do console do servidor: a sonda le estado de outro
            // jogador, e isso nao e coisa que se exponha ao cliente.
            if (arg.Connection != null) return;

            string steamId = arg.GetString(0);

            if (string.IsNullOrEmpty(steamId))
            {
                arg.ReplyWith("uso: origemz.dlcprobe <steamId> [skinItemId]");
                return;
            }

            BasePlayer player = FindPlayer(steamId);

            if (player == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"PLAYER_NOT_FOUND\"}");
                return;
            }

            var report = new StringBuilder();

            report.Append("{\"ok\":true");
            report.Append(",\"steamId\":\"").Append(player.UserIDString).Append('"');
            report.Append(",\"name\":\"").Append(Escape(player.displayName)).Append('"');
            report.Append(",\"sleeping\":").Append(Lower(player.IsSleeping()));

            // Os dois curto-circuitos do HasItem. Se DefaultSkinAccess
            // for falso, a posse REAL nem e consultada -- o jogo
            // responde AllSkinsUnlocked e pronto.
            report.Append(",\"defaultSkinAccess\":").Append(Lower(Safe(() => player.DefaultSkinAccess)));
            report.Append(",\"allSkinsUnlocked\":").Append(Lower(Safe(() => player.AllSkinsUnlocked)));

            PlayerBlueprints blueprints = player.blueprints;

            if (blueprints == null)
            {
                report.Append(",\"blueprints\":null}");
                arg.ReplyWith(report.ToString());
                return;
            }

            SteamInventory inventory = blueprints.steamInventory;

            if (inventory == null)
            {
                // Ja responde a pergunta, e na pior direcao.
                report.Append(",\"steamInventory\":null");
                report.Append(",\"verdict\":\"NAO DA: o componente nem existe no servidor\"}");
                arg.ReplyWith(report.ToString());
                return;
            }

            // ####  O CORACAO DA SONDA  ####
            //
            // `Items` null e a diferenca entre "da para checar posse"
            // e "nao da". Contar quantos itens ha diz tambem se o
            // array chegou vazio (sessao sem inventario carregado) ou
            // populado de verdade.
            int itemCount = -1;
            var sample = new List<string>();

            try
            {
                if (inventory.Items != null)
                {
                    itemCount = inventory.Items.Length;

                    for (int i = 0; i < inventory.Items.Length && i < 8; i++)
                    {
                        sample.Add(inventory.Items[i].DefinitionId.ToString());
                    }
                }
            }
            catch (Exception error)
            {
                report.Append(",\"itemsError\":\"").Append(Escape(error.Message)).Append('"');
            }

            report.Append(",\"itemsNull\":").Append(Lower(itemCount < 0));
            report.Append(",\"itemCount\":").Append(itemCount);
            report.Append(",\"sample\":[").Append(string.Join(",", sample.ToArray())).Append(']');

            // Se veio um skinItemId, pergunta de verdade.
            string rawSkin = arg.GetString(1);

            if (!string.IsNullOrEmpty(rawSkin))
            {
                int skinItemId;

                if (int.TryParse(rawSkin, out skinItemId))
                {
                    report.Append(",\"skinItemId\":").Append(skinItemId);

                    try
                    {
                        report.Append(",\"checkSkinOwnership\":")
                            .Append(Lower(blueprints.CheckSkinOwnership(skinItemId, player)));
                    }
                    catch (Exception error)
                    {
                        report.Append(",\"checkSkinOwnershipError\":\"")
                            .Append(Escape(error.Message)).Append('"');
                    }

                    try
                    {
                        report.Append(",\"hasItem\":").Append(Lower(inventory.HasItem(skinItemId)));
                    }
                    catch (Exception error)
                    {
                        report.Append(",\"hasItemError\":\"").Append(Escape(error.Message)).Append('"');
                    }
                }
                else
                {
                    // O Workshop ID passa de 2^31 e nao cabe em int --
                    // e ele NAO e o mesmo numero que o skinItemId
                    // daqui, que e a definicao de inventario Steam.
                    report.Append(",\"skinItemIdError\":\"nao cabe em int: e o Workshop ID, nao a definicao Steam?\"");
                }
            }

            report.Append(",\"verdict\":\"").Append(Escape(VerdictOf(itemCount, player))).Append('"');
            report.Append('}');

            arg.ReplyWith(report.ToString());
        }

        /// A leitura em uma frase, para quem le o resultado sem ler o codigo.
        private static string VerdictOf(int itemCount, BasePlayer player)
        {
            if (!Safe(() => player.DefaultSkinAccess))
            {
                return "INCONCLUSIVO: DefaultSkinAccess falso, a posse real nem e consultada";
            }

            if (itemCount < 0)
            {
                return "NAO DA: Items e null no servidor, HasItem responde false para todos";
            }

            if (itemCount == 0)
            {
                return "SUSPEITO: Items existe mas veio vazio -- confira com jogador que TENHA skin comprada";
            }

            return "DA: o servidor enxerga " + itemCount + " itens do inventario Steam deste jogador";
        }


        // ####  A SEGUNDA PERGUNTA: O QUE E DLC, AFINAL  ####
        //
        // A primeira sonda respondeu que o servidor ENXERGA a posse.
        // Falta saber COMO reconhecer uma skin de DLC -- porque o
        // numero que o nosso catalogo guarda e o Workshop ID, e o que
        // o `CheckSkinOwnership` recebe e a definicao de inventario
        // Steam. Sao dois numeros diferentes para a mesma coisa.
        //
        // A hipotese, lida no decompilado: `ItemSkinDirectory` e o
        // catalogo das skins OFICIAIS que o jogo conhece; as nossas,
        // publicadas no Workshop, nao estao la. Se for verdade, o
        // agente descobre sozinho o que e DLC -- e o admin nao precisa
        // marcar nada no cadastro.
        //
        // Esta sonda lista o que o jogo sabe sobre um item, para a
        // hipotese ser confirmada ou morrer.
        [ConsoleCommand("origemz.dlcprobe.skins")]
        private void CmdProbeSkins(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            string shortname = arg.GetString(0);

            if (string.IsNullOrEmpty(shortname))
            {
                arg.ReplyWith("uso: origemz.dlcprobe.skins <shortname>");
                return;
            }

            ItemDefinition definition = ItemManager.FindItemDefinition(shortname);

            if (definition == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"ITEM_NOT_FOUND\"}");
                return;
            }

            var report = new StringBuilder();

            report.Append("{\"ok\":true");
            report.Append(",\"shortname\":\"").Append(Escape(shortname)).Append('"');
            report.Append(",\"itemId\":").Append(definition.itemid);

            try
            {
                ItemSkinDirectory.Skin[] skins = ItemSkinDirectory.ForItem(definition);

                report.Append(",\"officialCount\":").Append(skins.Length);
                report.Append(",\"official\":[");

                for (int i = 0; i < skins.Length && i < 12; i++)
                {
                    if (i > 0) report.Append(',');

                    ItemSkinDirectory.Skin skin = skins[i];

                    report.Append("{\"id\":").Append(skin.id);
                    report.Append(",\"name\":\"").Append(Escape(skin.name)).Append('"');

                    // `invItem` e o que diz se aquilo e item de loja
                    // Steam -- e e o unico lugar com a categoria.
                    //
                    // O `workshopID` e a PONTE que o desenho precisa: o
                    // nosso catalogo guarda o Workshop ID, e o
                    // `CheckSkinOwnership` quer o id de inventario. Se
                    // este campo vier preenchido no servidor, da para ir
                    // de um ao outro sem o admin marcar nada.
                    //
                    // O `DlcItem` separa "skin de DLC" (uma licenca de
                    // outro appid) de "skin da loja" (um item comprado).
                    try
                    {
                        SteamInventoryItem inv = skin.invItem;

                        report.Append(",\"hasInvItem\":").Append(Lower(inv != null));

                        if (inv != null)
                        {
                            report.Append(",\"invId\":").Append(inv.id);
                            report.Append(",\"category\":\"").Append(inv.category.ToString()).Append('"');
                            report.Append(",\"workshopId\":").Append(inv.workshopID);
                            report.Append(",\"isDlc\":").Append(Lower(inv.DlcItem != null));

                            if (inv.DlcItem != null)
                            {
                                report.Append(",\"dlcAppId\":").Append(inv.DlcItem.dlcAppID);
                                report.Append(",\"dlcBypass\":").Append(Lower(inv.DlcItem.bypassLicenseCheck));
                            }
                        }
                    }
                    catch (Exception error)
                    {
                        report.Append(",\"invError\":\"").Append(Escape(error.Message)).Append('"');
                    }

                    report.Append('}');
                }

                report.Append(']');

                // A pergunta que decide o desenho: o `id` do diretorio
                // cabe num int, e o Workshop ID nao. Se todos couberem,
                // os dois numeros NAO se confundem -- e "esta no
                // diretorio" vira o teste de "e oficial".
                report.Append(",\"veredito\":\"");
                report.Append(skins.Length == 0
                    ? "este item nao tem skin oficial: toda skin dele e de Workshop"
                    : "o item tem " + skins.Length + " skins oficiais, e os ids acima sao de inventario Steam");
                report.Append('"');
            }
            catch (Exception error)
            {
                report.Append(",\"error\":\"").Append(Escape(error.Message)).Append('"');
            }

            report.Append('}');

            arg.ReplyWith(report.ToString());
        }

        // ####  A TERCEIRA PERGUNTA: QUANTO CUSTA PERGUNTAR  ####
        //
        // O menu de skins mostra 48 celulas por pagina, e as contagens
        // da lateral percorrem o catalogo inteiro. Se conferir a posse
        // for caro, conferir uma vez por celula a cada desenho vira
        // trabalho de servidor -- e o desenho tem de ser outro (cache
        // por jogador, ou resolver so as poucas skins oficiais).
        //
        // O custo NAO e o `HasItem` (um laco sobre os itens Steam do
        // jogador, que sao poucos): e o
        // `ItemSkinDirectory.FindByInventoryDefinitionId`, que percorre
        // LINEARMENTE o diretorio inteiro do jogo a cada chamada. Por
        // isso a sonda mede tambem o pior caso -- o id que esta no FIM
        // do array, onde o laco so para na ultima volta.
        //
        //   origemz.dlcprobe.cost <steamId> [repeticoes]
        [ConsoleCommand("origemz.dlcprobe.cost")]
        private void CmdProbeCost(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;

            string steamId = arg.GetString(0);

            if (string.IsNullOrEmpty(steamId))
            {
                arg.ReplyWith("uso: origemz.dlcprobe.cost <steamId> [repeticoes]");
                return;
            }

            BasePlayer player = FindPlayer(steamId);

            if (player == null || player.blueprints == null)
            {
                arg.ReplyWith("{\"ok\":false,\"error\":\"PLAYER_NOT_FOUND\"}");
                return;
            }

            int repeats;
            if (!int.TryParse(arg.GetString(1), out repeats) || repeats <= 0) repeats = 48;

            var report = new StringBuilder();
            report.Append("{\"ok\":true");
            report.Append(",\"steamId\":\"").Append(player.UserIDString).Append('"');
            report.Append(",\"repeats\":").Append(repeats);

            try
            {
                ItemSkinDirectory.Skin[] all = ItemSkinDirectory.Instance.skins;
                report.Append(",\"directorySize\":").Append(all.Length);

                // O id do fim do array: o pior caso do laco linear.
                int worstId = 0;
                for (int i = all.Length - 1; i >= 0; i--)
                {
                    if (all[i].isSkin && all[i].id != 0) { worstId = all[i].id; break; }
                }

                report.Append(",\"worstId\":").Append(worstId);

                // Aquece: a primeira chamada carrega o ScriptableObject do
                // `invItem` do disco e mediria o carregamento, nao a
                // pergunta.
                for (int i = 0; i < 200; i++) player.blueprints.CheckSkinOwnership(worstId, player);

                report.Append(",\"worstCaseUs\":").Append(Round(Measure(player, worstId, repeats)));

                // E um id que NAO esta no diretorio: o Workshop ID de uma
                // skin nossa, cortado para int. E o caso que o plugin mais
                // faria se conferisse tudo -- e tambem percorre o array
                // inteiro, sem achar.
                report.Append(",\"missingUs\":").Append(Round(Measure(player, int.MaxValue - 7, repeats)));

                // O custo de RESOLVER o que e oficial, que e o que o
                // plugin faria uma vez por skin na carga do catalogo.
                ItemDefinition ak = ItemManager.FindItemDefinition("rifle.ak");

                if (ak != null)
                {
                    for (int i = 0; i < 20; i++) ItemSkinDirectory.ForItem(ak);

                    long started = System.Diagnostics.Stopwatch.GetTimestamp();
                    for (int i = 0; i < repeats; i++) ItemSkinDirectory.ForItem(ak);
                    report.Append(",\"forItemUs\":").Append(Round(Micros(started)));
                }
            }
            catch (Exception error)
            {
                report.Append(",\"error\":\"").Append(Escape(error.Message)).Append('"');
            }

            report.Append('}');
            arg.ReplyWith(report.ToString());
        }

        /// Microssegundos gastos por `repeats` chamadas de CheckSkinOwnership.
        private static double Measure(BasePlayer player, int skinItemId, int repeats)
        {
            long started = System.Diagnostics.Stopwatch.GetTimestamp();

            for (int i = 0; i < repeats; i++)
            {
                player.blueprints.CheckSkinOwnership(skinItemId, player);
            }

            return Micros(started);
        }

        /// Ticks do Stopwatch -> microssegundos. O DateTime do Windows
        /// anda de 15 em 15 ms e nao enxergaria nada disto.
        private static double Micros(long started)
        {
            long elapsed = System.Diagnostics.Stopwatch.GetTimestamp() - started;

            return System.Diagnostics.Stopwatch.Frequency > 0L
                ? elapsed * 1000000d / System.Diagnostics.Stopwatch.Frequency
                : 0d;
        }

        private static string Round(double micros)
        {
            return micros.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        }

        private static BasePlayer FindPlayer(string steamId)
        {
            foreach (BasePlayer player in BasePlayer.allPlayerList)
            {
                if (player != null && player.UserIDString == steamId) return player;
            }

            return null;
        }

        private static bool Safe(Func<bool> read)
        {
            try { return read(); }
            catch { return false; }
        }

        private static string Lower(bool value)
        {
            return value ? "true" : "false";
        }

        private static string Escape(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;

            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
