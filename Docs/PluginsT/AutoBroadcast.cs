using System;
using System.Collections.Generic;
using System.Linq;
using Oxide.Core.Libraries.Covalence;

namespace Oxide.Plugins
{
    [Info("Auto Broadcast", "Wulf / Custom", "1.1.0")]
    [Description("Sends randomly or sequentially configured chat messages from JSON config every X seconds")]

    class AutoBroadcast : CovalencePlugin
    {
        #region Initialization

        const string permBroadcast = "autobroadcast.broadcast";
        bool random;
        int interval;
        int nextIndex;
        List<string> messages = new List<string>();

        protected override void LoadDefaultConfig()
        {
            Config["Randomize Messages (true/false)"] = GetConfig("Randomize Messages (true/false)", false);
            Config["Broadcast Interval (Seconds)"] = GetConfig("Broadcast Interval (Seconds)", 300);

            var defaultMessages = new List<object>
            {
                "<color=#ffe100>[OrigemZ]</color> Bem-vindo! Curta o jogo e respeite as regras.",
                "<color=#ffe100>[OrigemZ]</color> Entre na nossa comunidade: <color=#5865F2>discord.gg/origemz</color>",
                "<color=#ff3333>[OrigemZ]</color> Proibido o uso de hacks ou abusar de exploits."
            };

            Config["Messages"] = GetConfig("Messages", defaultMessages);
            SaveConfig();
        }

        void OnServerInitialized()
        {
            LoadDefaultConfig();
            permission.RegisterPermission(permBroadcast, this);

            random = GetConfig("Randomize Messages (true/false)", false);
            interval = GetConfig("Broadcast Interval (Seconds)", 300);

            var rawMessages = Config["Messages"] as List<object>;
            if (rawMessages != null)
            {
                messages = rawMessages.Select(m => m.ToString()).ToList();
            }

            Broadcast();
        }

        #endregion

        #region Broadcasting

        void Broadcast()
        {
            if (messages == null || messages.Count == 0)
            {
                LogWarning("Nenhuma mensagem configurada na lista 'Messages' no arquivo config!");
                return;
            }

            timer.Every(interval, () =>
            {
                if (players.Connected.Count() <= 0 || messages.Count == 0) return;

                string messageToSend;

                if (random)
                {
                    int randomIndex = new Random().Next(0, messages.Count);
                    messageToSend = messages[randomIndex];
                }
                else
                {
                    if (nextIndex >= messages.Count) nextIndex = 0;
                    messageToSend = messages[nextIndex];
                    nextIndex = (nextIndex + 1) % messages.Count;
                }

                foreach (var player in players.Connected)
                {
                    player.Message(messageToSend);
                }
            });
        }

        #endregion

        #region Helpers

        T GetConfig<T>(string name, T value) => Config[name] == null ? value : (T)Convert.ChangeType(Config[name], typeof(T));

        #endregion
    }
}