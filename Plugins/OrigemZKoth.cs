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

        /// A fumaça do fim. Conferida no manifesto: é o smoke que a
        /// granada deixa no chão, e ele apaga sozinho.
        private const string PrefabSmoke = "assets/prefabs/tools/smoke grenade/grenade.smoke.deployed.prefab";

        /// O flare do fim: o morteiro de fogos VERMELHO, que sobe e
        /// estoura. Conferido no manifesto em 15/09/2026.
        private const string PrefabFlare = "assets/prefabs/deployable/fireworks/mortarred.prefab";

        /// A caixa padrão, quando o admin não escolheu nenhuma.
        private const string PrefabDefaultCrate = "assets/bundled/prefabs/radtown/crate_normal.prefab";

        /// O lado de uma célula da grade do mapa, em metros. Constante
        /// do Rust: vale para qualquer tamanho de mundo.
        private const float GridCellMeters = 146.3f;

        private const string Marker = "#OZKOTH#";
        private const string UiRoot = "origemz.koth.hud";

        private string secret = "";

        /// ####  VÁRIOS AO MESMO TEMPO  ####
        ///
        /// A chave é o `runId` que o agente manda. O limite de quantos
        /// cabem NÃO é daqui: quem conta as vagas é o agente, que sabe
        /// quantas o admin configurou. O plugin recusa só o repetido.
        private readonly Dictionary<string, Run> runs = new Dictionary<string, Run>();

        /// O relógio é UM, e não um por evento: dois eventos não
        /// precisam de dois timers, e um só mantém a ordem estável
        /// entre eles.
        private Timer ticker;

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
            public float decayPerSecond;
            /// Só participa quem está em equipe.
            public bool requireTeam = true;

            /// ####  O QUE NASCE NO FIM  ####
            ///
            /// `crates` é a lista de prefabs com peso; `crateCount`,
            /// quantas nascem. Vazio = a caixa padrão.
            public readonly List<KeyValuePair<string, float>> crates =
                new List<KeyValuePair<string, float>>();
            public int crateCount = 1;
            public bool smoke = true;
            public bool flare = true;

            /// Quantos segundos a caixa fica no mapa. Zero = para
            /// sempre, e é escolha do admin — não o padrão.
            public float crateLifeSeconds = 600f;

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
            SweepLeftovers();

            Puts(Marker + "{\"kind\":\"ready\"}");
        }

        // ============================================================
        //  §1.5  O QUE SOBRA DE UM PLUGIN QUE MORREU NO MEIO
        //
        //  ####  O `Unload` NÃO É GARANTIA  ####
        //
        //  Ele roda no reload e no desligamento limpo. Não roda quando
        //  o plugin quebra, nem quando o servidor morre de uma vez — e
        //  a bandeira e o círculo continuam no mapa, sem ninguém que os
        //  conheça. Foi o que aconteceu no server01 em 15/09/2026.
        //
        //  A spec do KOTH já mandava: "registrar cada entidade criada;
        //  a limpeza atua nos IDs da instância, jamais em todos os
        //  objetos semelhantes do servidor". É exatamente a diferença
        //  entre varrer o que é NOSSO e apagar o marcador das lojas do
        //  mapa inteiro — que é o estrago que a varredura por heurística
        //  causou quando foi tentada.
        // ============================================================

        /// O arquivo com os netIDs do que está de pé AGORA.
        private const string LeftoverFile = "OrigemZKoth/entidades";

        /// <summary>
        /// O que ficou para trás, em duas listas.
        ///
        /// ####  A BANDEIRA E A CAIXA TÊM VIDAS DIFERENTES  ####
        ///
        /// `ids` é o do evento DE PÉ — bandeira e marcadores. Some
        /// quando ele acaba.
        ///
        /// `crates` é o prêmio, e ele PRECISA sobreviver ao fim do
        /// evento: a caixa fica no mapa para alguém buscar. Quem a
        /// apaga é o tempo dela, o saque (o `destroyOnEmpty` do jogo
        /// mata a caixa vazia sozinho) — ou o próximo KOTH, que varre
        /// o que o anterior deixou.
        /// </summary>
        private class Leftovers
        {
            public List<ulong> ids = new List<ulong>();
            public List<ulong> crates = new List<ulong>();
        }

        /// <summary>
        /// Anota os ids de tudo que está de pé AGORA.
        ///
        /// Chamado quando um evento nasce e quando um acaba: a lista é
        /// sempre o retrato do momento, e não um diário. Assim o
        /// plugin que cair no meio encontra, ao voltar, exatamente as
        /// entidades que ficaram sem dono.
        /// </summary>
        private void Remember()
        {
            try
            {
                var data = Read();

                data.ids.Clear();

                foreach (var entry in runs.Values)
                {
                    if (entry.banner != null && entry.banner.net != null) data.ids.Add(entry.banner.net.ID.Value);
                    if (entry.mapMarker != null && entry.mapMarker.net != null) data.ids.Add(entry.mapMarker.net.ID.Value);
                    if (entry.mapLabel != null && entry.mapLabel.net != null) data.ids.Add(entry.mapLabel.net.ID.Value);
                }

                Interface.Oxide.DataFileSystem.WriteObject(LeftoverFile, data);
            }
            catch (Exception e)
            {
                PrintWarning("não consegui anotar as entidades do KOTH: " + e.Message);
            }
        }

        private Leftovers Read()
        {
            var data = Interface.Oxide.DataFileSystem.ReadObject<Leftovers>(LeftoverFile);

            if (data == null) data = new Leftovers();
            if (data.ids == null) data.ids = new List<ulong>();
            if (data.crates == null) data.crates = new List<ulong>();

            return data;
        }

        /// <summary>Esvazia a lista do que estava de pé. Só o boot usa.</summary>
        private void Forget()
        {
            try
            {
                var data = Read();

                data.ids.Clear();

                Interface.Oxide.DataFileSystem.WriteObject(LeftoverFile, data);
            }
            catch (Exception e)
            {
                PrintWarning("não consegui limpar a lista de entidades do KOTH: " + e.Message);
            }
        }

        /// <summary>
        /// Anota uma caixa do prêmio.
        ///
        /// Ela sobrevive ao evento de propósito — e é por isso que
        /// precisa ser anotada: o que a apaga, se ninguém a abrir, é o
        /// relógio dela ou o PRÓXIMO KOTH.
        /// </summary>
        private void RememberCrate(BaseEntity crate)
        {
            try
            {
                if (crate == null || crate.net == null) return;

                var data = Read();

                data.crates.Add(crate.net.ID.Value);

                Interface.Oxide.DataFileSystem.WriteObject(LeftoverFile, data);
            }
            catch (Exception e)
            {
                PrintWarning("não consegui anotar a caixa do KOTH: " + e.Message);
            }
        }

        /// <summary>
        /// Limpa o que o KOTH anterior deixou no mapa.
        ///
        /// Pedido do dono (15/09/2026), depois de ver quatro caixas
        /// empilhadas no mesmo lugar: "ou quando vai iniciar um novo,
        /// limpar o anterior".
        ///
        /// A caixa VAZIA já some sozinha — `destroyOnEmpty` é padrão do
        /// `LootContainer` do jogo. Esta varredura é para a que ninguém
        /// abriu.
        /// </summary>
        private void SweepOldCrates()
        {
            try
            {
                var data = Read();

                if (data.crates.Count == 0) return;

                var mortas = 0;

                foreach (var id in data.crates)
                {
                    var found = BaseNetworkable.serverEntities.Find(new NetworkableId(id)) as BaseEntity;

                    if (found == null || found.IsDestroyed) continue;

                    Kill(found);
                    mortas++;
                }

                data.crates.Clear();
                Interface.Oxide.DataFileSystem.WriteObject(LeftoverFile, data);

                if (mortas > 0) Puts("limpei " + mortas + " caixa(s) do KOTH anterior.");
            }
            catch (Exception e)
            {
                PrintWarning("não consegui limpar as caixas do KOTH anterior: " + e.Message);
            }
        }

        /// <summary>
        /// Mata o que sobrou de uma vida anterior — e SÓ isso.
        ///
        /// Pelos ids anotados, um por um. Nunca "todo marcador do
        /// servidor": os marcadores das lojas do mapa são iguais aos
        /// nossos aos olhos de um filtro.
        /// </summary>
        private void SweepLeftovers()
        {
            try
            {
                var data = Interface.Oxide.DataFileSystem.ReadObject<Leftovers>(LeftoverFile);

                if (data == null || data.ids == null || data.ids.Count == 0) return;

                var mortos = 0;

                foreach (var id in data.ids)
                {
                    var found = BaseNetworkable.serverEntities.Find(new NetworkableId(id)) as BaseEntity;

                    if (found == null || found.IsDestroyed) continue;

                    Kill(found);
                    mortos++;
                }

                if (mortos > 0) Puts("varri " + mortos + " entidade(s) de um KOTH que não foi encerrado direito.");

                Forget();
            }
            catch (Exception e)
            {
                PrintWarning("não consegui varrer o que sobrou do KOTH: " + e.Message);
            }
        }

        private void Unload()
        {
            // Descarregar com evento de pé deixaria a bandeira no mapa
            // e a barra na tela de quem estava dentro — sem ninguém
            // para tirá-las.
            foreach (var key in runs.Keys.ToArray()) Teardown(key, "unload");

            if (ticker != null) ticker.Destroy();
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
                        player.Reply(DoStop(Arg(args, 1)));
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

        private static string Arg(string[] args, int index)
        {
            return args.Length > index ? args[index] : "";
        }

        private string DoSync(string json)
        {
            if (string.IsNullOrEmpty(json)) return Fail("empty", "Sync sem corpo.");

            var body = JObject.Parse(json);

            secret = body["secret"] == null ? "" : body["secret"].ToString();

            var payload = new JObject { ["ok"] = true, ["active"] = runs.Count > 0 };

            return payload.ToString(Formatting.None);
        }

        /// <summary>Ergue o território. O agente já escolheu onde.</summary>
        private string DoStart(string json)
        {
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
                decayPerSecond = Mathf.Clamp(Number(body, "decayPerSecond", 0f), 0f, 60f),
                requireTeam = body["requireTeam"] == null || body["requireTeam"].ToObject<bool>(),
            };

            if (string.IsNullOrEmpty(next.runId)) return Fail("no_run_id", "Start sem runId.");

            // ####  O MESMO EVENTO DUAS VEZES  ####
            //
            // Acontece quando o agente reenvia por timeout: o comando
            // saiu, a resposta se perdeu, e ele tenta de novo. Erguer
            // um segundo território no mesmo lugar seria pior que
            // recusar — e o agente trata este `no` como "já está lá".
            if (runs.ContainsKey(next.runId))
            {
                return Fail("already_active", "Esse KOTH já está de pé.");
            }

            ReadReward(next, body);

            // O KOTH novo limpa o que os ANTERIORES deixaram. Com
            // vários ao mesmo tempo isso continua valendo: as caixas
            // anotadas são as de eventos que já acabaram — as dos que
            // estão de pé ainda não foram anotadas como sobra.
            SweepOldCrates();

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
            runs[next.runId] = next;
            Remember();

            // O relógio sobe com o primeiro e cai com o último.
            if (ticker == null) ticker = timer.Every(1f, Tick);

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

        /// <summary>
        /// Derruba um território, ou todos.
        ///
        /// Sem argumento = todos. É o que o agente manda quando quer
        /// limpar o servidor, e o que o admin espera de um "parar" sem
        /// dizer qual.
        /// </summary>
        private string DoStop(string runId)
        {
            if (runs.Count == 0) return Fail("not_active", "Não há KOTH de pé.");

            if (string.IsNullOrEmpty(runId))
            {
                var todos = runs.Keys.ToArray();

                foreach (var key in todos) Teardown(key, "command");

                var geral = new JObject { ["ok"] = true, ["stopped"] = todos.Length };

                return geral.ToString(Formatting.None);
            }

            if (!runs.ContainsKey(runId)) return Fail("not_active", "Esse KOTH não está de pé.");

            Teardown(runId, "command");

            var payload = new JObject { ["ok"] = true, ["stopped"] = 1 };

            return payload.ToString(Formatting.None);
        }

        /// <summary>
        /// O estado de tudo que está de pé.
        ///
        /// ####  UMA LISTA, MESMO COM UM SÓ  ####
        ///
        /// `active` continua existindo para quem só quer saber se há
        /// algo acontecendo — mas o que importa agora é `events`. Uma
        /// resposta que mudasse de forma conforme a quantidade
        /// obrigaria quem lê a tratar os dois casos.
        /// </summary>
        private string DoStatus()
        {
            var lista = new JArray();

            foreach (var entry in runs.Values.ToArray())
            {
                var inside = Inside(entry);
                var sides = Sides(inside);

                lista.Add(new JObject
                {
                    ["runId"] = entry.runId,
                    ["name"] = entry.name,
                    ["grid"] = Grid(entry.center),
                    ["x"] = entry.center.x,
                    ["z"] = entry.center.z,
                    ["radius"] = entry.radius,
                    ["progress"] = Mathf.RoundToInt(entry.progress),
                    ["captureSeconds"] = entry.captureSeconds,
                    ["percent"] = Mathf.RoundToInt(Percent(entry)),
                    ["holder"] = entry.holder.ToString(CultureInfo.InvariantCulture),
                    ["holderName"] = entry.holderName,
                    ["contested"] = sides.Count > 1,
                    ["elapsed"] = Mathf.RoundToInt(Elapsed(entry)),
                    ["durationSeconds"] = entry.durationSeconds,
                    ["inside"] = inside.Count,
                });
            }

            var payload = new JObject
            {
                ["ok"] = true,
                ["active"] = runs.Count > 0,
                ["count"] = runs.Count,
                ["events"] = lista,
            };

            return payload.ToString(Formatting.None);
        }

        // ============================================================
        //  §3  O CORAÇÃO: UM TICK POR SEGUNDO
        // ============================================================

        /// <summary>
        /// Uma volta, para todos os territórios de pé.
        ///
        /// ####  A TELA É DECIDIDA NO FIM, E DE UMA VEZ  ####
        ///
        /// Cada evento faz a sua conta; a BARRA, não. Com dois
        /// territórios sobrepostos, dois `Draw` desenhariam um por
        /// cima do outro na tela do mesmo jogador — e ele veria a
        /// porcentagem piscando entre dois eventos.
        ///
        /// Então o tick junta quem está onde, e no fim desenha uma vez
        /// por jogador: a zona em que ele está, e se estiver em duas, a
        /// mais próxima do centro — que é aquela em que ele acha que
        /// está.
        /// </summary>
        private void Tick()
        {
            if (runs.Count == 0) return;

            // Quem está em qual evento, para a tela decidir depois.
            var byPlayer = new Dictionary<ulong, KeyValuePair<Run, float>>();
            var boards = new Dictionary<string, Dictionary<ulong, Side>>();

            foreach (var entry in runs.Values.ToArray())
            {
                try
                {
                    var inside = Inside(entry);
                    var sides = Sides(inside);

                    boards[entry.runId] = sides;

                    // ####  A ORDEM IMPORTA  ####
                    //
                    // Primeiro o tempo total (um evento que estourou
                    // não pode ser capturado no mesmo tick), depois o
                    // domínio.
                    if (Elapsed(entry) >= entry.durationSeconds)
                    {
                        Finish(entry, "expired", 0UL, "");
                        continue;
                    }

                    if (sides.Count == 1)
                    {
                        var side = sides.First();

                        // ####  A BARRA É DO EVENTO, E NÃO DO GRUPO  ####
                        //
                        // Decisão do dono (15/09/2026): o progresso NÃO
                        // volta a zero quando o grupo troca. Quem chega
                        // continua de onde o outro parou — e é o que faz
                        // a virada no fim valer a pena: levar a barra a
                        // 90% e morrer é perder o evento para quem
                        // fechar os 10% que faltavam.
                        //
                        // `holder` é quem está capturando AGORA, e serve
                        // à tela e ao marcador.
                        entry.holder = side.Key;
                        entry.holderName = side.Value.name;
                        entry.progress += 1f;

                        if (entry.progress >= entry.captureSeconds)
                        {
                            Finish(entry, "captured", side.Key, side.Value.name);
                            continue;
                        }
                    }
                    else if (sides.Count == 0)
                    {
                        // Zona vazia: o padrão é não perder nada. Ver o
                        // `decayPerSecond`, que nasce zero.
                        if (entry.decayPerSecond > 0f)
                        {
                            entry.progress = Mathf.Max(0f, entry.progress - entry.decayPerSecond);
                        }

                        entry.holder = 0UL;
                    }

                    // sides.Count > 1: contestado. Nada sobe, nada cai —
                    // o progresso fica onde está, e a barra diz por quê.

                    RefreshMarker(entry, sides.Count > 1);

                    // Quem está em dois eventos fica com o mais próximo.
                    foreach (var player in inside)
                    {
                        var id = player.userID.Get();
                        var distance = Vector2.Distance(
                            new Vector2(player.transform.position.x, player.transform.position.z),
                            new Vector2(entry.center.x, entry.center.z));

                        KeyValuePair<Run, float> chosen;

                        if (!byPlayer.TryGetValue(id, out chosen) || distance < chosen.Value)
                        {
                            byPlayer[id] = new KeyValuePair<Run, float>(entry, distance);
                        }
                    }
                }
                catch (Exception cause)
                {
                    // Um tick que lança mata o `timer.Every` e TODOS os
                    // eventos congelam sem avisar ninguém. Cada evento
                    // reclama por si, e os outros seguem.
                    PrintWarning("tick do KOTH '" + entry.runId + "' falhou: " + cause.Message);
                }
            }

            try
            {
                Draw(byPlayer, boards);
            }
            catch (Exception cause)
            {
                PrintWarning("a barra do KOTH não pôde ser desenhada: " + cause.Message);
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

        private void Finish(Run current, string reason, ulong winner, string winnerName)
        {
            if (current == null || current.closed) return;

            current.closed = true;

            var payload = new JObject
            {
                ["runId"] = current.runId,
                ["reason"] = reason,
                ["teamId"] = winner.ToString(CultureInfo.InvariantCulture),
                ["teamName"] = winnerName,
                ["seconds"] = Mathf.RoundToInt(Elapsed(current)),
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

            // ####  QUEM FALA É O AGENTE  ####
            //
            // Este plugin NÃO anuncia. A primeira versão dava um
            // `server.Broadcast` aqui e o agente mandava a mesma frase
            // ao receber o aviso: o chat levava tudo em dobro.
            //
            // A regra do projeto é a mesma do recibo da masmorra: o
            // plugin não sabe se o prêmio foi pago, não conhece as
            // tags do OrigemZChat e não sabe quem está em modo
            // streamer. Quem sabe é o agente, e é ele quem fala.
            Push(reason == "captured" ? "captured" : "expired", payload);

            // ####  O PRÊMIO É DA VITÓRIA, NÃO DO FIM  ####
            //
            // Expirou sem vencedor: nada nasce. A §10 da spec é clara
            // ("padrão de expiração: sem vencedor"), e uma caixa que
            // aparece sozinha no mato ensina que não vale a pena
            // disputar — basta esperar o tempo acabar.
            if (reason == "captured") SpawnReward(current);

            Teardown(current.runId, reason);
        }

        // ============================================================
        //  §4  O QUE APARECE NO MUNDO
        // ============================================================

        /// <summary>
        /// O que nasce quando alguém vence: a fumaça e as caixas.
        ///
        /// ####  O SORTEIO É DO ADMIN  ####
        ///
        /// Cada tipo de caixa tem um PESO, e o sorteio é entre eles —
        /// "nem toda vitória rende a caixa boa" foi o pedido. Peso, e
        /// não porcentagem fechada: somar 100 à mão é o tipo de conta
        /// que ninguém acerta na terceira edição, e um peso a mais não
        /// quebra os outros.
        /// </summary>
        private static void ReadReward(Run next, JObject body)
        {
            var reward = body["reward"] as JObject;

            if (reward == null) return;

            next.smoke = reward["smoke"] == null || reward["smoke"].ToObject<bool>();
            next.flare = reward["flare"] == null || reward["flare"].ToObject<bool>();
            next.crateCount = Mathf.Clamp((int)Number(reward, "count", 1f), 0, 10);
            next.crateLifeSeconds = Mathf.Clamp(Number(reward, "crateSeconds", 600f), 0f, 86400f);

            var list = reward["crates"] as JArray;

            if (list == null) return;

            foreach (var entry in list)
            {
                var item = entry as JObject;

                if (item == null) continue;

                var prefab = Text(item, "prefab", "");

                if (string.IsNullOrEmpty(prefab)) continue;

                next.crates.Add(new KeyValuePair<string, float>(
                    prefab,
                    Mathf.Max(0f, Number(item, "chance", 1f))));
            }
        }

        /// <summary>
        /// A fumaça e a caixa, no lugar da bandeira.
        ///
        /// Roda ANTES do `Teardown`: a bandeira ainda está de pé, e é a
        /// posição dela que manda. O `Teardown` a derruba logo depois.
        /// </summary>
        private void SpawnReward(Run current)
        {
            var center = current.center;

            if (current.smoke)
            {
                try
                {
                    // A fumaça é o que faz quem está longe olhar para
                    // lá. Ela apaga sozinha — nada a limpar depois.
                    var smoke = GameManager.server.CreateEntity(PrefabSmoke, center + new Vector3(0f, 0.5f, 0f));

                    if (smoke != null)
                    {
                        smoke.enableSaving = false;
                        smoke.Spawn();
                    }
                }
                catch (Exception e)
                {
                    PrintWarning("a fumaça do KOTH não subiu: " + e.Message);
                }
            }

            if (current.flare)
            {
                try
                {
                    // ####  O MORTEIRO PRECISA SER ACESO  ####
                    //
                    // Ele nasce apagado: quem o dispara é o
                    // `TryLightFuse`, que liga a flag `OnFire`. Sem
                    // isso ele fica no chão como um objeto qualquer.
                    //
                    // O `fuseLength` do jogo é de 3 s — o tiro sai
                    // logo depois de a caixa aparecer, que é a ordem
                    // certa: primeiro o barulho, depois o prêmio.
                    var flare = GameManager.server.CreateEntity(PrefabFlare, center) as BaseFirework;

                    if (flare != null)
                    {
                        flare.enableSaving = false;
                        flare.Spawn();
                        flare.TryLightFuse();

                        // Ele não se limpa sozinho depois de gasto.
                        flare.Invoke(() =>
                        {
                            if (flare != null && !flare.IsDestroyed) flare.Kill();
                        }, 60f);
                    }
                }
                catch (Exception e)
                {
                    PrintWarning("o flare do KOTH não subiu: " + e.Message);
                }
            }

            for (var i = 0; i < current.crateCount; i++)
            {
                try
                {
                    // Em roda, para duas caixas não nascerem uma dentro
                    // da outra.
                    var angle = current.crateCount <= 1 ? 0f : (360f / current.crateCount) * i;
                    var offset = current.crateCount <= 1
                        ? Vector3.zero
                        : Quaternion.Euler(0f, angle, 0f) * new Vector3(1.5f, 0f, 0f);

                    var spot = center + offset + new Vector3(0f, 0.3f, 0f);
                    var crate = GameManager.server.CreateEntity(PickCrate(current), spot);

                    if (crate == null) continue;

                    crate.enableSaving = false;
                    crate.Spawn();

                    // ####  ELA NÃO FICA PARA SEMPRE  ####
                    //
                    // Pedido do dono: caixa de evento que não some é
                    // mapa sujo — e, num servidor com KOTH de hora em
                    // hora, seriam dezenas espalhadas até o wipe.
                    //
                    // O relógio é do MUNDO e não do plugin: o `Invoke`
                    // vive na entidade, então recarregar o plugin não
                    // deixa caixa órfã. E ela some mesmo que ninguém a
                    // tenha aberto.
                    if (current.crateLifeSeconds > 0f)
                    {
                        var doomed = crate;

                        doomed.Invoke(() =>
                        {
                            if (doomed != null && !doomed.IsDestroyed) doomed.Kill();
                        }, current.crateLifeSeconds);
                    }

                    RememberCrate(crate);
                }
                catch (Exception e)
                {
                    PrintWarning("a caixa do KOTH não nasceu: " + e.Message);
                }
            }
        }

        /// <summary>Sorteia um tipo de caixa pelos pesos do admin.</summary>
        private static string PickCrate(Run current)
        {
            if (current.crates.Count == 0) return PrefabDefaultCrate;

            var total = 0f;

            foreach (var entry in current.crates) total += entry.Value;

            if (total <= 0f) return current.crates[0].Key;

            var roll = UnityEngine.Random.Range(0f, total);

            foreach (var entry in current.crates)
            {
                roll -= entry.Value;

                if (roll <= 0f) return entry.Key;
            }

            return current.crates[current.crates.Count - 1].Key;
        }

        private bool SpawnBanner(Run next)
        {
            var banner = GameManager.server.CreateEntity(PrefabBanner, next.center);

            if (banner == null) return false;

            banner.enableSaving = false;
            banner.Spawn();

            next.banner = banner;

            return true;
        }

        /// <summary>
        /// O que aparece no mapa do jogador.
        ///
        /// ####  O CARRINHO DE COMPRAS  ####
        ///
        /// O jeito de um marcador ter NOME no mapa do Rust é pendurá-lo
        /// num `VendingMachineMapMarker` — e o cliente desenha o ícone
        /// de LOJA junto, que não dá para trocar. VISTO no servidor em
        /// 15/09/2026: um carrinho de compras laranja no meio do
        /// território, com o círculo do evento como um pontinho ao lado.
        ///
        /// Por isso o rótulo é OPCIONAL: sem ele, nasce só o círculo, e
        /// o mapa mostra a ÁREA — que é o que importa num evento de
        /// domínio de território.
        ///
        /// ####  O RAIO NÃO É EM METROS  ####
        ///
        /// O servidor manda o número cru e quem o interpreta é o
        /// CLIENTE, que não está no assembly do servidor: não dá para
        /// ler a escala, só medir. Por isso ela vem do agente em
        /// `markerRadius` — calibrar não pode custar uma recompilação.
        /// </summary>
        private void SpawnMarker(Run next, JObject body)
        {
            try
            {
                // ####  O CARRINHO É O PREÇO DO NOME  ####
                //
                // O único jeito de um marcador ter TEXTO no mapa do
                // Rust é pendurá-lo num `VendingMachineMapMarker`, e o
                // cliente desenha o ícone de loja junto — não dá para
                // trocar. O dono viu e pediu assim mesmo: clicar e ler
                // quem está dominando vale o carrinho.
                //
                // O texto é o estado do evento, e ele MUDA: ver
                // `RefreshMarker`.
                var vending = GameManager.server.CreateEntity(PrefabVendingMarker, next.center)
                    as VendingMachineMapMarker;

                if (vending != null)
                {
                    vending.markerShopName = MarkerLabel(next, false);
                    vending.enableSaving = false;
                    vending.Spawn();
                }

                var marker = GameManager.server.CreateEntity(PrefabRadiusMarker, next.center)
                    as MapMarkerGenericRadius;

                if (marker == null)
                {
                    if (vending != null) vending.Kill();
                    return;
                }

                // ####  A ESCALA, MEDIDA CONTRA A GRADE  ####
                //
                // O servidor manda o raio cru e quem o desenha é o
                // CLIENTE — a escala não está no assembly do servidor.
                // Medida no server01 em 15/09/2026, comparando o
                // círculo com a grade do mapa: 1.0 é UMA CÉLULA.
                //
                // A grade do Rust é sempre de 146,3 m, em qualquer
                // tamanho de mapa. Então o raio em metros divide por
                // ela, e o círculo passa a ser a área DE VERDADE.
                //
                // `markerRadius` no corpo continua existindo para
                // calibrar sem recompilar, se um update mudar isso.
                marker.radius = Mathf.Clamp(
                    Number(body, "markerRadius", next.radius / GridCellMeters),
                    0.01f,
                    10f);
                marker.alpha = 0.5f;
                marker.color1 = ParseColor(Text(body, "color", "#C4B454"));
                marker.color2 = marker.color1;
                marker.enableSaving = false;
                marker.Spawn();

                if (vending != null)
                {
                    marker.SetParent(vending);
                    marker.transform.localPosition = Vector3.zero;
                    vending.SendNetworkUpdate();
                }

                marker.SendUpdate();

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
            if (runs.Count == 0) return null;
            if (entity == null || entity.net == null) return null;

            var mine = false;

            foreach (var entry in runs.Values)
            {
                if (entry.banner == null || entry.banner.net == null) continue;
                if (entry.banner.net.ID != entity.net.ID) continue;

                mine = true;
                break;
            }

            if (!mine) return null;

            if (info != null)
            {
                info.damageTypes.ScaleAll(0f);
                info.HitMaterial = 0;
                info.PointStart = Vector3.zero;
            }

            return true;
        }

        private void Teardown(string runId, string why)
        {
            Run closing;

            if (!runs.TryGetValue(runId, out closing)) return;

            runs.Remove(runId);

            // O relógio cai com o último: um `timer.Every` rodando para
            // zero eventos é trabalho por nada, a cada segundo.
            if (runs.Count == 0 && ticker != null)
            {
                try { ticker.Destroy(); }
                catch (Exception e) { PrintWarning("o relógio do KOTH não parou: " + e.Message); }

                ticker = null;
            }

            // ####  PRIMEIRO O QUE ESTÁ NO CHÃO  ####
            Kill(closing.banner);
            Kill(closing.mapMarker);
            Kill(closing.mapLabel);

            // A lista de sobras passa a ser a dos que CONTINUAM de pé.
            Remember();

            foreach (var id in closing.watching.ToArray())
            {
                try
                {
                    var player = BasePlayer.FindByID(id);

                    if (player != null) CuiHelper.DestroyUi(player, UiRoot);
                }
                catch (Exception e)
                {
                    PrintWarning("não consegui tirar a barra de um jogador: " + e.Message);
                }
            }

            Push("ended", new JObject { ["runId"] = closing.runId, ["reason"] = why });
        }

        private static void Kill(BaseEntity entity)
        {
            try
            {
                if (entity != null && !entity.IsDestroyed) entity.Kill();
            }
            catch
            {
                // Uma entidade que já morreu não é problema de ninguém.
            }
        }

        // ============================================================
        //  §5  A BARRA NA TELA
        // ============================================================

        /// <summary>
        /// A barra, uma por jogador.
        ///
        /// Recebe a escolha já feita pelo tick (quem está em qual
        /// evento) e desenha uma vez. Ver o cabeçalho do `Tick`: dois
        /// eventos sobrepostos desenhando cada um por si fariam a
        /// porcentagem piscar na tela de quem está nos dois.
        /// </summary>
        private void Draw(
            Dictionary<ulong, KeyValuePair<Run, float>> byPlayer,
            Dictionary<string, Dictionary<ulong, Side>> boards)
        {
            var seen = new HashSet<ulong>();

            foreach (var pair in byPlayer)
            {
                var player = BasePlayer.FindByID(pair.Key);

                if (player == null) continue;

                var current = pair.Value.Key;

                Dictionary<ulong, Side> sides;

                if (!boards.TryGetValue(current.runId, out sides)) continue;

                seen.Add(pair.Key);

                var soloWarning = current.requireTeam && player.currentTeam == 0UL;
                var contested = sides.Count > 1;

                // Quantos são os seus, e quantos são os outros. Não se
                // diz de que equipe são os outros: a §16 da spec proíbe
                // publicar a posição de cada participante, e o número
                // serve para a decisão que importa — dá para segurar,
                // ou é hora de sair?
                var mine = 0;
                var others = 0;

                foreach (var side in sides)
                {
                    if (player.currentTeam != 0UL && side.Key == player.currentTeam) mine += side.Value.members;
                    else others += side.Value.members;
                }

                CuiHelper.DestroyUi(player, UiRoot);
                CuiHelper.AddUi(
                    player,
                    Hud(current, Percent(current), contested, soloWarning, mine, others));

                current.watching.Add(pair.Key);
            }

            // Quem saiu de TODAS as zonas perde a barra. Sem isto ela
            // ficaria grudada na tela até o fim do evento — e o jogador
            // acharia que ainda está pontuando.
            foreach (var entry in runs.Values)
            {
                foreach (var id in entry.watching.ToArray())
                {
                    if (seen.Contains(id)) continue;

                    entry.watching.Remove(id);

                    var player = BasePlayer.FindByID(id);

                    if (player != null) CuiHelper.DestroyUi(player, UiRoot);
                }
            }
        }

        /// <summary>
        /// O CUI da barra.
        ///
        /// Seis elementos, ~390 bytes cada: cabe folgado no frame. Ele é
        /// montado à mão porque muda a cada segundo — ver o cabeçalho.
        /// </summary>
        private string Hud(
            Run current,
            float percent,
            bool contested,
            bool soloWarning,
            int mine,
            int others)
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
                RectTransform = { AnchorMin = "0.02 0.64", AnchorMax = "0.7 0.99" },
            }, root);

            var estado = soloWarning
                ? "VOCÊ PRECISA DE UMA EQUIPE"
                : contested
                    ? "CONTESTADO"
                    : current.holder == 0UL
                        ? (percent > 0f ? "PARADO" : "SEM DONO")
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
                RectTransform = { AnchorMin = "0.3 0.64", AnchorMax = "0.98 0.99" },
            }, root);

            // ####  A CONTAGEM: OS SEUS E OS OUTROS  ####
            //
            // Embaixo do nome, em letra pequena. Ela é a informação que
            // muda a decisão de quem está lá — e não diz de que equipe
            // são os outros, de propósito.
            var pessoas = soloWarning
                ? (others > 0 ? others + " na área" : "")
                : (mine > 0 || others > 0
                    ? "seus " + mine + " · outros " + others
                    : "");

            if (pessoas != "")
            {
                container.Add(new CuiLabel
                {
                    Text =
                    {
                        Text = pessoas,
                        FontSize = 9,
                        Align = TextAnchor.MiddleLeft,
                        Color = others > 0 ? "0.90 0.65 0.20 0.95" : "0.70 0.70 0.70 0.9",
                    },
                    RectTransform = { AnchorMin = "0.02 0.50", AnchorMax = "0.5 0.66" },
                }, root);
            }

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

        /// <summary>
        /// O texto do marcador no mapa.
        ///
        /// É o que o jogador lê ao clicar no ícone, sem sair do mapa:
        /// de quem é o território e quanto falta. Sem isso ele teria de
        /// ir até lá para saber se vale a pena ir até lá.
        /// </summary>
        private string MarkerLabel(Run current, bool contested)
        {
            var pct = Mathf.RoundToInt(Percent(current));

            if (contested) return current.name + " — DISPUTADO " + pct + "%";
            if (pct <= 0) return current.name + " — sem dono";

            // Com progresso e ninguém dentro, a barra fica PARADA onde
            // está — ela é do evento, não de quem a encheu. Dizer "sem
            // dono" aqui esconderia justamente a informação que faz
            // alguém correr para lá: já tem 80% feito.
            if (current.holder == 0UL) return current.name + " — livre, " + pct + "%";

            return current.name + " — " + current.holderName + " " + pct + "%";
        }

        /// <summary>
        /// Atualiza o texto do marcador, e só quando ele muda.
        ///
        /// ####  UM SendNetworkUpdate POR SEGUNDO É REDE JOGADA FORA  ####
        ///
        /// O tick roda a cada segundo, e na maior parte deles o texto é
        /// o mesmo (a porcentagem só muda de ponto em ponto). Mandar
        /// mesmo assim custaria um update para todo mundo no alcance da
        /// rede, o tempo inteiro.
        /// </summary>
        private void RefreshMarker(Run current, bool contested)
        {
            if (current.mapLabel == null || current.mapLabel.IsDestroyed) return;

            var label = MarkerLabel(current, contested);

            if (current.mapLabel.markerShopName == label) return;

            current.mapLabel.markerShopName = label;
            current.mapLabel.SendNetworkUpdate();
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
