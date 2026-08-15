// Requires: OrigemZAgent

// ============================================================
//  OrigemZVip.cs
//
//  Aplica no jogo o que o OrigemZAgent manda sobre VIP: cria os
//  grupos do Oxide com a heranca encadeada, poe e tira o jogador
//  do grupo do nivel ativo, e mostra o status para ele.
//
//  ESTE PLUGIN NAO GUARDA ESTADO DE VIP. A fonte da verdade e o
//  SQLite do RustAgent, e quem fala com ele e o OrigemZAgent.
//  Nada de nivel nem de validade vai para oxide\data ou para o
//  config - estado duplicado em dois lugares diverge, e o lugar
//  que diverge sempre e o que ninguem olha. O config daqui e de
//  AJUSTE (nomes de grupo, rank, heranca), nunca de estado.
//
//  Contrato de hook: Docs\OrigemZAgent\HOOKS.md
//  Config:           Docs\OrigemZAgent\config\OrigemZVip.md
//
//  Cinco regras valem para o arquivo inteiro:
//
//   1. NENHUMA chamada ao agente em Init(). O Oxide so garante as
//      dependencias a partir de OnServerInitialized(), e chamar
//      antes disso da null sem erro nenhum.
//
//   2. [PluginReference] vira null quando o alvo e descarregado -
//      o Oxide zera o campo em HandleRemovedFromManager. Por isso
//      o null-check esta em TODA chamada, e nao so na primeira.
//
//   3. A LISTA DE NIVEIS E DADO, NAO 'if'. Ela sai do config e
//      atravessa o plugin inteiro como lista; o quarto nivel entra
//      editando JSON, sem tocar em codigo.
//
//   4. Nada de sintaxe acima de C# 6. O compilador em tempo de
//      execucao do Oxide para nesse teto, e codigo mais novo
//      compila no MSBuild e e recusado no servidor - com erro
//      longe da causa. Sem "out var", sem tupla, sem funcao local,
//      sem pattern matching.
//
//   5. Texto que o jogador le sai do lang, nunca do codigo. O
//      identificador ("gold") e protocolo e viaja entre site,
//      banco, agente e plugin; o rotulo ("VIP OURO") e tela.
//
//  ------------------------------------------------------------
//  #### O QUE ESTE PLUGIN NAO FAZ ####
//
//  Loadout por nivel esta "a definir" no
//  Docs\OrigemZAgent\config\OrigemZVip.md - hook, conteudo e
//  tabela de origem, os tres em aberto. Nao ha chave "Loadouts"
//  neste config: uma chave vazia seria lida como formato
//  escolhido, e ele nao foi.
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json;

// [PluginReference] e o tipo Plugin moram em Oxide.Core.Plugins.
// [Info], [Description], [ChatCommand] e [ConsoleCommand] vem do
// Oxide.CSharp, no proprio namespace Oxide.Plugins - por isso nao
// precisam de using aqui.
using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    // O nome em [Info], o nome da classe e o nome do arquivo tem
    // de ser identicos, senao o Oxide recusa carregar.
    [Info("OrigemZVip", "OrigemZ", "0.1.0")]
    [Description("Aplica o VIP no jogo: grupos do Oxide, sincronizacao na conexao e tela de status. O estado mora no RustAgent")]
    public class OrigemZVip : RustPlugin
    {
        // ========================================================
        //  DEPENDENCIA
        //
        //  O "// Requires: OrigemZAgent" la em cima torna a
        //  dependencia obrigatoria: este plugin nao inicia sem o
        //  agente, e descarregar o agente descarrega este junto. E
        //  reload em cadeia, e e proposital.
        // ========================================================
        [PluginReference]
        private Plugin OrigemZAgent;

        // Nome de hook e string dos dois lados da fronteira: erro
        // de digitacao aqui so apareceria em runtime, no servidor.
        // Constante ao menos concentra o erro num lugar so.
        private const string HookGetApiVersion = "GetApiVersion";
        private const string HookGetVipTier = "GetVipTier";
        private const string HookGetVipInfo = "GetVipInfo";

        // Versao do contrato contra a qual este plugin foi escrito.
        // Divergencia e AVISO, nao recusa: o agente pode ter subido
        // primeiro numa atualizacao, e derrubar o VIP inteiro por
        // causa de um numero seria pior do que seguir com aviso.
        private const int ExpectedAgentApiVersion = 1;

        // ========================================================
        //  CODIGOS DE ERRO
        //
        //  Os mesmos de Docs\OrigemZAgent\HOOKS.md:
        //  SCREAMING_SNAKE_CASE, nunca frase para o jogador. Quem
        //  le isto e o agente e o admin no log.
        // ========================================================
        private const string ErrorInvalidArgs = "INVALID_ARGS";
        private const string ErrorInvalidTier = "INVALID_TIER";
        private const string ErrorAgentUnavailable = "AGENT_UNAVAILABLE";
        private const string ErrorInternal = "INTERNAL_ERROR";

        // Prefixo "origemz." porque comando de console no Oxide e
        // global: sem namespace, dois plugins com um comando
        // "apply" colidiriam.
        private const string ApplyCommand = "origemz.vip.apply";
        private const string StatusChatCommand = "vip";

        private const int SteamId64Length = 17;

        // ========================================================
        //  CHAVES DO LANG
        //
        //  O rotulo de cada nivel e montado com o prefixo mais o
        //  identificador do nivel ("TierLabel.gold"), e nao numa
        //  tabela fixa: nivel acrescentado no config ganha rotulo
        //  acrescentando uma linha no arquivo de lang, sem codigo
        //  novo. Sem a linha, ver ResolveTierLabel.
        // ========================================================
        private const string TierLabelPrefix = "TierLabel.";
        private const string MsgStatusNone = "StatusNone";
        private const string MsgStatusActive = "StatusActive";
        private const string MsgLifetime = "Lifetime";
        private const string MsgExpiresAt = "ExpiresAt";
        private const string MsgDateFormat = "DateFormat";
        private const string MsgUnavailable = "Unavailable";

        private PluginConfig _config;

        // Os niveis JA VALIDADOS, na ordem do config. Lista vazia
        // ate o OnServerInitialized montar - ver _ready.
        private List<VipLevel> _levels = new List<VipLevel>();

        // Falso ate o OnServerInitialized terminar. Enquanto for
        // falso, ninguem sincroniza: os grupos podem nao existir
        // ainda, e chamar hook do agente antes desse ponto e
        // justamente o que a regra 1 proibe.
        private bool _ready;

        // ========================================================
        //  CICLO DE VIDA
        // ========================================================
        private void Init()
        {
            // So log. Qualquer conversa com o agente daqui devolve
            // null sem erro - ver regra 1 no topo do arquivo.
            Puts("Init() - comandos: /" + StatusChatCommand + " (chat), " + ApplyCommand +
                 " (console). Contrato do agente esperado: v" + ExpectedAgentApiVersion + ".");
        }

        private void OnServerInitialized()
        {
            try
            {
                _levels = BuildLevels(_config);

                if (_levels.Count == 0)
                {
                    PrintError("Nenhum nivel utilizavel no config: o plugin carregou, mas nao " +
                               "aplica VIP nenhum. Ver Server\\oxide\\config\\OrigemZVip.json.");
                }

                EnsureGroups();
                LogAgentApiVersion();

                _ready = true;
            }
            catch (Exception ex)
            {
                // _ready continua falso: com o boot pela metade, e
                // melhor nao sincronizar ninguem do que sincronizar
                // contra grupos que podem nao existir.
                PrintError("OnServerInitialized falhou; a sincronizacao fica desligada ate um reload: " + ex);
            }
        }

        // ========================================================
        //  SINCRONIZACAO NA CONEXAO
        //
        //  E ela que conserta sozinha o VIP que venceu com o
        //  jogador OFFLINE: ninguem estava no servidor para o
        //  agente avisar, e o grupo continuou concedido. Ao entrar,
        //  o jogador e comparado com o que o agente diz agora.
        // ========================================================
        private void OnPlayerConnected(BasePlayer player)
        {
            if (player == null)
            {
                return;
            }

            SyncOutcome outcome = SyncPlayer(player.UserIDString);

            if (outcome.Error != null)
            {
                // Aviso, e nao erro: a entrada do jogador nao pode
                // depender disto, e o proximo origemz.vip.apply ou
                // a proxima conexao tentam de novo.
                PrintWarning("VIP nao sincronizado na conexao de " + player.UserIDString +
                             " (" + outcome.Error + ").");
                return;
            }

            // Log so quando algo MUDOU. Uma linha por conexao viraria
            // ruido num servidor cheio, e o caso comum e nada mudar.
            if (outcome.Added > 0 || outcome.Removed > 0)
            {
                Puts("VIP sincronizado para " + player.UserIDString + ": nivel " +
                     (outcome.Tier ?? "-") + ", " + outcome.Added + " grupo(s) concedido(s) e " +
                     outcome.Removed + " retirado(s).");
            }
        }

        // ========================================================
        //  GRUPOS
        //
        //  Duas passadas, e nao uma: com uma so, o pai declarado
        //  DEPOIS do filho no config ainda nao existiria na hora do
        //  SetGroupParent, e a heranca seria recusada por ordem de
        //  digitacao do JSON.
        //
        //  CreateGroup ja e "criar se nao existir": ele devolve
        //  false quando o grupo esta la, sem tocar em titulo nem em
        //  rank. Nao alterar grupo existente e proposital - rank e
        //  titulo podem ter sido ajustados a mao por um admin.
        // ========================================================
        private void EnsureGroups()
        {
            int created = 0;

            for (int i = 0; i < _levels.Count; i++)
            {
                VipLevel level = _levels[i];

                if (permission.CreateGroup(level.Group, level.Title, level.Rank))
                {
                    created++;
                }
            }

            int linked = 0;

            for (int i = 0; i < _levels.Count; i++)
            {
                if (ApplyGroupParent(_levels[i]))
                {
                    linked++;
                }
            }

            Puts("Grupos de VIP: " + _levels.Count + " nivel(is) no config, " + created +
                 " grupo(s) criado(s) agora, " + linked + " heranca(s) ajustada(s).");
        }

        // Devolve true quando MUDOU a heranca do grupo.
        //
        // O config manda: GrupoPai vazio limpa o pai, GrupoPai
        // preenchido aponta para ele. Ignorar o vazio deixaria o
        // JSON dizendo uma coisa e o servidor fazendo outra, que e
        // o pior dos dois - a config e o lugar onde o admin espera
        // enxergar a cadeia inteira.
        private bool ApplyGroupParent(VipLevel level)
        {
            string current = permission.GetGroupParent(level.Group);

            if (string.IsNullOrEmpty(level.ParentGroup))
            {
                if (string.IsNullOrEmpty(current))
                {
                    return false;
                }

                permission.SetGroupParent(level.Group, null);
                PrintWarning("Nivel '" + level.Tier + "': GrupoPai vazio no config, entao o grupo '" +
                             level.Group + "' deixou de herdar '" + current + "'.");
                return true;
            }

            // Grupo que e pai de si mesmo trava a resolucao de
            // permissao do Oxide. Recusar aqui e barato; descobrir
            // depois, nao.
            if (string.Equals(level.ParentGroup, level.Group, StringComparison.OrdinalIgnoreCase))
            {
                PrintError("Nivel '" + level.Tier + "': GrupoPai aponta para o proprio grupo '" +
                           level.Group + "'. Heranca ignorada.");
                return false;
            }

            // Pai inexistente nao e criado por conta propria: um
            // grupo vazio com nome parecido esconderia o erro de
            // digitacao em vez de mostra-lo.
            if (!permission.GroupExists(level.ParentGroup))
            {
                PrintError("Nivel '" + level.Tier + "': GrupoPai '" + level.ParentGroup +
                           "' nao existe. Heranca ignorada - confira a ordem e a grafia no config.");
                return false;
            }

            if (string.Equals(current, level.ParentGroup, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            // O Oxide recusa cadeia circular aqui dentro e devolve
            // false. O documento de config lista esse caso como "a
            // definir"; enquanto nao houver regra escrita, a escolha
            // e avisar alto e seguir com a heranca antiga, que ao
            // menos e um estado que ja funcionava.
            if (!permission.SetGroupParent(level.Group, level.ParentGroup))
            {
                PrintError("Nivel '" + level.Tier + "': o Oxide recusou '" + level.ParentGroup +
                           "' como pai de '" + level.Group + "'. Cadeia circular no config? " +
                           "A heranca anterior continua valendo.");
                return false;
            }

            Puts("Heranca: '" + level.Group + "' agora herda '" + level.ParentGroup + "'.");
            return true;
        }

        // ========================================================
        //  O CORACAO: comparar e corrigir
        //
        //  O jogador fica em UM grupo so - o do nivel ativo. Os
        //  beneficios dos niveis abaixo chegam pela heranca do
        //  Oxide, e nao por acumulo de grupos; poe-lo nos tres
        //  faria a heranca virar enfeite e a remocao virar um
        //  problema de tres passos.
        //
        //  Nunca lanca: devolve o codigo de erro dentro do
        //  SyncOutcome. Os dois chamadores (conexao do jogador e
        //  comando do agente) precisam de resposta, nao de excecao.
        // ========================================================
        private SyncOutcome SyncPlayer(string steamId)
        {
            try
            {
                if (!IsSteamId64(steamId))
                {
                    return SyncOutcome.Failure(ErrorInvalidArgs);
                }

                if (!_ready)
                {
                    PrintWarning("Sincronizacao pedida antes de o plugin terminar o boot. Nada foi alterado.");
                    return SyncOutcome.Failure(ErrorInternal);
                }

                // Null-check obrigatorio em toda chamada (regra 2).
                // Sem o agente NAO removemos grupo nenhum: "o hub
                // caiu" nao e "o jogador perdeu o VIP", e limpar
                // aqui revogaria beneficio pago por causa de um
                // reload do agente.
                if (OrigemZAgent == null)
                {
                    return SyncOutcome.Failure(ErrorAgentUnavailable);
                }

                string tier = NormalizeTier(OrigemZAgent.Call(HookGetVipTier, steamId) as string);

                // Nivel que o config nao conhece: nao da para
                // decidir grupo, e tirar o jogador de tudo seria
                // revogar VIP por causa de uma linha removida do
                // JSON. Deixamos como esta e avisamos - ver o
                // OrigemZVip.md, secao "Niveis".
                if (tier != null && FindLevelByTier(tier) == null)
                {
                    PrintError("Agente devolveu o nivel '" + tier + "' para " + steamId +
                               ", que nao existe no config. Grupos NAO foram alterados.");
                    return SyncOutcome.Failure(ErrorInvalidTier);
                }

                int added = 0;
                int removed = 0;

                for (int i = 0; i < _levels.Count; i++)
                {
                    VipLevel level = _levels[i];
                    bool shouldHave = tier != null && level.Tier == tier;
                    bool hasNow = permission.UserHasGroup(steamId, level.Group);

                    if (shouldHave == hasNow)
                    {
                        continue;
                    }

                    if (shouldHave)
                    {
                        permission.AddUserGroup(steamId, level.Group);
                        added++;
                    }
                    else
                    {
                        permission.RemoveUserGroup(steamId, level.Group);
                        removed++;
                    }
                }

                return SyncOutcome.Applied(tier, added, removed);
            }
            catch (Exception ex)
            {
                PrintError("Sincronizacao de VIP falhou para " + steamId + ": " + ex);
                return SyncOutcome.Failure(ErrorInternal);
            }
        }

        // ========================================================
        //  /vip - a tela de status
        //
        //  Le do GetVipInfo, e nao do grupo do Oxide: o grupo e o
        //  reflexo, o agente e a fonte. Perguntar ao reflexo daria
        //  "VIP ativo" para um jogador que o banco ja expirou e o
        //  servidor ainda nao corrigiu.
        // ========================================================
        [ChatCommand(StatusChatCommand)]
        private void CommandVipStatus(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            string userId = player.UserIDString;

            try
            {
                if (!_ready || OrigemZAgent == null)
                {
                    SendReply(player, Msg(MsgUnavailable, userId));
                    return;
                }

                string json = OrigemZAgent.Call(HookGetVipInfo, userId) as string;
                VipTierPayload highest = ReadHighestTier(json);

                if (highest == null)
                {
                    SendReply(player, Msg(MsgStatusNone, userId));
                    return;
                }

                string label = ResolveTierLabel(highest.Tier, userId);
                string validity = FormatValidity(highest.ExpiresAt, userId);

                SendReply(player, string.Format(Msg(MsgStatusActive, userId), label, validity));
            }
            catch (Exception ex)
            {
                // Inclui o FormatException de um lang editado a mao
                // com chave de formato quebrada. O jogador recebe a
                // mensagem de indisponivel; quem precisa do motivo e
                // o admin, e ele esta no log.
                PrintError("/" + StatusChatCommand + " falhou para " + userId + ": " + ex);
                SendReply(player, Msg(MsgUnavailable, userId));
            }
        }

        // ========================================================
        //  origemz.vip.apply <steamId>
        //
        //  O caminho do agente para forcar a sincronizacao logo
        //  depois de conceder ou revogar VIP, sem esperar o jogador
        //  reconectar.
        //
        //      {"ok":true,"steamId":"7656...","tier":"gold","added":1,"removed":0}
        //      {"ok":true,"steamId":"7656...","tier":null,"added":0,"removed":1}
        //      {"ok":false,"error":"AGENT_UNAVAILABLE"}
        //
        //  Resposta de UMA LINHA, como no OrigemZAgent: o agente
        //  separa respostas por linha no RCON, e um JSON quebrado
        //  em varias viraria fragmento invalido.
        //
        //  Funciona com o jogador OFFLINE de proposito - a
        //  permissao do Oxide e por SteamID, nao por BasePlayer.
        //  Exigir o jogador online transformaria "concedi o VIP" em
        //  "concedi o VIP, agora peca para ele entrar".
        // ========================================================
        [ConsoleCommand(ApplyCommand)]
        private void CommandVipApply(ConsoleSystem.Arg arg)
        {
            // Excecao que sobe de um ConsoleCommand vindo do RCON
            // nao produz resposta nenhuma, e o agente fica pendurado
            // ate o timeout. Todo caminho de saida daqui responde.
            try
            {
                arg.ReplyWith(HandleVipApply(arg));
            }
            catch (Exception ex)
            {
                PrintError(ApplyCommand + " falhou: " + ex);
                arg.ReplyWith(BuildError(ErrorInternal));
            }
        }

        private string HandleVipApply(ConsoleSystem.Arg arg)
        {
            // arg.Args e null quando o comando veio sem argumento -
            // indexar antes de checar seria NRE.
            if (arg.Args == null || arg.Args.Length < 1)
            {
                return BuildError(ErrorInvalidArgs);
            }

            // NAO indexe arg.Args diretamente: no Rust atual ele e
            // Facepunch.StringView[], que nao converte para string
            // nem tem os metodos dela. arg.GetString e a API estavel.
            string steamId = arg.GetString(0, "").Trim();

            SyncOutcome outcome = SyncPlayer(steamId);

            if (outcome.Error != null)
            {
                return BuildError(outcome.Error);
            }

            Puts(ApplyCommand + " " + steamId + ": nivel " + (outcome.Tier ?? "-") + ", " +
                 outcome.Added + " grupo(s) concedido(s) e " + outcome.Removed + " retirado(s).");

            return JsonConvert.SerializeObject(new ApplyOkResponse
            {
                SteamId = steamId,
                Tier = outcome.Tier,
                Added = outcome.Added,
                Removed = outcome.Removed
            });
        }

        // ========================================================
        //  AGENTE
        // ========================================================

        // Chamado UMA vez, no boot. Como toda chamada entre plugins
        // e por string, um metodo renomeado do outro lado so falha
        // em runtime - esta versao e o unico aviso antecipado que
        // existe, e por isso ela e lida mesmo sem ninguem usa-la.
        private void LogAgentApiVersion()
        {
            if (OrigemZAgent == null)
            {
                PrintError("OrigemZAgent nao esta carregado - este plugin nao aplica VIP sem ele.");
                return;
            }

            object raw = OrigemZAgent.Call(HookGetApiVersion);

            if (!(raw is int))
            {
                PrintError("GetApiVersion do agente devolveu " + (raw == null ? "null" : raw.ToString()) +
                           ", que nao e um inteiro. O contrato de hook pode ter mudado.");
                return;
            }

            int version = (int)raw;
            Puts("API do agente: v" + version + " (este plugin foi escrito para a v" +
                 ExpectedAgentApiVersion + ").");

            if (version != ExpectedAgentApiVersion)
            {
                PrintWarning("Versao de contrato diferente da esperada. O VIP continua funcionando, " +
                             "mas confira Docs\\OrigemZAgent\\HOOKS.md antes de confiar no resultado.");
            }
        }

        // O nivel mais alto do GetVipInfo. O agente ja devolve os
        // niveis do mais alto para o mais baixo, entao o primeiro
        // basta - e reordenar aqui duplicaria uma regra que e dele.
        //
        // Devolve null quando nao ha nivel ativo, quando o JSON nao
        // veio ou quando ele nao parseia: os tres significam a mesma
        // coisa para a tela, que e "nao ha o que mostrar".
        private VipTierPayload ReadHighestTier(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return null;
            }

            VipInfoPayload payload;

            try
            {
                payload = JsonConvert.DeserializeObject<VipInfoPayload>(json);
            }
            catch (Exception ex)
            {
                PrintWarning("GetVipInfo devolveu JSON ilegivel: " + ex.Message);
                return null;
            }

            if (payload == null || payload.Tiers == null)
            {
                return null;
            }

            for (int i = 0; i < payload.Tiers.Count; i++)
            {
                VipTierPayload tier = payload.Tiers[i];

                if (tier != null && !string.IsNullOrEmpty(tier.Tier))
                {
                    return tier;
                }
            }

            return null;
        }

        // ========================================================
        //  CONFIG
        // ========================================================
        protected override void LoadDefaultConfig()
        {
            _config = PluginConfig.Default();
            PrintWarning("Config novo criado com os tres niveis padrao.");
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();

            try
            {
                _config = Config.ReadObject<PluginConfig>();
            }
            catch (Exception ex)
            {
                // Config ilegivel NAO vira config padrao gravado por
                // cima: sobrescrever apagaria o arquivo que o admin
                // escreveu errado, e com ele a unica pista do que
                // ele quis dizer. Carregamos o padrao em memoria e
                // deixamos o arquivo como esta.
                PrintError("Config ilegivel, usando os padroes SEM gravar por cima. " +
                           "Conserte Server\\oxide\\config\\OrigemZVip.json: " + ex.Message);
                _config = PluginConfig.Default();
                return;
            }

            if (_config == null || _config.Niveis == null)
            {
                LoadDefaultConfig();
            }

            // Grava de volta para o arquivo ganhar as chaves novas de
            // uma versao futura do plugin.
            SaveConfig();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(_config, true);
        }

        // Config cru vira lista validada. Entrada sem identificador
        // ou sem grupo e DESCARTADA, e nao completada com um padrao:
        // adivinhar o nome do grupo criaria um grupo que ninguem
        // pediu e concederia beneficio por acidente.
        private List<VipLevel> BuildLevels(PluginConfig config)
        {
            List<VipLevel> levels = new List<VipLevel>();

            if (config == null || config.Niveis == null)
            {
                return levels;
            }

            HashSet<string> seenTiers = new HashSet<string>(StringComparer.Ordinal);
            HashSet<string> seenGroups = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < config.Niveis.Count; i++)
            {
                TierConfig entry = config.Niveis[i];

                if (entry == null)
                {
                    continue;
                }

                string tier = NormalizeTier(entry.Tier);
                string group = entry.Grupo == null ? null : entry.Grupo.Trim();

                if (tier == null || string.IsNullOrEmpty(group))
                {
                    PrintError("Nivel #" + i + " ignorado: Tier ou Grupo vazio no config.");
                    continue;
                }

                // Tier repetido faria o SyncPlayer conceder e tirar o
                // mesmo jogador no mesmo laco; grupo repetido faria
                // dois niveis brigarem pelo mesmo grupo do Oxide, e
                // quem vence seria a ordem do JSON.
                if (!seenTiers.Add(tier))
                {
                    PrintError("Nivel '" + tier + "' aparece mais de uma vez no config. " +
                               "So a primeira entrada vale.");
                    continue;
                }

                if (!seenGroups.Add(group))
                {
                    PrintError("Grupo '" + group + "' aparece em mais de um nivel do config. " +
                               "So a primeira entrada vale.");
                    continue;
                }

                levels.Add(new VipLevel
                {
                    Tier = tier,
                    Group = group,

                    // Titulo vazio nao impede nada: e rotulo
                    // administrativo do oxide.group, e o nome do
                    // grupo e um padrao honesto para ele.
                    Title = string.IsNullOrEmpty(entry.Titulo) ? group : entry.Titulo,
                    Rank = entry.Rank,
                    ParentGroup = entry.GrupoPai == null ? string.Empty : entry.GrupoPai.Trim()
                });
            }

            return levels;
        }

        // ========================================================
        //  LANG
        //
        //  #### POR QUE \uXXXX EM VEZ DE ACENTO DIRETO ####
        //
        //  O arquivo fonte e ASCII puro de proposito: ele viaja do
        //  MSBuild para Server\oxide\plugins e e recompilado la pelo
        //  Oxide, e byte acentuado dependeria de os dois lados
        //  concordarem sobre a codificacao. O escape resolve isso no
        //  compilador, antes de existir arquivo.
        //
        //  O jogador nunca ve o escape: o Oxide grava o lang em
        //  Server\oxide\lang\<idioma>\OrigemZVip.json ja com o
        //  caractere certo, e a partir dai o admin edita o texto la,
        //  em UTF-8, sem passar por aqui.
        // ========================================================
        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>
            {
                { MsgStatusNone, "You have no active VIP." },
                { MsgStatusActive, "{0} - {1}" },
                { MsgLifetime, "Lifetime" },
                { MsgExpiresAt, "until {0}" },
                { MsgDateFormat, "MM/dd/yyyy" },
                { MsgUnavailable, "VIP service unavailable right now. Try again in a moment." },
                { TierLabelPrefix + "bronze", "VIP BRONZE" },
                { TierLabelPrefix + "silver", "VIP SILVER" },
                { TierLabelPrefix + "gold", "VIP GOLD" }
            }, this);

            lang.RegisterMessages(new Dictionary<string, string>
            {
                // Rende: Voce nao tem VIP ativo.
                { MsgStatusNone, "Voc\u00ea n\u00e3o tem VIP ativo." },
                { MsgStatusActive, "{0} - {1}" },
                // Rende: Vitalicio
                { MsgLifetime, "Vital\u00edcio" },
                // Rende: ate {0}
                { MsgExpiresAt, "at\u00e9 {0}" },
                { MsgDateFormat, "dd/MM/yyyy" },
                // Rende: Servico de VIP indisponivel agora. Tente de novo em instantes.
                { MsgUnavailable, "Servi\u00e7o de VIP indispon\u00edvel agora. Tente de novo em instantes." },
                { TierLabelPrefix + "bronze", "VIP BRONZE" },
                { TierLabelPrefix + "silver", "VIP PRATA" },
                { TierLabelPrefix + "gold", "VIP OURO" }
            }, this, "pt-BR");
        }

        private string Msg(string key, string userId)
        {
            return lang.GetMessage(key, this, userId);
        }

        // O rotulo de tela do nivel. Nivel acrescentado no config
        // sem linha no lang cai no identificador em maiuscula:
        // "PLATINUM" e um rotulo pobre, mas "TierLabel.platinum" na
        // cara do jogador seria vazamento de chave interna.
        private string ResolveTierLabel(string tier, string userId)
        {
            string key = TierLabelPrefix + tier;
            string label = Msg(key, userId);

            // lang.GetMessage devolve a PROPRIA chave quando ela nao
            // esta registrada - e por isso a comparacao com a chave e
            // o teste de "nao existe".
            if (string.IsNullOrEmpty(label) || label == key)
            {
                return tier.ToUpperInvariant();
            }

            return label;
        }

        // expiresAt nulo ou vazio e vitalicio - o contrato do
        // GetVipInfo e explicito nisso.
        private string FormatValidity(string rawExpiresAt, string userId)
        {
            string raw = rawExpiresAt == null ? null : rawExpiresAt.Trim();

            if (string.IsNullOrEmpty(raw))
            {
                return Msg(MsgLifetime, userId);
            }

            // AssumeUniversal + AdjustToUniversal porque o contrato
            // manda ISO 8601 em UTC. Sem AssumeUniversal a data seria
            // lida no fuso do servidor, e a validade mudaria de dia
            // na virada sem ninguem entender por que.
            DateTime expiresAtUtc;
            if (!DateTime.TryParse(raw, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out expiresAtUtc))
            {
                // Data ilegivel NAO vira "Vitalicio": prometeria VIP
                // eterno por causa de um erro de formato. Mostrar o
                // texto cru e feio e honesto, e o log diz ao admin
                // onde olhar.
                PrintWarning("GetVipInfo devolveu expiresAt ilegivel: '" + raw + "'.");
                return string.Format(Msg(MsgExpiresAt, userId), raw);
            }

            // Convertido para o fuso do SERVIDOR: a pergunta que o
            // jogador faz e "ate que dia eu tenho", e o dia dele e o
            // do relogio do servidor, nao o do UTC.
            string date = expiresAtUtc.ToLocalTime()
                .ToString(Msg(MsgDateFormat, userId), CultureInfo.InvariantCulture);

            return string.Format(Msg(MsgExpiresAt, userId), date);
        }

        // ========================================================
        //  AUXILIARES
        // ========================================================

        // Identificador de nivel e SEMPRE ingles minusculo, em toda
        // a cadeia - site, banco, agente e plugin. Normalizar na
        // entrada deixa a comparacao no SyncPlayer ser ordinal
        // simples, e nao um ToLower espalhado por cinco lugares.
        //
        // Devolve null para vazio, que e como "nao e VIP" viaja.
        private static string NormalizeTier(string tier)
        {
            if (string.IsNullOrEmpty(tier))
            {
                return null;
            }

            string normalized = tier.Trim().ToLowerInvariant();
            return normalized.Length == 0 ? null : normalized;
        }

        private VipLevel FindLevelByTier(string tier)
        {
            for (int i = 0; i < _levels.Count; i++)
            {
                if (_levels[i].Tier == tier)
                {
                    return _levels[i];
                }
            }

            return null;
        }

        // 17 digitos ASCII, mesma regra do OrigemZAgent. char.IsDigit
        // aceitaria digito de outro alfabeto, que passaria aqui e
        // seria recusado do outro lado.
        private static bool IsSteamId64(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != SteamId64Length)
            {
                return false;
            }

            for (int i = 0; i < value.Length; i++)
            {
                if (value[i] < '0' || value[i] > '9')
                {
                    return false;
                }
            }

            return true;
        }

        private static string BuildError(string code)
        {
            return JsonConvert.SerializeObject(new ErrorResponse { Error = code });
        }

        // --------------------------------------------------------
        //  Um nivel do config, ja validado e normalizado.
        //
        //  Nao e DTO: nunca vira JSON. O que vai e volta do arquivo
        //  e o TierConfig, com os nomes em portugues que o admin le.
        // --------------------------------------------------------
        private class VipLevel
        {
            public string Tier { get; set; }

            public string Group { get; set; }

            public string Title { get; set; }

            public int Rank { get; set; }

            // Vazio significa "sem pai", e o vazio e aplicado - ver
            // ApplyGroupParent.
            public string ParentGroup { get; set; }
        }

        // --------------------------------------------------------
        //  O resultado de uma sincronizacao.
        //
        //  Classe, e nao quatro parametros out: os dois chamadores
        //  precisam dos mesmos quatro valores, e uma assinatura com
        //  quatro out e um convite a trocar a ordem sem o compilador
        //  reclamar.
        //
        //  Error != null significa que NADA foi alterado.
        // --------------------------------------------------------
        private class SyncOutcome
        {
            public string Error { get; set; }

            // null quando o jogador nao tem nivel ativo.
            public string Tier { get; set; }

            public int Added { get; set; }

            public int Removed { get; set; }

            public static SyncOutcome Failure(string code)
            {
                return new SyncOutcome { Error = code };
            }

            public static SyncOutcome Applied(string tier, int added, int removed)
            {
                return new SyncOutcome { Tier = tier, Added = added, Removed = removed };
            }
        }

        // --------------------------------------------------------
        //  CONFIG
        //
        //  Chaves em portugues porque quem le e edita este arquivo e
        //  o admin do servidor - e so o Tier fica em ingles, porque
        //  ele e protocolo e viaja para fora daqui.
        // --------------------------------------------------------
        private class PluginConfig
        {
            [JsonProperty("Niveis")]
            public List<TierConfig> Niveis { get; set; }

            // Os tres niveis do PLANO.md, com a cadeia
            // bronze <- silver <- gold. Rank 10/20/30 e espacado de
            // proposito: um nivel novo no meio entra sem reescrever
            // os outros.
            public static PluginConfig Default()
            {
                return new PluginConfig
                {
                    Niveis = new List<TierConfig>
                    {
                        new TierConfig
                        {
                            Tier = "bronze",
                            Grupo = "origemz.vip.bronze",
                            Titulo = "VIP Bronze",
                            Rank = 10,
                            GrupoPai = ""
                        },
                        new TierConfig
                        {
                            Tier = "silver",
                            Grupo = "origemz.vip.silver",
                            Titulo = "VIP Silver",
                            Rank = 20,
                            GrupoPai = "origemz.vip.bronze"
                        },
                        new TierConfig
                        {
                            Tier = "gold",
                            Grupo = "origemz.vip.gold",
                            Titulo = "VIP Gold",
                            Rank = 30,
                            GrupoPai = "origemz.vip.silver"
                        }
                    }
                };
            }
        }

        private class TierConfig
        {
            // Identificador de protocolo: ingles minusculo, o mesmo
            // que o agente devolve no GetVipTier.
            [JsonProperty("Tier")]
            public string Tier { get; set; }

            [JsonProperty("Grupo")]
            public string Grupo { get; set; }

            [JsonProperty("Titulo")]
            public string Titulo { get; set; }

            // groupRank do Oxide. NAO da prioridade automatica em
            // nada - e ordenacao que outros plugins podem ou nao
            // ler. Quem decide a fila e a config do OrigemZQueue.
            [JsonProperty("Rank")]
            public int Rank { get; set; }

            [JsonProperty("GrupoPai")]
            public string GrupoPai { get; set; }
        }

        // --------------------------------------------------------
        //  DTOs
        //
        //  Os de ENTRADA descrevem o que o GetVipInfo devolve; os de
        //  SAIDA, o que o origemz.vip.apply responde. Cada campo tem
        //  [JsonProperty] com o nome exato: sem isso o Newtonsoft
        //  usaria PascalCase e o outro lado nao reconheceria nada.
        // --------------------------------------------------------
        private class VipInfoPayload
        {
            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            [JsonProperty("tiers")]
            public List<VipTierPayload> Tiers { get; set; }
        }

        private class VipTierPayload
        {
            [JsonProperty("tier")]
            public string Tier { get; set; }

            // string, e nao DateTime: o parse e feito a mao no
            // FormatValidity, com fuso explicito. Deixar o Newtonsoft
            // converter usaria o fuso do servidor, que e o erro que
            // aquele metodo evita.
            [JsonProperty("expiresAt")]
            public string ExpiresAt { get; set; }
        }

        // "ok" e propriedade so de leitura com valor fixo: assim nao
        // existe caminho de codigo capaz de mandar um erro com
        // ok:true, ou vice-versa.
        private class ApplyOkResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return true; } }

            [JsonProperty("steamId")]
            public string SteamId { get; set; }

            // null quando o jogador ficou sem nivel nenhum. Precisa
            // SAIR como null no JSON: omitir o campo faria "sem VIP"
            // e "campo ausente" virarem a mesma coisa para quem le.
            [JsonProperty("tier")]
            public string Tier { get; set; }

            [JsonProperty("added")]
            public int Added { get; set; }

            [JsonProperty("removed")]
            public int Removed { get; set; }
        }

        private class ErrorResponse
        {
            [JsonProperty("ok")]
            public bool Ok { get { return false; } }

            [JsonProperty("error")]
            public string Error { get; set; }
        }
    }
}
