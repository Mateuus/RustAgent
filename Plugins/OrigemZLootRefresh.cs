// ============================================================
//  OrigemZLootRefresh.cs  -  DEVOLVE OS EFEITOS DO PopulateLoot
//                            QUE UM HOOK CANCELADO DEIXA CAIR
//
//  ####  O DEFEITO  ####
//
//  LootContainer::SpawnLoot, lido no IL deste servidor:
//
//      if (IsDestroyed) return;
//      if (inventory == null) { Log(...); return; }
//      inventory.Clear();
//      ItemManager.DoRemoves(false);
//      if (Interface.CallHook("OnLootSpawn", this) != null) return;   <-- aqui
//      PopulateLoot();
//      CancelLootRefreshCountdown();
//      if (shouldRefreshContents) StartLootRefreshCountdown(null);
//
//  O return do hook fica ANTES de tudo que vem depois dele. Um
//  plugin que devolve nao-nulo - o BetterLoot devolve, em todo
//  prefab que ele vigia - pula o PopulateLoot inteiro e as duas
//  linhas seguintes.
//
//  Este plugin devolve os TRES efeitos de estado que a queda
//  custa e que sao reproduziveis de fora. Sao tres porque o
//  PopulateLoot nativo, desmontado inteiro, escreve exatamente
//  dois campos alem de encher o inventario - HasBeenLooted e
//  FirstLooterId -, e o SpawnLoot arma o cronometro depois dele.
//
//  O que ele NAO devolve, e nem tenta: encher o inventario. Esse
//  e o trabalho que o plugin que cancelou assumiu, e refaze-lo
//  seria dobrar o loot.
//
//  ####  DEFEITO 1: O CRONOMETRO  ####
//
//  Uma varredura no Assembly-CSharp inteiro mostrou que so
//  quatro metodos armam esse cronometro - para um LootContainer
//  comum, apenas SpawnLoot e Load. Sem ele o container nunca
//  mais repopula. Medido ao vivo em 06/09/2026: 0 de 30
//  rearmaram com o BetterLoot ativo, 30 de 30 sem ele.
//
//  A degradacao e progressiva e silenciosa: cada container morre
//  quando o proprio cronometro vence (1 a 2 h), sem log nenhum.
//  E remover o plugin nao desfaz - os orfaos continuam orfaos.
//
//  ####  DEFEITO 2: A MARCA DE SAQUEADO  ####
//
//  LootContainer::OnItemAddedOrRemoved, 19 bytes de IL:
//
//      if (bAdded) return;
//      this.HasBeenLooted = true;
//
//  Ou seja: TODA remocao de item marca o container. E o proprio
//  SpawnLoot chama inventory.Clear() na linha antes do hook -
//  entao a marca sobe SEMPRE, cancelado ou nao. Quem a desmarca
//  e uma linha so no Assembly-CSharp inteiro: o
//  LootContainer::PopulateLoot, que o hook cancelado pula.
//
//  Quem LE a marca, tambem no assembly inteiro, sao dois:
//
//    JunkPile::SpawnGroupsEmpty
//        despawna o junkpile quando todos os LootContainer dos
//        spawngroups dele estao marcados. Este e o efeito caro:
//        medido em 06/09/2026, 47 % dos containers do mundo
//        sumiram em 6 minutos com o BetterLoot ativo.
//
//    PuzzleReset::HasPuzzleBeenPartialLooted
//        com a marca presa em true o puzzle de monumento nunca
//        pausa: ele reseta no ciclo cheio mesmo sem ninguem ter
//        entrado. E o efeito barato, e vai na direcao oposta -
//        loot de monumento a mais, nao a menos.
//
//  ####  DEFEITO 3: O PRIMEIRO SAQUEADOR  ####
//
//  FirstLooterId e a ultima linha do PopulateLoot. Preso em
//  nao-zero, o LootContainer::OnStartBeingLooted pula o bloco do
//  primeiro saqueador para sempre: nada de AddClanScore, e os
//  itens novos nao recebem SetItemOwnership. E o mais barato dos
//  tres, e sai de graca junto com a marca.
//
//  ####  O CONSERTO  ####
//
//  Assinamos o mesmo OnLootSpawn, SEMPRE devolvemos null (quem
//  devolve nao-nulo causa o defeito, nao o conserta) e, no tick
//  seguinte, refazemos o que o PopulateLoot faria: cronometro se
//  faltou, marca limpa se sobrou, primeiro saqueador zerado.
//
//  ####  POR QUE LIMPAR A MARCA NO NextTick E EXATO  ####
//
//  Nao e heuristica. Naquele instante o container ACABOU de ser
//  populado - pelo jogo ou pelo plugin que cancelou -, e
//  HasBeenLooted = false e literalmente a ultima linha do
//  PopulateLoot nativo. Se ninguem cancelou, o jogo ja escreveu
//  false e a nossa escrita e idempotente.
//
//  A janela de erro e de um frame: um jogador que tirasse um
//  item entre o SpawnLoot e o nosso tick teria a marca apagada.
//  O custo disso e um junkpile que vive ate o TimeOut em vez de
//  sumir cedo - e o JunkPile::TimeOut despawna incondicional-
//  mente (lido no IL), entao nem nesse caso ha acumulo.
//
//  ####  POR QUE A ORDEM DOS PLUGINS NAO IMPORTA  ####
//
//  Lido no IL de Oxide.Core.Plugins.PluginManager::CallHook: ele
//  percorre TODOS os plugins inscritos no hook, guarda os
//  retornos nao-nulos e so entao devolve. Nao ha "parar no
//  primeiro que cancelou". Nosso metodo e chamado com o
//  BetterLoot ativo, venha antes ou depois dele.
//
//  E o conserto roda no NextTick, ou seja, DEPOIS que o
//  SpawnLoot terminou - cancelado ou nao. Nesse ponto a pergunta
//  "sobrou cronometro?" tem uma resposta so, e ela nao depende
//  de quem carregou primeiro.
//
//  ####  POR QUE ELE NAO DUPLICA CRONOMETRO  ####
//
//  Duas travas, uma de cada lado:
//
//    1. no caminho normal (ninguem cancelou) o jogo ja armou o
//       cronometro antes do nosso tick, e o IsInvoking responde
//       "sim" - nao mexemos em nada;
//    2. StartLootRefreshCountdown comeca chamando
//       CancelLootRefreshCountdown (lido no IL), entao ele e
//       idempotente por construcao.
//
//  ####  A ARMADILHA DE MEDICAO QUE ESTE PLUGIN EVITA  ####
//
//  isLootCountdownRunning MENTE. Ele so vira false dentro do
//  CancelLootRefreshCountdown, que o hook cancelado pula; quando
//  o Invoke dispara sozinho o agendador tira a invocacao da
//  lista e ninguem toca no campo. A verdade do agendador e
//  IsInvoking(actionSpawnLoot), e e o que este plugin le.
//
//  ####  O QUE ACONTECE SE O RUST MUDAR  ####
//
//  StartLootRefreshCountdown e actionSpawnLoot sao privados: sao
//  alcancados por reflexao, resolvida uma vez no Init. Se um
//  update do jogo renomear qualquer um dos dois, o plugin NAO
//  finge que funcionou - ele grita no console de boot, marca-se
//  como desligado e para de tocar em container nenhum. O
//  comando origemz.loot.refresh repete o motivo.
//
//  ####  OS NUMEROS QUE ISTO CUSTOU E RESOLVEU  ####
//
//  Medido no server01 em 06/09/2026, com o dono jogando, pelo
//  par origemz.loot.diag arm/read sobre a mesma amostra de 30:
//
//    BetterLoot, sem este plugin   armed_after =  0 de 30
//    BetterLoot, com este plugin   armed_after = 30 de 30
//    sem BetterLoot, com ele       armed_after = 30 de 30
//
//  E o mesmo resultado com o BetterLoot carregado antes e depois
//  deste plugin - a ordem nao muda nada, como o IL prometia.
//
//  Contadores no mesmo periodo:
//
//    com BetterLoot     spawns=469  rearmed=469  already=0
//    sem BetterLoot     spawns=88   rearmed=0    already=88
//
//  Ou seja: com o BetterLoot ativo, CEM POR CENTO das populacoes
//  perdiam o cronometro; sem ele, este plugin nao toca em nada.
//
//  Custo: 4,8 us por populacao quando ha o que consertar, 2,4 us
//  quando nao ha. A uma taxa medida de ~5 populacoes por segundo,
//  isso da 25 microssegundos de CPU por segundo de servidor.
//
//  ####  OS COMANDOS  ####
//
//  origemz.loot.refresh
//      Contadores. spawns e quantas populacoes passaram por
//      aqui; rearmed e quantas precisaram de conserto. Num
//      servidor sem plugin que cancele o hook, rearmed fica em
//      zero - e essa e a forma de saber que o remendo virou
//      desnecessario.
//
//  origemz.loot.refresh sweep
//      Varredura de rede: percorre o mundo, rearma quem pode
//      repopular e esta sem cronometro, e limpa a marca de quem
//      ficou marcado com o inventario cheio. Existe para dois
//      motivos - consertar orfao que nasceu antes deste plugin
//      subir, e alcancar o que o hook NAO alcanca.
//
//      ####  O QUE O HOOK NAO ALCANCA  ####
//
//      O BetterLoot popula o mundo inteiro no load pelo proprio
//      UpdateInternals, chamando o PopulateContainer dele
//      DIRETAMENTE - sem passar pelo SpawnLoot e, portanto, sem
//      disparar o OnLootSpawn. No log isso e a linha
//      "Populated (6041) supported loot containers".
//
//      Nessas 6041 populacoes o nosso hook nao e chamado, e as
//      6041 marcas ficam presas em true de uma vez. Foi essa - e
//      nao o refresh - a causa da queda de 47 % em 6 minutos: os
//      junkpiles morreram muito antes de qualquer cronometro
//      vencer.
//
//      Por isso o sweep tambem roda sozinho alguns segundos
//      depois de QUALQUER plugin carregar (ver OnPluginLoaded).
//
//      ####  A TRAVA DO SWEEP  ####
//
//      No hook sabemos que houve populacao. No sweep nao
//      sabemos: um container marcado pode ter sido esvaziado por
//      um jogador de verdade, e apagar essa marca seguraria um
//      junkpile que o jogo queria despawnar.
//
//      Entao o sweep so limpa a marca de container com item
//      dentro. Quem foi esvaziado por jogador fica como esta.
//      Nao e perfeito - saque parcial cai do lado errado - mas o
//      erro custa um junkpile a mais por um ciclo, e o acerto
//      custa metade do mundo.
//
//  origemz.loot.refresh reset
//      Zera os contadores.
// ============================================================

using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    [Info("OrigemZLootRefresh", "OrigemZ", "1.0.0")]
    [Description("Rearma o cronometro de refresh que um OnLootSpawn cancelado deixa para tras")]
    internal class OrigemZLootRefresh : RustPlugin
    {
        private const string StatsCommand = "origemz.loot.refresh";

        // Distancia entre "um plugin carregou" e "o UpdateInternals
        // dele terminou de popular o mundo". Medido no server01:
        // 6041 containers levaram menos de 3 s; 10 s e folga.
        private const float SweepDelaySeconds = 10f;

        // ####  A REFLEXAO, RESOLVIDA UMA VEZ  ####
        //
        // Os dois membros do jogo que este plugin precisa sao
        // privados. Em vez de MethodInfo.Invoke a cada populacao,
        // eles viram delegates abertos: a chamada fica com custo
        // de chamada normal, e a reflexao acontece so no Init.
        private static Func<LootContainer, Action> _readSpawnAction;
        private static Action<LootContainer, float?> _startCountdown;
        private static string _reflectionError = string.Empty;
        private static bool _ready;

        // Fila do frame. O hook so empilha; quem decide e o
        // FlushPending, no tick seguinte.
        private readonly List<LootContainer> _pending = new List<LootContainer>();
        private bool _flushScheduled;

        private long _spawnsSeen;
        private long _alreadyArmed;
        private long _rearmed;
        private long _unmarked;
        private long _firstLooterReset;
        private long _vanished;
        private long _flushes;
        private double _flushMillis;
        private bool _warnedNotReady;

        // Debounce do sweep automatico. No boot os 13 plugins
        // carregam em sequencia; sem isto seriam 13 varreduras do
        // mundo inteiro. A geracao faz a ultima ganhar.
        private int _sweepGeneration;
        private long _autoSweeps;

        private void Init()
        {
            ResolveReflection();

            if (!_ready)
            {
                PrintError("DESLIGADO: o LootContainer deste servidor nao tem "
                    + _reflectionError
                    + "- o cronometro de refresh NAO sera rearmado. "
                    + "Provavel update do Rust: confira os nomes no Assembly-CSharp.");
            }
        }

        private void OnServerInitialized()
        {
            if (_ready)
            {
                // Orfao que nasceu antes deste plugin subir nao se
                // conserta sozinho: ninguem mais vai chamar
                // SpawnLoot nele. A varredura de boot os alcanca.
                RunSweep(null);
                return;
            }

            PrintError("DESLIGADO: sem " + _reflectionError + "- veja o erro do Init.");
        }

        private static void ResolveReflection()
        {
            if (_ready)
            {
                return;
            }

            const BindingFlags Flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            Type type = typeof(LootContainer);
            StringBuilder missing = new StringBuilder();

            PropertyInfo spawnAction = type.GetProperty("actionSpawnLoot", Flags);
            MethodInfo startCountdown = type.GetMethod(
                "StartLootRefreshCountdown", Flags, null, new Type[] { typeof(float?) }, null);

            MethodInfo spawnActionGetter = spawnAction == null ? null : spawnAction.GetGetMethod(true);

            if (spawnActionGetter == null)
            {
                missing.Append("actionSpawnLoot ");
            }

            if (startCountdown == null)
            {
                missing.Append("StartLootRefreshCountdown ");
            }

            if (missing.Length == 0)
            {
                try
                {
                    _readSpawnAction = (Func<LootContainer, Action>)Delegate.CreateDelegate(
                        typeof(Func<LootContainer, Action>), spawnActionGetter);
                    _startCountdown = (Action<LootContainer, float?>)Delegate.CreateDelegate(
                        typeof(Action<LootContainer, float?>), startCountdown);
                }
                catch (Exception ex)
                {
                    missing.Append("delegate(" + ex.GetType().Name + ") ");
                }
            }

            _reflectionError = missing.ToString();
            _ready = _reflectionError.Length == 0;
        }

        // O relogio de parede do Windows anda de 15 em 15 ms: com
        // ele, medir um flush de microssegundos so devolvia zero.
        private static double ElapsedMillis(long since)
        {
            return (System.Diagnostics.Stopwatch.GetTimestamp() - since)
                * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
        }

        // ####  A PERGUNTA AO AGENDADOR  ####
        //
        // IsInvoking consulta o InvokeHandler, que e quem de fato
        // guarda a lista de invocacoes pendentes. O delegate nasce
        // preguicoso: nulo significa que StartLootRefreshCountdown
        // nunca rodou neste container - logo, nada agendado.
        private static bool IsRefreshArmed(LootContainer container)
        {
            Action action = _readSpawnAction(container);

            return action != null && container.IsInvoking(action);
        }

        // ####  O HOOK  ####
        //
        // Ele NUNCA devolve nao-nulo. Devolver nao-nulo aqui seria
        // fazer com o proximo plugin exatamente o que o BetterLoot
        // faz com o jogo.
        private object OnLootSpawn(LootContainer container)
        {
            if (!_ready)
            {
                if (!_warnedNotReady)
                {
                    _warnedNotReady = true;
                    PrintError("DESLIGADO: chegou populacao de loot e o plugin nao "
                        + "consegue rearmar cronometro (falta " + _reflectionError + ").");
                }

                return null;
            }

            if (container == null || container.IsDestroyed)
            {
                return null;
            }

            // ####  ENTRA TODO MUNDO, E NAO SO QUEM REPOPULA  ####
            //
            // Ate a versao 1.0.0 este filtro era
            // "!shouldRefreshContents -> sai", porque o unico
            // conserto era o cronometro. A marca de saqueado nao
            // tem nada a ver com repopular: um container de
            // refresh infinito tambem e lido pelo
            // JunkPile::SpawnGroupsEmpty. O filtro do cronometro
            // desceu para o FlushPending, onde ele pertence.
            _spawnsSeen++;
            _pending.Add(container);

            if (!_flushScheduled)
            {
                _flushScheduled = true;
                NextTick(FlushPending);
            }

            return null;
        }

        // ####  O CONSERTO, UM TICK DEPOIS  ####
        //
        // Aqui o SpawnLoot ja terminou - cancelado ou nao -, entao
        // "sobrou cronometro?" tem resposta unica e a ordem de
        // carga dos plugins deixou de importar.
        private void FlushPending()
        {
            _flushScheduled = false;

            long startTicks = System.Diagnostics.Stopwatch.GetTimestamp();

            for (int index = 0; index < _pending.Count; index++)
            {
                LootContainer container = _pending[index];

                if (container == null || container.IsDestroyed)
                {
                    // O BetterLoot destroi containers empilhados no
                    // boot; eles caem aqui e nao sao defeito nosso.
                    _vanished++;
                    continue;
                }

                // ####  A MARCA, E POR QUE ELA VEM PRIMEIRO  ####
                //
                // Ela nao depende de shouldRefreshContents: o
                // JunkPile le a marca de qualquer LootContainer
                // dos spawngroups dele. Deixa-la depois do
                // `continue` do cronometro perderia exatamente os
                // containers de refresh infinito.
                if (container.HasBeenLooted)
                {
                    container.HasBeenLooted = false;
                    _unmarked++;
                }

                // ####  O TERCEIRO CAMPO, QUE FECHA O PopulateLoot  ####
                //
                // Ultima linha do PopulateLoot nativo, depois da
                // marca. Sem ela o LootContainer::OnStartBeingLooted
                // pula o bloco do primeiro saqueador para sempre:
                // nada de AddClanScore e nada de SetItemOwnership
                // nos itens novos. Custa a mesma atribuicao.
                if (container.FirstLooterId != 0uL)
                {
                    container.FirstLooterId = 0uL;
                    _firstLooterReset++;
                }

                if (!container.shouldRefreshContents)
                {
                    // Container sem refresh finito nao tem
                    // cronometro para perder. Rearmar um deles
                    // seria pior que nao fazer nada: o
                    // Range(0, 0) dispararia na hora.
                    continue;
                }

                if (IsRefreshArmed(container))
                {
                    _alreadyArmed++;
                    continue;
                }

                _startCountdown(container, null);
                _rearmed++;
            }

            _pending.Clear();
            _flushes++;
            _flushMillis += ElapsedMillis(startTicks);
        }

        [ConsoleCommand(StatsCommand)]
        private void CommandLootRefresh(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null)
            {
                return;
            }

            try
            {
                string mode = arg.GetString(0, string.Empty);

                if (mode == "sweep")
                {
                    RunSweep(arg);
                    return;
                }

                if (mode == "reset")
                {
                    _spawnsSeen = 0;
                    _alreadyArmed = 0;
                    _rearmed = 0;
                    _unmarked = 0;
                    _firstLooterReset = 0;
                    _vanished = 0;
                    _flushes = 0;
                    _flushMillis = 0;
                    _autoSweeps = 0;
                    arg.ReplyWith("contadores zerados");
                    return;
                }

                StringBuilder sb = new StringBuilder();
                sb.AppendLine("##### OZ LOOT REFRESH #####");
                sb.AppendLine("estado=" + (_ready ? "ativo" : "DESLIGADO (" + _reflectionError + ")"));
                sb.AppendLine("spawns=" + _spawnsSeen
                    + " already_armed=" + _alreadyArmed
                    + " rearmed=" + _rearmed
                    + " unmarked=" + _unmarked
                    + " first_looter_reset=" + _firstLooterReset
                    + " vanished=" + _vanished);
                sb.AppendLine("auto_sweeps=" + _autoSweeps);
                sb.AppendLine("flushes=" + _flushes
                    + " flush_total_ms=" + _flushMillis.ToString("F2")
                    + " us_por_spawn=" + (_spawnsSeen > 0
                        ? (1000.0 * _flushMillis / _spawnsSeen).ToString("F1")
                        : "n/a"));
                sb.AppendLine(_rearmed == 0
                    ? "LEITURA: nenhuma populacao precisou de cronometro ate agora."
                    : "LEITURA: " + _rearmed + " containers teriam parado de repopular sem este plugin.");
                sb.AppendLine(_unmarked == 0
                    ? "LEITURA: nenhuma marca de saqueado ficou presa ate agora."
                    : "LEITURA: " + _unmarked + " containers teriam mentido que foram saqueados, "
                        + "e os junkpiles deles teriam despawnado.");
                arg.ReplyWith(sb.ToString());
            }
            catch (Exception ex)
            {
                arg.ReplyWith("ERRO: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        // ####  A VARREDURA  ####
        //
        // Alcanca o que o hook nao alcanca: container que perdeu o
        // cronometro antes deste plugin existir. Nao substitui o
        // hook - um container sem cronometro nunca mais chama
        // SpawnLoot, entao sem o hook a varredura teria de rodar
        // para sempre, de tempos em tempos.
        //
        // arg nulo = chamada interna (o boot), sem resposta.
        private void RunSweep(ConsoleSystem.Arg arg)
        {
            if (!_ready)
            {
                if (arg != null)
                {
                    arg.ReplyWith("DESLIGADO: falta " + _reflectionError);
                }

                return;
            }

            long startTicks = System.Diagnostics.Stopwatch.GetTimestamp();
            int entities = 0;
            int containers = 0;
            int refreshable = 0;
            int healed = 0;
            int cleared = 0;
            int markedButEmpty = 0;

            foreach (BaseNetworkable entity in BaseNetworkable.serverEntities)
            {
                entities++;

                LootContainer container = entity as LootContainer;

                if (container == null || container.IsDestroyed)
                {
                    continue;
                }

                containers++;

                // ####  A MARCA, COM A TRAVA DO SWEEP  ####
                //
                // Ver o cabecalho: aqui nao sabemos se houve
                // populacao, entao a marca so cai em container que
                // tem item dentro. Container marcado E vazio e o
                // retrato de quem um jogador esvaziou - a marca
                // dele e verdadeira e fica.
                if (container.HasBeenLooted)
                {
                    ItemContainer inventory = container.inventory;

                    if (inventory != null && inventory.itemList != null && inventory.itemList.Count > 0)
                    {
                        container.HasBeenLooted = false;
                        container.FirstLooterId = 0uL;
                        cleared++;
                    }
                    else
                    {
                        markedButEmpty++;
                    }
                }

                if (!container.shouldRefreshContents)
                {
                    continue;
                }

                refreshable++;

                if (IsRefreshArmed(container))
                {
                    continue;
                }

                _startCountdown(container, null);
                healed++;
            }

            double millis = ElapsedMillis(startTicks);

            string line = "sweep: entities=" + entities
                + " containers=" + containers
                + " refreshable=" + refreshable
                + " healed=" + healed
                + " unmarked=" + cleared
                + " marked_but_empty=" + markedButEmpty
                + " ms=" + millis.ToString("F1");

            if (arg == null)
            {
                if (healed > 0 || cleared > 0)
                {
                    PrintWarning(line + " (varredura automatica)");
                }

                return;
            }

            arg.ReplyWith("##### OZ LOOT REFRESH - SWEEP #####\n" + line);
        }

        // ####  O SWEEP QUE O HOOK NAO DISPENSA  ####
        //
        // O BetterLoot popula o mundo inteiro no NextTick do
        // proprio load, chamando o PopulateContainer dele direto -
        // sem SpawnLoot, logo sem OnLootSpawn. Nosso hook nao ve
        // nenhuma dessas populacoes, e sao elas que marcam os 6041
        // containers de uma vez.
        //
        // Nao ha hook do Oxide para "o BetterLoot terminou de
        // popular". Ha um para "um plugin carregou", e o atraso
        // cobre a distancia entre um e outro.
        private void OnPluginLoaded(Plugin plugin)
        {
            if (plugin == null || plugin == this)
            {
                return;
            }

            ScheduleSweep(SweepDelaySeconds);
        }

        private void ScheduleSweep(float delaySeconds)
        {
            _sweepGeneration++;
            int generation = _sweepGeneration;

            timer.Once(delaySeconds, delegate
            {
                // No boot os plugins carregam em sequencia; so a
                // ultima varredura agendada roda.
                if (generation != _sweepGeneration || !_ready)
                {
                    return;
                }

                _autoSweeps++;
                RunSweep(null);
            });
        }
    }
}
