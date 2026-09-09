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

        /// <summary>
        /// O quadro de parede: o bloco das portas largas.
        ///
        /// É um `BuildingBlock` como a parede e o vão, entra na MESMA
        /// pose deles (a 1.3.4 já faz isso com o `wall.window`, na
        /// mesma `Lp()` das paredes) e tem dois metros de passagem.
        /// </summary>
        private const string PrefabWallFrame = "assets/prefabs/building core/wall.frame/wall.frame.prefab";

        /// <summary>
        /// A fechadura de código. É a mesma da 1.3.4 (`CodeLock`).
        /// </summary>
        private const string PrefabCodeLock = "assets/prefabs/locks/keypad/lock.code.prefab";

        /// <summary>
        /// Quanto a tampa precisa andar para ficar centrada no piso.
        ///
        /// Uma `Door` do Rust gira em torno da dobradiça, e é ali que
        /// fica a origem dela — não no meio. Sem este metro, a tampa
        /// nasce encostada na quina da célula.
        ///
        /// É o mesmo valor que o `ConvertToHatch` usa há tempos para as
        /// marcas de planta (`rotation * Vector3.right`); ele só não
        /// estava nomeado.
        /// </summary>
        private const float HatchPivotOffset = 1f;

        /// <summary>
        /// O inimigo da masmorra.
        ///
        /// E o mesmo que a base 1.3.4 usa. Ele nasce com armadura e arma
        /// proprias; a receita do painel troca as duas.
        /// </summary>
        private const string PrefabScientist =
            "assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab";

        /// <summary>A porta de cada cor de sala. Verde é a mais barata.</summary>
        /// <summary>
        /// A porta de cada cor.
        ///
        /// ####  PORTAS DE CONSTRUÇÃO, E NÃO AS DE MONUMENTO  ####
        ///
        /// Elas eram as `door.hinged.security.{green,blue,red}` — as
        /// coloridas dos monumentos, que combinavam com as cores das
        /// salas e eram lindas.
        ///
        /// E não abriam. MEDIDO em 09/09/2026, pelo dono, de dentro da
        /// masmorra: o jogo só oferecia "TOC... TOC...". Aquelas portas
        /// são acionadas por CARTÃO E ENERGIA — um leitor de cartão, um
        /// botão, um fio. A masmorra não tem elétrica nenhuma, então
        /// nenhuma delas abriria jamais: a masmorra inteira era um
        /// corredor com salas lacradas.
        ///
        /// Estas três abrem com a mão, e são exatamente o que o painel
        /// promete ao admin em cada cor: madeira na verde, metal na
        /// azul, blindada na vermelha. A cor deixa de estar na porta e
        /// passa a estar no MATERIAL dela — que é o que o jogador de
        /// Rust já lê sem pensar.
        /// </summary>
        private static readonly Dictionary<string, string> DoorByColor = new Dictionary<string, string>
        {
            ["green"] = "wood",
            ["blue"] = "metal",
            ["red"] = "toptier",
        };

        /// <summary>
        /// Uma porta: o bloco que a segura e a folha que fica nele.
        ///
        /// ####  A FOLHA LARGA NÃO CABE NUM `wall.doorway`  ####
        ///
        /// O vão de porta do Rust tem UM metro; porta dupla, grade de
        /// cela, portão de tela e porta de garagem têm DOIS, e o bloco
        /// delas é o `wall.frame` — o quadro de parede.
        ///
        /// MEDIDO em 09/09/2026 nas sete plantas herdadas: as seis
        /// grades que existem nelas (`base3`, `entrance1`, `entrance4`)
        /// estão TODAS na posição exata de um `wall.frame`, com a mesma
        /// rotação ou 180 graus dela — o lado para onde a folha abre.
        /// A pose local é zero, igual à da porta no vão.
        /// </summary>
        private sealed class DoorKind
        {
            /// <summary>O BuildingBlock que entra no lugar da parede.</summary>
            public string frame;
            /// <summary>A folha pendurada nele. `null` = passagem vazia.</summary>
            public string leaf;
            /// <summary>Cabe mais de um jogador de cada vez?</summary>
            public bool wide;
            /// <summary>O que o admin vê quando a porta não pode trancar.</summary>
            public string label;
        }

        /// <summary>
        /// As portas que o painel oferece.
        ///
        /// ####  TODO CAMINHO AQUI FOI CONFERIDO CONTRA O JOGO  ####
        ///
        /// Não contra a memória: os onze prefabs abaixo foram casados,
        /// em 09/09/2026, com o `Bundles/AssetSceneManifest.json` do
        /// Rust instalado em `Servers/server01` — 16.358 assets, e os
        /// onze estão lá. Um caminho errado devolve `null` no
        /// `CreateEntity`, o `return` engole, e a masmorra sobe com o
        /// vão aberto: foi assim que a versão anterior desta tabela
        /// (`door.hinged.wood/...`) chegou ao jogo, e quem descobriu
        /// foi o dono, lá dentro.
        /// </summary>
        private static readonly Dictionary<string, DoorKind> DoorCatalog = new Dictionary<string, DoorKind>
        {
            // ####  AS TRÊS DE CONSTRUÇÃO ABREM COM A MÃO  ####
            //
            // Elas eram as `door.hinged.security.{green,blue,red}` — as
            // coloridas dos monumentos, que combinavam com as cores das
            // salas e eram lindas.
            //
            // E não abriam. MEDIDO em 09/09/2026, pelo dono, de dentro
            // da masmorra: o jogo só oferecia "TOC... TOC...". Aquelas
            // portas são acionadas por CARTÃO E ENERGIA, e a masmorra
            // não tem elétrica nenhuma — a masmorra inteira era um
            // corredor com salas lacradas.
            //
            // A cor deixou de estar na porta e passou a estar no
            // MATERIAL dela, que é o que o jogador de Rust já lê sem
            // pensar.
            ["wood"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/building/door.hinged/door.hinged.wood.prefab",
                label = "porta de madeira",
            },
            ["metal"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/building/door.hinged/door.hinged.metal.prefab",
                label = "porta de metal",
            },
            ["toptier"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/building/door.hinged/door.hinged.toptier.prefab",
                label = "porta blindada",
            },

            // A de fábrica: um metro, como as três, e é a que a 1.3.4
            // usa no lobby da entrada dela.
            ["industrial"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = "assets/prefabs/misc/permstore/factorydoor/door.hinged.industrial.d.prefab",
                label = "porta de fábrica",
            },

            // ####  AS LARGAS, PARA A SALA QUE VIROU FUNIL  ####
            //
            // Nove células com uma porta de um metro são uma fila
            // indiana debaixo de fogo. Estas cinco têm dois metros de
            // passagem, e todas moram no `wall.frame`.
            ["double_wood"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/door.double.hinged/door.double.hinged.wood.prefab",
                wide = true,
                label = "porta dupla de madeira",
            },
            ["double_metal"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/door.double.hinged/door.double.hinged.metal.prefab",
                wide = true,
                label = "porta dupla de metal",
            },
            ["double_toptier"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/door.double.hinged/door.double.hinged.toptier.prefab",
                wide = true,
                label = "porta dupla blindada",
            },
            // A grade de cela deixa VER o que tem dentro sem deixar
            // entrar — e uma sala vermelha vista de fora é um convite.
            ["cell_gate"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/wall.frame.cell/wall.frame.cell.gate.prefab",
                wide = true,
                label = "grade de cela",
            },
            ["fence_gate"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/wall.frame.fence/wall.frame.fence.gate.prefab",
                wide = true,
                label = "portão de tela",
            },
            ["garage"] = new DoorKind
            {
                frame = PrefabWallFrame,
                leaf = "assets/prefabs/building/wall.frame.garagedoor/wall.frame.garagedoor.prefab",
                wide = true,
                label = "portão de garagem",
            },

            // Sem folha: o vão fica aberto de propósito. Serve para a
            // sala verde de uma masmorra que quer ser corrida, e para
            // depurar "a porta não abre" separando os dois casos.
            ["none"] = new DoorKind
            {
                frame = PrefabDoorway,
                leaf = null,
                label = "vão aberto",
            },
        };

        /// <summary>
        /// Os graus, do nome que o painel manda ao enum do jogo.
        ///
        /// MEDIDO por reflexão sobre o `Assembly-CSharp.dll` do
        /// `Servers/server01` em 09/09/2026: `None = -1`, `Twigs = 0`,
        /// `Wood = 1`, `Stone = 2`, `Metal = 3`, `TopTier = 4`. O
        /// `None` fica de fora de propósito — um bloco sem grau não
        /// tem malha, e a masmorra nasceria invisível.
        /// </summary>
        private static readonly Dictionary<string, BuildingGrade.Enum> GradeByName =
            new Dictionary<string, BuildingGrade.Enum>
            {
                ["twigs"] = BuildingGrade.Enum.Twigs,
                ["wood"] = BuildingGrade.Enum.Wood,
                ["stone"] = BuildingGrade.Enum.Stone,
                ["metal"] = BuildingGrade.Enum.Metal,
                ["toptier"] = BuildingGrade.Enum.TopTier,
            };

        /// <summary>O grau de quem não escolheu nenhum. Era o único.</summary>
        private const BuildingGrade.Enum DefaultGrade = BuildingGrade.Enum.Stone;

        /// <summary>As três peças que ganham grau próprio.</summary>
        private enum Piece { Foundation, Wall, Ceiling }

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

            // ####  AS FECHADURAS, POR SALA  ####
            //
            // O código é sorteado quando a PORTA nasce e o portador só
            // é escolhido quando o CONTEÚDO nasce — duas fases, e entre
            // elas a masmorra tem sala trancada sem ninguém que a abra.
            // É por isso que existe o `SettleLocks`: no fim de tudo,
            // fechadura sem portador vira porta destrancada, com grito
            // no log. Uma sala que ninguém abre é um pedaço de masmorra
            // que o jogador vê e não usa — e ele nunca saberia por que.
            /// <summary>A fechadura de cada sala trancada, por id de sala.</summary>
            public readonly Dictionary<int, RoomLock> locks = new Dictionary<int, RoomLock>();
            /// <summary>Os códigos já sorteados, para não repetir.</summary>
            public readonly HashSet<string> usedCodes = new HashSet<string>();
            /// <summary>O código único, quando a receita pede um só.</summary>
            public string sharedCode;
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


        /// <summary>
        /// A tranca de uma sala: o código, as portas dela e quem o leva.
        ///
        /// É por SALA, e não por porta: um cômodo com três entradas tem
        /// UM código. Um código por folha faria o jogador achar o papel
        /// da porta norte e continuar trancado do lado sul, sem nada na
        /// tela explicando por que aquele número não serve.
        /// </summary>
        private sealed class RoomLock
        {
            public int roomId;
            public string color;
            public string code;
            /// <summary>As folhas daquela sala. Todas com a mesma fechadura.</summary>
            public readonly List<CodeLock> locks = new List<CodeLock>();
            /// <summary>As células do cômodo. O portador nunca está numa delas.</summary>
            public readonly HashSet<(int, int)> cells = new HashSet<(int, int)>();
            /// <summary>Já existe alguém no mundo carregando este código?</summary>
            public bool delivered;
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
                case "ir":
                    CmdTeleportToEntrance(player, args.Skip(1).ToArray());
                    return;

                case "status":
                    ReplyStatus(player);
                    return;

                case "onde":
                case "where":
                    ReplyGround(player, args.Skip(1).ToArray());
                    return;

                default:
                    player.Reply("Não conheço '" + sub + "'. Use: /ozdungeon [lista|build <planta>|stop|tp [quem]|onde [x z]|status]");
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

            // ####  E O QUE O PAINEL MANDOU  ####
            //
            // Sem isto, "o plugin recebeu o desenho?" só se responde
            // construindo e contando peças. Com uma masmorra que sai
            // errada, é a primeira pergunta — e ela merecia uma linha,
            // não uma investigação.
            if (state.dungeons.Count == 0)
            {
                player.Reply("Nenhuma masmorra veio do painel ainda.");
            }
            else
            {
                foreach (var entry in state.dungeons)
                {
                    var spec = entry.Value;
                    var cells = 0;

                    if (spec != null && spec.grid != null)
                        foreach (var row in spec.grid)
                            foreach (var ch in row ?? "")
                                if (ch != '.' && ch != ' ') cells++;

                    player.Reply("  " + entry.Key
                                 + " · modo " + (spec == null ? "?" : spec.mode ?? "?")
                                 + " · desenho " + (spec == null || spec.grid == null
                                     ? "nenhum"
                                     : spec.grid.Count + " linhas, " + cells + " células")
                                 + " · entrada " + (spec == null || string.IsNullOrEmpty(spec.entrance)
                                     ? "mínima"
                                     : spec.entrance));
                }
            }

            player.Reply("Use: /ozdungeon build <nome>  — nasce onde você está, para onde você olha.");
        }

        /// <summary>
        /// Aquele ponto serve para uma masmorra?
        ///
        /// ####  ELE EXISTE PORQUE EU MATEI O DONO  ####
        ///
        /// Em 09/09/2026 mandei construir em (-1330, 871) sem olhar o
        /// mapa. A entrada nasceu dentro de um rio, e ele morreu no
        /// instante em que o teleporte o levou até lá.
        ///
        /// Antes disto, a única maneira de saber se um ponto servia era
        /// construir e ver. Agora dá para PERGUNTAR — e o painel, que
        /// escolhe pontos no mapa sem nunca ver o terreno, pode
        /// perguntar antes de mandar alguém para lá.
        /// </summary>
        private void ReplyGround(IPlayer player, string[] args)
        {
            float x, z;

            if (args.Length >= 2
                && float.TryParse(args[0], NumberStyles.Float, CultureInfo.InvariantCulture, out x)
                && float.TryParse(args[1], NumberStyles.Float, CultureInfo.InvariantCulture, out z))
            {
                // veio do console, ou o admin digitou as coordenadas
            }
            else
            {
                var basePlayer = player.Object as BasePlayer;

                if (basePlayer == null)
                {
                    player.Reply("Do console, informe onde: ozdungeon onde <x> <z>");
                    return;
                }

                x = basePlayer.transform.position.x;
                z = basePlayer.transform.position.z;
            }

            var ground = GroundAt(x, z);
            var point = new Vector3(x, ground, z);
            var depth = WaterDepth(point);
            var sea = TerrainMeta.WaterMap != null
                ? TerrainMeta.WaterMap.GetHeight(point)
                : 0f;

            player.Reply(
                Grid(point) + " (" + x.ToString("0", CultureInfo.InvariantCulture) + ", "
                + z.ToString("0", CultureInfo.InvariantCulture) + ")"
                + " · chão em y=" + ground.ToString("0.0", CultureInfo.InvariantCulture)
                + " · água em y=" + sea.ToString("0.0", CultureInfo.InvariantCulture)
                + " · profundidade " + depth.ToString("0.0", CultureInfo.InvariantCulture) + " m"
                + " · " + (depth > 0.5f ? "NÃO SERVE: é água" : "serve"));
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

            // ####  O ADMIN PRECISA DOS CÓDIGOS  ####
            //
            // Sem isto, a única maneira de saber o código de uma sala é
            // matar o NPC certo — e o admin que quer CONFERIR se a
            // fechadura funcionou teria de jogar a masmorra inteira.
            // O comando já é só de admin (ver `IsAllowed`).
            foreach (var entry in active.locks.Values)
            {
                player.Reply("  sala " + ColorLabel(entry.color)
                             + " · código " + entry.code
                             + " · " + (entry.delivered ? "entregue a alguém" : "SEM PORTADOR")
                             + " · " + entry.locks.Count + " porta(s)");
            }
        }

        /// <summary>
        /// Leva alguém até a entrada da masmorra que está de pé.
        ///
        /// ####  ELE ACEITA UM ALVO, E É POR CAUSA DO CONSOLE  ####
        ///
        /// Sem argumento, leva quem digitou — o caso do admin dentro do
        /// jogo. Mas o console NÃO É um jogador: `player.Object` é nulo,
        /// e o comando respondia "só funciona de dentro do jogo".
        ///
        /// Isso deixava o painel sem caminho nenhum para "me leve até
        /// lá": ele fala com o servidor pelo console, e o admin que
        /// acabou de construir uma masmorra pelo painel quer ir vê-la
        /// sem decorar coordenada.
        ///
        /// O alvo é procurado por nome parcial ou SteamID, como todo
        /// comando de admin do Rust.
        /// </summary>
        private void CmdTeleportToEntrance(IPlayer player, string[] args)
        {
            if (active == null) { player.Reply("Não há masmorra de pé."); return; }

            var target = args.Length > 0 ? FindPlayer(args[0]) : player.Object as BasePlayer;

            if (target == null)
            {
                player.Reply(args.Length > 0
                    ? "Não achei ninguém chamado '" + args[0] + "' online."
                    : "Do console, diga quem: ozdungeon tp <nome ou steamid>");
                return;
            }

            // O mesmo caminho do alçapão, e não um `Teleport` cru: sem
            // as pausas de detecção o jogador leva kick por velocidade.
            TeleportPlayer(target, active.surface + Vector3.up * 1.5f);

            player.Reply(target.displayName + " está na entrada de '" + active.slug + "'.");

            if (target.IPlayer != null && target.IPlayer.Id != player.Id)
            {
                target.IPlayer.Reply("Você foi levado até a entrada da masmorra '" + active.slug + "'.");
            }
        }

        /// <summary>
        /// Acha um jogador online por SteamID ou por pedaço do nome.
        ///
        /// O nome exato ganha do parcial: com "Ana" e "Anaconda" online,
        /// quem digitou "Ana" quis a Ana.
        /// </summary>
        private static BasePlayer FindPlayer(string needle)
        {
            if (string.IsNullOrEmpty(needle)) return null;

            foreach (var candidate in BasePlayer.activePlayerList)
            {
                if (candidate.UserIDString == needle) return candidate;
                if (string.Equals(candidate.displayName, needle, StringComparison.OrdinalIgnoreCase))
                    return candidate;
            }

            foreach (var candidate in BasePlayer.activePlayerList)
            {
                if (candidate.displayName != null
                    && candidate.displayName.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                    return candidate;
            }

            return null;
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

        /// <summary>
        /// Quantos metros de água há sobre aquele ponto. Zero = terra.
        ///
        /// A entrada é a única parte que se importa: a masmorra mora a
        /// -90 metros, onde tudo está "abaixo do mar" e nada se molha.
        /// </summary>
        private static float WaterDepth(Vector3 point)
        {
            if (TerrainMeta.WaterMap == null)
            {
                // Sem mapa de água, o nível do mar é o zero do mundo —
                // que é a convenção do Rust. É defesa para um mundo
                // ainda carregando, não o caminho normal.
                return Mathf.Max(0f, -point.y);
            }

            return Mathf.Max(0f, TerrainMeta.WaterMap.GetHeight(point) - point.y);
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

            // ####  NA ÁGUA, NÃO  ####
            //
            // MEDIDO em 09/09/2026, e da pior maneira: construí em
            // (-1330, 871) sem olhar o mapa, a entrada nasceu no fundo
            // do mar, e o dono MORREU no instante em que o `tp` o levou
            // até lá.
            //
            // `GroundAt` devolve o fundo do mar como se fosse chão — o
            // comentário dele já dizia isso e delegava a escolha a "quem
            // vê o mapa". Só que com coordenada explícita — que é como o
            // painel constrói, e o único jeito de testar sem um cliente
            // aberto — não há ninguém vendo mapa nenhum.
            //
            // `no_position` já era um dos oito motivos de falha do
            // plano, com "água" na descrição: ele existia no documento e
            // não no código.
            //
            // A checagem mora AQUI, e não no comando, porque o `Fail`
            // precisa da masmorra registrada para dizer ao painel QUAL
            // delas não nasceu.
            var depth = WaterDepth(surface);

            if (depth > 0.5f)
            {
                Fail(requester, "no_position",
                     "Ali é água: " + depth.ToString("0.0", CultureInfo.InvariantCulture)
                     + " m de profundidade. A entrada nasceria submersa, e quem descesse "
                     + "morreria afogado antes de achar o alçapão. Escolha um ponto em terra firme.");
                return;
            }

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

            // ####  A COR VEM ANTES DA PRIMEIRA PEÇA  ####
            //
            // O grau de cada peça depende da cor da sala dona dela, e o
            // CHÃO nasce antes das paredes — que era onde `RoomColor`
            // sorteava pela primeira vez. Sem esta volta, a fundação e o
            // teto da sala vermelha sairiam com o grau do corredor e só
            // as paredes obedeceriam a receita: metade do cômodo
            // blindada, metade de pedra, e nada no log.
            //
            // `RoomColor` cacheia por sala, então isto não sorteia duas
            // vezes nem repinta o que a planta já pintou.
            foreach (var pair in layout.owner)
                if (pair.Value >= 0) RoomColor(dungeon, layout, pair.Key, rng);

            // Quantas células e quantas portas cada sala tem. É disso
            // que sai a decisão "esta sala virou funil" — ver
            // `DoorTypeOf`.
            var roomCells = new Dictionary<int, int>();
            var roomDoors = new Dictionary<int, int>();

            foreach (var pair in layout.owner)
            {
                if (pair.Value < 0) continue;

                int seen;
                roomCells[pair.Value] = roomCells.TryGetValue(pair.Value, out seen) ? seen + 1 : 1;
            }

            foreach (var pair in layout.doors)
            {
                int owner;
                if (!layout.owner.TryGetValue(pair.room, out owner) || owner < 0) continue;

                int seen;
                roomDoors[owner] = roomDoors.TryGetValue(owner, out seen) ? seen + 1 : 1;
            }

            // 1) O chão.
            foreach (var cell in layout.cells)
            {
                var pos = dungeon.origin + right * (cell.Item1 * CellSize) + forward * (cell.Item2 * CellSize);
                pos.y = dungeon.origin.y;

                var block = GameManager.server.CreateEntity(PrefabFoundation, pos, R0) as BuildingBlock;
                if (block == null) continue;

                PrepareBlock(dungeon, block, GradeOf(dungeon, layout, cell, Piece.Foundation));
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

                    // ####  DONO IGUAL DOS DOIS LADOS: NÃO HÁ PAREDE  ####
                    //
                    // Duas células da mesma sala viram um cômodo só. E
                    // duas de CORREDOR viram caminho — que é o ponto de
                    // um corredor.
                    //
                    // MEDIDO em 09/09/2026, com o dono dentro do jogo:
                    // esta condição terminava em `&& mine >= 0`, e o
                    // corredor tem dono -1. O teste nunca passava para
                    // ele, então nascia parede entre CADA PAR de células
                    // de corredor — o caminho inteiro virava uma fileira
                    // de cubículos de 3×3 lacrados, e quem descia o
                    // alçapão caía dentro de um deles sem saída.
                    //
                    // Contar peças não pega isto: a masmorra sobe, o
                    // número fecha, e o defeito só existe para quem está
                    // lá dentro. Foi preciso um jogador de verdade
                    // olhando quatro paredes.
                    //
                    // Sem o `>= 0`, sala com sala e corredor com corredor
                    // ficam abertos; sala com corredor e sala com OUTRA
                    // sala continuam com parede, que é o que separa os
                    // cômodos.
                    if (layout.cells.Contains(neighbour)
                        && layout.owner.TryGetValue(cell, out var mine)
                        && layout.owner.TryGetValue(neighbour, out var theirs)
                        && mine == theirs)
                        continue;

                    var isDoor = doorPairs.Contains(key);

                    // ####  O BLOCO DEPENDE DA PORTA, E NÃO O CONTRÁRIO  ####
                    //
                    // A folha de um metro mora num `wall.doorway`; a de
                    // dois, num `wall.frame`. Erguer o vão primeiro e
                    // decidir a porta depois — como era — deixava a
                    // porta dupla sem onde nascer.
                    var roomCell = layout.owner.ContainsKey(cell) && layout.owner[cell] >= 0 ? cell : neighbour;
                    string color = null;
                    DoorKind kind = null;

                    if (isDoor)
                    {
                        color = RoomColor(dungeon, layout, roomCell, rng);

                        int room;
                        layout.owner.TryGetValue(roomCell, out room);

                        int cellsInRoom;
                        int doorsInRoom;
                        if (!roomCells.TryGetValue(room, out cellsInRoom)) cellsInRoom = 1;
                        if (!roomDoors.TryGetValue(room, out doorsInRoom)) doorsInRoom = 1;

                        kind = DoorKindOf(dungeon, color, cellsInRoom, doorsInRoom);
                    }

                    var prefab = isDoor ? kind.frame : PrefabWall;
                    var (localPos, localRot) = WallPlacement(cell, neighbour);

                    var wall = GameManager.server.CreateEntity(prefab, parent.transform.position) as BuildingBlock;
                    if (wall == null) continue;

                    wall.SetParent(parent);
                    wall.transform.localPosition = localPos;
                    wall.transform.localRotation = localRot;
                    PrepareBlock(dungeon, wall, WallGradeOf(dungeon, layout, cell, neighbour));
                    Adopt(dungeon, wall);
                    walls[key] = wall;

                    if (isDoor) HangDoor(dungeon, wall, kind, layout, roomCell, color, rng);
                }
            }

            // 3) O teto. Sem ele, quem entra vê o vazio a -90 metros e
            //    entende na hora que está fora do mundo.
            //
            // ####  A CÉLULA DO ALÇAPÃO TAMBÉM GANHA TETO  ####
            //
            // Ela recebia um `floor.frame` em vez do piso liso, para a
            // tampa nascer "dentro do vão". Mas um `floor.frame` é um
            // QUADRO: o buraco do meio só se fecha com o encaixe dele
            // (uma grade, uma escotilha de construção), e o
            // `door.hinged.bunker_hatch` é uma tampa de monumento que
            // apenas abre — ela não veda coisa nenhuma.
            //
            // MEDIDO em 09/09/2026, pelo dono, de dentro da masmorra:
            // "o teto de entrada está bugado, consigo ver o landscape de
            // baixo pra cima". Era o vão aberto, a noventa metros de
            // profundidade, olhando para o mundo.
            //
            // O vão nunca foi necessário: sair é TELEPORTE, e não subir
            // por um buraco. A tampa serve para ser vista e usada, e
            // para isso basta ela estar colada sob um teto inteiro.
            var ceilings = new Dictionary<(int, int), BuildingBlock>();

            foreach (var pair in floors)
            {
                if (pair.Value == null) continue;

                var ceiling = GameManager.server.CreateEntity(PrefabFloor, pair.Value.transform.position) as BuildingBlock;
                if (ceiling == null) continue;

                ceiling.SetParent(pair.Value);
                ceiling.transform.localPosition = new Vector3(0f, 3f, 0f);
                ceiling.transform.localRotation = R0;
                PrepareBlock(dungeon, ceiling, GradeOf(dungeon, layout, pair.Key, Piece.Ceiling));
                Adopt(dungeon, ceiling);
                ceilings[pair.Key] = ceiling;
            }

            // 4) O alçapão de saída, colado sob o teto da (0,0).
            if (ceilings.TryGetValue((0, 0), out var lobby) && lobby != null)
            {
                PlaceExitHatch(dungeon, lobby);
                PlaceLight(dungeon, lobby);
            }

            // 5) O que tem dentro: caixas e inimigos.
            Populate(dungeon, layout, floors, rng);

            Debug("masmorra: " + layout.cells.Count + " células, "
                  + layout.roomCount + " salas, " + dungeon.entities.Count + " peças");
        }

        // ============================================================
        //  O QUE TEM DENTRO
        //
        //  ####  ATÉ AQUI A MASMORRA ERA UM PRÉDIO VAZIO  ####
        //
        //  `npc` e `crates` viajavam do painel até o `DungeonSpec` e
        //  paravam ali: nenhum código os lia. O admin escolhia caixa de
        //  elite para a sala vermelha, salvava, construía — e encontrava
        //  quatro paredes.
        //
        //  ####  A CONTA É POR SALA, E NÃO POR CÉLULA  ####
        //
        //  "de 2 a 3 caixas na sala vermelha" é uma promessa sobre o
        //  CÔMODO. Sorteando por célula, uma sala de nove células
        //  nasceria com vinte e sete caixas — e a receita deixaria de
        //  querer dizer o que diz.
        //
        //  No corredor é o contrário: lá a densidade é "de cada cem
        //  células, quantas ganham uma", então o sorteio é por célula.
        // ============================================================

        private void Populate(
            ActiveDungeon dungeon,
            Layout layout,
            Dictionary<(int, int), BuildingBlock> floors,
            System.Random rng)
        {
            var byRoom = new Dictionary<int, List<(int, int)>>();
            var corridor = new List<(int, int)>();

            foreach (var cell in layout.cells)
            {
                // A chegada fica livre: uma caixa ali é onde o jogador
                // materializa, e um inimigo ali atira nele antes de a
                // tela terminar de carregar.
                if (IsEntranceCell(cell)) continue;

                int owner;
                if (!layout.owner.TryGetValue(cell, out owner)) continue;

                if (owner < 0)
                {
                    corridor.Add(cell);
                    continue;
                }

                List<(int, int)> list;
                if (!byRoom.TryGetValue(owner, out list))
                {
                    list = new List<(int, int)>();
                    byRoom[owner] = list;
                }

                list.Add(cell);
            }

            var crates = 0;
            var npcs = 0;

            foreach (var pair in byRoom)
            {
                var cells = pair.Value;
                if (cells.Count == 0) continue;

                var color = RoomColor(dungeon, layout, cells[0], rng);
                var spec = RoomSpecOf(dungeon, color);

                // ####  UMA CÉLULA RECEBE UMA COISA  ####
                //
                // MEDIDO em 09/09/2026, pelo dono, dentro do labirinto:
                // "está spawnando 3 NPC em cima do outro" e "se a sala é
                // só 1 cômodo então tem que spawnar só uma caixa".
                //
                // A causa era sortear a célula A CADA peça: numa sala de
                // uma célula, as três caixas e os três inimigos da
                // receita caíam todos no mesmo quadrado de 3×3 metros,
                // um dentro do outro. O jogador via um borrão de
                // cientistas e conseguia abrir uma caixa só.
                //
                // Agora as células são embaralhadas e consumidas: a
                // receita vira um TETO, e o cômodo cabe o que cabe. Uma
                // sala de uma célula recebe uma caixa e um inimigo,
                // diga a receita o que disser.
                var wantedCrates = spec == null ? 1 : Roll(rng, spec.loot);
                var wantedNpcs = spec == null ? 0 : Roll(rng, spec.npc);

                var prefabs = spec == null || spec.crates == null || spec.crates.Count == 0
                    ? DefaultCrates
                    : spec.crates;

                var forCrates = Shuffled(cells, rng);
                var forNpcs = Shuffled(cells, rng);

                for (var i = 0; i < wantedCrates && i < forCrates.Count; i++)
                {
                    if (SpawnCrate(dungeon, layout, floors, forCrates[i], prefabs[rng.Next(prefabs.Count)], rng))
                        crates++;
                }

                for (var i = 0; i < wantedNpcs && i < forNpcs.Count; i++)
                {
                    if (SpawnNpc(dungeon, layout, floors, forNpcs[i], color, rng)) npcs++;
                }
            }

            var corridorSpec = dungeon.spec == null ? null : dungeon.spec.corridor;
            var lootDensity = corridorSpec == null ? 0 : Mathf.Clamp(corridorSpec.lootDensity, 0, 100);
            var npcDensity = corridorSpec == null ? 0 : Mathf.Clamp(corridorSpec.npcDensity, 0, 100);

            var corridorCrates = corridorSpec == null || corridorSpec.crates == null || corridorSpec.crates.Count == 0
                ? DefaultCrates
                : corridorSpec.crates;

            foreach (var cell in corridor)
            {
                // Uma celula de corredor recebe UMA coisa: com as duas,
                // o inimigo nasce em cima da caixa e o jogador nao
                // consegue abri-la sem matar alguem primeiro — o que
                // parece bug, e nao desenho.
                if (rng.Next(100) < lootDensity)
                {
                    if (SpawnCrate(dungeon, layout, floors, cell, corridorCrates[rng.Next(corridorCrates.Count)], rng))
                        crates++;

                    continue;
                }

                if (rng.Next(100) < npcDensity && SpawnNpc(dungeon, layout, floors, cell, null, rng)) npcs++;
            }

            // ####  O ACERTO DE CONTAS DAS FECHADURAS  ####
            //
            // Depois desta linha não nasce mais nada, então é aqui que
            // se sabe se todo código achou um portador. Ver `SettleLocks`.
            SettleLocks(dungeon);

            Debug("conteudo: " + crates + " caixas, " + npcs + " inimigos");
        }

        /// <summary>
        /// Uma copia embaralhada da lista.
        ///
        /// Serve para distribuir sem repetir: percorrida em ordem, ela
        /// da uma celula diferente a cada peca, e acaba quando o comodo
        /// acaba.
        /// </summary>
        private static List<(int, int)> Shuffled(List<(int, int)> cells, System.Random rng)
        {
            var copy = new List<(int, int)>(cells);

            for (var i = copy.Count - 1; i > 0; i--)
            {
                var j = rng.Next(i + 1);
                var swap = copy[i];
                copy[i] = copy[j];
                copy[j] = swap;
            }

            return copy;
        }

        /// <summary>As caixas de quem nao escolheu nenhuma.</summary>
        private static readonly List<string> DefaultCrates = new List<string>
        {
            "assets/bundled/prefabs/radtown/crate_normal.prefab",
        };

        /// <summary>O que o painel definiu para aquela cor.</summary>
        private RoomSpec RoomSpecOf(ActiveDungeon dungeon, string color)
        {
            if (dungeon.spec == null || dungeon.spec.rooms == null) return null;

            foreach (var room in dungeon.spec.rooms)
                if (room != null && room.color == color) return room;

            return null;
        }

        /// <summary>Um numero dentro do intervalo, inclusive nas pontas.</summary>
        private static int Roll(System.Random rng, Range range)
        {
            if (range == null) return 0;

            var min = Mathf.Max(0, range.min);
            var max = Mathf.Max(min, range.max);

            return rng.Next(min, max + 1);
        }

        /// <summary>
        /// Onde uma peca de conteudo nasce dentro da celula.
        ///
        /// Nunca no centro exato: duas caixas na mesma celula ficariam
        /// uma dentro da outra, e o jogador so conseguiria abrir uma.
        /// Um metro de raio cabe folgado numa celula de tres.
        /// </summary>
        private static Vector3 SpotIn(BuildingBlock floor, System.Random rng)
        {
            var angle = rng.Next(360) * Mathf.Deg2Rad;
            var radius = 0.4f + rng.Next(70) / 100f;

            return floor.transform.position
                   + new Vector3(Mathf.Cos(angle) * radius, 0.1f, Mathf.Sin(angle) * radius);
        }

        private bool SpawnCrate(
            ActiveDungeon dungeon,
            Layout layout,
            Dictionary<(int, int), BuildingBlock> floors,
            (int, int) cell,
            string prefab,
            System.Random rng)
        {
            BuildingBlock floor;
            if (!floors.TryGetValue(cell, out floor) || floor == null) return false;

            var crate = GameManager.server.CreateEntity(
                prefab, SpotIn(floor, rng), Quaternion.Euler(0f, rng.Next(360), 0f));

            if (crate == null) return false;

            crate.OwnerID = 0UL;
            crate.EnableSaving(false);
            crate.Spawn();
            Adopt(dungeon, crate);

            // ####  UMA LINHA DA FRENTE DAS PORTAS  ####
            //
            // Ver `TakeCodeNote`: ela devolve o papel do código de uma
            // sala trancada, já marcado como entregue, ou `null`. A
            // caixa é o portador só quando a receita pede
            // (`lock.carrier: "crate"`).
            var crateNote = TakeCodeNote(dungeon, layout, cell, "crate");
            var crateBox = crate as StorageContainer;

            if (crateNote != null)
            {
                if (crateBox == null || !crateNote.MoveToContainer(crateBox.inventory))
                    crateNote.Remove();
            }

            // A caixa de radtown se enche sozinha ao nascer: quem decide
            // o que cai e a tabela de loot do servidor, e e assim que o
            // BetterLoot continua valendo aqui dentro.
            return true;
        }

        /// <summary>
        /// Um inimigo, parado onde nasceu.
        ///
        /// ####  A NAVEGACAO FICA DESLIGADA, E NAO E ESCOLHA  ####
        ///
        /// A noventa metros abaixo do mundo nao existe NavMesh: o mapa
        /// de navegacao do Rust e assado sobre o terreno, e ali nao ha
        /// terreno. Um cientista com `CanUseNavMesh` ligado passa o
        /// tempo tentando calcular um caminho que nao existe, e
        /// escorrega pelo chao.
        ///
        /// Parado ele ainda mira, atira e morre — que e o que o jogador
        /// precisa que ele faca. A IA que persegue e a mesma da base
        /// 1.3.4, e ela vem junto com a frente que a torna configuravel.
        /// </summary>
        private bool SpawnNpc(
            ActiveDungeon dungeon,
            Layout layout,
            Dictionary<(int, int), BuildingBlock> floors,
            (int, int) cell,
            string color,
            System.Random rng)
        {
            BuildingBlock floor;
            if (!floors.TryGetValue(cell, out floor) || floor == null) return false;

            var npc = GameManager.server.CreateEntity(
                PrefabScientist,
                floor.transform.position + Vector3.up * 0.2f,
                Quaternion.Euler(0f, rng.Next(360), 0f)) as ScientistNPC;

            if (npc == null) return false;

            npc.EnableSaving(false);
            npc.Spawn();
            Adopt(dungeon, npc);

            // ####  UMA LINHA DA FRENTE DAS PORTAS  ####
            //
            // Ver `TakeCodeNote`. O papel entra no inventário principal
            // do cientista; QUE ELE CAIA quando o NPC morre é da frente
            // do loot — o corpo do `ScientistNPC` leva o `containerMain`
            // junto por padrão, mas quem confirma isso no jogo, e trata
            // o caso de não levar, é ela.
            var npcNote = TakeCodeNote(dungeon, layout, cell, "npc");

            if (npcNote != null)
            {
                if (npc.inventory == null || !npcNote.MoveToContainer(npc.inventory.containerMain))
                    npcNote.Remove();
            }

            var navigator = npc.GetComponent<BaseNavigator>();
            if (navigator != null) navigator.CanUseNavMesh = false;

            var spec = dungeon.spec == null ? null : dungeon.spec.npc;

            if (spec != null)
            {
                if (spec.health != null)
                {
                    var health = Mathf.Max(1, Roll(rng, spec.health));
                    npc.InitializeHealth(health, health);
                }

                npc.damageScale = Mathf.Max(0f, spec.damageScale);

                if (spec.names != null && spec.names.Count > 0)
                    npc.displayName = spec.names[rng.Next(spec.names.Count)];

                if (spec.weapons != null && spec.weapons.Count > 0)
                    GiveWeapon(npc, spec.weapons[rng.Next(spec.weapons.Count)]);
            }

            // ####  A IA VEM POR ULTIMO  ####
            //
            // Depois da arma e da vida: o componente le as duas ao
            // acordar, e ligado antes ele encontraria um cientista
            // ainda pela metade.
            AttachAi(npc, AiProfileFor(dungeon, color));

            return true;
        }

        /// <summary>
        /// Troca a arma do inimigo pela que a receita pediu.
        ///
        /// O cientista ja nasce com uma; a nova entra no primeiro slot
        /// da barra e vira a ativa. Sem o `UpdateActiveItem` ele fica
        /// com a arma na cintura e as maos vazias.
        /// </summary>
        private void GiveWeapon(BasePlayer npc, string shortname)
        {
            if (string.IsNullOrEmpty(shortname) || npc.inventory == null) return;

            var item = ItemManager.CreateByName(shortname, 1);

            if (item == null)
            {
                // Um shortname que o Rust nao conhece mais e PULADO, com
                // aviso: derrubar a masmorra inteira por causa de uma
                // arma renomeada num update seria desproporcional.
                PrintWarning("arma desconhecida no inimigo: " + shortname);
                return;
            }

            var belt = npc.inventory.containerBelt;

            if (belt == null || !item.MoveToContainer(belt, 0, false))
            {
                item.Remove();
                return;
            }

            npc.UpdateActiveItem(item.uid);
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

        // ============================================================
        //  A PORTA QUE O PAINEL ESCOLHEU
        //
        //  ####  DOIS DEFEITOS QUE SÓ APARECEM DEPOIS  ####
        //
        //  O `DoorOf` antigo devolvia uma COR e casava `room.key` com
        //  ela. Isso funcionava por coincidência: o painel grava
        //  `key == color` nas três salas, e havia exatamente três
        //  portas para três cores. Duas coisas quebravam:
        //
        //    1. o contrato PERMITE `key = "A"` — o `dungeons.ts` diz
        //       `key: z.string().min(1).max(16)` e o `dungeon_rooms`
        //       do plano diz "'A','B','C'... no modo planta". Com uma
        //       chave dessas, o `DoorOf` NÃO ACHA a sala e devolve a
        //       cor: o admin escolhe porta blindada, salva, constroi,
        //       e recebe madeira sem uma linha no log. O `RoomSpecOf`,
        //       três funções acima, já casava por `room.color` — duas
        //       regras diferentes para a mesma pergunta, no mesmo
        //       arquivo;
        //
        //    2. traduzir para cor só funciona enquanto houver uma
        //       porta por cor. `cell_gate` não tem cor nenhuma.
        //
        //  Agora há UMA regra (`RoomSpecOf`, por cor) e o que viaja é
        //  o TIPO da porta, que é o vocabulário do painel.
        // ============================================================

        /// <summary>Quantas células por porta antes de o cômodo virar funil.</summary>
        private const int DefaultWideDoorCellsPerDoor = 4;

        /// <summary>O tipo de porta que o painel pediu para aquela cor.</summary>
        private string DoorTypeOf(ActiveDungeon dungeon, string color, int cells, int doors)
        {
            string fallback;
            if (!DoorByColor.TryGetValue(color, out fallback)) fallback = DoorByColor["green"];

            var room = RoomSpecOf(dungeon, color);
            if (room == null) return fallback;

            var wanted = string.IsNullOrEmpty(room.door) ? fallback : room.door;

            // ####  A SALA GRANDE COM UMA PORTA E UM FUNIL  ####
            //
            // Nove células e uma folha de um metro põem três jogadores
            // em fila indiana debaixo de fogo, e o cômodo que devia ser
            // o prêmio vira o lugar onde eles morrem um por vez. A
            // conta é CÉLULAS POR PORTA, e não células: um salão com
            // quatro entradas já não afunila ninguém.
            if (!string.IsNullOrEmpty(room.wideDoor))
            {
                var perDoor = cells / Mathf.Max(1, doors);
                var threshold = room.wideDoorCellsPerDoor > 0
                    ? room.wideDoorCellsPerDoor
                    : DefaultWideDoorCellsPerDoor;

                if (perDoor >= threshold) wanted = room.wideDoor;
            }

            return wanted;
        }

        /// <summary>O tipo, já resolvido em bloco e folha.</summary>
        private DoorKind DoorKindOf(ActiveDungeon dungeon, string color, int cells, int doors)
        {
            var wanted = DoorTypeOf(dungeon, color, cells, doors);

            DoorKind kind;
            if (DoorCatalog.TryGetValue(wanted, out kind)) return kind;

            // Um tipo que este plugin não conhece GRITA e cai na porta
            // da cor. Silenciar aqui é como o `DoorOf` antigo fazia — e
            // é assim que o admin passa uma semana achando que o painel
            // não salva.
            PrintWarning("porta desconhecida '" + wanted + "' na sala " + color
                         + ": usando a porta padrão da cor. Tipos: "
                         + string.Join(", ", DoorCatalog.Keys.ToArray()));

            string fallback;
            if (!DoorByColor.TryGetValue(color, out fallback)) fallback = DoorByColor["green"];

            return DoorCatalog[fallback];
        }

        private void HangDoor(
            ActiveDungeon dungeon,
            BuildingBlock frame,
            DoorKind kind,
            Layout layout,
            (int, int) roomCell,
            string color,
            System.Random rng)
        {
            // Vão aberto é uma escolha do admin (`door: "none"`), e não
            // um erro: sem folha não há o que pendurar.
            if (kind == null || string.IsNullOrEmpty(kind.leaf)) return;

            var door = GameManager.server.CreateEntity(kind.leaf, frame.transform.position);

            if (door == null)
            {
                // ####  O VÃO SEM PORTA E MUDO  ####
                //
                // MEDIDO em 09/09/2026: eu troquei os prefabs e escrevi
                // o caminho de cabeça — `door.hinged.wood/...` em vez de
                // `door.hinged/...`. O `CreateEntity` devolveu null, o
                // `return` engoliu, e a masmorra subiu inteira com os
                // vãos abertos. Quem viu foi o dono, lá dentro.
                //
                // Um prefab que não existe agora GRITA no log, com o
                // caminho — que é a única informação que resolve.
                PrintWarning("porta não criada: o prefab '" + kind.leaf + "' não existe");
                return;
            }

            door.SetParent(frame);
            door.transform.localPosition = Vector3.zero;
            door.transform.localRotation = Quaternion.identity;
            door.OwnerID = 0UL;
            door.EnableSaving(false);
            door.Spawn();
            Adopt(dungeon, door);

            if (IsLocked(dungeon, color)) LockDoor(dungeon, door, kind, layout, roomCell, color, rng);
        }

        // ============================================================
        //  A FECHADURA E O CÓDIGO
        //
        //  ####  CINCO DÍGITOS TRANCAM PARA SEMPRE  ####
        //
        //  O `CodeLock.code` do servidor é uma STRING livre: a 1.3.4
        //  põe "18549" no alçapão dela justamente para que ninguém o
        //  abra, e "0" numa fechadura de planta. Mas o teclado do
        //  CLIENTE tem quatro casas — um código de cinco dígitos não
        //  pode ser digitado, e a sala fica lacrada sem nada na tela
        //  dizendo por que.
        //
        //  Então o sorteio é de QUATRO, sempre, com zeros à esquerda.
        //  Isso não é configurável de propósito: não há faixa útil do
        //  outro lado, só uma masmorra quebrada.
        // ============================================================

        /// <summary>A config de fechadura de quem não mandou nenhuma.</summary>
        private static readonly LockSpec DefaultLockSpec = new LockSpec();

        private LockSpec LockConfigOf(ActiveDungeon dungeon) =>
            dungeon.spec == null || dungeon.spec.doorLock == null
                ? DefaultLockSpec
                : dungeon.spec.doorLock;

        /// <summary>Aquela cor tranca?</summary>
        private bool IsLocked(ActiveDungeon dungeon, string color)
        {
            if (!LockConfigOf(dungeon).enabled) return false;

            var room = RoomSpecOf(dungeon, color);
            return room != null && room.locked;
        }

        /// <summary>Quatro dígitos que ninguém mais tem nesta masmorra.</summary>
        private string NewCode(ActiveDungeon dungeon, System.Random rng)
        {
            var settings = LockConfigOf(dungeon);

            if (settings.sharedCode && !string.IsNullOrEmpty(dungeon.sharedCode))
                return dungeon.sharedCode;

            string code = null;

            for (var attempt = 0; attempt < 64 && code == null; attempt++)
            {
                var candidate = rng.Next(0, 10000).ToString("0000", CultureInfo.InvariantCulture);

                // "0707" é a marca de alçapão das plantas herdadas (ver
                // `IsEntranceHatchMarker`). Sorteá-lo não quebra nada
                // hoje — a marca é lida do JSON, não do mundo —, mas
                // poria o mesmo número em dois significados, e a
                // próxima pessoa a depurar isso perderia uma tarde.
                if (candidate == HatchMarkerCode) continue;
                if (dungeon.usedCodes.Contains(candidate)) continue;

                code = candidate;
            }

            // Trinta e duas salas trancadas na mesma masmorra é mais do
            // que o teto do painel; se ainda assim o sorteio não achou
            // um livre, repetir é melhor que não trancar.
            if (code == null) code = rng.Next(0, 10000).ToString("0000", CultureInfo.InvariantCulture);

            dungeon.usedCodes.Add(code);
            if (settings.sharedCode) dungeon.sharedCode = code;

            return code;
        }

        /// <summary>
        /// Pendura o cadeado e tranca.
        ///
        /// ####  A ORDEM E A DA 1.3.4, E ELA FUNCIONA  ####
        ///
        /// `SetParent` no OSSO do encaixe (`GetSlotAnchorName`), pose
        /// local zero, `Spawn`, e SÓ ENTÃO o código, a flag e o
        /// `SetSlot`. Sem o osso, a fechadura nasce no centro da porta,
        /// atravessada nela — e o jogador vê um teclado dentro da
        /// madeira.
        /// </summary>
        private void LockDoor(
            ActiveDungeon dungeon,
            BaseEntity leaf,
            DoorKind kind,
            Layout layout,
            (int, int) roomCell,
            string color,
            System.Random rng)
        {
            var door = leaf as Door;

            if (door == null)
            {
                // ####  SALA TRANCADA SEM FECHADURA E PIOR QUE ABERTA  ####
                //
                // Nem toda folha do catálogo é uma `Door` com encaixe de
                // cadeado. Se esta não for, a sala fica ABERTA e o log
                // diz qual — em vez de o admin ver "trancada" no painel
                // é uma porta que abre sozinha no jogo.
                PrintWarning("a " + kind.label + " não aceita fechadura: a sala "
                             + ColorLabel(color) + " fica destrancada");
                return;
            }

            int roomId;
            if (!layout.owner.TryGetValue(roomCell, out roomId) || roomId < 0) return;

            RoomLock entry;
            if (!dungeon.locks.TryGetValue(roomId, out entry))
            {
                entry = new RoomLock { roomId = roomId, color = color, code = NewCode(dungeon, rng) };

                foreach (var pair in layout.owner)
                    if (pair.Value == roomId) entry.cells.Add(pair.Key);

                dungeon.locks[roomId] = entry;
            }

            var padlock = GameManager.server.CreateEntity(PrefabCodeLock, door.transform.position) as CodeLock;

            if (padlock == null)
            {
                PrintWarning("fechadura não criada: o prefab '" + PrefabCodeLock + "' não existe");
                return;
            }

            padlock.SetParent(door, door.GetSlotAnchorName(BaseEntity.Slot.Lock));
            padlock.transform.localPosition = Vector3.zero;
            padlock.transform.localRotation = Quaternion.identity;
            padlock.OwnerID = 0UL;
            padlock.EnableSaving(false);
            padlock.Spawn();

            padlock.code = entry.code;
            padlock.hasCode = true;
            padlock.SetFlagLocal(BaseEntity.Flags.Locked, true);
            door.SetSlot(BaseEntity.Slot.Lock, padlock);
            door.SetOpen(false);
            padlock.SendNetworkUpdate();

            // `Adopt` põe a marca que o `OnEntityTakeDamage` lê: sem
            // ela, dois tiros de espingarda na fechadura resolvem o
            // enigma inteiro.
            Adopt(dungeon, padlock);
            entry.locks.Add(padlock);
        }

        /// <summary>A cor, como o jogador a lê.</summary>
        private static string ColorLabel(string color)
        {
            if (color == "blue") return "azul";
            if (color == "red") return "vermelha";
            return "verde";
        }

        // ============================================================
        //  A FRONTEIRA COM A FRENTE DO LOOT
        //
        //  ####  DUAS METADES, E ELAS SE ENCONTRAM AQUI  ####
        //
        //  PORTAS (este arquivo, daqui para cima): a fechadura existe,
        //  o código é sorteado, e há uma regra dizendo QUEM pode
        //  carrega-lo.
        //
        //  LOOT (a outra frente): em que corpo o papel entra, se ele
        //  sobrevive à morte do NPC, o que mais vem junto e o respawn.
        //
        //  O contrato entre as duas é este método mais UMA LINHA em
        //  `SpawnNpc` e outra em `SpawnCrate`. `TakeCodeNote` devolve um
        //  `Item` pronto — quem chama só precisa achar container para
        //  ele — e já marcou a fechadura como entregue, então chamar
        //  duas vezes não produz dois papeis do mesmo código.
        //
        //  ####  O PORTADOR NUNCA ESTA DENTRO DA SALA QUE ELE ABRE  ####
        //
        //  Isso NÃO é configurável, e não é capricho: o código da sala
        //  vermelha guardado dentro da sala vermelha é uma porta que só
        //  abre para quem já entrou. O jogador daria a volta na masmorra
        //  inteira procurando um papel que estava do outro lado da porta
        //  trancada.
        // ============================================================

        private Item TakeCodeNote(ActiveDungeon dungeon, Layout layout, (int, int) cell, string carrier)
        {
            if (dungeon.locks.Count == 0) return null;

            var settings = LockConfigOf(dungeon);
            if (settings.carrier != carrier) return null;

            // `corridor` é o padrão porque é o que se lê sozinho: o
            // guarda do corredor tem a chave da sala. `anywhere` deixa
            // o papel cair em qualquer cômodo que não seja o trancado —
            // útil quando a receita quase não tem NPC de corredor.
            var scope = string.IsNullOrEmpty(settings.carrierScope) ? "corridor" : settings.carrierScope;

            int owner;
            var inCorridor = layout.owner.TryGetValue(cell, out owner) && owner < 0;

            if (scope == "corridor" && !inCorridor) return null;

            foreach (var entry in dungeon.locks.Values)
            {
                if (entry.delivered) continue;
                if (entry.cells.Contains(cell)) continue;

                var note = ItemManager.CreateByName("note", 1);

                if (note == null)
                {
                    // O `note` existe no Rust de 09/09/2026 (conferido no
                    // `Bundles/items/note.json` do server01, itemid
                    // 1414245162). Se um update o renomear, a sala fica
                    // trancada sem código — e o `SettleLocks` a abre.
                    PrintWarning("o item 'note' não existe mais: o código da sala "
                                 + ColorLabel(entry.color) + " não pode ser entregue");
                    return null;
                }

                note.name = string.IsNullOrEmpty(settings.noteTitle)
                    ? "Código da porta"
                    : settings.noteTitle;

                note.text = "A porta da sala " + ColorLabel(entry.color)
                            + " abre com o código " + entry.code + ".";

                entry.delivered = true;
                return note;
            }

            return null;
        }

        /// <summary>
        /// O acerto de contas das fechaduras, no fim da construção.
        ///
        /// ####  UMA SALA QUE NINGUÉM ABRE E UM DEFEITO MUDO  ####
        ///
        /// A porta nasce trancada antes de o conteúdo existir, e o
        /// portador só aparece no `Populate`. Se a receita não tiver NPC
        /// nenhum no corredor — ou se o admin puser `carrier: "none"` —
        /// a sala fica lacrada para sempre, a masmorra sobe, a contagem
        /// de peças fecha e ninguém descobre até um jogador desistir de
        /// procurar o papel.
        ///
        /// Então o padrão é DESTRANCAR o que ficou sem portador, e
        /// gritar qual foi. `onUndelivered: "keep"` existe para quem
        /// quer mesmo a sala fechada (um evento em que o admin abre).
        /// </summary>
        private void SettleLocks(ActiveDungeon dungeon)
        {
            if (dungeon.locks.Count == 0) return;

            var settings = LockConfigOf(dungeon);
            var stranded = 0;

            foreach (var entry in dungeon.locks.Values)
            {
                if (entry.delivered) continue;
                stranded++;

                if (settings.onUndelivered == "keep")
                {
                    PrintWarning("a sala " + ColorLabel(entry.color) + " ficou trancada com o código "
                                 + entry.code + " e ninguém para entregá-lo (onUndelivered=keep)");
                    continue;
                }

                foreach (var padlock in entry.locks)
                {
                    if (padlock == null || padlock.IsDestroyed) continue;

                    padlock.SetFlagLocal(BaseEntity.Flags.Locked, false);
                    padlock.SendNetworkUpdate();
                }

                PrintWarning("a sala " + ColorLabel(entry.color) + " foi DESTRANCADA: não havia onde pôr "
                             + "o código " + entry.code + " fora dela. Ponha NPC no corredor, "
                             + "troque `lock.carrier` ou ponha `lock.carrierScope` em 'anywhere'.");
            }

            Debug("fechaduras: " + dungeon.locks.Count + " sala(s), " + stranded + " sem portador");
        }

        /// <summary>Uma linha no chat de quem está lá dentro.</summary>
        private void Announce(ActiveDungeon dungeon, string message)
        {
            foreach (var id in dungeon.inside)
            {
                var player = BasePlayer.FindByID(id);
                if (player != null && player.IsConnected) player.ChatMessage(message);
            }
        }

        // ============================================================
        //  O GRAU DE CADA PEÇA
        //
        //  ####  ERA `Stone` CRAVADO EM SEIS LUGARES  ####
        //
        //  O painel prometia nível de construção e o construtor punha
        //  pedra em tudo: fundação, parede, teto, corredor e entrada.
        //  Agora o grau vem da receita, e vale POR TIPO DE PEÇA e POR
        //  COR DE SALA — a sala vermelha pode ser blindada com o
        //  corredor de madeira.
        // ============================================================

        private static BuildingGrade.Enum ParseGrade(string name, BuildingGrade.Enum fallback)
        {
            if (string.IsNullOrEmpty(name)) return fallback;

            BuildingGrade.Enum grade;
            return GradeByName.TryGetValue(name.ToLowerInvariant(), out grade) ? grade : fallback;
        }

        /// <summary>
        /// O grau daquela peça naquela célula.
        ///
        /// A célula sem dono de sala — corredor, entrada, o que a planta
        /// colou — usa o `structure` da masmorra. A célula de uma sala
        /// usa o `grade` da COR dela, e cai no `structure` quando a cor
        /// não definiu nenhum.
        /// </summary>
        private BuildingGrade.Enum GradeOf(ActiveDungeon dungeon, Layout layout, (int, int) cell, Piece piece)
        {
            var set = dungeon.spec == null ? null : dungeon.spec.structure;

            int owner;
            if (layout != null && layout.owner.TryGetValue(cell, out owner) && owner >= 0)
            {
                string color;
                if (dungeon.roomColors.TryGetValue(owner, out color))
                {
                    var room = RoomSpecOf(dungeon, color);
                    if (room != null && room.grade != null) set = room.grade;
                }
            }

            if (set == null) return DefaultGrade;

            if (piece == Piece.Foundation) return ParseGrade(set.foundation, DefaultGrade);
            if (piece == Piece.Ceiling) return ParseGrade(set.ceiling, DefaultGrade);

            return ParseGrade(set.wall, DefaultGrade);
        }

        /// <summary>
        /// O grau de uma parede, que tem DOIS donos.
        ///
        /// Vence o lado mais forte. Uma sala blindada encostada numa de
        /// madeira não pode ganhar parede de madeira: o admin escolheu
        /// blindado para aquele cômodo, e uma única parede fraca torna a
        /// escolha inteira decorativa — o invasor entra pelo lado barato.
        /// </summary>
        private BuildingGrade.Enum WallGradeOf(ActiveDungeon dungeon, Layout layout, (int, int) a, (int, int) b)
        {
            var mine = GradeOf(dungeon, layout, a, Piece.Wall);

            if (!layout.cells.Contains(b)) return mine;

            var theirs = GradeOf(dungeon, layout, b, Piece.Wall);
            return theirs > mine ? theirs : mine;
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

            PrepareBlock(dungeon, foundation, GradeOf(dungeon, null, (0, 0), Piece.Foundation));
            Adopt(dungeon, foundation);
            made++;

            // Piso liso, e não um `floor.frame`: o quadro tem um buraco
            // que a tampa do bunker não fecha (ver `PlaceExitHatch`), e
            // aqui o buraco daria para dentro da fundação enterrada —
            // quem pisasse nele cairia três metros para dentro de um
            // cubo sem saída.
            var frame = GameManager.server.CreateEntity(
                PrefabFloor, foundation.transform.position) as BuildingBlock;

            if (frame != null)
            {
                frame.SetParent(foundation);
                frame.transform.localPosition = new Vector3(0f, 3f, 0f);
                frame.transform.localRotation = R0;
                PrepareBlock(dungeon, frame, GradeOf(dungeon, null, (0, 0), Piece.Ceiling));
                Adopt(dungeon, frame);
                made++;

                var hatch = GameManager.server.CreateEntity(PrefabHatch, frame.transform.position) as Door;

                if (hatch != null)
                {
                    hatch.SetParent(frame);
                    // Cinco centímetros ACIMA do piso: a tampa apoiada
                    // nele, que é o que o jogador vê e usa. O desvio em
                    // x e o quarto de volta são o pivô na dobradiça —
                    // ver `PlaceExitHatch`.
                    hatch.transform.localPosition = new Vector3(HatchPivotOffset, 0.05f, 0f);
                    hatch.transform.localRotation = R90;
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
        /// O alçapão que sai da masmorra: a tampa colada sob o teto.
        ///
        /// ####  SEM VÃO, E ISSO NÃO É PREGUIÇA  ####
        ///
        /// Ela ficava dentro de um `floor.frame` — um quadro com buraco
        /// no meio. O buraco nunca fechava, porque o que o fecha é o
        /// encaixe de construção do Rust, e a tampa do bunker é um
        /// prefab de monumento que só abre. Resultado medido pelo dono,
        /// de dentro da masmorra: dava para ver o mundo pelo teto, a
        /// noventa metros de profundidade.
        ///
        /// E o vão nunca foi necessário: quem sai é TELEPORTADO
        /// (`OnDoorOpened`), não sobe por lugar nenhum. A tampa existe
        /// para ser vista e usada — e para isso basta ela estar colada
        /// sob um teto inteiro, ao alcance de quem olha para cima.
        /// </summary>
        private void PlaceExitHatch(ActiveDungeon dungeon, BuildingBlock ceiling)
        {
            var hatch = GameManager.server.CreateEntity(PrefabHatch, ceiling.transform.position) as Door;
            if (hatch == null) return;

            hatch.SetParent(ceiling);
            // ####  O PIVÔ DA TAMPA ESTÁ NA DOBRADIÇA  ####
            //
            // Como em toda `Door` do Rust: a origem dela é a beirada em
            // que ela gira, não o meio. Pondo o pivô no centro do teto,
            // a tampa nasce inteira para um lado — foi o que o dono viu,
            // encostada na quina do piso.
            //
            // O `ConvertToHatch` já compensava isso na entrada, com um
            // `rotation * Vector3.right`. Aqui vale o mesmo metro, no
            // eixo local do teto.
            //
            // Um palmo abaixo do teto, e não cinco centímetros: encostada
            // demais, o piso comia metade dela e a roda ficava afundada
            // na madeira. Vinte e cinco centímetros a destacam sem
            // atrapalhar quem passa por baixo.
            hatch.transform.localPosition = new Vector3(HatchPivotOffset, -0.25f, 0f);
            // O quarto de volta faz parte da compensação: com a
            // dobradiça na origem, girar muda para que lado o corpo da
            // tampa se estende. Deslocar sem girar só a empurra para a
            // outra quina — foi o que o dono viu na segunda tentativa.
            hatch.transform.localRotation = R90;
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

            // ####  A CHEGADA É O CENTRO DA CÉLULA, SEM DESVIO  ####
            //
            // MEDIDO em 09/09/2026, e o dono pagou por isso: o destino
            // era `Vector3.down * 2f - forward * 1.5f`, e uma célula tem
            // 3 metros. Um metro e meio a partir do centro é EXATAMENTE
            // a borda — a linha onde a parede fica.
            //
            // O log não deixou dúvida:
            //
            //     Mateuus was killed by Suicide at (-1271.00, -89.12, 962.50)
            //
            // com a origem da masmorra em z=964. Ele desceu o alçapão,
            // nasceu dentro da parede sul da célula de chegada e morreu
            // preso.
            //
            // Não era um erro de meio metro: a célula (0,0) é a ÚNICA
            // que pode não ter vizinha atrás — o corredor sai dela para
            // a frente —, então o desvio apontava para a parede em toda
            // masmorra desenhada.
            //
            // O centro da célula é seguro por construção: ela existe
            // sempre, é a chegada, e está vazia. Dois metros abaixo da
            // tampa é um metro acima do piso — longe da porta, que era o
            // medo original, e longe das quatro paredes.
            var down = top.gameObject.AddComponent<HatchLink>();
            down.descends = true;
            down.target = bottom.transform.position + Vector3.down * 2f;

            // Subir devolve o jogador SOBRE a tampa, e não ao lado dela:
            // ao lado é onde ficam as paredes da casinha da entrada, e é
            // o mesmo jeito de morrer preso, só que na superfície.
            var up = bottom.gameObject.AddComponent<HatchLink>();
            up.descends = false;
            up.target = top.transform.position + Vector3.up * 1.2f;

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

        /// <summary>
        /// Alguém digitou um código.
        ///
        /// ####  ESTE GANCHO RECEBE O SERVIDOR INTEIRO  ####
        ///
        /// Toda fechadura de todo jogador passa por aqui. A marca no
        /// `_name` — a mesma que o `OnEntityTakeDamage` usa — responde
        /// "é nossa?" em uma comparação de string, antes de qualquer
        /// outra coisa.
        ///
        /// Trancar é do plugin; PUNIR quem erra é do jogo: o `CodeLock`
        /// do Rust já conta os erros (`wrongCodes`) e bloqueia o teclado
        /// sozinho. Reimplementar isso aqui daria duas punições para o
        /// mesmo engano, e a nossa não apareceria na interface.
        /// </summary>
        private void OnCodeEntered(CodeLock codeLock, BasePlayer player, string code)
        {
            if (active == null || codeLock == null || player == null) return;
            if (codeLock._name != MarkIndestructible) return;

            var settings = LockConfigOf(active);

            if (code != codeLock.code)
            {
                if (settings.warnOnWrongCode)
                    player.ChatMessage("Código errado. O papel com ele está com alguém aqui dentro.");

                return;
            }

            if (!settings.announceOpen) return;

            foreach (var entry in active.locks.Values)
            {
                if (!entry.locks.Contains(codeLock)) continue;

                Announce(active, "A porta da sala " + ColorLabel(entry.color) + " foi aberta.");
                return;
            }
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

            // ####  O CIENTISTA NAO RECEBE A MARCA  ####
            //
            // Em `BasePlayer`, `_name` E o nome de exibicao: o que sai
            // no kill feed e sobre a cabeca. Marcando tudo, um inimigo
            // sem `names` na receita apareceria chamado "#ozdung#".
            //
            // Ele nao precisa da marca: quem a le e a protecao de
            // estrutura, e `OnEntityTakeDamage` ja devolve cedo para
            // qualquer `BasePlayer` — o cientista tem de poder morrer.
            if (!(entity is BasePlayer)) entity._name = MarkIndestructible;

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

            /// <summary>O nível padrão das peças: corredor, entrada e o resto.</summary>
            public GradeSpec structure;

            /// <summary>A fechadura. Ver `LockSpec` sobre o nome.</summary>
            [JsonProperty("lock")]
            public LockSpec doorLock;
        }

        private class Range { public int min; public int max; }
        private class Weights { public int green; public int blue; public int red; }

        private class CorridorSpec
        {
            /// <summary>Como o inimigo do corredor se comporta. Ver `AiSpec`.</summary>
            public AiSpec ai;
            public int npcDensity;
            public int lootDensity;
            public List<string> crates;
        }

        private class NpcSpec
        {
            /// <summary>O comportamento padrao, do qual as cores herdam.</summary>
            public AiSpec ai;
            public Range health;
            public float damageScale;
            public List<string> weapons;
            public List<string> names;
        }

        private class RoomSpec
        {
            /// <summary>O comportamento desta cor. Campo ausente herda do padrao.</summary>
            public AiSpec ai;
            public string key;
            public string color;
            public Range npc;
            public Range loot;
            public List<string> crates;
            public string door;
            public bool locked;
            /// <summary>A porta da sala grande. Vazio = usa `door` sempre.</summary>
            public string wideDoor;
            /// <summary>Células por porta a partir das quais `wideDoor` vale. 0 = o padrão.</summary>
            public int wideDoorCellsPerDoor;
            /// <summary>O nível das peças desta cor. `null` = herda de `structure`.</summary>
            public GradeSpec grade;
        }

        private class ZoneSpec { public float x; public float z; public float radius; }


        /// <summary>
        /// O nível de construção, por tipo de peça.
        ///
        /// Os nomes são os do painel (`twigs`|`wood`|`stone`|`metal`|
        /// `toptier`) e não os do enum do jogo: o contrato é escrito uma
        /// vez, em `core/src/types/dungeons.ts`, e o plugin traduz —
        /// ver `GradeByName`.
        /// </summary>
        private class GradeSpec
        {
            public string foundation;
            public string wall;
            public string ceiling;
        }

        /// <summary>
        /// Como a masmorra tranca, e como o código chega ao jogador.
        ///
        /// ####  `lock` E PALAVRA RESERVADA EM C#  ####
        ///
        /// O campo do JSON se chama `lock`, e um `public LockSpec lock;`
        /// não compila. O `[JsonProperty]` resolve num lugar só — ver o
        /// `DungeonSpec`. Renomear o campo do contrato seria mais
        /// simples e mais errado: quem lê o JSON é o painel, e lá a
        /// palavra certa é essa.
        /// </summary>
        private class LockSpec
        {
            public bool enabled = true;
            /// <summary>Um código para a masmorra inteira, em vez de um por sala.</summary>
            public bool sharedCode;
            /// <summary>`npc` | `crate` | `none`.</summary>
            public string carrier = "npc";
            /// <summary>`corridor` | `anywhere`. Nunca dentro da sala trancada.</summary>
            public string carrierScope = "corridor";
            /// <summary>`unlock` | `keep`, quando ninguém recebeu o código.</summary>
            public string onUndelivered = "unlock";
            /// <summary>O nome do papel no inventário.</summary>
            public string noteTitle;
            /// <summary>Avisar quem está dentro quando uma porta abre.</summary>
            public bool announceOpen = true;
            /// <summary>Dizer a quem errou que ele errou.</summary>
            public bool warnOnWrongCode = true;
        }

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

        // ============================================================
        //  A IA DO INIMIGO
        //
        //  ####  ELA É NOSSA, E ISSO NÃO É PREFERÊNCIA  ####
        //
        //  A masmorra fica a y = -90. O mapa de navegação do Rust é
        //  assado sobre o terreno, e ali não há terreno: NÃO EXISTE
        //  NAVMESH. O `ScientistBrain` do jogo, deixado ligado, passa
        //  o tempo pedindo ao `BaseNavigator` um caminho que não
        //  existe — e o cientista escorrega pelo chão sem sair do
        //  lugar.
        //
        //  Por isso o brain PARA de pensar (`AIThinkMode.None`, medido
        //  em `BaseAIBrain.ShouldServerThink`: o modo 2 devolve false e
        //  o `DoThink` nunca roda) e quem decide tudo é este
        //  componente: um relógio de percepção e um de movimento, como
        //  no DungeonBases 1.3.4 (linhas 904 e 956).
        //
        //  O que continua sendo do jogo, porque o jogo faz melhor:
        //
        //    · a MIRA — `HumanNPC.SetAimDirection` gira o olho E o
        //      corpo (`ServerRotation`) e passa o aim pela arma, que
        //      aplica o sway dela;
        //    · o TIRO — `ScientistNPC.ShotTest(dist)` cuida da rajada,
        //      da cadência da arma, do som, do efeito e da RECARGA.
        //      Lido na IL: sem munição ele chama `ServerReload` e
        //      devolve false; antes do `NextAttackTime` devolve false.
        //      Chamar demais não faz o NPC atirar mais rápido que a
        //      arma dele;
        //    · a POSIÇÃO na rede — `ServerPosition` marca
        //      `transform.hasChanged`, e é isso que o
        //      `BasePlayer.NetworkPositionTick` do jogo procura para
        //      mandar a nova posição aos clientes. Um
        //      `SendNetworkUpdate` por tick seria trabalho repetido.
        //
        //  ####  TODO NÚMERO VEM DE CIMA  ####
        //
        //  Nada de constante de comportamento no meio da função: o
        //  painel manda um bloco `ai` no `npc` (o padrão da masmorra),
        //  e cada cor de sala — e o corredor — pode sobrescrever
        //  campo a campo. O inimigo da sala vermelha não é o da verde.
        //
        //  As poucas constantes que sobraram são FÍSICA (altura do
        //  peito, alcance da sonda de chão): mudá-las pelo painel não
        //  produziria uma masmorra diferente, produziria um NPC
        //  quebrado.
        // ============================================================

        /// <summary>
        /// O que o painel mandou sobre o comportamento. Tudo opcional:
        /// `null` quer dizer "não falei disso", e não "zero" — é o que
        /// permite a sala vermelha mudar só a cadência e herdar o resto.
        /// </summary>
        private class AiSpec
        {
            // percepção
            public float? visionRadius;
            public bool? requireLineOfSight;
            public float? loseTargetAfter;
            public float? reactionDelay;
            public float? maxTargetHeightDelta;
            public bool? alertOnSpot;

            // movimento
            public bool? holdPosition;
            public float? moveSpeed;
            public float? chaseRadius;
            public bool? returnHome;
            public float? returnSpeed;
            public float? arriveRadius;
            public float? stuckTimeout;

            // combate
            public float? fireRange;
            public float? fireInterval;
            public float? standoffDistance;
            public float? aimConeScale;

            // ritmo
            public float? senseInterval;
            public float? moveInterval;
        }

        /// <summary>
        /// A receita já resolvida: padrão da masmorra + o que a cor
        /// daquela sala sobrescreveu, com cada número dentro da faixa.
        ///
        /// Existe separada do `AiSpec` porque o componente não pode
        /// perguntar "veio ou não veio?" a cada tick — a essa altura a
        /// pergunta já foi respondida.
        /// </summary>
        private class AiProfile
        {
            public float visionRadius = 18f;
            public bool requireLineOfSight = true;
            public float loseTargetAfter = 6f;
            public float reactionDelay = 0.4f;
            public float maxTargetHeightDelta = 3f;
            public bool alertOnSpot = true;

            public bool holdPosition;
            public float moveSpeed = 2.8f;
            public float chaseRadius = 25f;
            public bool returnHome = true;
            public float returnSpeed = 2.2f;
            public float arriveRadius = 0.6f;
            public float stuckTimeout = 6f;

            public float fireRange = 15f;
            public float fireInterval = 0.35f;
            public float standoffDistance = 2.5f;

            /// <summary>
            /// A dispersão do tiro, como multiplicador do cone da arma
            /// (medido na IL: `BaseProjectile.GetAIAimcone()` devolve
            /// `npc.aimConeScale * arma.aiAimCone`). Menor = mais
            /// certeiro.
            ///
            /// `null` de propósito: sem ordem do painel, o valor do
            /// prefab do cientista fica de pé. Chutar um número aqui
            /// seria mudar a dificuldade do servidor sem ninguém pedir.
            /// </summary>
            public float? aimConeScale;

            public float senseInterval = 0.5f;
            public float moveInterval = 0.2f;

            /// <summary>
            /// Aplica por cima o que veio do painel. Campo ausente não
            /// toca em nada — é o que faz a herança funcionar.
            /// </summary>
            public void Apply(AiSpec spec)
            {
                if (spec == null) return;

                if (spec.visionRadius.HasValue) visionRadius = Mathf.Clamp(spec.visionRadius.Value, 0f, 150f);
                if (spec.requireLineOfSight.HasValue) requireLineOfSight = spec.requireLineOfSight.Value;
                if (spec.loseTargetAfter.HasValue) loseTargetAfter = Mathf.Clamp(spec.loseTargetAfter.Value, 0f, 300f);
                if (spec.reactionDelay.HasValue) reactionDelay = Mathf.Clamp(spec.reactionDelay.Value, 0f, 30f);
                if (spec.maxTargetHeightDelta.HasValue) maxTargetHeightDelta = Mathf.Clamp(spec.maxTargetHeightDelta.Value, 0.5f, 50f);
                if (spec.alertOnSpot.HasValue) alertOnSpot = spec.alertOnSpot.Value;

                if (spec.holdPosition.HasValue) holdPosition = spec.holdPosition.Value;
                if (spec.moveSpeed.HasValue) moveSpeed = Mathf.Clamp(spec.moveSpeed.Value, 0f, 12f);
                if (spec.chaseRadius.HasValue) chaseRadius = Mathf.Clamp(spec.chaseRadius.Value, 0f, 250f);
                if (spec.returnHome.HasValue) returnHome = spec.returnHome.Value;
                if (spec.returnSpeed.HasValue) returnSpeed = Mathf.Clamp(spec.returnSpeed.Value, 0f, 12f);
                if (spec.arriveRadius.HasValue) arriveRadius = Mathf.Clamp(spec.arriveRadius.Value, 0.1f, 10f);
                if (spec.stuckTimeout.HasValue) stuckTimeout = Mathf.Clamp(spec.stuckTimeout.Value, 0f, 120f);

                if (spec.fireRange.HasValue) fireRange = Mathf.Clamp(spec.fireRange.Value, 0f, 250f);
                if (spec.fireInterval.HasValue) fireInterval = Mathf.Clamp(spec.fireInterval.Value, 0.05f, 60f);
                if (spec.standoffDistance.HasValue) standoffDistance = Mathf.Clamp(spec.standoffDistance.Value, 0f, 100f);
                if (spec.aimConeScale.HasValue) aimConeScale = Mathf.Clamp(spec.aimConeScale.Value, 0f, 20f);

                if (spec.senseInterval.HasValue) senseInterval = Mathf.Clamp(spec.senseInterval.Value, 0.1f, 10f);
                if (spec.moveInterval.HasValue) moveInterval = Mathf.Clamp(spec.moveInterval.Value, 0.05f, 2f);
            }
        }

        /// <summary>
        /// A receita daquele inimigo: o padrão da masmorra com a cor da
        /// sala por cima. `color` nulo = corredor.
        /// </summary>
        private AiProfile AiProfileFor(ActiveDungeon dungeon, string color)
        {
            var profile = new AiProfile();
            if (dungeon == null || dungeon.spec == null) return profile;

            if (dungeon.spec.npc != null) profile.Apply(dungeon.spec.npc.ai);

            if (color == null)
            {
                if (dungeon.spec.corridor != null) profile.Apply(dungeon.spec.corridor.ai);
                return profile;
            }

            var room = RoomSpecOf(dungeon, color);
            if (room != null) profile.Apply(room.ai);

            return profile;
        }

        /// <summary>
        /// Liga a IA no cientista recém-nascido.
        ///
        /// ####  A ORDEM AQUI IMPORTA  ####
        ///
        /// O brain só para de pensar DEPOIS do `Spawn()` — antes dele o
        /// `ServerInit` do cientista ainda não montou os estados, e o
        /// `SetThinkMode` cairia num objeto que o próprio jogo
        /// reinicializa em seguida.
        /// </summary>
        private void AttachAi(ScientistNPC npc, AiProfile profile)
        {
            if (npc == null || profile == null) return;

            // ####  O BRAIN CALA A BOCA  ####
            //
            // `AIThinkMode.None` faz o `ShouldServerThink` devolver
            // false (lido na IL do `BaseAIBrain`), e com isso o
            // `DoThink` nunca roda: nada de RoamState procurando ponto
            // de patrulha, nada de ChaseState pedindo caminho ao
            // navigator. Sem isto, dois donos disputam o mesmo NPC e
            // ele treme no lugar.
            var brain = npc.Brain;
            if (brain != null)
            {
                brain.SetThinkMode(AIThinkMode.None);
                if (brain.Navigator != null) brain.Navigator.Stop();
            }

            // A -90 não há NavMesh nem grafo A*: qualquer um destes
            // ligado é trabalho jogado fora a cada tick.
            var navigator = npc.GetComponent<BaseNavigator>();
            if (navigator != null)
            {
                navigator.CanUseNavMesh = false;
                navigator.CanUseAStar = false;
                navigator.CanUseBaseNav = false;
                navigator.CanUseCustomNav = false;
            }

            if (profile.aimConeScale.HasValue) npc.aimConeScale = profile.aimConeScale.Value;

            // Sem isto o cientista fica com a arma na cintura: o
            // `ShotTest` procura o item ATIVO, e um NPC de mãos vazias
            // persegue em silêncio.
            npc.EquipWeapon();

            npc.gameObject.AddComponent<DungeonNpcAi>().Setup(npc, profile);
        }

        /// <summary>
        /// O inimigo: percebe, persegue, atira e volta para o posto.
        ///
        /// Vive como componente do próprio NPC porque é assim que ele
        /// morre junto: `Kill()` destrói o `GameObject`, o `OnDestroy`
        /// cancela os dois relógios e não sobra nada rodando. A base
        /// 1.3.4 usa `timer.Every` do Oxide e o de movimento (linha
        /// 956) NUNCA é destruído — ele continua acordando de 0,2 em
        /// 0,2 segundo para cada cientista já morto, até o plugin
        /// descarregar.
        /// </summary>
        private class DungeonNpcAi : FacepunchBehaviour
        {
            // ####  AS CONSTANTES QUE NÃO SÃO DE PAINEL  ####
            //
            // Física do boneco e das sondas. Um admin que mexesse
            // nelas não teria uma masmorra mais difícil, teria um
            // cientista atravessando parede ou enterrado no chão.

            /// <summary>De onde sai a sonda que procura parede.</summary>
            private const float ChestHeight = 1.1f;

            /// <summary>A largura do boneco, para ele não raspar na quina.</summary>
            private const float BodyRadius = 0.5f;

            /// <summary>Quanto a sonda de chão começa acima e termina abaixo.</summary>
            private const float GroundProbeUp = 1f;
            private const float GroundProbeDown = 2f;

            /// <summary>Para que lado ele tenta contornar o que barrou o passo.</summary>
            private const float SideStepAngle = 45f;

            /// <summary>Distância entre duas migalhas da trilha.</summary>
            private const float TrailSpacing = 1.5f;

            /// <summary>
            /// Teto da trilha. Com 1,5 m entre migalhas isso é uma
            /// perseguição de 90 metros — mais que qualquer
            /// `chaseRadius` sensato. Cheia, ela para de crescer: jogar
            /// fora a migalha mais antiga apagaria justamente o caminho
            /// de volta.
            /// </summary>
            private const int MaxTrail = 64;

            /// <summary>
            /// Quanto ele precisa se mexer para não ser considerado
            /// preso.
            /// </summary>
            private const float StuckDistance = 0.75f;

            /// <summary>
            /// O que barra o passo: construção, mundo, deployáveis e o
            /// que estiver no Default. Jogadores e outros cientistas
            /// ficam DE FORA de propósito — se entrassem, um NPC
            /// atravessando a porta travaria a fila inteira atrás dele.
            ///
            /// Os números são os do `Rust.Layer`, medidos no
            /// Assembly-CSharp de 09/09/2026: Default 0, Deployed 8,
            /// World 16, Construction 21.
            /// </summary>
            private const int ObstacleMask = (1 << 0) | (1 << 8) | (1 << 16) | (1 << 21);

            /// <summary>
            /// O que serve de chão. Sem Deployed: senão ele sobe na
            /// caixa de loot e fica lá em cima.
            /// </summary>
            private const int GroundMask = (1 << 0) | (1 << 16) | (1 << 21) | (1 << 23);

            /// <summary>
            /// O que corta a linha de visada. É o de cima mais
            /// Player_Server (17): um colega na frente segura o tiro, e
            /// é isso que evita o NPC matar o NPC pelas costas.
            /// </summary>
            private const int SightMask = ObstacleMask | (1 << 17);

            // ####  A LISTA DE CANDIDATOS É UMA SÓ  ####
            //
            // Varrer `activePlayerList` uma vez POR NPC e POR TICK é
            // trabalho multiplicado por nada: são 30 cientistas
            // olhando a mesma lista de 100 jogadores. Aqui a varredura
            // acontece uma vez por `CandidateRefresh`, e o que sobra
            // para cada NPC é uma lista do tamanho de "quem está lá
            // embaixo" — quase sempre zero ou um.
            //
            // Estático porque a masmorra é UMA por servidor (ver
            // `active`). No dia em que forem duas, isto vira um campo
            // do `ActiveDungeon`.
            private static readonly List<BasePlayer> Candidates = new List<BasePlayer>();
            private static float candidatesAt = float.MinValue;
            private static float candidatesCeiling = float.MaxValue;
            private const float CandidateRefresh = 0.4f;

            private ScientistNPC npc;
            private AiProfile profile;

            private Vector3 home;
            private Vector3 homeAim;

            private BasePlayer target;
            private bool targetVisible;
            private Vector3 lastKnownPosition;
            private float lastSeenAt;
            private float spottedAt;

            /// <summary>Onde o alvo pisou. É por aqui que ele contorna a parede.</summary>
            private readonly List<Vector3> targetTrail = new List<Vector3>();

            /// <summary>Onde ELE pisou. É por aqui que ele volta.</summary>
            private readonly List<Vector3> homeTrail = new List<Vector3>();

            private bool goingHome;
            private float lastMoveAt;
            private float nextShotAt;
            private Vector3 stuckAnchor;
            private float stuckSince;

            public void Setup(ScientistNPC owner, AiProfile settings)
            {
                npc = owner;
                profile = settings;

                home = owner.ServerPosition;
                homeAim = owner.eyes != null ? owner.eyes.BodyForward() : owner.transform.forward;
                if (homeAim.sqrMagnitude < 0.001f) homeAim = Vector3.forward;
                homeAim.y = 0f;
                if (homeAim.sqrMagnitude < 0.001f) homeAim = Vector3.forward;

                lastMoveAt = Time.time;
                stuckAnchor = home;
                stuckSince = Time.time;

                // Quem está na masmorra está abaixo disto. É o filtro
                // que mantém a lista de candidatos curta sem varrer
                // distância para cada um dos 100 jogadores do servidor.
                candidatesCeiling = home.y + 30f;

                // ####  O PRIMEIRO TICK É SORTEADO  ####
                //
                // Trinta cientistas nascidos no mesmo frame pensariam
                // todos no mesmo frame para sempre. Espalhar o começo
                // custa uma linha e tira o pico do servidor.
                InvokeRepeating(Sense, UnityEngine.Random.Range(0f, profile.senseInterval), profile.senseInterval);
                InvokeRepeating(Move, UnityEngine.Random.Range(0f, profile.moveInterval), profile.moveInterval);
            }

            private void OnDestroy()
            {
                CancelInvoke(Sense);
                CancelInvoke(Move);
            }

            /// <summary>
            /// Levou um tiro: passa a saber de quem, mesmo sem ter
            /// visto. É o que a base 1.3.4 faz na linha 2144, e sem
            /// isso um jogador mata a sala inteira pelas costas sem
            /// ninguém virar.
            /// </summary>
            public void OnHurtBy(BasePlayer attacker)
            {
                if (attacker == null || npc == null || profile == null) return;
                if (attacker.IsNpc) return;

                if (target != attacker)
                {
                    target = attacker;
                    spottedAt = Time.time;
                    targetTrail.Clear();
                }

                targetVisible = false;
                lastSeenAt = Time.time;
                lastKnownPosition = attacker.transform.position;
                goingHome = false;
            }

            // ------------------------------------------------------------
            //  PERCEPÇÃO
            // ------------------------------------------------------------

            private void Sense()
            {
                if (npc == null || npc.IsDestroyed || !npc.IsAlive())
                {
                    CancelInvoke(Sense);
                    CancelInvoke(Move);
                    return;
                }

                var eye = npc.eyes == null ? npc.ServerPosition : npc.eyes.position;

                // O alvo de agora ainda serve?
                if (target != null && !Eligible(target)) Forget();

                var best = target;
                var bestScore = float.MaxValue;
                var bestVisible = false;

                RefreshCandidates();

                for (var i = 0; i < Candidates.Count; i++)
                {
                    var candidate = Candidates[i];
                    if (!Eligible(candidate)) continue;

                    var position = candidate.transform.position;
                    var distance = Vector3.Distance(eye, position);
                    if (distance > profile.visionRadius) continue;

                    // ####  O ANDAR DE CIMA NÃO CONTA  ####
                    //
                    // Sem isto o cientista do lobby persegue quem está
                    // no alçapão da superfície, 90 metros acima, e fica
                    // girando embaixo dele. A base usa 2,5 m (linha
                    // 967); aqui o número é do painel.
                    if (Mathf.Abs(position.y - npc.ServerPosition.y) > profile.maxTargetHeightDelta) continue;

                    var visible = !profile.requireLineOfSight || HasSight(candidate, eye, distance);
                    if (!visible) continue;

                    // O mais perto ganha; empate não existe na prática.
                    if (distance >= bestScore) continue;

                    bestScore = distance;
                    best = candidate;
                    bestVisible = true;
                }

                if (bestVisible)
                {
                    if (target != best)
                    {
                        target = best;
                        spottedAt = Time.time;
                        targetTrail.Clear();

                        // O grito do cientista é a única pista sonora
                        // que o jogador tem de que foi visto.
                        if (profile.alertOnSpot) npc.Alert();
                    }

                    targetVisible = true;
                    lastSeenAt = Time.time;
                    lastKnownPosition = best.transform.position;
                    goingHome = false;

                    Breadcrumb(targetTrail, lastKnownPosition);
                    return;
                }

                targetVisible = false;

                // Perdeu de vista: ele ainda vai até onde viu por
                // último, e só depois desiste.
                if (target != null && Time.time - lastSeenAt > profile.loseTargetAfter) Forget();
            }

            /// <summary>
            /// A lista de quem pode ser alvo, refeita no máximo a cada
            /// `CandidateRefresh` para o servidor inteiro.
            /// </summary>
            private static void RefreshCandidates()
            {
                if (Time.time - candidatesAt < CandidateRefresh) return;
                candidatesAt = Time.time;

                Candidates.Clear();

                var everyone = BasePlayer.activePlayerList;
                for (var i = 0; i < everyone.Count; i++)
                {
                    var player = everyone[i];
                    if (player == null || player.IsNpc) continue;
                    if (!player.IsAlive() || player.IsSleeping()) continue;
                    if (player.IsSpectating()) continue;
                    if (player.transform.position.y > candidatesCeiling) continue;

                    Candidates.Add(player);
                }
            }

            private bool Eligible(BasePlayer player)
            {
                return player != null
                       && !player.IsDestroyed
                       && player.IsAlive()
                       && !player.IsSleeping()
                       && !player.IsSpectating();
            }

            private void Forget()
            {
                target = null;
                targetVisible = false;
                targetTrail.Clear();

                goingHome = profile.returnHome;

                // Quem não volta larga a trilha: guardada, ela levaria
                // a próxima perseguição de volta por um caminho que
                // começa onde ele não está mais.
                if (!goingHome) homeTrail.Clear();
            }

            /// <summary>
            /// Enxerga daqui até lá?
            ///
            /// ####  O PRIMEIRO QUE O RAIO ENCONTRA DECIDE  ####
            ///
            /// Se for o próprio alvo, há visada; qualquer outra coisa é
            /// parede, porta ou colega. É o teste da base (linha 926),
            /// com duas correções: o raio sai do OLHO — e não dos pés,
            /// onde a fundação da própria célula o interrompia — e a
            /// máscara é positiva, para caber num comentário.
            ///
            /// O raio que começa dentro do próprio colisor não o
            /// devolve (é como o PhysX trata volume convexo), então o
            /// cientista não enxerga a si mesmo como obstáculo.
            /// </summary>
            private bool HasSight(BasePlayer candidate, Vector3 eye, float distance)
            {
                var targetEye = candidate.eyes == null
                    ? candidate.transform.position + Vector3.up * 1.5f
                    : candidate.eyes.position;

                var direction = targetEye - eye;
                if (direction.sqrMagnitude < 0.0001f) return true;

                RaycastHit hit;
                if (!Physics.Raycast(eye, direction.normalized, out hit, distance + 0.5f, SightMask)) return true;

                var blocker = hit.GetEntity();
                return blocker == candidate || blocker == npc;
            }

            // ------------------------------------------------------------
            //  MOVIMENTO E COMBATE
            // ------------------------------------------------------------

            private void Move()
            {
                if (npc == null || npc.IsDestroyed || !npc.IsAlive())
                {
                    CancelInvoke(Sense);
                    CancelInvoke(Move);
                    return;
                }

                var now = Time.time;
                var delta = Mathf.Min(now - lastMoveAt, 1f);
                lastMoveAt = now;

                var position = npc.ServerPosition;

                if (target != null)
                {
                    // ####  ELE SÓ ENCARA O QUE ESTÁ VENDO  ####
                    //
                    // `SetAimDirection` gira o CORPO junto com o olho
                    // (medido na IL: ela termina em `ServerRotation`).
                    // Mirar no alvo sem visada faria o cientista girar
                    // para acompanhar o jogador ATRAVÉS da parede — e
                    // não há defeito que pareça mais trapaça que esse.
                    // Sem visada ele encara para onde anda.
                    if (targetVisible) AimAt(target.eyes == null
                        ? target.transform.position + Vector3.up * 1.5f
                        : target.eyes.position);

                    Shoot(position);

                    if (!profile.holdPosition)
                    {
                        Chase(position, delta);
                        CheckStuck(position, now);
                    }

                    return;
                }

                // Sem alvo: ou volta para o posto, ou fica olhando para
                // onde nasceu — o que evita o cientista de costas para
                // a porta que ele deveria guardar.
                if (goingHome && !profile.holdPosition)
                {
                    GoHome(position, delta);
                    CheckStuck(position, now);
                    return;
                }

                npc.SetAimDirection(homeAim);
                stuckSince = now;
            }

            private void AimAt(Vector3 point)
            {
                var eye = npc.eyes == null ? npc.ServerPosition : npc.eyes.position;
                var to = point - eye;

                // `SetAimDirection` ignora o vetor zero — e o corpo
                // ficaria travado na direção anterior.
                if (to.sqrMagnitude < 0.0001f) return;

                npc.SetAimDirection(to.normalized);
            }

            /// <summary>
            /// Puxa o gatilho, se for a hora.
            ///
            /// Quem cuida da rajada, do intervalo entre tiros e da
            /// recarga é o `ShotTest` do jogo. O que está aqui é o que
            /// ele NÃO decide: se enxerga, se está no alcance que o
            /// painel deu, e quanto tempo depois de avistar ele começa.
            /// </summary>
            private void Shoot(Vector3 position)
            {
                if (!targetVisible && profile.requireLineOfSight) return;
                if (Time.time < nextShotAt) return;
                if (Time.time - spottedAt < profile.reactionDelay) return;

                var distance = Vector3.Distance(position, target.transform.position);
                if (distance > profile.fireRange) return;

                npc.ShotTest(distance);
                nextShotAt = Time.time + profile.fireInterval;
            }

            private void Chase(Vector3 position, float delta)
            {
                var distance = Vector3.Distance(position, target.transform.position);

                // Chegou perto o bastante: daqui ele atira, não abraça.
                if (targetVisible && distance <= profile.standoffDistance)
                {
                    stuckSince = Time.time;
                    return;
                }

                Breadcrumb(homeTrail, position);

                Vector3 destination;

                if (targetVisible)
                {
                    // Com o alvo à vista, a trilha dele não serve para
                    // nada: o caminho é a linha reta.
                    destination = target.transform.position;
                    targetTrail.Clear();
                }
                else
                {
                    // Sem visada, ele pisa onde o jogador pisou — e é
                    // assim que ele dobra o corredor sem NavMesh. As
                    // migalhas que já ficaram para trás são jogadas
                    // fora antes, senão ele anda de volta para pegá-las.
                    while (targetTrail.Count > 0 && Flat(position, targetTrail[0]) < profile.arriveRadius)
                        targetTrail.RemoveAt(0);

                    destination = targetTrail.Count > 0 ? targetTrail[0] : lastKnownPosition;

                    // Sem ver, ele encara o caminho — nunca o jogador.
                    AimAt(new Vector3(destination.x, destination.y + 1.5f, destination.z));
                }

                Step(position, destination, profile.moveSpeed, delta);
            }

            private void GoHome(Vector3 position, float delta)
            {
                // A trilha de volta é consumida do fim para o começo: o
                // último lugar em que ele esteve é o mais perto dele
                // agora.
                while (homeTrail.Count > 0 && Flat(position, homeTrail[homeTrail.Count - 1]) < profile.arriveRadius)
                    homeTrail.RemoveAt(homeTrail.Count - 1);

                var destination = homeTrail.Count > 0 ? homeTrail[homeTrail.Count - 1] : home;

                if (homeTrail.Count == 0 && Flat(position, home) < profile.arriveRadius)
                {
                    // Chegou. Daqui ele volta a olhar para onde nasceu
                    // — parado de costas para a porta que guarda seria
                    // pior que não voltar.
                    goingHome = false;
                    npc.SetAimDirection(homeAim);
                    return;
                }

                AimAt(new Vector3(destination.x, destination.y + 1.5f, destination.z));
                Step(position, destination, profile.returnSpeed, delta);
            }

            /// <summary>
            /// Um passo na direção do destino, se houver por onde.
            ///
            /// ####  NUNCA ATRAVESSA A PAREDE, NUNCA SAI DA MASMORRA  ####
            ///
            /// Duas travas, e as duas são de segurança, não de
            /// desempenho: a sonda à frente impede o passo dentro da
            /// parede — a IA move o boneco por código, e código não tem
            /// colisão — e a coleira do posto impede que a perseguição
            /// leve o cientista para fora do que foi construído.
            /// </summary>
            private void Step(Vector3 position, Vector3 destination, float speed, float delta)
            {
                if (speed <= 0f) return;

                var flat = new Vector3(destination.x - position.x, 0f, destination.z - position.z);
                var distance = flat.magnitude;
                if (distance < 0.01f) return;

                var direction = flat / distance;
                var step = Mathf.Min(speed * delta, distance);

                if (!Free(position, direction, step))
                {
                    var left = Quaternion.Euler(0f, SideStepAngle, 0f) * direction;
                    var right = Quaternion.Euler(0f, -SideStepAngle, 0f) * direction;

                    if (Free(position, left, step)) direction = left;
                    else if (Free(position, right, step)) direction = right;
                    else return;
                }

                var next = position + direction * step;

                // A coleira. Ela vale para os dois modos: perseguindo
                // ele não passa do raio, voltando ele já está dentro.
                if (!goingHome && Flat(next, home) > profile.chaseRadius) return;

                next.y = GroundAt(next, position.y);
                npc.ServerPosition = next;
            }

            private static bool Free(Vector3 position, Vector3 direction, float step)
            {
                return !Physics.Raycast(
                    position + Vector3.up * ChestHeight, direction, step + BodyRadius, ObstacleMask);
            }

            /// <summary>
            /// A altura do piso naquele ponto.
            ///
            /// Sem isto o cientista mantém a altura em que nasceu e vai
            /// afundando ou flutuando pela masmorra — a IA move o
            /// boneco por código, e código não tem gravidade. Sem
            /// acertar nada, ele fica na altura que estava: é melhor
            /// que cair para sempre.
            /// </summary>
            private static float GroundAt(Vector3 point, float fallback)
            {
                RaycastHit hit;
                if (Physics.Raycast(point + Vector3.up * GroundProbeUp, Vector3.down, out hit,
                        GroundProbeUp + GroundProbeDown, GroundMask))
                    return hit.point.y;

                return fallback;
            }

            /// <summary>
            /// Preso? Volta para o posto.
            ///
            /// Uma quina em que a sonda barra os três lados travaria o
            /// cientista para sempre — e o jogador encontraria um
            /// inimigo dançando contra a parede. O teleporte é feio, e
            /// é melhor que isso.
            /// </summary>
            private void CheckStuck(Vector3 position, float now)
            {
                if (profile.stuckTimeout <= 0f) return;

                if (Vector3.Distance(position, stuckAnchor) > StuckDistance)
                {
                    stuckAnchor = position;
                    stuckSince = now;
                    return;
                }

                if (now - stuckSince < profile.stuckTimeout) return;

                npc.ServerPosition = home;
                stuckAnchor = home;
                stuckSince = now;
                homeTrail.Clear();
                targetTrail.Clear();
                goingHome = false;
            }

            private static void Breadcrumb(List<Vector3> trail, Vector3 point)
            {
                if (trail.Count >= MaxTrail) return;
                if (trail.Count > 0 && Vector3.Distance(trail[trail.Count - 1], point) < TrailSpacing) return;

                trail.Add(point);
            }

            /// <summary>Distância no plano. A altura aqui só atrapalha.</summary>
            private static float Flat(Vector3 a, Vector3 b)
            {
                var dx = a.x - b.x;
                var dz = a.z - b.z;
                return Mathf.Sqrt(dx * dx + dz * dz);
            }
        }

        /// <summary>
        /// O tiro que acerta o cientista.
        ///
        /// ####  DUAS COISAS, E AS DUAS FORAM MEDIDAS NA BASE  ####
        ///
        /// A primeira: cientista não mata cientista. Uma rajada que
        /// atravessa o colega faria a sala se dizimar sozinha enquanto
        /// o jogador assiste — e o `damageScale` que o painel deu para
        /// o jogador vale contra ele também.
        ///
        /// A segunda: levar tiro é uma forma de perceber. Sem isto, um
        /// jogador de mira boa limpa a masmorra pelas costas sem
        /// ninguém virar (base 1.3.4, linha 2121).
        /// </summary>
        private object OnEntityTakeDamage(ScientistNPC npc, HitInfo info)
        {
            if (npc == null || info == null) return null;

            var ai = npc.GetComponent<DungeonNpcAi>();
            if (ai == null) return null;

            var initiator = info.Initiator;

            if (initiator is ScientistNPC && initiator.GetComponent<DungeonNpcAi>() != null)
            {
                info.damageTypes.ScaleAll(0f);
                return null;
            }

            ai.OnHurtBy(info.InitiatorPlayer);
            return null;
        }

        private class SyncPayload
        {
            public string secret;
            public List<DungeonSpec> dungeons;
            public List<ZoneSpec> zones;
        }
    }
}
