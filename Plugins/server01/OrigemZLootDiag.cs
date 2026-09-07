// ============================================================
//  OrigemZLootDiag.cs  -  PLUGIN DESCARTAVEL DE MEDICAO
//
//  Ele existe para responder UMA pergunta, ao vivo, e depois sair
//  do servidor. Nao guarda estado, nao tem config, nao tem hook.
//
//  ####  A PERGUNTA  ####
//
//  O Docs/CustomItem/06 secao 4.4 mediu NO IL que o
//  LootContainer::SpawnLoot faz assim:
//
//      if (IsDestroyed) return;
//      if (inventory == null) { Log(...); return; }
//      inventory.Clear();
//      ItemManager.DoRemoves(false);
//      if (Interface.CallHook("OnLootSpawn", this) != null) return;
//      PopulateLoot();
//      CancelLootRefreshCountdown();
//      if (shouldRefreshContents) StartLootRefreshCountdown(null);
//
//  O return do hook fica ANTES do StartLootRefreshCountdown. Se um
//  plugin cancela o OnLootSpawn - como o BetterLoot faz -, nenhum
//  cronometro novo e armado, e o container nunca mais repopula.
//
//  Isso era leitura de bytecode. Este plugin transforma em medida.
//
//  ####  COMO ELE PERGUNTA AO JOGO  ####
//
//  Quem arma o cronometro e StartLootRefreshCountdown, que faz
//  Invoke(actionSpawnLoot, currentLootCountdownLength). A verdade
//  do agendador, portanto, e IsInvoking(actionSpawnLoot) - e nao o
//  campo isLootCountdownRunning, que MENTE.
//
//  Por que ele mente: o campo so vira false dentro de
//  CancelLootRefreshCountdown, e so quando IsInvoking ainda era
//  true. Quando o Invoke dispara sozinho, o agendador tira a
//  invocacao da lista mas ninguem toca no campo. Se o hook cancelar
//  o SpawnLoot logo em seguida, o campo fica preso em true para
//  sempre, descrevendo um cronometro que nao existe mais.
//
//  Por isso este plugin mede os DOIS e mostra a divergencia: ela e
//  a assinatura exata do defeito.
//
//  Tudo por reflexao, de proposito: actionSpawnLoot e
//  isLootCountdownRunning sao membros internos do jogo, e um
//  plugin de medicao nao deve depender da visibilidade deles.
//
//  ####  OS DOIS MODOS  ####
//
//  origemz.loot.diag
//      Censo passivo do mundo. Nao toca em nada. Diz quantos
//      LootContainer existem, quantos PODEM repopular
//      (shouldRefreshContents) e quantos estao de fato com o
//      cronometro armado.
//
//  origemz.loot.diag probe [n]
//      A medida que decide. Um censo passivo nao serve sozinho:
//      instalar o BetterLoot nao desarma os cronometros que ja
//      estao correndo - eles duram de 1 a 2 h, e o efeito so
//      apareceria quando cada um disparasse.
//
//      Entao o probe FORCA o disparo em n containers longe de
//      qualquer jogador. Em tres passos, e o primeiro nao e
//      opcional:
//
//        1. DESARMA o cronometro atual
//           (CancelLootRefreshCountdown).
//        2. chama SpawnLoot().
//        3. olha se um cronometro NOVO nasceu.
//
//      ####  POR QUE O PASSO 1 E OBRIGATORIO  ####
//
//      Sem ele a medida da falso-positivo, e a primeira versao
//      deste plugin caiu nessa. Quando o Invoke dispara de
//      verdade, o agendador TIRA a invocacao da lista antes de
//      chamar o metodo. Chamar SpawnLoot() a mao nao tira nada: a
//      invocacao velha continua agendada, e IsInvoking responde
//      "sim" por causa dela - mesmo que o hook tenha cancelado
//      tudo e nenhum cronometro novo tenha nascido.
//
//      O passo 1 poe o container no mesmo estado em que o Invoke
//      real o deixa: lista vazia, prestes a rodar SpawnLoot. Dai
//      um "sim" do IsInvoking so pode ter vindo do
//      StartLootRefreshCountdown do proprio SpawnLoot.
//
//      Sem BetterLoot: nasce (armed_after = n).
//      Com BetterLoot:  nao nasce (armed_after = 0).
//
//      ####  O PROBE NAO DEIXA ESTRAGO  ####
//
//      Container que nao rearmou sozinho e rearmado a mao no fim
//      (restored=n na saida), porque desarmar e ir embora deixaria
//      barril parado no mundo do dono por causa da medicao.
//
//      O outro efeito colateral e o loot daqueles n containers ser
//      refeito - que e o que o jogo faria de qualquer jeito. Por
//      seguranca eles sao escolhidos a mais de 50 m de qualquer
//      jogador conectado, para nunca limpar uma caixa aberta.
//
//  origemz.loot.diag arm [n]   +   origemz.loot.diag read
//      O MESMO probe, partido em dois comandos - e existe por
//      causa de uma terceira armadilha de medicao, achada em
//      06/09/2026 ao medir o OrigemZLootRefresh:
//
//      ####  O PROBE DE UM COMANDO SO NAO VE CONSERTO ASSINCRONO  ####
//
//      O probe acima le armed_after na linha seguinte ao
//      SpawnLoot, ou seja, DENTRO do mesmo frame. Um conserto que
//      age no NextTick - e o do OrigemZLootRefresh age, de
//      proposito, para nao depender da ordem de carga dos plugins
//      - ainda nao rodou nesse instante. O probe deu
//      "REFRESH MORTO" com o conserto ativo e funcionando.
//
//      Pior: o proprio probe restaura o que nao rearmou, entao no
//      tick seguinte o conserto ve tudo ja armado e nao faz nada.
//      A medida se apagava sozinha.
//
//      O par arm/read separa as duas metades em dois comandos de
//      console. Entre um e outro passam varios frames, entao o
//      NextTick de quem quer que seja ja rodou. E o "arm" NAO
//      restaura nada: quem restaura e o "read", depois de ler.
//
//      Sem BetterLoot:            armed_after = n
//      Com BetterLoot, sem conserto:  armed_after = 0
//      Com BetterLoot, com conserto:  armed_after = n
//
//      Rodar "arm" e esquecer o "read" deixa ate n containers sem
//      cronometro. O "heal" conserta; e o "read" avisa quando a
//      lista guardada ficou velha.
// ============================================================

using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using Oxide.Core;
using Oxide.Core.Plugins;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("OrigemZLootDiag", "OrigemZ", "1.0.0")]
    [Description("Mede quantos LootContainer tem o cronometro de refresh armado")]
    internal class OrigemZLootDiag : RustPlugin
    {
        private const string DiagCommand = "origemz.loot.diag";

        // Distancia minima de um jogador para um container poder
        // entrar no probe. Um SpawnLoot limpa o inventario: fazer
        // isso numa caixa que alguem esta olhando some com o loot
        // na cara do jogador.
        private const float ProbeSafeDistance = 50f;

        private const int ProbeDefaultCount = 20;
        private const int ProbeMaxCount = 200;

        // Reflexao resolvida uma vez. Os quatro membros existem no
        // LootContainer deste servidor - medidos no IL antes de
        // escrever este arquivo.
        private static PropertyInfo _propActionSpawnLoot;
        private static FieldInfo _fieldCountdownRunning;
        private static MethodInfo _methodTimeRemaining;
        private static FieldInfo _fieldMinRefresh;
        private static FieldInfo _fieldMaxRefresh;
        private static MethodInfo _methodCancelCountdown;
        private static MethodInfo _methodStartCountdown;
        private static FieldInfo _fieldHasBeenLooted;
        private static bool _reflectionReady;
        private static string _reflectionError;

        private void Init()
        {
            ResolveReflection();
        }

        private static void ResolveReflection()
        {
            if (_reflectionReady)
            {
                return;
            }

            const BindingFlags Flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            Type type = typeof(LootContainer);
            StringBuilder missing = new StringBuilder();

            _propActionSpawnLoot = type.GetProperty("actionSpawnLoot", Flags);
            _fieldCountdownRunning = type.GetField("isLootCountdownRunning", Flags);
            _methodTimeRemaining = type.GetMethod("GetLootCountdownTimeRemaining", Flags, null, Type.EmptyTypes, null);
            _fieldMinRefresh = type.GetField("minSecondsBetweenRefresh", Flags);
            _fieldMaxRefresh = type.GetField("maxSecondsBetweenRefresh", Flags);
            _methodCancelCountdown = type.GetMethod("CancelLootRefreshCountdown", Flags, null, Type.EmptyTypes, null);
            _methodStartCountdown = type.GetMethod("StartLootRefreshCountdown", Flags, null, new Type[] { typeof(float?) }, null);
            _fieldHasBeenLooted = type.GetField("HasBeenLooted", Flags);

            if (_fieldHasBeenLooted == null) missing.Append("HasBeenLooted ");
            if (_propActionSpawnLoot == null) missing.Append("actionSpawnLoot ");
            if (_fieldCountdownRunning == null) missing.Append("isLootCountdownRunning ");
            if (_methodTimeRemaining == null) missing.Append("GetLootCountdownTimeRemaining ");
            if (_fieldMinRefresh == null) missing.Append("minSecondsBetweenRefresh ");
            if (_fieldMaxRefresh == null) missing.Append("maxSecondsBetweenRefresh ");
            if (_methodCancelCountdown == null) missing.Append("CancelLootRefreshCountdown ");
            if (_methodStartCountdown == null) missing.Append("StartLootRefreshCountdown ");

            _reflectionError = missing.ToString();
            _reflectionReady = _reflectionError.Length == 0;
        }

        // ####  A PERGUNTA AO AGENDADOR  ####
        //
        // Esta e a linha que vale o plugin inteiro. IsInvoking
        // consulta o InvokeHandler, que e quem de fato guarda a
        // lista de invocacoes pendentes.
        private static bool IsRefreshArmed(LootContainer container)
        {
            object action = _propActionSpawnLoot.GetValue(container, null);
            Action typed = action as Action;

            if (typed == null)
            {
                // O delegate nasce preguicoso. Nulo significa que
                // StartLootRefreshCountdown nunca rodou neste
                // container - logo, nada agendado.
                return false;
            }

            return container.IsInvoking(typed);
        }

        private static bool ReadCountdownFlag(LootContainer container)
        {
            return (bool)_fieldCountdownRunning.GetValue(container);
        }

        private static float ReadTimeRemaining(LootContainer container)
        {
            return (float)_methodTimeRemaining.Invoke(container, null);
        }

        // shouldRefreshContents, reconstruido do IL:
        //   min > 0 && max > 0
        private static bool CanRefresh(LootContainer container)
        {
            float min = (float)_fieldMinRefresh.GetValue(container);
            float max = (float)_fieldMaxRefresh.GetValue(container);
            return min > 0f && max > 0f;
        }

        // A amostra que o "arm" disparou e o "read" ainda nao leu.
        private static readonly List<LootContainer> _held = new List<LootContainer>();
        private static int _heldArmedBefore;
        private static int _heldItemsBefore;
        private static int _heldDisarmFailed;
        private static float _heldAtRealtime;

        private sealed class PrefabTally
        {
            public string Prefab;
            public int Total;
            public int Refreshable;
            public int Armed;
            public int FlagRunning;
            public int Ghost;
            public int Looted;
            public int Full;
        }

        // ####  A MARCA DE SAQUEADO, E POR QUE ELA ESTA AQUI  ####
        //
        // HasBeenLooted e escrito em TODA remocao de item
        // (LootContainer::OnItemAddedOrRemoved) e desmarcado por um
        // lugar so: o PopulateLoot nativo. Quem cancela o
        // OnLootSpawn pula o PopulateLoot e deixa a marca presa em
        // true.
        //
        // Quem le a marca, no Assembly-CSharp inteiro:
        //   JunkPile::SpawnGroupsEmpty          -> despawna o junkpile
        //   PuzzleReset::HasPuzzleBeenPartialLooted -> libera o reset do puzzle
        //
        // Por isso o censo conta os marcados E os junkpiles: um
        // sobe enquanto o outro desce, e o par e a prova.
        private static bool ReadHasBeenLooted(LootContainer container)
        {
            return (bool)_fieldHasBeenLooted.GetValue(container);
        }

        // ####  O CONTAINER SEM SLOT LIVRE  ####
        //
        // O BetterLoot fecha a capacidade na contagem de itens
        // (capacity = itemList.Count) ao fim de cada populacao.
        // Depois disso ninguem mais insere nada: nem plugin nosso,
        // nem o proprio jogo. Aqui isso vira numero.
        private static bool IsFull(LootContainer container)
        {
            ItemContainer inventory = container.inventory;

            return inventory != null
                && inventory.itemList != null
                && inventory.itemList.Count >= inventory.capacity;
        }

        [ConsoleCommand(DiagCommand)]
        private void CommandLootDiag(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            ResolveReflection();

            if (!_reflectionReady)
            {
                arg.ReplyWith("ERRO: membros nao encontrados no LootContainer: " + _reflectionError);
                return;
            }

            try
            {
                string mode = arg.GetString(0, "");

                if (mode == "probe")
                {
                    RunProbe(arg, arg.GetInt(1, ProbeDefaultCount));
                    return;
                }

                if (mode == "arm")
                {
                    RunProbeArm(arg, arg.GetInt(1, ProbeDefaultCount));
                    return;
                }

                if (mode == "read")
                {
                    RunProbeRead(arg);
                    return;
                }

                if (mode == "heal")
                {
                    RunHeal(arg);
                    return;
                }

                if (mode == "insert")
                {
                    RunInsertProbe(arg, arg.GetInt(1, ProbeDefaultCount));
                    return;
                }

                if (mode == "capacity")
                {
                    RunCapacityRepair(arg);
                    return;
                }

                RunCensus(arg);
            }
            catch (Exception ex)
            {
                arg.ReplyWith("ERRO: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        // ####  O CONSERTO  ####
        //
        // Container que perdeu o cronometro nao o recupera sozinho:
        // quem rearma e o proprio SpawnLoot, e ele so roda quando o
        // cronometro dispara. Sem cronometro, nao ha disparo - e o
        // container fica parado para sempre.
        //
        // Este modo devolve o cronometro a quem pode repopular e nao
        // tem nenhum agendado. Antes do experimento o censo deu
        // 6329 de 6329 armados: no servidor saudavel esse conjunto e
        // vazio, entao rearmar todo mundo dele e restaurar, nao
        // inventar.
        private void RunHeal(ConsoleSystem.Arg arg)
        {
            int scanned = 0;
            int healed = 0;

            foreach (BaseNetworkable entity in BaseNetworkable.serverEntities)
            {
                LootContainer container = entity as LootContainer;

                if (container == null || container.IsDestroyed || !CanRefresh(container))
                {
                    continue;
                }

                scanned++;

                if (IsRefreshArmed(container))
                {
                    continue;
                }

                _methodStartCountdown.Invoke(container, new object[] { null });
                healed++;
            }

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("##### OZ LOOT DIAG - HEAL #####");
            sb.AppendLine("scanned=" + scanned + " healed=" + healed);
            arg.ReplyWith(sb.ToString());
        }

        private void RunCensus(ConsoleSystem.Arg arg)
        {
            int total = 0;
            int refreshable = 0;
            int armed = 0;
            int flagRunning = 0;
            int ghost = 0;
            int infinite = 0;
            int looted = 0;
            int full = 0;
            int junkPiles = 0;
            double remainingSum = 0;
            int remainingCount = 0;

            Dictionary<string, PrefabTally> byPrefab = new Dictionary<string, PrefabTally>();

            foreach (BaseNetworkable entity in BaseNetworkable.serverEntities)
            {
                if (entity is JunkPile)
                {
                    // O junkpile e a vitima do defeito da marca:
                    // ele despawna quando TODOS os LootContainer
                    // dos spawngroups dele estao marcados. Contar
                    // os dois no mesmo censo e o que liga causa e
                    // efeito numa linha so.
                    junkPiles++;
                }

                LootContainer container = entity as LootContainer;

                if (container == null || container.IsDestroyed)
                {
                    continue;
                }

                total++;

                bool canRefresh = CanRefresh(container);
                bool isArmed = IsRefreshArmed(container);
                bool flag = ReadCountdownFlag(container);
                bool isLooted = ReadHasBeenLooted(container);
                bool isFull = IsFull(container);

                if (canRefresh) refreshable++;
                if (isArmed) armed++;
                if (flag) flagRunning++;
                if (isLooted) looted++;
                if (isFull) full++;

                // O FANTASMA: o campo diz que ha cronometro, o
                // agendador diz que nao. E a assinatura do
                // SpawnLoot interrompido no meio.
                if (flag && !isArmed) ghost++;

                if (isArmed)
                {
                    float remaining = ReadTimeRemaining(container);

                    // Ha container com refresh praticamente
                    // infinito no mapa; incluir na media a
                    // envenena inteira.
                    if (!float.IsInfinity(remaining) && !float.IsNaN(remaining) && remaining < 1e7f)
                    {
                        remainingSum += remaining;
                        remainingCount++;
                    }
                    else
                    {
                        infinite++;
                    }
                }

                string prefab = container.ShortPrefabName;
                PrefabTally tally;

                if (!byPrefab.TryGetValue(prefab, out tally))
                {
                    tally = new PrefabTally();
                    tally.Prefab = prefab;
                    byPrefab[prefab] = tally;
                }

                tally.Total++;
                if (canRefresh) tally.Refreshable++;
                if (isArmed) tally.Armed++;
                if (flag) tally.FlagRunning++;
                if (flag && !isArmed) tally.Ghost++;
                if (isLooted) tally.Looted++;
                if (isFull) tally.Full++;
            }

            List<PrefabTally> ordered = new List<PrefabTally>(byPrefab.Values);
            ordered.Sort(delegate (PrefabTally a, PrefabTally b) { return b.Total.CompareTo(a.Total); });

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("##### OZ LOOT DIAG - CENSO #####");
            sb.AppendLine("containers=" + total
                + " refreshable=" + refreshable
                + " armed=" + armed
                + " flag_running=" + flagRunning
                + " ghost=" + ghost);

            double avg = remainingCount > 0 ? remainingSum / remainingCount : 0;
            sb.AppendLine("armed_pct_of_refreshable=" + (refreshable > 0 ? (100.0 * armed / refreshable).ToString("F1") : "n/a")
                + " remaining_avg_s=" + avg.ToString("F0") + " (n=" + remainingCount + ") infinite=" + infinite);
            sb.AppendLine("looted=" + looted
                + " looted_pct=" + (total > 0 ? (100.0 * looted / total).ToString("F1") : "n/a")
                + " full_no_free_slot=" + full
                + " junkpiles=" + junkPiles);
            sb.AppendLine("-- por prefab --");

            int shown = 0;

            foreach (PrefabTally t in ordered)
            {
                if (shown++ >= 25)
                {
                    sb.AppendLine("... (" + (ordered.Count - 25) + " prefabs a mais)");
                    break;
                }

                sb.AppendLine(t.Prefab
                    + " total=" + t.Total
                    + " refreshable=" + t.Refreshable
                    + " armed=" + t.Armed
                    + " flag=" + t.FlagRunning
                    + " ghost=" + t.Ghost
                    + " looted=" + t.Looted
                    + " full=" + t.Full);
            }

            arg.ReplyWith(sb.ToString());
        }

        // A escolha da amostra, comum aos dois probes: container
        // que pode repopular, tem inventario e esta longe de todo
        // jogador conectado.
        private static List<LootContainer> SelectProbeTargets(int requested)
        {
            int count = requested;

            if (count < 1) count = ProbeDefaultCount;
            if (count > ProbeMaxCount) count = ProbeMaxCount;

            List<Vector3> players = new List<Vector3>();

            foreach (BasePlayer player in BasePlayer.activePlayerList)
            {
                if (player != null)
                {
                    players.Add(player.transform.position);
                }
            }

            List<LootContainer> chosen = new List<LootContainer>();

            foreach (BaseNetworkable entity in BaseNetworkable.serverEntities)
            {
                if (chosen.Count >= count)
                {
                    break;
                }

                LootContainer container = entity as LootContainer;

                if (container == null || container.IsDestroyed)
                {
                    continue;
                }

                // So faz sentido medir onde o refresh existiria.
                if (!CanRefresh(container))
                {
                    continue;
                }

                if (container.inventory == null)
                {
                    continue;
                }

                bool tooClose = false;
                Vector3 pos = container.transform.position;

                foreach (Vector3 p in players)
                {
                    if (Vector3.Distance(p, pos) < ProbeSafeDistance)
                    {
                        tooClose = true;
                        break;
                    }
                }

                if (tooClose)
                {
                    continue;
                }

                chosen.Add(container);
            }

            return chosen;
        }

        // ####  O REPARO DA CAPACIDADE  ####
        //
        // O BetterLoot fecha capacity = itemList.Count ao fim de
        // cada populacao, e NADA desfaz isso: descarregar o plugin
        // nao devolve, e o PopulateLoot nativo tambem nao mexe em
        // capacity. Medido em 07/09/2026: os 6072 containers
        // continuaram fechados depois do oxide.unload.
        //
        // A capacidade original nao se perdeu, porem. O
        // StorageContainer::CreateInventory faz
        //
        //     inventory.ServerInitialize(null, this.inventorySlots)
        //
        // e o inventorySlots e um campo do PREFAB, que ninguem
        // sobrescreve. Entao a restauracao e exata, e nao um
        // chute em 36.
        //
        // Ele NAO roda sozinho, e de proposito: fechar a
        // capacidade e escolha do BetterLoot ("For viewing
        // purposes", no proprio codigo dele). Desfaze-la a cada
        // populacao seria brigar com o plugin. Este comando existe
        // para o depois - quando o plugin sai e o servidor fica
        // com o mundo inteiro fechado.
        private void RunCapacityRepair(ConsoleSystem.Arg arg)
        {
            int scanned = 0;
            int repaired = 0;
            int alreadyOk = 0;
            int noSlotsField = 0;
            long slotsGiven = 0;

            foreach (BaseNetworkable entity in BaseNetworkable.serverEntities)
            {
                LootContainer container = entity as LootContainer;

                if (container == null || container.IsDestroyed || container.inventory == null)
                {
                    continue;
                }

                scanned++;

                int original = container.inventorySlots;

                if (original <= 0)
                {
                    noSlotsField++;
                    continue;
                }

                if (container.inventory.capacity >= original)
                {
                    alreadyOk++;
                    continue;
                }

                slotsGiven += original - container.inventory.capacity;
                container.inventory.capacity = original;
                container.inventory.MarkDirty();
                repaired++;
            }

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("##### OZ LOOT DIAG - REPARO DE CAPACIDADE #####");
            sb.AppendLine("scanned=" + scanned
                + " repaired=" + repaired
                + " already_ok=" + alreadyOk
                + " sem_inventorySlots=" + noSlotsField
                + " slots_devolvidos=" + slotsGiven);
            sb.AppendLine(repaired == 0
                ? "LEITURA: nenhuma capacidade estava fechada."
                : "LEITURA: " + repaired + " containers voltaram a aceitar item.");
            arg.ReplyWith(sb.ToString());
        }

        // ####  A SONDA DA CAPACIDADE  ####
        //
        // Responde uma pergunta que nenhum censo responde: um
        // plugin NOSSO ainda consegue por item num container que o
        // BetterLoot encheu?
        //
        // O caminho medido e o do OrigemZItems::InjectLoot, que
        // acrescenta o trofeu no NextTick do OnLootSpawn com
        // MoveToContainer(inventory, -1, true, false, null, true).
        // Esta sonda faz exatamente essa chamada, com um item
        // barato, e DESFAZ em seguida - o item e removido tenha
        // entrado ou nao.
        //
        // O que ela distingue: "coube" de "nao coube por falta de
        // slot". O BetterLoot fecha capacity = itemList.Count ao
        // fim de cada populacao (BetterLoot.cs:2666), e a partir
        // dai a resposta e sempre "nao coube".
        private void RunInsertProbe(ConsoleSystem.Arg arg, int requested)
        {
            List<LootContainer> chosen = SelectProbeTargets(requested);

            if (chosen.Count == 0)
            {
                arg.ReplyWith("nenhum container elegivel (todos perto de jogador?)");
                return;
            }

            ItemDefinition definition = ItemManager.FindItemDefinition("wood");

            if (definition == null)
            {
                arg.ReplyWith("ERRO: item 'wood' nao existe nesta versao do Rust");
                return;
            }

            int fitted = 0;
            int rejected = 0;
            int failedToCreate = 0;
            int capacityEqualsCount = 0;

            // ####  A MARCA TEM DE VOLTAR COMO ESTAVA  ####
            //
            // Achado medindo: tirar o item de teste dispara o
            // LootContainer::OnItemAddedOrRemoved, que acende
            // HasBeenLooted. A primeira versao desta sonda deixou
            // 38 containers marcados no mundo do dono - a
            // ferramenta criando o proprio defeito que ela veio
            // medir.
            //
            // E restaurar dentro do laco nao bastou: o
            // Item.Remove() so ENFILEIRA, e quem de fato tira o
            // item do itemList e o ItemManager.DoRemoves() la
            // embaixo - que dispara o evento de novo, depois da
            // nossa restauracao. Por isso o estado e guardado
            // aqui e devolvido num segundo passe, DEPOIS do
            // DoRemoves.
            bool[] lootedBefore = new bool[chosen.Count];

            for (int index = 0; index < chosen.Count; index++)
            {
                LootContainer container = chosen[index];
                ItemContainer inventory = container.inventory;

                if (inventory == null)
                {
                    continue;
                }

                if (inventory.itemList != null && inventory.itemList.Count >= inventory.capacity)
                {
                    capacityEqualsCount++;
                }

                Item probe = ItemManager.Create(definition, 1, 0uL);

                if (probe == null)
                {
                    failedToCreate++;
                    continue;
                }

                lootedBefore[index] = ReadHasBeenLooted(container);

                // A MESMA assinatura do InjectLoot. Trocar qualquer
                // um dos argumentos mediria outra coisa.
                if (probe.MoveToContainer(inventory, -1, true, false, null, true))
                {
                    fitted++;
                }
                else
                {
                    rejected++;
                }

                // Desfaz sempre. A sonda mede, nao presenteia.
                probe.RemoveFromContainer();
                probe.Remove();
            }

            ItemManager.DoRemoves();

            // O segundo passe: agora que o DoRemoves ja disparou
            // todos os OnItemAddedOrRemoved que ia disparar, a
            // marca pode voltar ao que era.
            for (int index = 0; index < chosen.Count; index++)
            {
                LootContainer container = chosen[index];

                if (container != null && !container.IsDestroyed)
                {
                    _fieldHasBeenLooted.SetValue(container, lootedBefore[index]);
                }
            }

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("##### OZ LOOT DIAG - SONDA DE CAPACIDADE #####");
            sb.AppendLine("amostra=" + chosen.Count
                + " coube=" + fitted
                + " recusado=" + rejected
                + " sem_slot_livre_antes=" + capacityEqualsCount
                + " falhou_criar=" + failedToCreate);
            // ####  O LIMIAR, E POR QUE ELE NAO E ZERO  ####
            //
            // Container cheio EXISTE no jogo sem plugin nenhum: o
            // FillLoot nativo as vezes ocupa todos os slots do
            // prefab. Medido no server01 sem BetterLoot, isso da
            // 2 em 40 (e 1276 de 6116 no censo) - cerca de 20 %.
            //
            // Um veredito que gritasse a partir de 1 recusa
            // acusaria o jogo de estar quebrado todo dia. O corte
            // fica na metade da amostra: abaixo disso e o mundo
            // normal, acima e alguem fechando capacidade em massa.
            bool massClosure = rejected * 2 > chosen.Count;

            sb.AppendLine(massClosure
                ? "VEREDITO: CAPACIDADE FECHADA - " + rejected + " de " + chosen.Count
                    + " recusaram o item. O trofeu do OrigemZItems nao entraria nesses."
                : "VEREDITO: CAPACIDADE NORMAL - " + fitted + " de " + chosen.Count
                    + " aceitaram. As " + rejected + " recusas cabem no que o jogo faz sozinho.");
            arg.ReplyWith(sb.ToString());
        }

        // ####  PROBE EM DOIS TEMPOS - A METADE QUE DISPARA  ####
        //
        // Desarma e chama SpawnLoot, e para por aqui. Nao le nada
        // e nao restaura nada: quem faz as duas coisas e o "read",
        // varios frames depois, quando o NextTick de qualquer
        // conserto assincrono ja rodou.
        private void RunProbeArm(ConsoleSystem.Arg arg, int requested)
        {
            List<LootContainer> chosen = SelectProbeTargets(requested);

            _heldArmedBefore = 0;
            _heldItemsBefore = 0;
            _heldDisarmFailed = 0;
            _held.Clear();

            foreach (LootContainer container in chosen)
            {
                if (IsRefreshArmed(container)) _heldArmedBefore++;
                _heldItemsBefore += container.inventory.itemList.Count;

                _methodCancelCountdown.Invoke(container, null);

                if (IsRefreshArmed(container))
                {
                    _heldDisarmFailed++;
                }

                container.SpawnLoot();
                _held.Add(container);
            }

            _heldAtRealtime = Time.realtimeSinceStartup;

            arg.ReplyWith("##### OZ LOOT DIAG - ARM #####\n"
                + "armed=" + _held.Count
                + " armed_before=" + _heldArmedBefore
                + " disarm_failed=" + _heldDisarmFailed
                + "\nAgora rode: origemz.loot.diag read");
        }

        // ####  PROBE EM DOIS TEMPOS - A METADE QUE LE  ####
        private void RunProbeRead(ConsoleSystem.Arg arg)
        {
            if (_held.Count == 0)
            {
                arg.ReplyWith("nada guardado - rode origemz.loot.diag arm [n] antes");
                return;
            }

            int armedAfter = 0;
            int flagAfter = 0;
            int ghostAfter = 0;
            int itemsAfter = 0;
            int restored = 0;
            int gone = 0;

            StringBuilder detail = new StringBuilder();
            int detailShown = 0;

            foreach (LootContainer container in _held)
            {
                if (container == null || container.IsDestroyed)
                {
                    gone++;
                    continue;
                }

                bool afterArmed = IsRefreshArmed(container);
                bool afterFlag = ReadCountdownFlag(container);

                if (afterArmed) armedAfter++;
                if (afterFlag) flagAfter++;
                if (afterFlag && !afterArmed) ghostAfter++;
                if (container.inventory != null) itemsAfter += container.inventory.itemList.Count;

                if (detailShown < 6)
                {
                    detailShown++;
                    detail.AppendLine("  " + container.ShortPrefabName
                        + " armed_after:" + (afterArmed ? "1" : "0")
                        + " rem:" + ReadTimeRemaining(container).ToString("F0") + "s");
                }

                // Nao deixar estrago: o que nao rearmou sozinho foi
                // o experimento que tirou do mundo.
                if (!afterArmed)
                {
                    _methodStartCountdown.Invoke(container, new object[] { null });
                    restored++;
                }
            }

            int sample = _held.Count - gone;
            float elapsed = Time.realtimeSinceStartup - _heldAtRealtime;

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("##### OZ LOOT DIAG - READ #####");
            sb.AppendLine("probed=" + _held.Count
                + " gone=" + gone
                + " armed_before=" + _heldArmedBefore
                + " armed_after=" + armedAfter
                + " flag_after=" + flagAfter
                + " ghost_after=" + ghostAfter
                + " disarm_failed=" + _heldDisarmFailed
                + " restored=" + restored);
            sb.AppendLine("items_total_before=" + _heldItemsBefore
                + " items_total_after=" + itemsAfter
                + " atraso_s=" + elapsed.ToString("F1"));
            sb.AppendLine("VEREDITO: " + (sample == 0
                ? "sem amostra"
                : (armedAfter == sample
                    ? "REFRESH INTACTO - todo container rearmou o cronometro"
                    : (armedAfter == 0
                        ? "REFRESH MORTO - nenhum container rearmou o cronometro"
                        : "PARCIAL - " + armedAfter + " de " + sample + " rearmaram"))));
            sb.AppendLine("-- amostra --");
            sb.Append(detail.ToString());

            _held.Clear();
            arg.ReplyWith(sb.ToString());
        }

        private void RunProbe(ConsoleSystem.Arg arg, int requested)
        {
            List<LootContainer> chosen = SelectProbeTargets(requested);

            int armedBefore = 0;
            int armedAfter = 0;
            int itemsBefore = 0;
            int itemsAfter = 0;
            int flagAfter = 0;
            int ghostAfter = 0;
            int disarmFailed = 0;
            int restored = 0;

            StringBuilder detail = new StringBuilder();
            int detailShown = 0;

            foreach (LootContainer container in chosen)
            {
                bool beforeArmed = IsRefreshArmed(container);
                float beforeRemaining = ReadTimeRemaining(container);
                int beforeItems = container.inventory.itemList.Count;

                if (beforeArmed) armedBefore++;
                itemsBefore += beforeItems;

                // ####  PASSO 1 - DESARMAR  ####
                //
                // Poe o container no estado em que o Invoke real o
                // deixa. Sem isto a invocacao velha continua na
                // lista e responde "sim" no lugar da nova.
                _methodCancelCountdown.Invoke(container, null);

                if (IsRefreshArmed(container))
                {
                    disarmFailed++;
                }

                // ####  PASSO 2 - O DISPARO  ####
                //
                // A mesma chamada que o Invoke faria quando o
                // cronometro vencesse. Se o caminho do jogo estiver
                // intacto, ela termina em StartLootRefreshCountdown
                // e um cronometro novo nasce aqui mesmo.
                container.SpawnLoot();

                // ####  PASSO 3 - A LEITURA  ####
                bool afterArmed = IsRefreshArmed(container);
                bool afterFlag = ReadCountdownFlag(container);
                float afterRemaining = ReadTimeRemaining(container);
                int afterItems = container.inventory.itemList.Count;

                if (afterArmed) armedAfter++;
                if (afterFlag) flagAfter++;
                if (afterFlag && !afterArmed) ghostAfter++;
                itemsAfter += afterItems;

                if (detailShown < 6)
                {
                    detailShown++;
                    detail.AppendLine("  " + container.ShortPrefabName
                        + " armed:" + (beforeArmed ? "1" : "0") + "->" + (afterArmed ? "1" : "0")
                        + " items:" + beforeItems + "->" + afterItems
                        + " cap=" + container.inventory.capacity
                        + " rem:" + beforeRemaining.ToString("F0") + "s->" + afterRemaining.ToString("F0") + "s");
                }

                // ####  NAO DEIXAR ESTRAGO  ####
                //
                // Se o cronometro nao renasceu sozinho, foi o
                // experimento que o tirou do mundo. Devolve.
                if (!afterArmed)
                {
                    _methodStartCountdown.Invoke(container, new object[] { null });
                    restored++;
                }
            }

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("##### OZ LOOT DIAG - PROBE #####");
            sb.AppendLine("probed=" + chosen.Count
                + " armed_before=" + armedBefore
                + " armed_after=" + armedAfter
                + " flag_after=" + flagAfter
                + " ghost_after=" + ghostAfter
                + " disarm_failed=" + disarmFailed
                + " restored=" + restored);
            sb.AppendLine("items_total_before=" + itemsBefore + " items_total_after=" + itemsAfter);
            sb.AppendLine("VEREDITO: " + (chosen.Count == 0
                ? "sem amostra"
                : (armedAfter == chosen.Count
                    ? "REFRESH INTACTO - todo container rearmou o cronometro"
                    : (armedAfter == 0
                        ? "REFRESH MORTO - nenhum container rearmou o cronometro"
                        : "PARCIAL - " + armedAfter + " de " + chosen.Count + " rearmaram"))));
            sb.AppendLine("-- amostra --");
            sb.Append(detail.ToString());

            arg.ReplyWith(sb.ToString());
        }
    }
}
