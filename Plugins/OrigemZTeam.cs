// ============================================================
//  OrigemZTeam  -  a equipe do jogo, com nome e com cargo.
//
//  ####  O JOGO JÁ TEM EQUIPE; FALTAVA O NOME  ####
//
//  `RelationshipManager.PlayerTeam` tem `teamName` desde sempre, e
//  o Rust NUNCA escreve nele: nasce vazio e assim fica. O "Team
//  Fulano" que aparece na tela do jogador é o cliente mostrando o
//  nome do LÍDER — não um nome guardado.
//
//  O campo está lá, persiste no save e vai para o cliente na mesma
//  mensagem da equipe. Este plugin é quem escreve nele.
//
//  ------------------------------------------------------------
//  ####  ESTE PLUGIN NÃO DECIDE NADA  ####
//
//  Ele LÊ a equipe do jogo e EXECUTA o que o agente mandar. Quem
//  valida nome, quem sabe o cargo de cada um e quem diz se aquele
//  jogador podia expulsar o outro é o agente — o mesmo desenho do
//  OrigemZDungeon, e pela mesma razão: uma segunda régua é uma
//  régua que vai divergir.
//
//  O que é do JOGO e este plugin só espelha:
//    quem está na equipe, quem é líder, convites, tamanho máximo.
//  O que é NOSSO e mora no agente:
//    o cargo de cada membro, e o que cada cargo pode fazer.
//
//  ------------------------------------------------------------
//  ####  DOIS CANOS, COMO NO RESTO DO PROJETO  ####
//
//    PERGUNTA   o agente manda `origemz.team list` pelo RCON e lê a
//               resposta CASADA. Ela não aparece no console.
//    AVISO      o plugin grita `#OZTEAM#{…}` no console quando algo
//               acontece por iniciativa do JOGADOR (criou equipe,
//               saiu, foi expulso, virou líder).
//
//  O segredo do aviso vem do agente no `origemz.team sync`. Sem
//  ele, um jogador que digitasse `#OZTEAM#{…}` no chat inventaria
//  eventos — e o marcador tem de estar no começo da linha, o que o
//  chat não permite.
//
//  ####  O DISBAND APAGA TUDO  ####
//
//  Regra do dono (15/09/2026): equipe desfeita apaga tudo daquela
//  equipe, cargos inclusive. O hook `OnTeamDisbanded` cobre os DOIS
//  caminhos — o desfazer explícito e o último membro saindo, que o
//  próprio jogo resolve chamando `Disband()`. MEDIDO no
//  Assembly-CSharp de 15/09/2026: `RemovePlayer` → `Disband()` →
//  `DisbandTeam()` → o hook.
//
//  Ver Docs/OrigemZTeam/00-LEVANTAMENTO.md.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Core.Libraries.Covalence;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("OrigemZ Team", "OrigemZ", "0.1.0")]
    [Description("A equipe nativa do Rust com nome, comandada pelo painel")]
    public class OrigemZTeam : CovalencePlugin
    {
        // ============================================================
        //  O CANAL COM O AGENTE
        // ============================================================

        private const string Marker = "#OZTEAM#";

        /// O segredo desta sessão do agente. Vazio = ninguém sincronizou
        /// ainda, e nenhum aviso sai — um aviso sem segredo o agente
        /// descartaria de qualquer jeito.
        private string secret = "";

        /// O teto do nome. O agente valida de verdade; isto é o freio
        /// bruto para um nome que estouraria a tela do cliente.
        private const int MaxNameLength = 24;

        /// <summary>
        /// O plugin subiu (ou recarregou) e perdeu o segredo.
        ///
        /// Ele grita, e o agente reenvia o `sync`. Sem isto, um
        /// `oxide.reload OrigemZTeam` deixaria o plugin mudo até o
        /// próximo restart do agente — e ninguém relacionaria uma coisa
        /// com a outra. Mesmo desenho do `#OZAREQ#` do OrigemZAgent.
        /// </summary>
        private void OnServerInitialized()
        {
            Puts(Marker + "{\"kind\":\"ready\"}");
        }

        // ============================================================
        //  §1  O QUE O AGENTE PERGUNTA E MANDA
        // ============================================================

        [Command("origemz.team")]
        private void CmdTeam(IPlayer player, string command, string[] args)
        {
            // Só o console (o agente) e admin. Um jogador comum fala com
            // o agente pelo /menu, e é o agente que chega aqui.
            if (!player.IsServer && !player.IsAdmin)
            {
                player.Reply(Fail("forbidden", "Você não tem permissão para isso."));
                return;
            }

            var sub = args.Length > 0 ? args[0].ToLowerInvariant() : "";

            try
            {
                switch (sub)
                {
                    case "":
                    case "list":
                        player.Reply(ReplyList());
                        return;

                    case "get":
                        player.Reply(ReplyGet(Arg(args, 1)));
                        return;

                    case "rename":
                        player.Reply(DoRename(Arg(args, 1), string.Join(" ", args.Skip(2).ToArray())));
                        return;

                    case "kick":
                        player.Reply(DoKick(Arg(args, 1), Arg(args, 2)));
                        return;

                    case "leader":
                        player.Reply(DoLeader(Arg(args, 1), Arg(args, 2)));
                        return;

                    case "disband":
                        player.Reply(DoDisband(Arg(args, 1)));
                        return;

                    case "sync":
                        player.Reply(DoSync(string.Join(" ", args.Skip(1).ToArray())));
                        return;

                    default:
                        player.Reply(Fail("unknown_command",
                            "Não conheço '" + sub + "'. Use: list | get <id> | rename <id> <nome> | " +
                            "kick <id> <steamId> | leader <id> <steamId> | disband <id> | sync <json>"));
                        return;
                }
            }
            catch (Exception cause)
            {
                // Um comando que lança devolve o texto da exceção ao RCON
                // e some do log. O agente precisa de uma resposta com
                // forma, sempre — senão o timeout dele é a única pista.
                player.Reply(Fail("exception", cause.Message));
            }
        }

        private static string Arg(string[] args, int index)
        {
            return args.Length > index ? args[index] : "";
        }

        // ------------------------------------------------------------
        //  Ler
        // ------------------------------------------------------------

        private string ReplyList()
        {
            var manager = RelationshipManager.ServerInstance;

            if (manager == null) return Fail("no_manager", "O RelationshipManager ainda não subiu.");

            var teams = new JArray();

            foreach (var team in manager.teams.Values.ToArray())
            {
                if (team == null) continue;

                teams.Add(Describe(team));
            }

            var payload = new JObject
            {
                ["ok"] = true,
                ["maxSize"] = RelationshipManager.maxTeamSize,
                ["teams"] = teams,
            };

            return payload.ToString(Formatting.None);
        }

        private string ReplyGet(string key)
        {
            var team = Find(key);

            if (team == null) return Fail("not_found", "Não achei essa equipe.");

            var payload = new JObject
            {
                ["ok"] = true,
                ["maxSize"] = RelationshipManager.maxTeamSize,
                ["team"] = Describe(team),
            };

            return payload.ToString(Formatting.None);
        }

        /// <summary>
        /// Uma equipe como o agente a lê.
        ///
        /// ####  IDS VÃO COMO TEXTO  ####
        ///
        /// `teamID` e SteamID são `ulong`, e passam de 2^53. Em número
        /// de JSON o JavaScript do agente os ARREDONDA em silêncio — o
        /// id volta diferente do que saiu, e a equipe "não existe" na
        /// hora de renomear. Texto, sempre.
        /// </summary>
        private JObject Describe(RelationshipManager.PlayerTeam team)
        {
            var members = new JArray();

            foreach (var id in team.members.ToArray())
            {
                var online = BasePlayer.FindByID(id);

                members.Add(new JObject
                {
                    ["steamId"] = id.ToString(CultureInfo.InvariantCulture),
                    ["name"] = NameOf(id),
                    ["online"] = online != null && online.IsConnected,
                    ["leader"] = id == team.teamLeader,
                });
            }

            var invites = new JArray();

            foreach (var id in team.invites.ToArray())
            {
                invites.Add(id.ToString(CultureInfo.InvariantCulture));
            }

            return new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
                ["name"] = team.teamName ?? "",
                ["leader"] = team.teamLeader.ToString(CultureInfo.InvariantCulture),
                ["leaderName"] = NameOf(team.teamLeader),
                // Segundos desde que ela existe. NÃO é epoch: o
                // `teamStartTime` do jogo conta a partir do boot do
                // servidor, e virar data aqui seria inventar precisão.
                ["ageSeconds"] = Mathf.Max(0f, UnityEngine.Time.realtimeSinceStartup - team.teamStartTime),
                ["members"] = members,
                ["invites"] = invites,
            };
        }

        private string NameOf(ulong id)
        {
            var text = id.ToString(CultureInfo.InvariantCulture);
            var known = covalence.Players.FindPlayerById(text);

            if (known != null && !string.IsNullOrEmpty(known.Name)) return known.Name;

            // O Covalence só conhece quem já entrou neste wipe. Quem não
            // conhece vira o próprio id — melhor que "desconhecido", que
            // some com a única pista que sobrou.
            var player = RelationshipManager.FindByID(id);

            return player != null && !string.IsNullOrEmpty(player.displayName) ? player.displayName : text;
        }

        // ------------------------------------------------------------
        //  Escrever
        // ------------------------------------------------------------

        private string DoRename(string key, string name)
        {
            var team = Find(key);

            if (team == null) return Fail("not_found", "Não achei essa equipe.");

            name = (name ?? "").Replace("\n", " ").Replace("\r", " ").Trim();

            if (name.Length > MaxNameLength) name = name.Substring(0, MaxNameLength);

            team.teamName = name;

            // Sem isto o nome muda no servidor e NÃO chega a ninguém: o
            // cliente continua com a cópia antiga até o próximo update
            // da equipe, que pode não vir nunca.
            team.MarkDirty();

            Push("renamed", new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
                ["name"] = team.teamName,
            });

            var payload = new JObject { ["ok"] = true, ["team"] = Describe(team) };

            return payload.ToString(Formatting.None);
        }

        private string DoKick(string key, string steamId)
        {
            var team = Find(key);

            if (team == null) return Fail("not_found", "Não achei essa equipe.");

            ulong id;

            if (!ulong.TryParse(steamId, out id)) return Fail("bad_steam_id", "SteamID inválido.");
            if (!team.members.Contains(id)) return Fail("not_a_member", "Esse jogador não está na equipe.");

            // ####  O JOGO DECIDE O QUE ACONTECE DEPOIS  ####
            //
            // Tirar o LÍDER com gente dentro promove `members[0]`
            // sozinho; tirar o último desfaz a equipe e dispara
            // `OnTeamDisbanded`. Não reimplementar nenhuma das duas
            // coisas aqui: o hook avisa o agente nos dois casos.
            var wasLast = team.members.Count <= 1;

            team.RemovePlayer(id);

            Push("kicked", new JObject
            {
                ["teamId"] = key,
                ["steamId"] = id.ToString(CultureInfo.InvariantCulture),
            });

            if (wasLast)
            {
                var gone = new JObject { ["ok"] = true, ["disbanded"] = true };

                return gone.ToString(Formatting.None);
            }

            var payload = new JObject { ["ok"] = true, ["team"] = Describe(team) };

            return payload.ToString(Formatting.None);
        }

        private string DoLeader(string key, string steamId)
        {
            var team = Find(key);

            if (team == null) return Fail("not_found", "Não achei essa equipe.");

            ulong id;

            if (!ulong.TryParse(steamId, out id)) return Fail("bad_steam_id", "SteamID inválido.");
            if (!team.members.Contains(id)) return Fail("not_a_member", "Esse jogador não está na equipe.");
            if (team.teamLeader == id) return Fail("already_leader", "Ele já é o líder.");

            // `SetTeamLeader` chama `MarkDirty` sozinho, e passa pelo
            // hook `OnTeamMemberPromote` — que é onde o aviso nasce.
            team.SetTeamLeader(id);

            var payload = new JObject { ["ok"] = true, ["team"] = Describe(team) };

            return payload.ToString(Formatting.None);
        }

        private string DoDisband(string key)
        {
            var team = Find(key);

            if (team == null) return Fail("not_found", "Não achei essa equipe.");

            // ####  TIRAR TODO MUNDO ANTES  ####
            //
            // `DisbandTeam` remove a equipe do dicionário e devolve o
            // objeto ao pool, mas NÃO limpa o `currentTeam` de quem
            // estava dentro: os membros ficariam apontando para uma
            // equipe que não existe mais, e o cliente deles mostraria
            // uma equipe fantasma até relogar.
            //
            // `RemovePlayer` do último membro já chama `Disband()`
            // sozinho — por isso o laço vai até esvaziar, sem um
            // `DisbandTeam` explícito depois.
            var ids = team.members.ToArray();

            foreach (var id in ids)
            {
                team.RemovePlayer(id);
            }

            if (RelationshipManager.ServerInstance.FindTeam(team.teamID) != null)
            {
                // Equipe sem membro nenhum não passa pelo caminho acima.
                RelationshipManager.ServerInstance.DisbandTeam(team);
            }

            var payload = new JObject { ["ok"] = true, ["disbanded"] = true };

            return payload.ToString(Formatting.None);
        }

        private string DoSync(string json)
        {
            if (string.IsNullOrEmpty(json)) return Fail("empty", "Sync sem corpo.");

            var body = JObject.Parse(json);
            var incoming = body["secret"];

            secret = incoming == null ? "" : incoming.ToString();

            var payload = new JObject
            {
                ["ok"] = true,
                ["teams"] = RelationshipManager.ServerInstance == null
                    ? 0
                    : RelationshipManager.ServerInstance.teams.Count,
            };

            return payload.ToString(Formatting.None);
        }

        /// <summary>
        /// A equipe, por id dela OU por SteamID de quem está dentro.
        ///
        /// Os dois porque as duas perguntas aparecem: o painel tem o id
        /// da equipe; a tela do jogador só tem quem clicou.
        /// </summary>
        private RelationshipManager.PlayerTeam Find(string key)
        {
            var manager = RelationshipManager.ServerInstance;

            if (manager == null || string.IsNullOrEmpty(key)) return null;

            ulong id;

            if (!ulong.TryParse(key, out id)) return null;

            var team = manager.FindTeam(id);

            if (team != null) return team;

            // Não era id de equipe: pode ser o SteamID de um membro. Um
            // SteamID nunca colide com um teamID — o do jogo começa em 1
            // e conta de um em um.
            return manager.FindPlayersTeam(id);
        }

        // ============================================================
        //  §2  O QUE O JOGADOR FAZ, E O AGENTE PRECISA SABER
        // ============================================================

        private void OnTeamCreated(BasePlayer player, RelationshipManager.PlayerTeam team)
        {
            if (team == null) return;

            Push("created", new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
                ["leader"] = team.teamLeader.ToString(CultureInfo.InvariantCulture),
                ["leaderName"] = NameOf(team.teamLeader),
            });
        }

        private void OnTeamDisbanded(RelationshipManager.PlayerTeam team)
        {
            if (team == null) return;

            // O evento que apaga os cargos no agente. Ele sai ANTES de o
            // objeto voltar ao pool — depois disso o `teamID` já pode
            // ser de outra equipe.
            Push("disbanded", new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
            });
        }

        private void OnTeamLeave(RelationshipManager.PlayerTeam team, BasePlayer player)
        {
            if (team == null || player == null) return;

            Push("left", new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
                ["steamId"] = player.userID.Get().ToString(CultureInfo.InvariantCulture),
            });
        }

        private void OnTeamKick(RelationshipManager.PlayerTeam team, BasePlayer player, ulong target)
        {
            if (team == null) return;

            Push("kicked", new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
                ["steamId"] = target.ToString(CultureInfo.InvariantCulture),
            });
        }

        private void OnTeamAcceptInvite(RelationshipManager.PlayerTeam team, BasePlayer player)
        {
            if (team == null || player == null) return;

            Push("joined", new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
                ["steamId"] = player.userID.Get().ToString(CultureInfo.InvariantCulture),
                ["name"] = player.displayName ?? "",
            });
        }

        private void OnTeamMemberPromote(RelationshipManager.PlayerTeam team, ulong newLeader)
        {
            if (team == null) return;

            Push("leader", new JObject
            {
                ["teamId"] = team.teamID.ToString(CultureInfo.InvariantCulture),
                ["steamId"] = newLeader.ToString(CultureInfo.InvariantCulture),
            });
        }

        // ============================================================
        //  §3  FERRAMENTA
        // ============================================================

        /// <summary>
        /// Um aviso para o agente, no console.
        ///
        /// Sem segredo não sai nada: o agente descartaria, e uma linha
        /// que ninguém lê só enche o console de quem está olhando.
        ///
        /// ####  ELE SAI NO PRÓXIMO FRAME, E NÃO AGORA  ####
        ///
        /// MEDIDO no server01 em 15/09/2026: um `Puts` disparado DENTRO
        /// de um comando entra na resposta CASADA do RCON. O agente
        /// pediu `origemz.team rename` e recebeu
        ///
        ///     [OrigemZ Team] #OZTEAM#{"kind":"renamed",…}
        ///
        /// grudado no JSON da resposta — que então não é mais JSON. O
        /// rename tinha funcionado; o agente é que não conseguiu ler
        /// o que ele mesmo mandou fazer.
        ///
        /// O `timer.Once` tira o aviso do frame do comando. A resposta
        /// volta limpa, e o aviso sai logo depois, no console, que é
        /// onde ele sempre devia estar.
        /// </summary>
        private void Push(string kind, JObject data)
        {
            if (string.IsNullOrEmpty(secret)) return;

            data["kind"] = kind;
            data["secret"] = secret;

            var line = Marker + data.ToString(Formatting.None);

            timer.Once(0.1f, () => Puts(line));
        }

        private static string Fail(string reason, string message)
        {
            var payload = new JObject
            {
                ["ok"] = false,
                ["error"] = reason,
                ["message"] = message,
            };

            return payload.ToString(Formatting.None);
        }
    }
}
