// ============================================================
//  OrigemZKoth  -  o território que se toma ficando nele.
//
//  ####  O QUE ELE FAZ, EM UMA FIGURA  ####
//
//            ⚑  a bandeira, no centro
//         ╭───────────╮
//        │   ● ● ●     │   quem está dentro do cilindro conta
//        │      ●      │   (raio + altura, do chão para cima)
//         ╰───────────╯
//              ↑
//        um LADO só dentro  →  o progresso sobe
//        dois lados dentro  →  contestado, congela
//        ninguém dentro     →  decai
//
//  Chegou a 100%: capturado. O plugin avisa o agente e ele decide o
//  prêmio — este arquivo não paga nada, não sabe de OZCoin e não
//  conhece a loja.
//
//  ####  LADO É EQUIPE, E SÓ  ####
//
//  Regra do dono (15/09/2026): só participa quem está em equipe.
//  Quem entra sozinho vê um aviso dizendo isso e não faz a barra
//  andar. Não é punição: é o que faz o placar ter nome — ver
//  Docs/KOTH/DECISOES-DO-DONO.md §2 e §3.
//
//  ####  A BARRA É DESENHADA AQUI, E ISSO É EXCEÇÃO  ####
//
//  No resto do projeto o plugin não desenha: as telas vêm prontas
//  do agente (ver OrigemZUI). Esta barra muda TODO SEGUNDO para
//  todo mundo dentro da zona — mandá-la pelo agente seria um
//  ida-e-volta de RCON por segundo por jogador.
//
//  O que vem do agente é o que não muda no meio: o nome do evento,
//  as cores, os tempos. O desenho é fixo, e só os números andam.
//
//  ####  ELE NÃO DECIDE QUANDO NASCE  ####
//
//  Quem sorteia a hora e o lugar é o agendador, no agente. Aqui só
//  existe `start`, `stop` e `status`.
//
//  Ver Docs/KOTH/KOTH-OrigemZ-Especificacao.md e DECISOES-DO-DONO.md.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Game.Rust.Cui;
using Oxide.Core.Libraries.Covalence;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("OrigemZ KOTH", "OrigemZ", "0.1.0")]
    [Description("Domínio de território por equipe, comandado pelo painel")]
    public class OrigemZKoth : CovalencePlugin
    {
        // ============================================================
        //  PREFABS — conferidos no manifesto do jogo em 15/09/2026
        //  (`GameManifest.Current.entities`). Chutar caminho de prefab
        //  não dá erro: ele é PULADO em silêncio, e a bandeira não
        //  nasce.
        // ============================================================

        private const string PrefabBanner = "assets/prefabs/deployable/signs/sign.pole.banner.large.prefab";
        private const string PrefabRadiusMarker = "assets/prefabs/tools/map/genericradiusmarker.prefab";
        private const string PrefabVendingMarker = "assets/prefabs/deployable/vendingmachine/vending_mapmarker.prefab";

        private const string Marker = "#OZKOTH#";
        private const string UiRoot = "origemz.koth.hud";

        private string secret = "";
        private Run run;

        // ============================================================
        //  §1  O ESTADO DE UMA EXECUÇÃO
        // ============================================================

        /// <summary>O que o agente mandou, mais o que aconteceu desde então.</summary>
        private class Run
        {
            public string runId = "";
            public string name = "KOTH";
            public Vector3 center;
            public float radius = 25f;
            public float height = 30f;

            /// Segundos de domínio para capturar.
            public float captureSeconds = 300f;
            /// Teto da execução. Estourou sem vencedor: expira.
            public float durationSeconds = 1800f;
            /// Quanto o progresso cai por segundo com a zona vazia.
            public float decayPerSecond = 1f;
            /// Só participa quem está em equipe.
            public bool requireTeam = true;

            public float progress;
            /// O time que detém o progresso. 0 = ninguém.
            public ulong holder;
            public string holderName = "";

            public float startedAt;
            public BaseEntity banner;
            public MapMarkerGenericRadius mapMarker;
            public VendingMachineMapMarker mapLabel;
            public Timer ticker;
            /// Quem está com a barra na tela, para saber de quem tirar.
            public readonly HashSet<ulong> watching = new HashSet<ulong>();
            /// Já anunciou o fim? Evita o aviso duplo do tick com o stop.
            public bool closed;
        }

        // ============================================================
        //  §2  OS COMANDOS DO AGENTE
        // ============================================================

        private void OnServerInitialized()
        {
            Puts(Marker + "{\"kind\":\"ready\"}");
        }

        private void Unload()
        {
            // Descarregar com evento de pé deixaria a bandeira no mapa
            // e a barra na tela de quem estava dentro — sem ninguém
            // para tirá-las.
            if (run != null) Teardown("unload");
        }

        [Command("origemz.koth")]
        private void CmdKoth(IPlayer player, string command, string[] args)
        {
            if (!player.IsServer && !player.IsAdmin)
            {
                player.Reply(Fail("forbidden", "Você não tem permissão para isso."));
                return;
            }

            var sub = args.Length > 0 ? args[0].ToLowerInvariant() : "status";

            try
            {
                switch (sub)
                {
                    case "start":
                        player.Reply(DoStart(string.Join(" ", args.Skip(1).ToArray())));
                        return;

                    case "stop":
                        player.Reply(DoStop());
                        return;

                    case "status":
                        player.Reply(DoStatus());
                        return;

                    case "sync":
                        player.Reply(DoSync(string.Join(" ", args.Skip(1).ToArray())));
                        return;

                    default:
                        player.Reply(Fail("unknown_command", "Use: start <json> | stop | status | sync <json>"));
                        return;
                }
            }
            catch (Exception cause)
            {
                player.Reply(Fail("exception", cause.Message));
            }
        }

        private string DoSync(string json)
        {
            if (string.IsNullOrEmpty(json)) return Fail("empty", "Sync sem corpo.");

            var body = JObject.Parse(json);

            secret = body["secret"] == null ? "" : body["secret"].ToString();

            var payload = new JObject { ["ok"] = true, ["active"] = run != null };

            return payload.ToString(Formatting.None);
        }

        /// <summary>Ergue o território. O agente já escolheu onde.</summary>
        private string DoStart(string json)
        {
            if (run != null) return Fail("already_active", "Já existe um KOTH de pé. Derrube antes.");
            if (string.IsNullOrEmpty(json)) return Fail("empty", "Start sem corpo.");

            var body = JObject.Parse(json);
            var next = new Run
            {
                runId = Text(body, "runId", ""),
                name = Text(body, "name", "KOTH"),
                radius = Mathf.Clamp(Number(body, "radius", 25f), 5f, 200f),
                height = Mathf.Clamp(Number(body, "height", 30f), 5f, 200f),
                captureSeconds = Mathf.Clamp(Number(body, "captureSeconds", 300f), 10f, 7200f),
                durationSeconds = Mathf.Clamp(Number(body, "durationSeconds", 1800f), 60f, 21600f),
                decayPerSecond = Mathf.Clamp(Number(body, "decayPerSecond", 1f), 0f, 60f),
                requireTeam = body["requireTeam"] == null || body["requireTeam"].ToObject<bool>(),
            };

            var x = Number(body, "x", 0f);
            var z = Number(body, "z", 0f);

            // ####  A ALTURA É DO TERRENO, E NÃO DO PAINEL  ####
            //
            // O admin marca no mapa, que é plano: ele escolhe X e Z. Um
            // Y vindo de lá poria a bandeira enterrada ou voando, e
            // ninguém entenderia por quê. O `y` do corpo existe só para
            // o caso de o agente já saber o chão daquele ponto.
            var y = body["y"] == null || body["y"].Type == JTokenType.Null
                ? TerrainMeta.HeightMap.GetHeight(new Vector3(x, 0f, z))
                : Number(body, "y", 0f);

            next.center = new Vector3(x, y, z);

            if (!SpawnBanner(next))
            {
                return Fail("no_banner", "A bandeira não nasceu: o prefab não foi aceito pelo servidor.");
            }

            SpawnMarker(next, body);

            next.startedAt = UnityEngine.Time.realtimeSinceStartup;
            run = next;
            run.ticker = timer.Every(1f, Tick);

            Push("started", new JObject
            {
                ["runId"] = next.runId,
                ["x"] = x,
                ["z"] = z,
                ["grid"] = Grid(next.center),
            });

            var payload = new JObject
            {
                ["ok"] = true,
                ["runId"] = next.runId,
                ["grid"] = Grid(next.center),
                ["y"] = y,
            };

            return payload.ToString(Formatting.None);
        }

        private string DoStop()
        {
            if (run == null) return Fail("not_active", "Não há KOTH de pé.");

            Teardown("command");

            var payload = new JObject { ["ok"] = true };

            return payload.ToString(Formatting.None);
        }

        private string DoStatus()
        {
            var payload = new JObject { ["ok"] = true, ["active"] = run != null };

            if (run != null)
            {
                payload["runId"] = run.runId;
                payload["name"] = run.name;
                payload["grid"] = Grid(run.center);
                payload["progress"] = Mathf.RoundToInt(run.progress);
                payload["captureSeconds"] = run.captureSeconds;
                payload["percent"] = Mathf.RoundToInt(Percent(run));
                payload["holder"] = run.holder.ToString(CultureInfo.InvariantCulture);
                payload["holderName"] = run.holderName;
                payload["elapsed"] = Mathf.RoundToInt(Elapsed(run));
                payload["inside"] = Inside(run).Count;
            }

            return payload.ToString(Formatting.None);
        }

        // ============================================================
        //  §3  O CORAÇÃO: UM TICK POR SEGUNDO
        // ============================================================

        private void Tick()
        {
            if (run == null) return;

            try
            {
                var inside = Inside(run);
                var sides = Sides(inside);

                // ####  A ORDEM IMPORTA  ####
                //
                // Primeiro o tempo total (um evento que estourou não
                // pode ser capturado no mesmo tick), depois o domínio.
                if (Elapsed(run) >= run.durationSeconds)
                {
                    Finish("expired", 0UL, "");
                    return;
                }

                if (sides.Count == 1)
                {
                    var side = sides.First();

                    // Trocou de dono: o progresso do anterior NÃO é
                    // herdado. Quem chega começa de onde o outro parou
                    // seria o mesmo que dar a captura a quem passou
                    // por último.
                    if (run.holder != side.Key && run.holder != 0UL)
                    {
                        run.progress = 0f;
                    }

                    run.holder = side.Key;
                    run.holderName = side.Value.name;
                    run.progress += 1f;

                    if (run.progress >= run.captureSeconds)
                    {
                        Finish("captured", side.Key, side.Value.name);
                        return;
                    }
                }
                else if (sides.Count == 0)
                {
                    run.progress = Mathf.Max(0f, run.progress - run.decayPerSecond);

                    if (run.progress <= 0f) run.holder = 0UL;
                }

                // sides.Count > 1: contestado. Nada sobe, nada cai — o
                // progresso fica onde está, e a barra diz por quê.

                Draw(run, inside, sides.Count > 1);
            }
            catch (Exception cause)
            {
                // Um tick que lança mata o `timer.Every` e o evento
                // congela sem avisar ninguém. Ele reclama e segue.
                PrintWarning("tick do KOTH falhou: " + cause.Message);
            }
        }

        /// <summary>Quem está dentro do cilindro, vivo e acordado.</summary>
        private List<BasePlayer> Inside(Run current)
        {
            var found = new List<BasePlayer>();

            foreach (var player in BasePlayer.activePlayerList)
            {
                if (player == null || player.IsDead() || player.IsSleeping()) continue;
                if (player.IsNpc) continue;

                var position = player.transform.position;
                var dy = position.y - current.center.y;

                // ####  ALTURA CONTA, E É POR ISSO QUE NÃO É UMA
                //       ESFERA  ####
                //
                // Sem o teto, quem passa de helicóptero captura. Sem o
                // piso, quem está no metrô embaixo também. A conta é
                // num cilindro: do chão do centro para cima.
                if (dy < -2f || dy > current.height) continue;

                var flat = new Vector2(position.x - current.center.x, position.z - current.center.z);

                if (flat.sqrMagnitude > current.radius * current.radius) continue;

                found.Add(player);
            }

            return found;
        }

        private class Side
        {
            public string name = "";
            public int members;
        }

        /// <summary>Os LADOS dentro da zona. Sem equipe, sem lado.</summary>
        private Dictionary<ulong, Side> Sides(List<BasePlayer> inside)
        {
            var sides = new Dictionary<ulong, Side>();

            foreach (var player in inside)
            {
                var teamId = player.currentTeam;

                if (teamId == 0UL) continue;

                var team = RelationshipManager.ServerInstance == null
                    ? null
                    : RelationshipManager.ServerInstance.FindTeam(teamId);

                if (team == null) continue;

                Side side;

                if (!sides.TryGetValue(teamId, out side))
                {
                    side = new Side
                    {
                        // O nome da equipe é do OrigemZTeam. Vazio = ninguém
                        // batizou, e aí o líder dá o nome — que é o que o
                        // próprio cliente do Rust faz.
                        name = string.IsNullOrEmpty(team.teamName)
                            ? NameOf(team.teamLeader)
                            : team.teamName,
                    };

                    sides[teamId] = side;
                }

                side.members++;
            }

            return sides;
        }

        private void Finish(string reason, ulong winner, string winnerName)
        {
            if (run == null || run.closed) return;

            run.closed = true;

            var payload = new JObject
            {
                ["runId"] = run.runId,
                ["reason"] = reason,
                ["teamId"] = winner.ToString(CultureInfo.InvariantCulture),
                ["teamName"] = winnerName,
                ["seconds"] = Mathf.RoundToInt(Elapsed(run)),
            };

            // Os beneficiários vão junto: quem paga é o agente, e sem
            // esta lista ele teria de adivinhar quem estava lá.
            var members = new JArray();

            if (winner != 0UL && RelationshipManager.ServerInstance != null)
            {
                var team = RelationshipManager.ServerInstance.FindTeam(winner);

                if (team != null)
                {
                    foreach (var id in team.members.ToArray())
                    {
                        members.Add(id.ToString(CultureInfo.InvariantCulture));
                    }
                }
            }

            payload["members"] = members;

            Push(reason == "captured" ? "captured" : "expired", payload);

            var message = reason == "captured"
                ? "<color=#C4B454>" + run.name + "</color>: <color=#8FBF4F>" + winnerName +
                  "</color> dominou o território!"
                : "<color=#C4B454>" + run.name + "</color>: ninguém dominou o território a tempo.";

            server.Broadcast(message);

            Teardown(reason);
        }

        // ============================================================
        //  §4  O QUE APARECE NO MUNDO
        // ============================================================

        private bool SpawnBanner(Run next)
        {
            var banner = GameManager.server.CreateEntity(PrefabBanner, next.center);

            if (banner == null) return false;

            banner.enableSaving = false;
            banner.Spawn();

            next.banner = banner;

            return true;
        }

        private void SpawnMarker(Run next, JObject body)
        {
            try
            {
                var vending = GameManager.server.CreateEntity(PrefabVendingMarker, next.center)
                    as VendingMachineMapMarker;

                if (vending == null) return;

                vending.markerShopName = next.name;
                vending.enableSaving = false;
                vending.Spawn();

                var marker = GameManager.server.CreateEntity(PrefabRadiusMarker, next.center)
                    as MapMarkerGenericRadius;

                if (marker == null)
                {
                    vending.Kill();
                    return;
                }

                // O raio do marcador é em FRAÇÃO do mapa, e não em
                // metros: 0.5 é meio mapa. A conta abaixo o deixa do
                // tamanho real da zona.
                var world = TerrainMeta.Size.x <= 0f ? 4000f : TerrainMeta.Size.x;

                marker.radius = Mathf.Clamp(next.radius / world * 8f, 0.1f, 2f);
                marker.alpha = 0.6f;
                marker.color1 = ParseColor(Text(body, "color", "#C4B454"));
                marker.color2 = marker.color1;
                marker.enableSaving = false;
                marker.Spawn();
                marker.SetParent(vending);
                marker.transform.localPosition = Vector3.zero;
                marker.SendUpdate();
                vending.SendNetworkUpdate();

                next.mapMarker = marker;
                next.mapLabel = vending;
            }
            catch (Exception cause)
            {
                // Sem marcador o evento funciona — só fica escondido.
                PrintWarning("o marcador do KOTH não nasceu: " + cause.Message);
            }
        }

        /// <summary>
        /// A bandeira não morre.
        ///
        /// ####  O PRIMEIRO JEITO ESTAVA ERRADO  ####
        ///
        /// A primeira versão zerava o `baseProtection` da bandeira
        /// achando que isso a tornava indestrutível. Faz o CONTRÁRIO:
        /// conferido no BaseCombatEntity do jogo, `baseProtection`
        /// nulo é tratado com segurança (`if (!baseProtection)`) e
        /// significa proteção NENHUMA — a bandeira ficava mais frágil.
        ///
        /// O jeito certo é recusar o dano. Ela é a marca do evento e o
        /// único ponto de referência de quem chega no meio do mato; um
        /// foguete nela no primeiro minuto apagaria o evento do mapa.
        ///
        /// O hook é global e roda a cada tiro do servidor: a primeira
        /// comparação recusa tudo que não é a nossa bandeira.
        /// </summary>
        private object OnEntityTakeDamage(BaseCombatEntity entity, HitInfo info)
        {
            if (run == null || run.banner == null) return null;
            if (entity == null || entity.net == null || run.banner.net == null) return null;
            if (entity.net.ID != run.banner.net.ID) return null;

            if (info != null)
            {
                info.damageTypes.ScaleAll(0f);
                info.HitMaterial = 0;
                info.PointStart = Vector3.zero;
            }

            return true;
        }

        private void Teardown(string why)
        {
            if (run == null) return;

            var closing = run;

            run = null;

            if (closing.ticker != null) closing.ticker.Destroy();

            foreach (var id in closing.watching.ToArray())
            {
                var player = BasePlayer.FindByID(id);

                if (player != null) CuiHelper.DestroyUi(player, UiRoot);
            }

            if (closing.banner != null && !closing.banner.IsDestroyed) closing.banner.Kill();
            if (closing.mapMarker != null && !closing.mapMarker.IsDestroyed) closing.mapMarker.Kill();
            if (closing.mapLabel != null && !closing.mapLabel.IsDestroyed) closing.mapLabel.Kill();

            Push("ended", new JObject { ["runId"] = closing.runId, ["reason"] = why });
        }

        // ============================================================
        //  §5  A BARRA NA TELA
        // ============================================================

        private void Draw(Run current, List<BasePlayer> inside, bool contested)
        {
            var percent = Percent(current);
            var seen = new HashSet<ulong>();

            foreach (var player in inside)
            {
                seen.Add(player.userID.Get());

                var soloWarning = current.requireTeam && player.currentTeam == 0UL;

                CuiHelper.DestroyUi(player, UiRoot);
                CuiHelper.AddUi(player, Hud(current, percent, contested, soloWarning));
            }

            // Quem saiu da zona perde a barra. Sem isto ela ficaria
            // grudada na tela até o fim do evento — e o jogador acharia
            // que ainda está pontuando.
            foreach (var id in current.watching.ToArray())
            {
                if (seen.Contains(id)) continue;

                var player = BasePlayer.FindByID(id);

                if (player != null) CuiHelper.DestroyUi(player, UiRoot);
            }

            current.watching.Clear();

            foreach (var id in seen) current.watching.Add(id);
        }

        /// <summary>
        /// O CUI da barra.
        ///
        /// Seis elementos, ~390 bytes cada: cabe folgado no frame. Ele é
        /// montado à mão porque muda a cada segundo — ver o cabeçalho.
        /// </summary>
        private string Hud(Run current, float percent, bool contested, bool soloWarning)
        {
            var container = new CuiElementContainer();

            var root = container.Add(new CuiPanel
            {
                Image = { Color = "0.05 0.05 0.05 0.75" },
                RectTransform = { AnchorMin = "0.35 0.86", AnchorMax = "0.65 0.92" },
                CursorEnabled = false,
            }, "Hud", UiRoot);

            container.Add(new CuiLabel
            {
                Text =
                {
                    Text = current.name,
                    FontSize = 12,
                    Align = TextAnchor.MiddleLeft,
                    Color = "0.77 0.71 0.33 1",
                },
                RectTransform = { AnchorMin = "0.02 0.52", AnchorMax = "0.7 0.98" },
            }, root);

            var estado = soloWarning
                ? "VOCÊ PRECISA DE UMA EQUIPE"
                : contested
                    ? "CONTESTADO"
                    : current.holder == 0UL
                        ? "SEM DONO"
                        : current.holderName;

            container.Add(new CuiLabel
            {
                Text =
                {
                    Text = estado,
                    FontSize = 10,
                    Align = TextAnchor.MiddleRight,
                    Color = soloWarning
                        ? "0.85 0.35 0.25 1"
                        : contested ? "0.90 0.65 0.20 1" : "0.85 0.85 0.85 1",
                },
                RectTransform = { AnchorMin = "0.3 0.52", AnchorMax = "0.98 0.98" },
            }, root);

            // O trilho da barra.
            var trilho = container.Add(new CuiPanel
            {
                Image = { Color = "0.15 0.15 0.15 0.9" },
                RectTransform = { AnchorMin = "0.02 0.12", AnchorMax = "0.98 0.45" },
            }, root);

            // O quanto já foi. Zero vira um fio invisível, e não um
            // retângulo de largura negativa.
            var fill = Mathf.Clamp01(percent / 100f);

            if (fill > 0.001f)
            {
                container.Add(new CuiPanel
                {
                    Image = { Color = contested ? "0.90 0.65 0.20 0.95" : "0.56 0.75 0.31 0.95" },
                    RectTransform =
                    {
                        AnchorMin = "0 0",
                        AnchorMax = fill.ToString("0.###", CultureInfo.InvariantCulture) + " 1",
                    },
                }, trilho);
            }

            container.Add(new CuiLabel
            {
                Text =
                {
                    Text = Mathf.RoundToInt(percent).ToString(CultureInfo.InvariantCulture) + "%",
                    FontSize = 9,
                    Align = TextAnchor.MiddleCenter,
                    Color = "1 1 1 0.9",
                },
                RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1" },
            }, trilho);

            return container.ToJson();
        }

        // ============================================================
        //  §6  FERRAMENTA
        // ============================================================

        private static float Elapsed(Run current)
        {
            return UnityEngine.Time.realtimeSinceStartup - current.startedAt;
        }

        private static float Percent(Run current)
        {
            if (current.captureSeconds <= 0f) return 0f;

            return Mathf.Clamp01(current.progress / current.captureSeconds) * 100f;
        }

        private string NameOf(ulong id)
        {
            var text = id.ToString(CultureInfo.InvariantCulture);
            var known = covalence.Players.FindPlayerById(text);

            return known != null && !string.IsNullOrEmpty(known.Name) ? known.Name : text;
        }

        private static string Text(JObject body, string key, string fallback)
        {
            var value = body[key];

            return value == null || value.Type == JTokenType.Null ? fallback : value.ToString();
        }

        private static float Number(JObject body, string key, float fallback)
        {
            var value = body[key];

            if (value == null || value.Type == JTokenType.Null) return fallback;

            float parsed;

            return float.TryParse(value.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out parsed)
                ? parsed
                : fallback;
        }

        private static Color ParseColor(string hex)
        {
            Color color;

            return ColorUtility.TryParseHtmlString(hex, out color) ? color : Color.yellow;
        }

        /// <summary>A grade do mapa: "E7". É o que gente lê.</summary>
        private static string Grid(Vector3 position)
        {
            var size = TerrainMeta.Size.x <= 0f ? 4000f : TerrainMeta.Size.x;
            var half = size / 2f;
            var cell = 146.3f;

            var column = Mathf.FloorToInt((position.x + half) / cell);
            var row = Mathf.FloorToInt((half - position.z) / cell);

            var letters = "";
            var value = column;

            do
            {
                letters = (char)('A' + value % 26) + letters;
                value = value / 26 - 1;
            }
            while (value >= 0);

            return letters + row.ToString(CultureInfo.InvariantCulture);
        }

        private void Push(string kind, JObject data)
        {
            if (string.IsNullOrEmpty(secret)) return;

            data["kind"] = kind;
            data["secret"] = secret;

            var line = Marker + data.ToString(Formatting.None);

            // Fora do frame do comando: um `Puts` disparado dentro dele
            // entra na resposta CASADA do RCON e a quebra. Medido no
            // OrigemZTeam em 15/09/2026.
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
