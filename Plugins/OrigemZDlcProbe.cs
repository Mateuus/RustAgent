using System;
using System.Collections.Generic;
using System.Text;
using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    // ============================================================
    //  OrigemZDlcProbe  -  SONDA DESCARTAVEL. Apague depois de usar.
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
    [Info("OrigemZDlcProbe", "OrigemZ", "0.1.0")]
    [Description("Sonda descartavel: o servidor enxerga a posse de skin/DLC do jogador?")]
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
