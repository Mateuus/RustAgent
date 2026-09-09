// ============================================================
//  OrigemZDungeon  -  a masmorra, construída de dentro do jogo.
//
//  ####  O TRUQUE QUE SUSTENTA TUDO  ####
//
//         superfície                        y ≈ 3
//    ┌────────────────┐
//    │    ENTRADA     │  uma casinha colada no mapa, com um alçapão
//    └────────┬───────┘
//             │  o alçapão NÃO desce: ele TELEPORTA
//             ▼
//    ┌────────────────┐
//    │    A MASMORRA  │  y = -90, longe de tudo, invisível do mapa
//    └────────────────┘
//
//  A -90 metros não há terreno, monumento, metrô nem base de
//  jogador. O construtor desenha 30 salas sem consultar o mundo,
//  o mapa não muda para quem sobrevoa, e fechar a masmorra é
//  matar um alçapão — não há porta para trancar por fora nem muro
//  para escalar.
//
//  O preço: o par de alçapões TEM de existir. Sem os dois, não há
//  masmorra, e o plugin diz isso em vez de deixar uma casinha
//  vazia de pé (`no_hatch`).
//
//  ------------------------------------------------------------
//  ####  DUAS MANEIRAS DE PRODUZIR A MESMA COISA  ####
//
//     PLANTA (blueprint)              RECEITA (recipe)
//     um .json de peças               parâmetros; o layout é sorteado
//          │                                │
//          ▼                                ▼
//     ┌──────────────────────────────────────────┐
//     │  células + salas + portas                │  ← a estrutura
//     └──────────────────────────────────────────┘
//                       │
//                       ▼
//     ┌──────────────────────────────────────────┐
//     │  funda, ergue, abre, tranca, popula      │  ← um construtor
//     └──────────────────────────────────────────┘
//
//  ------------------------------------------------------------
//  ####  O PAINEL MANDA; ESTE ARQUIVO EXECUTA  ####
//
//  A config abaixo tem CINCO chaves, todas sobre a máquina e
//  nenhuma sobre o jogo. Que masmorra existe, quanto ela dura, o
//  que ela fala e quantos NPCs ela tem vem do agente — e, nesta
//  primeira frente, do arquivo que o admin põe em
//
//      oxide/data/OrigemZDungeon/blueprints/<slug>.json
//
//  Um admin que edite o `oxide/config/OrigemZDungeon.json` não
//  consegue mudar o jogo, e é exatamente isso que se quer: UMA
//  fonte de verdade, e ela é o painel.
//
//  ------------------------------------------------------------
//  ####  O FORMATO DA PLANTA É O DO CopyPaste, E O LEITOR É
//        NOSSO  ####
//
//  As plantas que herdamos (`#dung#base2`, `#dung#entrance1`…)
//  são CopyPaste puro, e o CopyPaste NÃO está instalado aqui.
//  Depender dele significaria mais um plugin de terceiro no boot,
//  atrasando atrás de cada update do Rust, para ler um JSON de
//  seis campos. Então lemos nós — ver `PasteBlueprint`.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Core.Libraries.Covalence;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("OrigemZ Dungeon", "OrigemZ", "0.1.0")]
    [Description("Masmorras criadas e comandadas pelo painel")]
    public class OrigemZDungeon : CovalencePlugin
    {
        // ============================================================
        //  Os prefabs. Todos conferidos contra o Rust de 08/09/2026.
        // ============================================================

        private const string PrefabFoundation = "assets/prefabs/building core/foundation/foundation.prefab";
        private const string PrefabWall = "assets/prefabs/building core/wall/wall.prefab";
        private const string PrefabDoorway = "assets/prefabs/building core/wall.doorway/wall.doorway.prefab";
        private const string PrefabFloor = "assets/prefabs/building core/floor/floor.prefab";
        private const string PrefabHatchSource = "assets/prefabs/building/floor.ladder.hatch/floor.ladder.hatch.prefab";
        private const string PrefabHatch = "assets/bundled/prefabs/static/door.hinged.bunker_hatch.prefab";
        private const string PrefabCeilingLight = "assets/prefabs/deployable/ceiling light/ceilinglight.deployed.prefab";

        /// <summary>A porta de cada cor de sala. Verde é a mais barata.</summary>
        private static readonly Dictionary<string, string> DoorByColor = new Dictionary<string, string>
        {
            ["green"] = "assets/bundled/prefabs/static/door.hinged.security.green.prefab",
            ["blue"] = "assets/bundled/prefabs/static/door.hinged.security.blue.prefab",
            ["red"] = "assets/bundled/prefabs/static/door.hinged.security.red.prefab",
        };

        /// <summary>Leste, norte, oeste, sul — nesta ordem, sempre.</summary>
        private static readonly (int dx, int dz)[] Dirs = { (1, 0), (0, 1), (-1, 0), (0, -1) };

        private static readonly Quaternion R0 = Quaternion.identity;
        private static readonly Quaternion R90 = Quaternion.Euler(0f, 90f, 0f);
        private static readonly Quaternion R180 = Quaternion.Euler(0f, 180f, 0f);
        private static readonly Quaternion R270 = Quaternion.Euler(0f, 270f, 0f);

        /// <summary>O passo do grid, em metros. Uma fundação.</summary>
        private const float CellSize = 3f;

        /// <summary>
        /// Os formatos de sala que o sorteio conhece, em células.
        ///
        /// Só retângulos: a regra "a parede morre entre duas células
        /// da mesma sala" produz geometria válida só para eles. Uma
        /// sala em L nasceria com uma parede solta no meio.
        /// </summary>
        private static readonly (int w, int d)[] RoomShapes = { (1, 2), (2, 2), (3, 1), (3, 2), (3, 3) };

        private const string PermAdmin = "origemzdungeon.admin";

        /// <summary>
        /// A marca no `_name` de tudo que a masmorra ergueu.
        ///
        /// É como o `OnEntityTakeDamage` sabe, em O(1), que aquela
        /// parede é nossa e não deve receber dano — sem manter uma
        /// lista de 3.000 entidades para consultar a cada tiro.
        /// </summary>
        private const string MarkIndestructible = "#ozdung#";

        // ============================================================
        //  A CONFIG — cinco chaves, todas sobre a máquina
        // ============================================================

        private class ConfigData
        {
            [JsonProperty("Prefixo das linhas para o agente")]
            public string agentMarker = "#OZDUNGEON#";

            [JsonProperty("Profundidade da masmorra (Y)")]
            public float baseDepth = -90f;

            [JsonProperty("Entidades por tick (freio da construção)")]
            public int entitiesPerTick = 25;

            [JsonProperty("Tempo máximo de construção (segundos)")]
            public int buildTimeout = 60;

            [JsonProperty("Log detalhado")]
            public bool debug = false;
        }

        private ConfigData config = new ConfigData();

        protected override void LoadDefaultConfig() => config = new ConfigData();

        protected override void LoadConfig()
        {
            base.LoadConfig();
            try
            {
                config = Config.ReadObject<ConfigData>() ?? new ConfigData();
            }
            catch (Exception e)
            {
                // Config ilegível vira config padrão COM AVISO. Cair no
                // load deixaria o servidor sem o plugin por causa de uma
                // vírgula — e sem ninguém para dizer isso no chat.
                PrintError("Config ilegível, usando os padrões: " + e.Message);
                config = new ConfigData();
            }
            SaveConfig();
        }

        protected override void SaveConfig() => Config.WriteObject(config, true);

        // ============================================================
        //  O ESTADO
        // ============================================================

        /// <summary>
        /// A masmorra que está de pé agora. `null` = nenhuma.
        ///
        /// UMA por servidor, nesta frente. Duas ao mesmo tempo exigem
        /// o `OrigemZEvents` para arbitrar quem nasce quando, e ele é
        /// a frente G.
        /// </summary>
        private ActiveDungeon active;

        /// <summary>Onde as plantas moram. Calculado uma vez no Init.</summary>
        private string blueprintDir;

        /// <summary>
        /// Uma masmorra viva: o que foi erguido e como desfazer.
        /// </summary>
        private class ActiveDungeon
        {
            public string slug;
            /// <summary>A receita do painel. `null` = a planta foi colada crua.</summary>
            public DungeonSpec spec;
            /// <summary>Onde a entrada foi colada, na superfície.</summary>
            public Vector3 surface;
            /// <summary>O canto de onde a masmorra cresceu, a -90.</summary>
            public Vector3 origin;
            public uint buildingId;
            /// <summary>Tudo que foi erguido, na ordem em que nasceu.</summary>
            public readonly List<BaseEntity> entities = new List<BaseEntity>();

            // ####  OS DOIS ALÇAPÕES TÊM DONOS DIFERENTES  ####
            //
            // O de cima vem da PLANTA (é ela que sabe onde fica a
            // escotilha na casinha); o de baixo é NOSSO, no teto do
            // lobby. Guardá-los em campos separados, e não numa lista
            // ordenada por altura, é o que faz o par ser previsível
            // numa planta com oito marcas — como a `entrance1`.
            /// <summary>O da superfície. Vem da planta.</summary>
            public Door entranceHatch;
            /// <summary>O do fundo. Nasce no teto da célula (0,0).</summary>
            public Door exitHatch;
            /// <summary>Quem está lá dentro agora.</summary>
            public readonly HashSet<ulong> inside = new HashSet<ulong>();
            /// <summary>A cor sorteada de cada sala. Ver `RoomColor`.</summary>
            public readonly Dictionary<int, string> roomColors = new Dictionary<int, string>();
            public DateTime startedAt;
            public bool ready;
            /// <summary>Desiste se a construção não terminar. Ver `buildTimeout`.</summary>
            public Timer watchdog;
        }

        /// <summary>
        /// O destino de cada alçapão, e para que lado ele leva.
        ///
        /// Vive como componente na porta porque é ali que o
        /// `OnDoorOpened` a encontra sem procurar em lista nenhuma.
        /// </summary>
        private class HatchLink : MonoBehaviour
        {
            public Vector3 target;
            /// <summary>true = este é o de cima; abrir desce.</summary>
            public bool descends;
        }

        // ============================================================
        //  CICLO DE VIDA
        // ============================================================

        private void Init()
        {
            permission.RegisterPermission(PermAdmin, this);

            // ####  SEM SUBPASTA, E ISSO É CONTRATO  ####
            //
            // Quem grava aqui é o agente, pelo `oxide/data-files.ts`,
            // e ele só sabe escrever `<plugin>/<arquivo>.json` — os
            // dois nomes sem barra. É essa restrição que faz a trava
            // de `..` dele valer. Mudar para uma subpasta aqui é
            // pedir para o agente escrever num lugar que o plugin
            // não lê.
            blueprintDir = Path.Combine(Interface.Oxide.DataDirectory, "OrigemZDungeon");
        }

        private void OnServerInitialized()
        {
            try
            {
                if (!Directory.Exists(blueprintDir)) Directory.CreateDirectory(blueprintDir);
            }
            catch (Exception e)
            {
                PrintError("Não consegui criar " + blueprintDir + ": " + e.Message);
            }

            Puts("OrigemZDungeon no ar. Plantas em: " + blueprintDir);

            // ####  O PLUGIN PEDE O ESTADO; O AGENTE NÃO ADIVINHA  ####
            //
            // Um `oxide.reload` esvazia o cache daqui sem derrubar o
            // RCON: para o agente, nada aconteceu. Sem este grito, o
            // plugin ficaria sem masmorra nenhuma até o próximo sync
            // por relógio — e o admin veria "não conheço essa planta"
            // logo depois de recarregar.
            //
            // Ele vai SEM segredo, porque é justamente o segredo que
            // o plugin ainda não tem. Forjá-lo pelo chat não faz
            // dano: o agente responde reenviando o que já era para
            // estar aqui.
            timer.Once(1f, () => Puts(config.agentMarker + "{\"kind\":\"ready\",\"version\":\"0.1.0\"}"));
        }

        /// <summary>
        /// Estamos no meio do descarregamento?
        ///
        /// Só o `Report` olha isto, e a razão está lá: um `NextTick`
        /// agendado durante o `Unload` nunca chega, porque o plugin já
        /// não existe quando ele rodaria.
        /// </summary>
        private bool unloading;

        private void Unload()
        {
            unloading = true;

            // Nada da masmorra entra no save do mundo (ver
            // `PrepareBlock`), então o que não for derrubado aqui vira
            // ruína pendurada a -90 até o próximo wipe.
            if (active != null) Demolish("unload");
        }

        // ============================================================
        //  OS COMANDOS
        //
        //  ####  UM HANDLER, DOIS TRANSPORTES  ####
        //
        //  `[Command]` do Covalence atende o chat (`/ozdungeon`) E o
        //  console (`ozdungeon`) com o mesmo método. É o que faz o
        //  agente, na frente C, reusar exatamente o caminho que o
        //  admin já testou de dentro do jogo — em vez de um segundo
        //  comando parecido que diverge do primeiro em um detalhe.
        // ============================================================

        [Command("ozdungeon", "ozdung")]
        private void CmdDungeon(IPlayer player, string command, string[] args)
        {
            if (!IsAllowed(player))
            {
                player.Reply("Você não tem permissão para isso.");
                return;
            }

            var sub = args.Length > 0 ? args[0].ToLowerInvariant() : "";

            switch (sub)
            {
                case "":
                case "lista":
                case "list":
                    ReplyList(player);
                    return;

                case "build":
                case "construir":
                    CmdBuild(player, args.Skip(1).ToArray());
                    return;

                case "stop":
                case "parar":
                    if (active == null) { player.Reply("Não há masmorra de pé."); return; }
                    var slug = active.slug;
                    Demolish("command");
                    player.Reply("Masmorra '" + slug + "' derrubada.");
                    return;

                case "tp":
                    CmdTeleportToEntrance(player);
                    return;

                case "status":
                    ReplyStatus(player);
                    return;

                default:
                    player.Reply("Não conheço '" + sub + "'. Use: /ozdungeon [lista|build <planta>|stop|tp|status]");
                    return;
            }
        }

        private bool IsAllowed(IPlayer player)
        {
            // O console do servidor é sempre admin: é por ele que o
            // agente vai falar na frente C.
            return player.IsServer || player.IsAdmin || permission.UserHasPermission(player.Id, PermAdmin);
        }

        private void ReplyList(IPlayer player)
        {
            var names = ListBlueprints();
            if (names.Count == 0)
            {
                player.Reply("Nenhuma planta em " + blueprintDir +
                             ". Ponha um .json lá e use /ozdungeon build <nome>.");
                return;
            }

            player.Reply("Plantas (" + names.Count + "): " + string.Join(", ", names));
            player.Reply("Use: /ozdungeon build <nome>  — nasce onde você está, para onde você olha.");
        }

        private void ReplyStatus(IPlayer player)
        {
            if (active == null) { player.Reply("Nenhuma masmorra de pé."); return; }

            var minutes = (int)(DateTime.UtcNow - active.startedAt).TotalMinutes;
            player.Reply("Masmorra '" + active.slug + "'"
                         + " · " + active.entities.Count + " peças"
                         + " · " + active.inside.Count + " dentro"
                         + " · de pé há " + minutes + " min"
                         + " · entrada em " + Grid(active.surface));
        }

        private void CmdTeleportToEntrance(IPlayer player)
        {
            if (active == null) { player.Reply("Não há masmorra de pé."); return; }

            var basePlayer = player.Object as BasePlayer;
            if (basePlayer == null) { player.Reply("Esse comando só funciona de dentro do jogo."); return; }

            basePlayer.Teleport(active.surface + Vector3.up * 1.5f);
            player.Reply("Você está na entrada.");
        }

        // ============================================================
        //  BUILD — o comando que o painel manda o admin colar
        // ============================================================

        private void CmdBuild(IPlayer player, string[] args)
        {
            if (args.Length == 0)
            {
                player.Reply("Falta o nome da planta. /ozdungeon build <nome>");
                return;
            }

            if (active != null)
            {
                player.Reply("Já existe uma masmorra de pé ('" + active.slug + "'). Use /ozdungeon stop antes.");
                return;
            }

            var slug = Sanitize(args[0]);
            if (slug == null)
            {
                player.Reply("Nome inválido. Use letras, números, '-' e '_'.");
                return;
            }

            Vector3 surface;
            Vector3 forward;

            // ####  DUAS FORMAS, E A SEGUNDA EXISTE POR DOIS MOTIVOS  ####
            //
            //   build <planta>              onde eu estou, para onde eu olho
            //   build <planta> <x> <z> [g]  naquele ponto do mapa
            //
            // A segunda é o que o agente vai chamar na frente C — e é o
            // único jeito de conferir a construção sem um cliente de
            // Rust aberto, o que faz dela a forma que se testa primeiro.
            if (args.Length >= 3
                && float.TryParse(args[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var x)
                && float.TryParse(args[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var z))
            {
                var yaw = 0f;
                if (args.Length >= 4)
                    float.TryParse(args[3], NumberStyles.Float, CultureInfo.InvariantCulture, out yaw);

                surface = new Vector3(x, GroundAt(x, z), z);
                forward = Quaternion.Euler(0f, yaw, 0f) * Vector3.forward;
            }
            else
            {
                var basePlayer = player.Object as BasePlayer;
                if (basePlayer == null)
                {
                    player.Reply("Do console, informe onde: ozdungeon build " + slug + " <x> <z> [graus]");
                    return;
                }

                // A direção de crescimento é para onde o admin olha,
                // achatada no plano. Custa uma linha e dá controle real
                // sobre um mapa apertado.
                forward = basePlayer.eyes.HeadForward();
                forward.y = 0f;
                if (forward.sqrMagnitude < 0.001f) forward = Vector3.forward;
                forward.Normalize();

                surface = basePlayer.transform.position;
            }

            player.Reply("Construindo '" + slug + "'…");
            Build(slug, surface, forward, player);
        }

        // ============================================================
        //  A CONSTRUÇÃO, EM DUAS METADES
        //
        //  Entrada na superfície, masmorra a -90. As duas nascem, e
        //  só então os alçapões são emparelhados: antes disso não há
        //  o que emparelhar, e emparelhar cedo é a origem do
        //  "No hatch found" que a base 1.3.4 leva 60 segundos para
        //  descobrir.
        // ============================================================

        private void Build(string slug, Vector3 surface, Vector3 forward, IPlayer requester)
        {
            // ####  O SLUG É DE UMA MASMORRA; A PLANTA É PLANO B  ####
            //
            // Com o painel no ar, `/ozdungeon build bunker` quer dizer
            // "erga a masmorra Bunker" — e é ELA que sabe qual planta
            // serve de entrada, de que tamanho é e o que tem em cada
            // sala.
            //
            // Sem o painel (agente parado, plugin recém-instalado, um
            // .json posto à mão para testar), o slug cai de volta para
            // "cole esta planta". Os dois caminhos existem porque o
            // segundo é o que permite conferir uma planta ANTES de
            // cadastrar qualquer coisa.
            DungeonSpec spec;
            state.dungeons.TryGetValue(slug, out spec);

            var blueprintName = spec != null && !string.IsNullOrEmpty(spec.entrance)
                ? spec.entrance
                : slug;

            var dungeon = new ActiveDungeon
            {
                slug = slug,
                spec = spec,
                surface = surface,
                origin = new Vector3(surface.x, config.baseDepth, surface.z),
                buildingId = BuildingManager.server.NewBuildingID(),
                startedAt = DateTime.UtcNow,
            };
            active = dungeon;

            var blueprint = LoadBlueprint(blueprintName);

            // ####  SEM PLANTA ESCOLHIDA, A ENTRADA É GERADA AQUI  ####
            //
            // O painel oferece "Entrada mínima — gerada por código: uma
            // laje, um alçapão e uma luz" como a opção PADRÃO, e até
            // aqui ela produzia `blueprint_missing` no jogo: sem
            // `spec.entrance`, o plugin caía de volta para "procure uma
            // planta com o nome da masmorra", que ninguém tinha.
            //
            // Quem aceitasse o padrão do painel — o caminho mais provável
            // de todos — via a masmorra falhar sem entender por quê.
            var minimal = blueprint == null && spec != null && string.IsNullOrEmpty(spec.entrance);

            if (blueprint == null && !minimal)
            {
                Fail(requester, "blueprint_missing",
                     spec == null
                         ? "Não achei a masmorra nem a planta '" + slug + "'. Use /ozdungeon para ver o que existe."
                         : "A masmorra '" + slug + "' aponta para a planta '" + blueprintName
                           + "', que não está em " + blueprintDir);
                return;
            }

            // ####  O RELÓGIO COMEÇA AQUI  ####
            //
            // Uma construção que não termina não pode ficar de pé para
            // sempre bloqueando a próxima. Sessenta segundos é o número
            // que a base 1.3.4 usa para desistir, e ele já viu servidor
            // carregado.
            dungeon.watchdog = timer.Once(config.buildTimeout, () =>
            {
                if (active != dungeon || dungeon.ready) return;
                Fail(requester, "build_timeout",
                     "Passei de " + config.buildTimeout + "s construindo '" + slug + "' e desisti.");
            });

            // 1) A entrada, na superfície, orientada para onde o admin
            //    olha. É ela que traz o alçapão de cima.
            var yaw = Quaternion.LookRotation(forward, Vector3.up).eulerAngles.y;

            if (minimal)
            {
                int made;

                try
                {
                    made = BuildMinimalEntrance(dungeon, surface, yaw);
                }
                catch (Exception e)
                {
                    Fail(requester, "build_error", "Falhei ao erguer a entrada: " + e.Message);
                    return;
                }

                if (made == 0)
                {
                    Fail(requester, "build_error", "A entrada mínima não subiu: nenhuma peça nasceu.");
                    return;
                }

                Debug("entrada mínima: " + made + " peças em " + surface);
                BuildBelow(dungeon, slug, surface, forward, requester);
                return;
            }

            PasteBlueprint(dungeon, blueprint, surface, yaw, (placed, error) =>
            {
                if (active != dungeon) return;

                if (error != null)
                {
                    Fail(requester, "blueprint_invalid",
                         "A planta '" + slug + "' não pôde ser lida: " + error);
                    return;
                }

                if (placed == 0)
                {
                    Fail(requester, "blueprint_invalid", "A planta '" + slug + "' não tem nenhuma peça válida.");
                    return;
                }

                Debug("entrada: " + placed + " peças em " + surface);

                // 2) A masmorra, a -90.
                BuildBelow(dungeon, slug, surface, forward, requester);
            });
        }

        /// <summary>
        /// A masmorra a -90, depois que a entrada já está de pé.
        ///
        /// ####  UM TICK DEPOIS, E ISSO NÃO É ZELO  ####
        ///
        /// Parede filha de uma fundação que ainda não existe cai por
        /// instabilidade no mesmo instante em que nasce.
        ///
        /// Ela é chamada dos DOIS caminhos da entrada — a planta colada
        /// e a entrada mínima gerada por código —, e é por isso que
        /// virou método: duplicá-la faria a entrada mínima nascer sem
        /// watchdog, sem emparelhamento ou sem o `Report`, e o painel
        /// ficaria esperando um "terminei" que nunca vem.
        /// </summary>
        private void BuildBelow(
            ActiveDungeon dungeon, string slug, Vector3 surface, Vector3 forward, IPlayer requester)
        {
            NextTick(() =>
            {
                if (active != dungeon) return;

                try
                {
                    GenerateRooms(dungeon, forward);
                }
                catch (Exception e)
                {
                    Fail(requester, "build_error", "Falhei ao erguer a masmorra: " + e.Message);
                    return;
                }

                // 3) Emparelhar. Só agora existem os dois.
                timer.Once(1f, () =>
                {
                    if (active != dungeon) return;

                    if (!LinkHatches(dungeon))
                    {
                        Fail(requester, "no_hatch",
                             "A planta subiu, mas não achei o par de alçapões. Sem eles não há masmorra.");
                        return;
                    }

                    dungeon.ready = true;
                    dungeon.watchdog?.Destroy();
                    dungeon.watchdog = null;

                    var ms = (int)(DateTime.UtcNow - dungeon.startedAt).TotalMilliseconds;

                    requester?.Reply("Masmorra '" + slug + "' de pé: "
                                     + dungeon.entities.Count + " peças em " + ms + " ms. "
                                     + "A entrada está em " + Grid(surface) + ".");

                    Report("built", new Dictionary<string, object>
                    {
                        ["slug"] = slug,
                        ["x"] = surface.x,
                        ["z"] = surface.z,
                        ["grid"] = Grid(surface),
                        ["entities"] = dungeon.entities.Count,
                        ["ms"] = ms,
                    });
                });
            });
        }

        /// <summary>
        /// Desiste, derruba o que já subiu e diz por quê — com o mesmo
        /// nome de motivo que o painel vai mostrar.
        /// </summary>
        private void Fail(IPlayer requester, string reason, string human)
        {
            PrintWarning(human);
            requester?.Reply(human);

            Report("failed", new Dictionary<string, object>
            {
                ["slug"] = active?.slug,
                ["reason"] = reason,
            });

            Demolish(reason);
        }

        // ============================================================
        //  A LIMPEZA
        // ============================================================

        private void Demolish(string reason)
        {
            var dungeon = active;
            active = null;
            if (dungeon == null) return;

            // Antes de qualquer coisa: um watchdog vivo depois da
            // demolição chamaria `Fail` sobre uma masmorra que já não
            // existe, e o `Fail` chama `Demolish` de novo.
            dungeon.watchdog?.Destroy();
            dungeon.watchdog = null;

            // ####  AVISAR QUE ACABOU NÃO É OPCIONAL  ####
            //
            // MEDIDO em 09/09/2026: sem esta linha, um `ozdungeon
            // stop` derruba a masmorra no jogo e deixa a run ABERTA
            // no banco — para sempre. O painel passa a dizer "1 no
            // ar" com o mapa vazio, e nada no sistema conserta isso
            // sozinho.
            //
            // A masmorra que nunca chegou a ficar de pé (`ready`
            // falso) não gera `ended`: quem falhou já reportou
            // `failed`, e dois eventos para o mesmo desfecho fariam
            // o histórico contar duas vezes.
            if (dungeon.ready)
            {
                Report("ended", new Dictionary<string, object>
                {
                    ["reason"] = reason,
                    ["entered"] = dungeon.inside.Count,
                });
            }

            // Quem está dentro sai ANTES de a estrutura sumir. Matar o
            // chão debaixo de um jogador a -90 o deixa caindo para
            // sempre, e ele volta como "preso no terreno".
            foreach (var id in dungeon.inside.ToList())
            {
                var player = BasePlayer.FindByID(id);
                if (player == null || !player.IsConnected) continue;
                TeleportPlayer(player, dungeon.surface + Vector3.up * 1.5f);
            }
            dungeon.inside.Clear();

            var killed = 0;
            foreach (var entity in dungeon.entities)
            {
                if (entity == null || entity.IsDestroyed) continue;
                entity.Kill();
                killed++;
            }
            dungeon.entities.Clear();
            dungeon.entranceHatch = null;
            dungeon.exitHatch = null;

            Debug("derrubada ('" + reason + "'): " + killed + " peças");
        }

        // ============================================================
        //  O SORTEIO DO LAYOUT
        //
        //  Um corredor que serpenteia, e salas penduradas nele.
        //
        //      z ▲
        //      3 │  .  .  ┌──────┐  .        . vazio
        //        │        │  A   │           ▓ corredor
        //      2 │  .  ▓  │  A   │  .        A,B salas
        //        │        └──╥───┘           ╥ porta
        //      1 │  .  ▓  ▓  ▓  ▓  ▓
        //        │     ║
        //      0 │  E  ▓  .  ┌───┐  .        E entrada (0,0)
        //        │           │ B │
        //     -1 │  .  ▓  .  └───┘  .
        //        └────────────────────► x
        //          0  1  2  3  4  5
        //
        //  ####  O CORREDOR TEM DOIS DE LARGURA  ####
        //
        //  `corridor` é uma lista de PARES de células, não de células.
        //  Um corredor de uma célula parece certo no desenho e vira um
        //  cano claustrofóbico no jogo — dois jogadores não se cruzam
        //  nele. A base 1.3.4 já tinha aprendido isso.
        //
        //  ####  (0,0) É SEMPRE A ENTRADA  ####
        //
        //  É onde o alçapão de descida cospe o jogador. Ela e a (0,1)
        //  ficam reservadas: uma sala ali taparia a chegada.
        // ============================================================

        private class Layout
        {
            /// <summary>Toda célula que existe.</summary>
            public readonly HashSet<(int, int)> cells = new HashSet<(int, int)>();
            /// <summary>De quem é cada célula: -1 = corredor, 0..n = sala n.</summary>
            public readonly Dictionary<(int, int), int> owner = new Dictionary<(int, int), int>();
            /// <summary>Onde a parede vira porta: (célula da sala, célula do corredor).</summary>
            public readonly List<((int, int) room, (int, int) corridor)> doors = new List<((int, int), (int, int))>();
            /// <summary>A espinha, em pares lado a lado.</summary>
            public readonly List<((int, int) a, (int, int) b)> corridor = new List<((int, int), (int, int))>();
            public int roomCount;
        }

        private Layout BuildLayout(int targetRooms, System.Random rng)
        {
            var layout = new Layout();

            // 1) A espinha. Anda em segmentos de 8 a 16 passos e vira
            //    para um dos lados — o que produz um traçado que parece
            //    escavado, e não um corredor reto de 90 metros.
            var x = 0;
            var z = 0;
            var dir = 0;
            var stepsLeft = rng.Next(8, 17);

            // Três células de corredor por sala é a proporção que a
            // 1.3.4 usa, e ela dá salas com espaço para nascer nos dois
            // lados sem se atropelarem.
            var wanted = targetRooms * 3 + 6;

            while (layout.cells.Count < wanted)
            {
                if (stepsLeft <= 0)
                {
                    stepsLeft = rng.Next(8, 17);
                    dir = (dir + (rng.Next(2) == 0 ? 1 : 3)) % 4;
                }

                // O par: a célula e a vizinha à sua esquerda.
                var side = (dir + 1) % 4;
                var a = (x, z);
                var b = (x + Dirs[side].dx, z + Dirs[side].dz);

                layout.corridor.Add((a, b));
                foreach (var c in new[] { a, b })
                {
                    if (layout.cells.Add(c)) layout.owner[c] = -1;
                }

                stepsLeft--;
                x += Dirs[dir].dx;
                z += Dirs[dir].dz;
            }

            // 2) As salas, penduradas nas laterais livres do corredor.
            //    Quatro passadas: a primeira pega os lugares fáceis, e
            //    as seguintes aproveitam o que sobrou entre elas.
            var nextRoom = 0;
            for (var pass = 0; pass < 4 && nextRoom < targetRooms; pass++)
            {
                var free = layout.cells
                    .Where(c => layout.owner.TryGetValue(c, out var o) && o < 0)
                    .OrderBy(_ => rng.Next())
                    .ToList();

                foreach (var corridorCell in free)
                {
                    if (nextRoom >= targetRooms) break;
                    if (IsEntranceCell(corridorCell)) continue;

                    for (var side = 0; side < 4 && nextRoom < targetRooms; side++)
                    {
                        var anchor = (corridorCell.Item1 + Dirs[side].dx, corridorCell.Item2 + Dirs[side].dz);
                        if (layout.cells.Contains(anchor)) continue;

                        if (TryPlaceRoom(layout, anchor, side, nextRoom, rng))
                        {
                            layout.doors.Add((anchor, corridorCell));
                            nextRoom++;
                        }
                    }
                }
            }

            layout.roomCount = nextRoom;
            return layout;
        }

        /// <summary>
        /// Tenta encaixar um retângulo com um canto em <paramref name="anchor"/>.
        /// Devolve false quando nenhum formato coube.
        /// </summary>
        private bool TryPlaceRoom(Layout layout, (int, int) anchor, int side, int roomId, System.Random rng)
        {
            foreach (var shape in RoomShapes.OrderBy(_ => rng.Next()))
            {
                int width, depth, originX, originZ;

                // Sala que sai pelo lado leste/oeste nasce deitada; pelo
                // norte/sul, em pé. Sem isso, metade delas cresceria
                // para dentro do corredor.
                if (side <= 1)
                {
                    width = shape.w;
                    depth = shape.d;
                    var offset = rng.Next(shape.w);
                    originX = anchor.Item1 - offset;
                    originZ = side == 0 ? anchor.Item2 : anchor.Item2 - depth + 1;
                }
                else
                {
                    width = shape.d;
                    depth = shape.w;
                    var offset = rng.Next(shape.w);
                    originX = side == 2 ? anchor.Item1 : anchor.Item1 - width + 1;
                    originZ = anchor.Item2 - offset;
                }

                var fits = true;
                for (var dx = 0; dx < width && fits; dx++)
                    for (var dz = 0; dz < depth && fits; dz++)
                        if (layout.cells.Contains((originX + dx, originZ + dz))) fits = false;

                if (!fits) continue;

                for (var dx = 0; dx < width; dx++)
                    for (var dz = 0; dz < depth; dz++)
                    {
                        var cell = (originX + dx, originZ + dz);
                        layout.cells.Add(cell);
                        layout.owner[cell] = roomId;
                    }

                return true;
            }

            return false;
        }

        // ============================================================
        //  O DESENHO DO PAINEL VIRA LAYOUT
        //
        //  ####  ATÉ AQUI O MODO PLANTA SÓ EXISTIA NO PAINEL  ####
        //
        //  O admin desenhava célula a célula, via a prévia, salvava — e
        //  o jogo sorteava um traçado qualquer assim mesmo, porque
        //  `GenerateRooms` só sabia chamar `BuildLayout`. O desenho
        //  chegava aqui dentro de `spec.grid` e não era lido por
        //  ninguém.
        //
        //  ####  A TRANSLAÇÃO É PELO `E`, E NÃO PELO CANTO  ####
        //
        //  A (0,0) é a origem da masmorra: o ponto que o alçapão
        //  conhece, e para onde ele teleporta quem desce. O desenho que
        //  chega tem o `E` em qualquer lugar das linhas — ele foi
        //  recortado pelo editor —, então tudo é deslocado para que o
        //  `E` caia ali.
        //
        //  Alinhar pelo canto poria a chegada dentro de uma sala, ou no
        //  vazio: o jogador desceria para dentro de um quadrado
        //  fechado, ou cairia noventa metros.
        // ============================================================

        /// <summary>
        /// O maior desenho que o construtor aceita, em células.
        ///
        /// O editor do painel trabalha num grid de 24×24, ou seja 576
        /// células — e cada célula são três peças (fundação, teto e a
        /// média de paredes). O teto existe porque a régua do agente
        /// aceita 64×64: um desenho colado à mão por API poderia pedir
        /// 4.096 células e doze mil entidades, e o servidor engasgaria
        /// no meio, deixando meia masmorra de pé.
        /// </summary>
        private const int MaxGridCells = 600;

        /// <summary>
        /// Lê o desenho do painel e devolve o mesmo <see cref="Layout"/>
        /// que o sorteio produz. Daí para baixo o construtor é um só.
        /// </summary>
        private Layout LayoutFromGrid(ActiveDungeon dungeon, List<string> rows)
        {
            var layout = new Layout();

            // 1) Onde está o E. Ver o cabeçalho: tudo é transladado para
            //    que ele caia em (0,0).
            var offsetX = 0;
            var offsetZ = 0;
            var found = false;

            for (var index = 0; index < rows.Count && !found; index++)
            {
                var row = rows[index] ?? "";
                var column = row.IndexOf('E');

                if (column < 0) continue;

                offsetX = -column;
                // A primeira linha é a de MAIOR z: o norte em cima, como
                // um mapa é lido. Inverter isto espelha a masmorra.
                offsetZ = -(rows.Count - 1 - index);
                found = true;
            }

            if (!found)
            {
                throw new InvalidOperationException(
                    "o desenho não tem entrada (E), e é nela que o alçapão cospe o jogador");
            }

            // 2) As células. A letra é a COR da sala, e não o número
            //    dela — quem separa "duas vermelhas" de "uma vermelha
            //    grande" é o passo 3.
            var painted = new Dictionary<(int, int), char>();

            for (var index = 0; index < rows.Count; index++)
            {
                var row = rows[index] ?? "";
                var z = rows.Count - 1 - index + offsetZ;

                for (var column = 0; column < row.Length; column++)
                {
                    var ch = row[column];

                    if (ch == '.' || ch == ' ') continue;

                    var cell = (column + offsetX, z);

                    layout.cells.Add(cell);

                    if (ch == '#' || ch == 'E') layout.owner[cell] = -1;
                    else painted[cell] = ch;
                }
            }

            if (layout.cells.Count > MaxGridCells)
            {
                throw new InvalidOperationException(
                    "o desenho tem " + layout.cells.Count + " células e o teto é " + MaxGridCells);
            }

            // 3) Cada mancha contígua da mesma cor é uma sala. É a mesma
            //    regra do editor e a mesma do verificador do agente: o
            //    admin pinta COR, e o agrupamento é derivado.
            var nextRoom = 0;

            foreach (var start in painted.Keys.ToList())
            {
                if (layout.owner.ContainsKey(start)) continue;

                var color = painted[start];
                var id = nextRoom++;
                var queue = new Queue<(int, int)>();

                layout.owner[start] = id;
                queue.Enqueue(start);

                while (queue.Count > 0)
                {
                    var current = queue.Dequeue();

                    for (var d = 0; d < 4; d++)
                    {
                        var next = (current.Item1 + Dirs[d].dx, current.Item2 + Dirs[d].dz);

                        if (layout.owner.ContainsKey(next)) continue;

                        char theirs;
                        if (!painted.TryGetValue(next, out theirs) || theirs != color) continue;

                        layout.owner[next] = id;
                        queue.Enqueue(next);
                    }
                }

                // ####  A COR É A DO DESENHO, E NÃO A DOS PESOS  ####
                //
                // Decidida aqui, ela entra no mesmo cache que o sorteio
                // usa — então `RoomColor` a devolve sem sortear nada. Um
                // admin que pintou a sala de vermelho não quer que os
                // pesos da receita a repintem de verde.
                dungeon.roomColors[id] = ColorOfChar(color);
            }

            layout.roomCount = nextRoom;

            // 4) A porta nasce onde a sala encosta no corredor. TODAS as
            //    adjacências, e não uma por sala: é o que o editor
            //    promete ao admin enquanto ele desenha, e é o que a
            //    verificação dele assume quando avisa que um cômodo de
            //    uma célula com corredor em três lados nasce sem parede.
            foreach (var pair in layout.owner)
            {
                if (pair.Value < 0) continue;

                for (var d = 0; d < 4; d++)
                {
                    var neighbour = (pair.Key.Item1 + Dirs[d].dx, pair.Key.Item2 + Dirs[d].dz);

                    int theirs;
                    if (!layout.owner.TryGetValue(neighbour, out theirs) || theirs >= 0) continue;

                    layout.doors.Add((pair.Key, neighbour));
                }
            }

            return layout;
        }

        /// <summary>
        /// Esta masmorra tem desenho para seguir?
        ///
        /// O `mode` é conferido junto com o grid, e não só ele: uma
        /// receita que carrega um grid velho — porque o admin desenhou,
        /// mudou de ideia e voltou para receita — não pode construir o
        /// desenho abandonado.
        /// </summary>
        private static bool HasDrawing(ActiveDungeon dungeon) =>
            dungeon.spec != null
            && dungeon.spec.mode == "blueprint"
            && dungeon.spec.grid != null
            && dungeon.spec.grid.Count > 0;

        /// <summary>A letra do formato salvo, na cor que ela significa.</summary>
        private static string ColorOfChar(char ch)
        {
            if (ch == 'B') return "blue";
            if (ch == 'R') return "red";

            // Uma letra desconhecida cai em verde — o mesmo que o editor
            // faz ao reabrir um desenho de antes de a letra guardar a
            // cor. Recusar aqui derrubaria a masmorra inteira por causa
            // de um caractere.
            return "green";
        }

        /// <summary>A (0,0) e a (0,1): a chegada do alçapão.</summary>
        private static bool IsEntranceCell((int, int) cell) =>
            cell.Item1 == 0 && (cell.Item2 == 0 || cell.Item2 == 1);

        // ============================================================
        //  ERGUER — do layout ao mundo
        //
        //  Três regras, e é só isso:
        //
        //    uma célula          = uma fundação, mais um teto
        //    entre dois vizinhos = uma parede…
        //    …a menos que os dois sejam da mesma sala (aí não há nada)
        //    …ou que o par esteja em `doors` (aí é vão + porta)
        // ============================================================

        /// <summary>
        /// Quantas salas, enquanto não há receita.
        ///
        /// É o `size` do modo receita, e ele vai vir do painel na frente
        /// C. Fixo aqui, e nomeado, porque um `12` solto no meio da
        /// função seria lido como número mágico e ninguém saberia que
        /// ele tem dono marcado.
        /// </summary>
        private const int DefaultRoomCount = 12;

        private void GenerateRooms(ActiveDungeon dungeon, Vector3 forward)
        {
            // Sem semente, por enquanto: quem precisa de semente é o modo
            // permanente, que reconstrói a MESMA masmorra depois de um
            // restart (ver o §9.3 do plano). Ela entra junto com ele.
            var rng = new System.Random();

            // O tamanho vem da receita do painel; sem receita, o padrão.
            var rooms = DefaultRoomCount;

            if (dungeon.spec != null && dungeon.spec.size != null)
            {
                var min = Mathf.Clamp(dungeon.spec.size.min, 1, 40);
                var max = Mathf.Clamp(dungeon.spec.size.max, min, 40);
                rooms = rng.Next(min, max + 1);
            }

            // ####  DESENHO GANHA DO SORTEIO  ####
            //
            // No modo planta o admin já disse exatamente o que quer, e
            // sortear por cima seria ignorá-lo em silêncio: ele veria a
            // prévia certa no painel e uma masmorra diferente no jogo.
            var layout = HasDrawing(dungeon)
                ? LayoutFromGrid(dungeon, dungeon.spec.grid)
                : BuildLayout(rooms, rng);

            var right = Vector3.Cross(Vector3.up, forward).normalized;
            var floors = new Dictionary<(int, int), BuildingBlock>();

            // 1) O chão.
            foreach (var cell in layout.cells)
            {
                var pos = dungeon.origin + right * (cell.Item1 * CellSize) + forward * (cell.Item2 * CellSize);
                pos.y = dungeon.origin.y;

                var block = GameManager.server.CreateEntity(PrefabFoundation, pos, R0) as BuildingBlock;
                if (block == null) continue;

                PrepareBlock(dungeon, block, BuildingGrade.Enum.Stone);
                Adopt(dungeon, block);
                floors[cell] = block;
            }

            // 2) As paredes. A chave canônica do par evita erguer a
            //    mesma parede duas vezes — uma vez por vizinho.
            var walls = new Dictionary<(int, int, int, int), BuildingBlock>();
            var doorPairs = new HashSet<(int, int, int, int)>(
                layout.doors.Select(d => WallKey(d.room, d.corridor)));

            foreach (var cell in layout.cells)
            {
                if (!floors.TryGetValue(cell, out var parent) || parent == null) continue;

                for (var d = 0; d < 4; d++)
                {
                    var neighbour = (cell.Item1 + Dirs[d].dx, cell.Item2 + Dirs[d].dz);
                    var key = WallKey(cell, neighbour);
                    if (walls.ContainsKey(key)) continue;

                    // Mesma sala dos dois lados: os cômodos viram um só.
                    if (layout.cells.Contains(neighbour)
                        && layout.owner.TryGetValue(cell, out var mine)
                        && layout.owner.TryGetValue(neighbour, out var theirs)
                        && mine == theirs && mine >= 0)
                        continue;

                    var isDoor = doorPairs.Contains(key);
                    var prefab = isDoor ? PrefabDoorway : PrefabWall;
                    var (localPos, localRot) = WallPlacement(cell, neighbour);

                    var wall = GameManager.server.CreateEntity(prefab, parent.transform.position) as BuildingBlock;
                    if (wall == null) continue;

                    wall.SetParent(parent);
                    wall.transform.localPosition = localPos;
                    wall.transform.localRotation = localRot;
                    PrepareBlock(dungeon, wall, BuildingGrade.Enum.Stone);
                    Adopt(dungeon, wall);
                    walls[key] = wall;

                    if (isDoor)
                    {
                        var roomCell = layout.owner.ContainsKey(cell) && layout.owner[cell] >= 0 ? cell : neighbour;
                        var color = RoomColor(dungeon, layout, roomCell, rng);
                        HangDoor(dungeon, wall, DoorOf(dungeon, color));
                    }
                }
            }

            // 3) O teto. Sem ele, quem entra vê o vazio a -90 metros e
            //    entende na hora que está fora do mundo.
            foreach (var pair in floors)
            {
                if (pair.Value == null) continue;

                // A célula do alçapão recebe o vão, não o teto liso.
                if (pair.Key.Item1 == 0 && pair.Key.Item2 == 0) continue;

                var ceiling = GameManager.server.CreateEntity(PrefabFloor, pair.Value.transform.position) as BuildingBlock;
                if (ceiling == null) continue;

                ceiling.SetParent(pair.Value);
                ceiling.transform.localPosition = new Vector3(0f, 3f, 0f);
                ceiling.transform.localRotation = R0;
                PrepareBlock(dungeon, ceiling, BuildingGrade.Enum.Stone);
                Adopt(dungeon, ceiling);
            }

            // 4) O alçapão de saída, no teto da (0,0).
            if (floors.TryGetValue((0, 0), out var lobby) && lobby != null)
            {
                PlaceExitHatch(dungeon, lobby);
                PlaceLight(dungeon, lobby);
            }

            Debug("masmorra: " + layout.cells.Count + " células, "
                  + layout.roomCount + " salas, " + dungeon.entities.Count + " peças");
        }

        /// <summary>
        /// A cor da sala que aquela porta serve.
        ///
        /// Nesta frente é sempre verde: quem decide a cor é a receita,
        /// e a receita vem do painel (frente C). Ela existe agora para
        /// que a porta já nasça do tipo certo quando ela chegar.
        /// </summary>
        /// <summary>
        /// A cor da sala que aquela porta serve.
        ///
        /// ####  A COR É SORTEADA UMA VEZ POR SALA, E FICA  ####
        ///
        /// Duas portas do mesmo cômodo com cores diferentes seriam a
        /// pior coisa que a masmorra poderia fazer: a cor é a única
        /// linguagem que o jogador aprende sem ler nada — vermelha
        /// quer dizer "cuidado, e vale a pena". Uma sala bicolor
        /// desmancha isso em silêncio.
        ///
        /// Sem receita, tudo verde: é o que a Frente A fazia, e o
        /// certo quando ninguém disse o contrário.
        /// </summary>
        private string RoomColor(ActiveDungeon dungeon, Layout layout, (int, int) roomCell, System.Random rng)
        {
            int roomId;
            if (!layout.owner.TryGetValue(roomCell, out roomId) || roomId < 0) return "green";

            // ####  O CACHE É CONSULTADO ANTES DOS PESOS  ####
            //
            // No modo planta a cor vem do DESENHO, e `LayoutFromGrid` já
            // a gravou aqui. Conferir os pesos primeiro faria uma
            // masmorra desenhada sem receita nenhuma sair inteira em
            // verde, apagando o que o admin pintou.
            string decided;
            if (dungeon.roomColors.TryGetValue(roomId, out decided)) return decided;

            if (dungeon.spec == null || dungeon.spec.weights == null) return "green";

            var w = dungeon.spec.weights;
            var total = Mathf.Max(0, w.green) + Mathf.Max(0, w.blue) + Mathf.Max(0, w.red);

            // Pesos todos zero seria divisão por zero. A régua do
            // agente já barra isso, mas um estado antigo em cache
            // não passou por ela.
            var color = "green";

            if (total > 0)
            {
                var roll = rng.Next(total);

                if (roll < Mathf.Max(0, w.green)) color = "green";
                else if (roll < Mathf.Max(0, w.green) + Mathf.Max(0, w.blue)) color = "blue";
                else color = "red";
            }

            dungeon.roomColors[roomId] = color;
            return color;
        }

        /// <summary>A porta daquela cor, como o painel a definiu.</summary>
        private string DoorOf(ActiveDungeon dungeon, string color)
        {
            if (dungeon.spec == null || dungeon.spec.rooms == null) return color;

            foreach (var room in dungeon.spec.rooms)
            {
                if (room != null && room.key == color && !string.IsNullOrEmpty(room.door))
                {
                    // A receita fala em madeira/metal/topo; o
                    // construtor fala em verde/azul/vermelho. A
                    // tradução é aqui, num lugar só.
                    if (room.door == "wood") return "green";
                    if (room.door == "metal") return "blue";
                    if (room.door == "toptier") return "red";
                }
            }

            return color;
        }

        private void HangDoor(ActiveDungeon dungeon, BuildingBlock frame, string color)
        {
            string prefab;
            if (!DoorByColor.TryGetValue(color, out prefab)) prefab = DoorByColor["green"];

            var door = GameManager.server.CreateEntity(prefab, frame.transform.position);
            if (door == null) return;

            door.SetParent(frame);
            door.transform.localPosition = Vector3.zero;
            door.transform.localRotation = Quaternion.identity;
            door.OwnerID = 0UL;
            door.EnableSaving(false);
            door.Spawn();
            Adopt(dungeon, door);
        }

        /// <summary>
        /// A entrada mínima: uma laje, um alçapão e uma luz.
        ///
        /// É o que o painel oferece como opção PADRÃO — a masmorra que
        /// funciona sem ninguém ter de arrumar um .json em lugar nenhum.
        /// Ela não impressiona, e não é para isso que existe: é para o
        /// admin conseguir a primeira masmorra de pé no primeiro minuto.
        ///
        /// ####  A LAJE FICA ENTERRADA, E O VÃO RENTE AO CHÃO  ####
        ///
        /// Uma fundação apoiada NA superfície poria o alçapão a um metro
        /// do chão, e o jogador teria de pular para alcançá-lo. Rebaixada
        /// a altura de um andar, o teto dela — que é onde o vão vai —
        /// nasce no nível do terreno: uma boca de esgoto, que é
        /// exatamente o que esta entrada quer ser.
        ///
        /// Devolve quantas peças subiram. Zero é falha.
        /// </summary>
        private int BuildMinimalEntrance(ActiveDungeon dungeon, Vector3 surface, float yaw)
        {
            var rotation = Quaternion.Euler(0f, yaw, 0f);
            var made = 0;

            var foundation = GameManager.server.CreateEntity(
                PrefabFoundation, surface - Vector3.up * 3f, rotation) as BuildingBlock;

            if (foundation == null) return 0;

            PrepareBlock(dungeon, foundation, BuildingGrade.Enum.Stone);
            Adopt(dungeon, foundation);
            made++;

            var frame = GameManager.server.CreateEntity(
                "assets/prefabs/building core/floor.frame/floor.frame.prefab",
                foundation.transform.position) as BuildingBlock;

            if (frame != null)
            {
                frame.SetParent(foundation);
                frame.transform.localPosition = new Vector3(0f, 3f, 0f);
                frame.transform.localRotation = R0;
                PrepareBlock(dungeon, frame, BuildingGrade.Enum.Stone);
                Adopt(dungeon, frame);
                made++;

                var hatch = GameManager.server.CreateEntity(PrefabHatch, frame.transform.position) as Door;

                if (hatch != null)
                {
                    hatch.SetParent(frame);
                    hatch.transform.localPosition = Vector3.zero;
                    hatch.transform.localRotation = Quaternion.identity;
                    hatch.OwnerID = 0UL;
                    hatch.EnableSaving(false);
                    hatch.Spawn();
                    Adopt(dungeon, hatch);
                    made++;

                    // ####  SEM ESTA LINHA A MASMORRA SOBE E FALHA  ####
                    //
                    // `LinkHatches` procura o par, e o de cima vem daqui.
                    // Com a planta ele sai da marca (§5.3.7); aqui não há
                    // marca nenhuma para achar, então ele é apontado.
                    dungeon.entranceHatch = hatch;
                }
            }

            // A luz fica pendurada no teto do poço, logo abaixo do vão:
            // é o que faz o alçapão ser visível de noite, que é quando
            // metade dos eventos acontece.
            PlaceLight(dungeon, foundation);

            return made;
        }

        /// <summary>
        /// O alçapão que sai da masmorra: um vão no teto, e a tampa
        /// dentro dele. É o gêmeo do que a planta da entrada traz.
        /// </summary>
        private void PlaceExitHatch(ActiveDungeon dungeon, BuildingBlock lobby)
        {
            var frame = GameManager.server.CreateEntity(
                "assets/prefabs/building core/floor.frame/floor.frame.prefab",
                lobby.transform.position) as BuildingBlock;
            if (frame == null) return;

            frame.SetParent(lobby);
            frame.transform.localPosition = new Vector3(0f, 3f, 0f);
            frame.transform.localRotation = R0;
            PrepareBlock(dungeon, frame, BuildingGrade.Enum.Stone);
            Adopt(dungeon, frame);

            var hatch = GameManager.server.CreateEntity(PrefabHatch, frame.transform.position) as Door;
            if (hatch == null) return;

            hatch.SetParent(frame);
            hatch.transform.localPosition = Vector3.zero;
            hatch.transform.localRotation = Quaternion.identity;
            hatch.OwnerID = 0UL;
            hatch.EnableSaving(false);
            hatch.Spawn();
            Adopt(dungeon, hatch);
            dungeon.exitHatch = hatch;
        }

        private void PlaceLight(ActiveDungeon dungeon, BuildingBlock under)
        {
            var light = GameManager.server.CreateEntity(
                PrefabCeilingLight,
                under.transform.position + Vector3.up * 2.9f,
                Quaternion.identity);
            if (light == null) return;

            light.OwnerID = 0UL;
            light.EnableSaving(false);
            light.Spawn();
            light.SetFlagLocal(BaseEntity.Flags.On, true);

            // Ligada não é o mesmo que acesa: a luminária é uma
            // `IOEntity` e fica apagada até alguém lhe dar energia. Não
            // há gerador a -90 metros, então damos nós.
            var powered = light as IOEntity;
            if (powered != null) powered.UpdateHasPower(1, 1);

            Adopt(dungeon, light);
        }

        /// <summary>
        /// A chave canônica de uma parede: o par ordenado das duas
        /// células. Sem ela, a parede entre A e B nasce uma vez ao
        /// visitar A e outra ao visitar B.
        /// </summary>
        private static (int, int, int, int) WallKey((int, int) a, (int, int) b) =>
            a.Item1 < b.Item1 || (a.Item1 == b.Item1 && a.Item2 < b.Item2)
                ? (a.Item1, a.Item2, b.Item1, b.Item2)
                : (b.Item1, b.Item2, a.Item1, a.Item2);

        /// <summary>Onde a parede fica, em relação à fundação dona dela.</summary>
        private static (Vector3, Quaternion) WallPlacement((int, int) cell, (int, int) neighbour)
        {
            if (cell.Item1 == neighbour.Item1)
            {
                return cell.Item2 < neighbour.Item2
                    ? (new Vector3(0f, 0f, 1.5f), R270)
                    : (new Vector3(0f, 0f, -1.5f), R90);
            }

            return cell.Item1 < neighbour.Item1
                ? (new Vector3(1.5f, 0f, 0f), R0)
                : (new Vector3(-1.5f, 0f, 0f), R180);
        }

        // ============================================================
        //  OS ALÇAPÕES — o par, e o teleporte
        // ============================================================

        /// <summary>
        /// Liga um alçapão ao outro. Sem os dois, não há masmorra — e
        /// é melhor dizer isso agora do que deixar uma casinha vazia
        /// de pé com um alçapão que não vai a lugar nenhum.
        /// </summary>
        private bool LinkHatches(ActiveDungeon dungeon)
        {
            Debug("link: entrada=" + (dungeon.entranceHatch == null
                      ? "null"
                      : dungeon.entranceHatch.transform.position.ToString())
                  + " saída=" + (dungeon.exitHatch == null
                      ? "null"
                      : dungeon.exitHatch.transform.position.ToString()));

            if (dungeon.entranceHatch == null)
            {
                PrintWarning("a planta não tinha marca de alçapão "
                             + "(nem hatch com código " + HatchMarkerCode
                             + ", nem vaso com 1+999 de fertilizante).");
                return false;
            }

            if (dungeon.exitHatch == null)
            {
                PrintWarning("a masmorra subiu sem alçapão de saída.");
                return false;
            }

            var top = dungeon.entranceHatch;
            var bottom = dungeon.exitHatch;

            // Descer cospe o jogador ABAIXO da tampa de baixo, e um
            // passo à frente: dentro dela, ele nasceria preso na
            // própria porta.
            var down = top.gameObject.AddComponent<HatchLink>();
            down.descends = true;
            down.target = bottom.transform.position + Vector3.down * 2f - bottom.transform.forward * 1.5f;

            var up = bottom.gameObject.AddComponent<HatchLink>();
            up.descends = false;
            up.target = top.transform.position - top.transform.forward + Vector3.up * 0.5f;

            Debug("alçapões ligados: superfície y=" + top.transform.position.y.ToString("F1")
                  + " ⇄ masmorra y=" + bottom.transform.position.y.ToString("F1"));
            return true;
        }

        /// <summary>
        /// Abrir um alçapão não abre nada: teleporta.
        ///
        /// `SetOpen(false)` primeiro, sempre. Uma tampa que fica aberta
        /// deixa ver o vazio do outro lado — e, pior, deixa o jogador
        /// cair por ela em vez de ser levado.
        /// </summary>
        private void OnDoorOpened(Door door, BasePlayer player)
        {
            if (active == null || !active.ready) return;
            if (door != active.entranceHatch && door != active.exitHatch) return;

            door.SetOpen(false);

            var link = door.gameObject.GetComponent<HatchLink>();
            if (link == null) return;

            if (link.descends) active.inside.Add(player.userID);
            else active.inside.Remove(player.userID);

            TeleportPlayer(player, link.target);
        }

        /// <summary>
        /// Leva o jogador sem que o anticheat o expulse.
        ///
        /// Cada linha aqui existe por um sintoma: sem as pausas de
        /// detecção ele leva kick por velocidade; sem o `StartSleeping`
        /// e o snapshot ele chega num mundo não carregado e cai pelo
        /// chão; sem o `EnsureDismounted` ele chega montado no que
        /// ficou para trás.
        /// </summary>
        private void TeleportPlayer(BasePlayer player, Vector3 target)
        {
            player.PauseFlyHackDetection(5f);
            player.PauseSpeedHackDetection(5f);
            player.ApplyStallProtection(4f);
            player.UpdateActiveItem(default(ItemId));
            player.EnsureDismounted();
            player.Server_CancelGesture();
            player.StartSleeping();
            player.SetPlayerFlag(BasePlayer.PlayerFlags.ReceivingSnapshot, true);
            player.ClientRPC(RpcTarget.Player("StartLoading", player), true);
            player.Teleport(target);

            if (!player.IsConnected) return;

            player.SetPlayerFlag(BasePlayer.PlayerFlags.ReceivingSnapshot, true);
            player.UpdateNetworkGroup();
            player.SendNetworkUpdateImmediate();
            player.ClearEntityQueue(null);
            player.SendCompleteSnapshot();

            player.Invoke(() =>
            {
                if (player != null && player.IsConnected) player.EndSleeping();
            }, 0.5f);
        }

        /// <summary>
        /// A masmorra não recebe dano.
        ///
        /// A marca no `_name` responde isso em O(1). Uma busca na lista
        /// de 3.000 entidades a cada tiro disparado no servidor inteiro
        /// seria o caminho mais curto para o plugin virar o vilão do
        /// tickrate.
        /// </summary>
        private object OnEntityTakeDamage(BaseCombatEntity entity, HitInfo info)
        {
            if (entity == null || entity._name != MarkIndestructible) return null;
            if (entity is BasePlayer) return null;

            return true;
        }

        /// <summary>
        /// Estar a -90 metros é, para o anticheat, estar dentro do
        /// terreno. Sem isto, todo mundo lá dentro leva kick.
        /// </summary>
        private object OnPlayerViolation(BasePlayer player, AntiHackType type)
        {
            if (active == null) return null;
            if (type != AntiHackType.InsideTerrain) return null;
            return active.inside.Contains(player.userID) ? (object)false : null;
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            active?.inside.Remove(player.userID);
        }

        // ============================================================
        //  A PLANTA — ler o .json e pôr as peças no mundo
        //
        //  ####  O FORMATO  ####
        //
        //    { "default":  { "position": {x,y,z}, "rotationy": "317.45" },
        //      "entities": [ { "prefabname": "...",
        //                      "pos":  {x,y,z},   ← RELATIVO ao centro
        //                      "rot":  {x,y,z},   ← euler
        //                      "grade": 3, "skinid": 0,
        //                      "items": [ { "id", "amount", "position" } ] } ] }
        //
        //  Os números vêm como STRING — é o CopyPaste que faz isso — e
        //  cada um deles passa por `InvariantCulture`. Sem isso, num
        //  Windows pt-BR, "3.515838" vira 3.515.838 e a masmorra nasce
        //  a três milhões de metros de altura. É o primeiro erro de
        //  todo leitor de planta escrito no Brasil.
        //
        //  ####  E EXISTE UM `children[]` QUE É FÁCIL DE NÃO VER  ####
        //
        //  A fechadura de uma porta NÃO está em `entities`: está em
        //  `children` da porta, com `parentbone: "lock"`. Medido nas
        //  sete plantas herdadas — um leitor que só percorra `entities`
        //  cola portas sem fechadura e alçapões sem código, e nada no
        //  arquivo denuncia a falta.
        // ============================================================

        private List<string> ListBlueprints()
        {
            try
            {
                if (!Directory.Exists(blueprintDir)) return new List<string>();

                return Directory.GetFiles(blueprintDir, "*.json")
                    .Select(Path.GetFileNameWithoutExtension)
                    .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
                    .ToList();
            }
            catch (Exception e)
            {
                PrintWarning("não consegui listar as plantas: " + e.Message);
                return new List<string>();
            }
        }

        private JObject LoadBlueprint(string slug)
        {
            try
            {
                var path = Path.Combine(blueprintDir, slug + ".json");
                if (!File.Exists(path)) return null;

                return JObject.Parse(File.ReadAllText(path));
            }
            catch (Exception e)
            {
                PrintWarning("planta '" + slug + "' ilegível: " + e.Message);
                return null;
            }
        }

        /// <summary>
        /// Põe as peças da planta no mundo, em volta de <paramref name="origin"/>.
        /// </summary>
        /// <param name="yaw">
        /// Para que lado a construção inteira aponta, em graus. A planta
        /// foi salva já normalizada (o CopyPaste tira a rotação de quem
        /// copiou), então `yaw = 0` a reproduz exatamente como estava.
        /// </param>
        /// <param name="onDone">
        /// Recebe quantas peças nasceram e, se algo estourou, a mensagem.
        /// </param>
        /// <remarks>
        /// ####  ELE COLA EM LOTES, E ISSO NÃO É OTIMIZAÇÃO  ####
        ///
        /// A maior planta herdada tem 584 peças. Criá-las num tick só
        /// engasga o servidor de forma visível para todo mundo que está
        /// jogando — um congelamento de meio segundo que ninguém
        /// relaciona com "o admin construiu uma masmorra do outro lado
        /// do mapa". `Entidades por tick` (config) é o freio.
        ///
        /// O preço é o método virar assíncrono, e é por isso que ele
        /// termina em callback em vez de `return`.
        /// </remarks>
        private void PasteBlueprint(
            ActiveDungeon dungeon,
            JObject blueprint,
            Vector3 origin,
            float yaw,
            Action<int, string> onDone)
        {
            var entities = blueprint["entities"] as JArray;
            if (entities == null) { onDone(0, null); return; }

            var spin = Quaternion.Euler(0f, yaw, 0f);
            var markers = new List<HatchMark>();
            var placed = 0;
            var skipped = 0;
            var index = 0;

            var batchSize = Mathf.Clamp(config.entitiesPerTick, 1, 500);

            Action step = null;
            step = () =>
            {
                // A masmorra pode ter sido derrubada no meio (o admin
                // desistiu, o watchdog estourou). Continuar colaria
                // peças órfãs, que ninguém mais sabe apagar.
                if (active != dungeon) return;

                var untilTick = 0;
                while (index < entities.Count && untilTick < batchSize)
                {
                    var node = entities[index++] as JObject;
                    untilTick++;

                    if (node == null) continue;

                    // ####  O try/catch É POR PEÇA, E NÃO PELO LOTE  ####
                    //
                    // MEDIDO em 08/09/2026: a `entrance4` traz um carro
                    // modular, um sofá com assentos e um armário — peças
                    // que exigem montagem própria e estouram ao nascer
                    // soltas. Com o catch em volta do laço, UMA delas
                    // matava as 114, e a planta inteira voltava como
                    // `blueprint_invalid`.
                    //
                    // Uma planta é um monte de peças independentes. A que
                    // não sobe é uma cadeira que faltou, não uma masmorra
                    // perdida — e o alçapão, que é o que importa, quase
                    // nunca é a peça exótica.
                    try
                    {
                        if (PasteOne(dungeon, node, origin, spin, markers)) placed++;
                        else skipped++;
                    }
                    catch (Exception e)
                    {
                        skipped++;
                        Debug("peça '" + (node.Value<string>("prefabname") ?? "?").Split('/').Last()
                              + "' estourou e foi pulada: " + e.Message);
                    }
                }

                if (index < entities.Count) { NextTick(step); return; }

                if (skipped > 0) Debug("planta: " + skipped + " peça(s) puladas");
                Debug("planta: " + markers.Count + " marca(s) de alçapão");

                // Os marcadores viram alçapão só depois que a planta
                // inteira subiu: converter mata a peça original, e matar
                // no meio do laço desloca o que ainda não foi visitado.
                try
                {
                    foreach (var marker in markers) ConvertToHatch(dungeon, marker);
                }
                catch (Exception e)
                {
                    // Este SIM é fatal: sem alçapão não há masmorra, e
                    // seguir em frente daria um `no_hatch` que esconde a
                    // causa real.
                    onDone(placed, e.Message);
                    return;
                }

                onDone(placed, null);
            };

            step();
        }

        /// <summary>Uma peça. Devolve false quando ela foi pulada.</summary>
        private bool PasteOne(
            ActiveDungeon dungeon,
            JObject node,
            Vector3 origin,
            Quaternion spin,
            List<HatchMark> markers)
        {
            var prefab = node.Value<string>("prefabname");
            if (string.IsNullOrEmpty(prefab)) return false;

            // ####  VEÍCULO NÃO ENTRA  ####
            //
            // A `entrance4` traz um carro modular de três módulos. Um
            // carro só existe montado (chassi + módulos + motor), e
            // colá-lo peça a peça produz um destroço que não anda. O
            // 1.3.4 também o pula — e um carro dentro de uma masmorra
            // a 90 metros de profundidade não ia a lugar nenhum.
            if (prefab.Contains("modularcar")
                || prefab.Contains("module_car_spawned")
                || prefab.Contains("modular_car_fuel_storage"))
                return false;

            var worldPos = origin + spin * ReadVector(node["pos"]);
            var worldRot = spin * Quaternion.Euler(ReadVector(node["rot"]));

            var entity = GameManager.server.CreateEntity(prefab, worldPos, worldRot);
            if (entity == null)
            {
                // Prefab que o Rust removeu num update. Pular, nunca
                // abortar: uma planta de 584 peças não pode morrer
                // porque uma delas saiu do jogo.
                return false;
            }

            var block = entity as BuildingBlock;
            if (block != null)
            {
                var grade = node.Value<int?>("grade") ?? (int)BuildingGrade.Enum.Stone;
                PrepareBlock(dungeon, block, (BuildingGrade.Enum)Mathf.Clamp(grade, 0, 4));
            }
            else
            {
                entity.skinID = node.Value<ulong?>("skinid") ?? 0UL;
                entity.OwnerID = 0UL;
                entity.EnableSaving(false);
                entity.Spawn();
            }

            Adopt(dungeon, entity);
            ApplyFlags(entity, node["flags"] as JObject);
            FillContainer(entity, node["items"] as JArray);
            PasteChildren(dungeon, entity, node["children"] as JArray);

            // A pose é lida AGORA, enquanto a peça existe. Ver `HatchMark`.
            if (IsEntranceHatchMarker(node, entity))
            {
                markers.Add(new HatchMark
                {
                    position = entity.transform.position,
                    rotation = entity.transform.rotation,
                    fromLadderHatch = entity.PrefabName == PrefabHatchSource,
                    entity = entity,
                });
            }

            return true;
        }

        /// <summary>
        /// Cola o que está pendurado numa peça: fechadura, na prática.
        ///
        /// O `parentbone` é o encaixe ("lock"); sem ele a fechadura
        /// nasce no centro da porta, atravessada nela.
        /// </summary>
        private void PasteChildren(ActiveDungeon dungeon, BaseEntity parent, JArray children)
        {
            if (children == null || children.Count == 0) return;

            foreach (var token in children)
            {
                var node = token as JObject;
                if (node == null) continue;

                var prefab = node.Value<string>("prefabname");
                if (string.IsNullOrEmpty(prefab)) continue;

                var child = GameManager.server.CreateEntity(prefab, parent.transform.position);
                if (child == null) continue;

                var bone = node.Value<string>("parentbone");
                if (!string.IsNullOrEmpty(bone)) child.SetParent(parent, bone);
                else child.SetParent(parent);

                child.transform.localPosition = ReadVector(node["pos"]);
                child.transform.localRotation = Quaternion.Euler(ReadVector(node["rot"]));
                child.OwnerID = 0UL;
                child.EnableSaving(false);
                child.Spawn();
                Adopt(dungeon, child);

                // O código da fechadura é o que marca a peça (ver
                // `IsEntranceHatchMarker`), então ele tem de chegar.
                var codeLock = child as CodeLock;
                var code = node.Value<string>("code");
                if (codeLock != null && !string.IsNullOrEmpty(code)) codeLock.code = code;

                ApplyFlags(child, node["flags"] as JObject);
            }
        }

        /// <summary>
        /// As flags que a planta guardou (`Open`, `Locked`, `On`…).
        ///
        /// Só as que existem no enum: a planta pode trazer o nome de
        /// uma flag que o Rust removeu, e isso não pode derrubar a
        /// colagem inteira.
        /// </summary>
        private static void ApplyFlags(BaseEntity entity, JObject flags)
        {
            if (flags == null) return;

            foreach (var pair in flags)
            {
                BaseEntity.Flags flag;
                if (!Enum.TryParse(pair.Key, out flag)) continue;
                if (pair.Value == null || pair.Value.Type != JTokenType.Boolean) continue;

                entity.SetFlagLocal(flag, pair.Value.Value<bool>());
            }
        }

        // ============================================================
        //  AS DUAS CONVENÇÕES DO ALÇAPÃO
        //
        //  A planta não tem campo "aqui vai o alçapão". Ela marca o
        //  lugar com uma peça combinada — e são DUAS marcas, porque as
        //  sete plantas herdadas usam as duas:
        //
        //    1) `floor.ladder.hatch` com fechadura de código "0707"
        //       (as três `base*.json`)
        //
        //    2) `planter.large` com fertilizante nos slots 0 e 5, nas
        //       quantidades 1 e 999
        //       (as três `entrance2..4.json`)
        //
        //  A segunda parece arbitrária e não é: um alçapão de verdade
        //  na planta seria colado como alçapão comum e o construtor
        //  precisaria adivinhar qual dos vários é O alçapão. Um vaso
        //  com 999 fertilizantes não acontece por acaso.
        //
        //  MEDIDO nas sete plantas em 08/09/2026. Mudar isto exige
        //  reeditar as plantas — é contrato com quem as construiu.
        // ============================================================

        /// <summary>O fertilizante. É o item que marca o vaso.</summary>
        private const int FertilizerItemId = -930193596;

        /// <summary>O código que marca um alçapão da planta.</summary>
        private const string HatchMarkerCode = "0707";

        private bool IsEntranceHatchMarker(JObject node, BaseEntity entity)
        {
            var prefab = node.Value<string>("prefabname") ?? "";

            if (prefab == PrefabHatchSource)
            {
                var children = node["children"] as JArray;
                if (children == null) return false;

                return children.OfType<JObject>().Any(c =>
                    (c.Value<string>("prefabname") ?? "").Contains("lock.code")
                    && c.Value<string>("code") == HatchMarkerCode);
            }

            if (prefab.Contains("planter.large"))
            {
                var items = node["items"] as JArray;
                if (items == null) return false;

                var slots = items.OfType<JObject>()
                    .Where(i => i.Value<int?>("id") == FertilizerItemId)
                    .ToDictionary(i => i.Value<int?>("position") ?? -1, i => i.Value<int?>("amount") ?? 0);

                int first, second;
                return slots.TryGetValue(0, out first) && first == 1
                       && slots.TryGetValue(5, out second) && second == 999;
            }

            return false;
        }

        /// <summary>
        /// Onde uma marca estava, e que marca era.
        ///
        /// ####  A POSE, E NÃO A ENTIDADE  ####
        ///
        /// MEDIDO em 08/09/2026: o `floor.ladder.hatch` colado solto
        /// **não sobrevive** até o fim da colagem. Ele é um alçapão de
        /// piso, precisa de um vão para se encaixar, e a planta o traz
        /// com um vão que ainda não nasceu — o jogo o destrói em algum
        /// tick no meio das 226 peças.
        ///
        /// Guardar a `BaseEntity` fazia `ConvertToHatch` cair no
        /// `IsDestroyed` e sair calado; a planta era detectada (o log
        /// dizia "1 marca") e nenhum alçapão nascia. O planter das
        /// entradas sobrevivia — é deployable e fica de pé em qualquer
        /// lugar —, e foi por isso que só metade das plantas funcionava.
        ///
        /// Guardando a POSE, a tampa nasce onde a marca esteve, tenha
        /// ela sobrevivido ou não.
        /// </summary>
        private struct HatchMark
        {
            public Vector3 position;
            public Quaternion rotation;
            /// <summary>Muda o deslocamento e a rotação final.</summary>
            public bool fromLadderHatch;
            /// <summary>Pode já estar morta. Só serve para limpar.</summary>
            public BaseEntity entity;
        }

        /// <summary>
        /// Põe uma tampa de bunker onde a marca estava.
        ///
        /// O deslocamento sai do 1.3.4 e não é enfeite: a tampa nasce
        /// AO LADO da marca, porque a marca ocupa o buraco por onde o
        /// jogador vai descer.
        /// </summary>
        private void ConvertToHatch(ActiveDungeon dungeon, HatchMark mark)
        {
            var offset = mark.fromLadderHatch
                ? mark.rotation * Vector3.right + Vector3.up * 0.1f
                : mark.rotation * Vector3.forward;

            var rotation = mark.fromLadderHatch ? mark.rotation * R90 : mark.rotation;

            var hatch = GameManager.server.CreateEntity(
                PrefabHatch,
                mark.position + offset,
                rotation) as Door;

            if (hatch == null)
            {
                Debug("a marca em " + mark.position + " não virou alçapão");
            }
            else
            {
                hatch.OwnerID = 0UL;
                hatch.EnableSaving(false);
                hatch.Spawn();
                Adopt(dungeon, hatch);

                Debug("alçapão em " + hatch.transform.position
                      + (mark.fromLadderHatch ? " (de um hatch)" : " (de um vaso)"));

                if (dungeon.entranceHatch == null
                    || hatch.transform.position.y > dungeon.entranceHatch.transform.position.y)
                {
                    // MEDIDO: as sete plantas herdadas têm UMA marca
                    // cada — a `entrance1` tem dois alçapões e seis
                    // vasos, e só um deles é marcado. O desempate por
                    // altura é defesa para uma planta futura com duas:
                    // a de cima é a que o jogador alcança a pé.
                    dungeon.entranceHatch = hatch;
                }
            }

            // A marca some: ela era um recado para nós, não decoração.
            if (mark.entity != null && !mark.entity.IsDestroyed) mark.entity.Kill();
            if (mark.entity != null) dungeon.entities.Remove(mark.entity);
        }

        /// <summary>
        /// Enche um baú/caixa da planta com o que ela mandava.
        ///
        /// Item cujo id o Rust não conhece mais é PULADO. Deixar um
        /// `null` no inventário é o caminho para o container quebrar
        /// na primeira vez que alguém o abre.
        /// </summary>
        private void FillContainer(BaseEntity entity, JArray items)
        {
            if (items == null || items.Count == 0) return;

            var container = entity.GetComponent<StorageContainer>();
            if (container == null || container.inventory == null) return;

            foreach (var token in items)
            {
                var node = token as JObject;
                if (node == null) continue;

                var id = node.Value<int?>("id");
                if (id == null) continue;

                var amount = node.Value<int?>("amount") ?? 1;
                var skin = node.Value<ulong?>("skinid") ?? 0UL;

                var item = ItemManager.CreateByItemID(id.Value, amount, skin);
                if (item == null) continue;

                var slot = node.Value<int?>("position") ?? -1;
                if (!item.MoveToContainer(container.inventory, slot)) item.Remove();
            }
        }

        /// <summary>
        /// Lê `{x,y,z}` onde cada componente pode ser string ou número.
        /// Ver o cabeçalho da seção sobre `InvariantCulture`.
        /// </summary>
        private static Vector3 ReadVector(JToken node)
        {
            if (node == null) return Vector3.zero;
            return new Vector3(ReadFloat(node["x"]), ReadFloat(node["y"]), ReadFloat(node["z"]));
        }

        private static float ReadFloat(JToken node)
        {
            if (node == null) return 0f;

            var raw = node.Type == JTokenType.String ? node.Value<string>() : node.ToString();
            float value;
            return float.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ? value : 0f;
        }

        // ============================================================
        //  O BLOCO — o que faz uma parede ficar de pé
        //
        //  ####  A ORDEM IMPORTA, E ELA NÃO É ÓBVIA  ####
        //
        //  `blockDefinition`, `SetGrade`, `AttachToBuilding` e
        //  `buildingID` têm de estar postos ANTES do `Spawn()`. Depois
        //  dele, o jogo já rodou o cálculo de estabilidade — e um
        //  prédio que nasce órfão despenca sozinho em segundos, o que
        //  parece bug de física e é ordem de chamada.
        //
        //  ####  E NADA DISSO ENTRA NO SAVE  ####
        //
        //  `EnableSaving(false)` em tudo. Uma masmorra salva vira lixo
        //  permanente no `.sav`, wipe após wipe. O preço é que ela não
        //  sobrevive a um restart — e o jeito certo de resolver isso é
        //  o agente RECONSTRUIR (com a mesma semente), não o jogo
        //  guardar 3.000 entidades.
        // ============================================================

        private void PrepareBlock(ActiveDungeon dungeon, BuildingBlock block, BuildingGrade.Enum grade)
        {
            block.blockDefinition = PrefabAttribute.server.Find<Construction>(block.prefabID);
            block.SetGrade(grade);
            block.AttachToBuilding(dungeon.buildingId);
            block.buildingID = dungeon.buildingId;
            block.EnableSaving(false);
            block.OwnerID = 0UL;
            block.Spawn();
            block.SetHealthToMax();
            block.UpdateSkin();
            block.SendNetworkUpdate();
            block.ResetUpkeepTime();

            // Sem isso, a masmorra apodrece: ela não tem armário de
            // ferramentas e o decay a come antes de o evento acabar.
            var decay = block.GetComponent<DecayEntity>();
            if (decay != null) decay.lastDecayTick = 999999f;
        }

        /// <summary>
        /// Registra a peça como nossa: na lista da masmorra e com a
        /// marca que o `OnEntityTakeDamage` procura.
        /// </summary>
        private void Adopt(ActiveDungeon dungeon, BaseEntity entity)
        {
            if (entity == null) return;
            entity._name = MarkIndestructible;
            dungeon.entities.Add(entity);
        }

        // ============================================================
        //  UTILITÁRIOS
        // ============================================================

        /// <summary>
        /// O nome que pode virar caminho de arquivo.
        ///
        /// Sem isso, `build ../../plugins/x` leria fora da pasta — e o
        /// alvo mais próximo daqui é `oxide/plugins`. É a mesma trava
        /// do `data-files.ts` do agente, pela mesma razão.
        /// </summary>
        private static string Sanitize(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;

            var trimmed = raw.Trim();
            foreach (var c in trimmed)
            {
                var ok = char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '#';
                if (!ok) return null;
            }

            return trimmed.Length > 64 ? null : trimmed;
        }

        /// <summary>
        /// A altura do chão naquele ponto.
        ///
        /// O raio desce de 500 m para pegar o telhado de um monumento
        /// tanto quanto a grama. Sem acertar nada — o que acontece em
        /// cima d'água —, cai para a altura do terreno, que ali é o
        /// fundo do mar. Quem escolhe o lugar é quem vê o mapa; aqui
        /// só se resolve a terceira coordenada.
        /// </summary>
        private static float GroundAt(float x, float z)
        {
            var from = new Vector3(x, 500f, z);
            RaycastHit hit;

            // Layer 8 (terreno) + 16 (mundo) + 21 (construções).
            const int mask = (1 << 8) | (1 << 16) | (1 << 21);
            if (Physics.Raycast(from, Vector3.down, out hit, 1000f, mask))
                return hit.point.y;

            return TerrainMeta.HeightMap != null
                ? TerrainMeta.HeightMap.GetHeight(new Vector3(x, 0f, z))
                : 0f;
        }

        /// <summary>A coordenada de mapa ("K7"), como o jogo mostra.</summary>
        private static string Grid(Vector3 pos)
        {
            try { return MapHelper.PositionToString(pos); }
            catch { return "?"; }
        }

        private void Debug(string message)
        {
            if (config.debug) Puts("[debug] " + message);
        }

        /// <summary>
        /// Uma linha para o agente ler no stream do console.
        ///
        /// JSON em UMA LINHA, com prefixo. O agente separa as
        /// respostas por linha — um JSON indentado chegaria lá como
        /// vários fragmentos inválidos.
        ///
        /// ####  O SEGREDO VAI EM TODA LINHA  ####
        ///
        /// O `onConsoleLine` do agente recebe o CHAT dos jogadores
        /// junto com o resto do console. Sem ele, alguém digitando
        /// `#OZDUNGEON#{"kind":"built",…}` no chat inventaria um
        /// nascimento no histórico — e faria o assistente do painel
        /// declarar sucesso sobre uma masmorra que não existe.
        ///
        /// Ele chega no `sync` e vale só enquanto o agente estiver
        /// de pé. Sem sync ainda, a linha sai sem segredo e o agente
        /// a IGNORA — que é o certo: ele não pediu nada.
        /// </summary>
        private void Report(string kind, Dictionary<string, object> data)
        {
            try
            {
                data["kind"] = kind;
                if (!string.IsNullOrEmpty(state.secret)) data["secret"] = state.secret;

                var line = config.agentMarker + JsonConvert.SerializeObject(data, Formatting.None);

                // ####  UM TICK DEPOIS, OU O AGENTE NUNCA VÊ  ####
                //
                // MEDIDO em 09/09/2026: `ozdungeon stop` pelo RCON
                // derrubava a masmorra, o plugin emitia este `ended`, e
                // a linha saía na RESPOSTA CASADA do comando — aquela
                // que volta no POST /rcon e some do buffer. O agente, que
                // escuta o STREAM do console, não a via.
                //
                // O resultado era a run ficar aberta para sempre: o
                // painel dizendo "1 masmorra no ar" com o chão vazio, e
                // nada no sistema consertando isso sozinho.
                //
                // Fora do comando, a mesma linha sai no console geral e o
                // stream a entrega. É a mesma armadilha documentada em
                // `a-resposta-do-comando-vem-casada-nao-no-console`.
                //
                // No descarregamento não há próximo tick — o plugin já
                // não existe quando ele chegaria —, então ali ela sai
                // agora. Cair na resposta de um `oxide.reload` é um risco
                // menor que nunca sair.
                if (unloading) Puts(line);
                else NextTick(() => Puts(line));
            }
            catch (Exception e)
            {
                PrintWarning("não consegui reportar '" + kind + "': " + e.Message);
            }
        }

        // ============================================================
        //  O ESTADO QUE VEM DO PAINEL
        //
        //  ####  ELE CHEGA COMPLETO, NUNCA EM PEDAÇOS  ####
        //
        //  `ApplySync` monta um objeto NOVO e troca o campo inteiro
        //  na última linha. A masmorra que sumiu do JSON deixa de
        //  existir aqui no instante em que o comando é aplicado — e é
        //  isso que faz "apaguei no painel" chegar ao jogo.
        //
        //  ####  E A PLANTA NÃO VEM POR AQUI  ####
        //
        //  A maior tem 512 KB e o frame do RCON aguenta ~70. Ela vem
        //  pelo DISCO, escrita pelo agente antes deste comando. O que
        //  atravessa o console é só a receita: tamanho, cores, NPCs,
        //  loot — cem masmorras cabem folgadas.
        // ============================================================

        private class SyncState
        {
            /// <summary>Vazio = o agente ainda não falou com este plugin.</summary>
            public string secret = "";
            public Dictionary<string, DungeonSpec> dungeons = new Dictionary<string, DungeonSpec>();
            public List<ZoneSpec> zones = new List<ZoneSpec>();
        }

        private class DungeonSpec
        {
            public string id;
            public string mode;
            public string entrance;
            public Range size;
            public Weights weights;
            public CorridorSpec corridor;
            public List<string> grid;
            public NpcSpec npc;
            public float timeOfDay;
            public List<RoomSpec> rooms;
        }

        private class Range { public int min; public int max; }
        private class Weights { public int green; public int blue; public int red; }

        private class CorridorSpec
        {
            public int npcDensity;
            public int lootDensity;
            public List<string> crates;
        }

        private class NpcSpec
        {
            public Range health;
            public float damageScale;
            public List<string> weapons;
            public List<string> names;
        }

        private class RoomSpec
        {
            public string key;
            public string color;
            public Range npc;
            public Range loot;
            public List<string> crates;
            public string door;
            public bool locked;
        }

        private class ZoneSpec { public float x; public float z; public float radius; }

        private SyncState state = new SyncState();

        /// <summary>
        /// `origemz.dungeon.sync &lt;base64&gt;`.
        ///
        /// ####  BASE64 PORQUE O CONSOLE COME AS ASPAS  ####
        ///
        /// MEDIDO no projeto e documentado no `plugin-push.ts` do
        /// agente: o parser de console do Rust trata token entre
        /// aspas como argumento citado e as REMOVE. Mandando o JSON
        /// cru, este método receberia `recipe` sem aspas e o parse
        /// quebraria com "Unexpected character encountered while
        /// parsing value: r".
        ///
        /// Base64 não tem aspa, espaço nem chave: atravessa qualquer
        /// parser de console sem perder byte.
        /// </summary>
        /// <remarks>
        /// ####  `[Command]`, E NÃO `[ConsoleCommand]`  ####
        ///
        /// MEDIDO em 09/09/2026: num `CovalencePlugin`, o
        /// `[ConsoleCommand]` NÃO REGISTRA NADA. O comando some sem
        /// erro — o console do Rust não reclama do que não conhece,
        /// ele apenas se cala —, e o agente recebe `RCON_TIMEOUT`
        /// sobre um comando que nunca existiu.
        ///
        /// `[Command]` é a forma do Covalence, e atende os dois
        /// transportes: o console do servidor e o chat.
        /// </remarks>
        [Command("origemz.dungeon.sync")]
        private void CmdSync(IPlayer caller, string command, string[] args)
        {
            // Só do console do servidor: o comando carrega o segredo
            // desta subida do agente, e um jogador que o executasse
            // ganharia o direito de forjar eventos.
            if (!caller.IsServer) return;

            var encoded = args.Length > 0 ? args[0] : "";

            if (string.IsNullOrEmpty(encoded))
            {
                PrintWarning("sync sem payload");
                return;
            }

            try
            {
                var json = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
                var incoming = JsonConvert.DeserializeObject<SyncPayload>(json);

                if (incoming == null)
                {
                    PrintWarning("sync com payload ilegível");
                    return;
                }

                var next = new SyncState { secret = incoming.secret ?? "" };

                foreach (var spec in incoming.dungeons ?? new List<DungeonSpec>())
                {
                    if (spec != null && !string.IsNullOrEmpty(spec.id)) next.dungeons[spec.id] = spec;
                }

                next.zones = incoming.zones ?? new List<ZoneSpec>();

                // A troca é a ÚLTIMA linha: até aqui, um payload torto
                // teria deixado o cache antigo intacto.
                state = next;

                Puts("estado recebido: " + next.dungeons.Count + " masmorra(s), "
                     + next.zones.Count + " zona(s) proibida(s)");
            }
            catch (Exception e)
            {
                // Cache velho e íntegro é melhor que cache novo pela
                // metade: o plugin acreditaria que o incompleto é o
                // completo.
                PrintError("sync recusado, o estado anterior continua de pé: " + e.Message);
            }
        }

        private class SyncPayload
        {
            public string secret;
            public List<DungeonSpec> dungeons;
            public List<ZoneSpec> zones;
        }
    }
}
