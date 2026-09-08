using System.Collections.Generic;
using Newtonsoft.Json;
using UnityEngine;
using Oxide.Core.Libraries.Covalence;
using Oxide.Game.Rust.Libraries;
using System;
using Oxide.Core.Plugins;
using Oxide.Core;
using Oxide.Core.Configuration;
using System.Linq;
using HarmonyLib;
using Rust;
using ProtoBuf;


namespace Oxide.Plugins
{
    [Info("Dungeon Bases", "OrigemZ", "1.3.4")]
    [Description("Dungeon Bases")]

    public class DungeonBases : CovalencePlugin
    {
        private const string Found = "assets/prefabs/building core/foundation/foundation.prefab";
        private const string Wall = "assets/prefabs/building core/wall/wall.prefab";
        private const string DoorF = "assets/prefabs/building core/wall.doorway/wall.doorway.prefab";
        private const string Floor = "assets/prefabs/building core/floor/floor.prefab";
        private const string FloorFrame = "assets/prefabs/building core/floor.frame/floor.frame.prefab";
        private const string LadderHatch = "assets/prefabs/building/floor.ladder.hatch/floor.ladder.hatch.prefab";
        private const string CodeLock = "assets/prefabs/locks/keypad/lock.code.prefab";
        private const string ElecBranch = "assets/prefabs/deployable/playerioents/gates/branch/electrical.branch.deployed.prefab";
        private const string CeilingLight = "assets/prefabs/deployable/ceiling light/ceilinglight.deployed.prefab";
        private const string Lantern = "assets/prefabs/deployable/lantern/lantern.deployed.prefab";
        private const string WeaponRackH = "assets/prefabs/deployable/weaponracks/weaponrack_horizontal.deployed.prefab";
        private const string WeaponRackW = "assets/prefabs/deployable/weaponracks/weaponrack_wide.deployed.prefab";
        private const string WaterBarrel = "assets/prefabs/deployable/liquidbarrel/waterbarrel.prefab";
        private const string WeaponRackLit = "assets/prefabs/deployable/gun_rack/weaponracklightdouble.prefab";
        private static readonly string[] DoorTypes = {
            "assets/prefabs/building/door.hinged/door.hinged.wood.prefab",
            "assets/prefabs/building/door.hinged/door.hinged.metal.prefab",
            "assets/prefabs/building/door.hinged/door.hinged.toptier.prefab"
        };
        private uint buildingID;
        private DifficultyConfig currentTier;
        private Dictionary<int, string> roomColors = new Dictionary<int, string>();

        static readonly (int w, int d)[] RoomTypes = { (1, 2), (2, 2), (3, 1), (3, 2), (3, 3) };
        static readonly (int dx, int dz)[] Dirs = { (1, 0), (0, 1), (-1, 0), (0, -1) };
        static readonly Quaternion R0 = Quaternion.identity;
        static readonly Quaternion R90 = Quaternion.Euler(0f, 90f, 0f);
        static readonly Quaternion R180 = Quaternion.Euler(0f, 180f, 0f);
        static readonly Quaternion R270 = Quaternion.Euler(0f, 270f, 0f);

        public static DungeonBases Instance { get; private set; }
        private const int layerS = ~(1 << 2 | 1 << 3 | 1 << 4 | 1 << 10 | 1 << 18 | 1 << 28 | 1 << 29);
        private ConfigData Configuration = new();
        private List<Door> hatchPair = new();
        private List<PowerCounter> counterList = new();
        private List<Vector3> blackList = new();
        private List<BasePlayer> dungeonPlayers = new();
        public static List<BaseEntity> entitiesList = new();
        public static List<BaseEntity> npcList = new();
        public static List<Door> doorsList = new();
        private List<BuildingPrivlidge> tcList = new();
        private List<AutoTurret> turretsList = new();
        private string[] doorNameList = {
                                            "assets/prefabs/building/door.double.hinged/door.double.hinged.metal.prefab",
                                            "assets/prefabs/building/door.double.hinged/door.double.hinged.toptier.prefab",
                                            "assets/prefabs/building/door.double.hinged/door.double.hinged.wood.prefab",
                                            "assets/prefabs/misc/permstore/factorydoor/door.hinged.industrial.d.prefab",
                                            "assets/prefabs/building/door.hinged/door.hinged.wood.prefab",
                                            "assets/prefabs/building/door.hinged/door.hinged.metal.prefab",
                                            "assets/prefabs/building/door.hinged/door.hinged.toptier.prefab",
                                            "assets/prefabs/building/wall.frame.garagedoor/wall.frame.garagedoor.prefab",
                                            "assets/prefabs/building/wall.frame.shopfront/wall.frame.shopfront.prefab",
                                            "assets/prefabs/building/wall.frame.cell/wall.frame.cell.gate.prefab",
                                            "assets/prefabs/building/wall.frame.fence/wall.frame.fence.gate.prefab",
                                            "assets/prefabs/misc/decor_dlc/bardoors/door.double.hinged.bardoors.prefab"
                                        };
        private RaycastHit hit;
        private bool softcoreMode = false;
        private Vector3 basePosition = Vector3.up * -90;
        private bool isEventActive = false;
        private Timer eventTimer;
        private int remain;
        private int duration;
        private int eventCooldown = 0;
        private int ownerTimerRemain = -1;
        private bool inception;
        private ulong eventOwnerID;
        private ulong superCardSkinID = 1988408422;
        private int entranceIndex = 0;
        private int dungeonIndex = 0;
        private BasePlayer eventOwner;
        private MapMarkerGenericRadius marker;
        private VendingMachineMapMarker vending;
        private int notifyType = -1;
        private bool CopyPasteInventory = false;
        DynamicConfigFile eventData;
        DynamicConfigFile npcData;
        DynamicConfigFile playersData;
        private string baseName = "", entranceName = "";
        private Vector3 manualSpawnPointRef = new Vector3(0, -999, 0);
        private Vector3 manualSpawnPoint;
        private int buildingComplete = 0;
        private Timer startTimer;
        public class ObjectSettings
        {
            public string name { get; set; }
            public string prefab { get; set; }
            public string objectID { get; set; }
        }

        public class NPCSettings
        {
            public float health { get; set; }
            public string name { get; set; }
            public bool isStatic { get; set; }
            public float x { get; set; }
            public float y { get; set; }
            public float z { get; set; }
            public string prefab { get; set; }
            public string code { get; set; }
            public string weapon { get; set; }
            public string tableName { get; set; }
            public int tableMinItems { get; set; }
            public int tableMaxItems { get; set; }
            public string objectID { get; set; }
            public string kit { get; set; }
            public float dmgScale { get; set; }
        }

        [PluginReference] Plugin CopyPaste, SimpleLootTable, SuperCard, Kits, Notify;

        private class CardReaderAdd : FacepunchBehaviour
        {
            public Door door;
        }

        public class SlabNPC : FacepunchBehaviour
        {
            public Timer timer;
            public Timer timerAI;
            public Vector3 moveTarget;
            public List<Vector3> wayPoints = new();
            public BaseEntity mainTarget;
            public bool targetIsVisible;
            public bool contact;
            public bool isStatic;
            public float range;
            public string code;
            public string weapon;
            public string tableName;
            public int tableMinItems;
            public int tableMaxItems;
            public string kit;
            public float dmgScale;
        }

        private class HatchComponent : FacepunchBehaviour
        {
            public Vector3 position;
            public float time;
            public bool entrance;
        }

        //var gamemode = ConVar.Server.gamemode;

        private class DifficultyConfig
        {
            [JsonProperty("Min size (1-30)")]
            public int minSize = 2;
            [JsonProperty("Max size (1-30)")]
            public int maxSize = 4;
            [JsonProperty("Green room chance (0-100)")]
            public int greenRoomChance = 70;
            [JsonProperty("Blue room chance (0-100)")]
            public int blueRoomChance = 25;
            [JsonProperty("Red room chance (0-100)")]
            public int redRoomChance = 5;
            [JsonProperty("Green room min NPCs")]
            public int greenMinNpc = 0;
            [JsonProperty("Green room max NPCs")]
            public int greenMaxNpc = 1;
            [JsonProperty("Blue room min NPCs")]
            public int blueMinNpc = 1;
            [JsonProperty("Blue room max NPCs")]
            public int blueMaxNpc = 2;
            [JsonProperty("Red room min NPCs")]
            public int redMinNpc = 2;
            [JsonProperty("Red room max NPCs")]
            public int redMaxNpc = 4;
            [JsonProperty("Green room min loot crates")]
            public int greenMinLoot = 1;
            [JsonProperty("Green room max loot crates")]
            public int greenMaxLoot = 1;
            [JsonProperty("Green room loot prefabs")]
            public List<string> greenLootPrefabs = new List<string> { "assets/bundled/prefabs/radtown/crate_normal.prefab", "assets/bundled/prefabs/radtown/crate_normal_2.prefab" };
            [JsonProperty("Blue room min loot crates")]
            public int blueMinLoot = 1;
            [JsonProperty("Blue room max loot crates")]
            public int blueMaxLoot = 2;
            [JsonProperty("Blue room loot prefabs")]
            public List<string> blueLootPrefabs = new List<string> { "assets/bundled/prefabs/radtown/crate_normal.prefab" };
            [JsonProperty("Red room min loot crates")]
            public int redMinLoot = 2;
            [JsonProperty("Red room max loot crates")]
            public int redMaxLoot = 3;
            [JsonProperty("Red room loot prefabs")]
            public List<string> redLootPrefabs = new List<string> { "assets/bundled/prefabs/radtown/crate_normal.prefab", "assets/bundled/prefabs/radtown/crate_elite.prefab" };
            [JsonProperty("Corridor NPC density (0-100)")]
            public int corridorNpcDensity = 0;
            [JsonProperty("Corridor loot density (0-100)")]
            public int corridorLootDensity = 20;
            [JsonProperty("Corridor loot prefabs")]
            public List<string> corridorLootPrefabs = new List<string> {
                "assets/bundled/prefabs/radtown/crate_normal.prefab",
                "assets/bundled/prefabs/radtown/crate_tools.prefab",
                "assets/bundled/prefabs/radtown/crate_basic.prefab",
                "assets/bundled/prefabs/radtown/crate_normal_2.prefab"
            };
            [JsonProperty("NPC weapon short names")]
            public List<string> npcWeapons = new();
            [JsonProperty("NPC min health")]
            public float npcMinHealth = 100f;
            [JsonProperty("NPC max health")]
            public float npcMaxHealth = 150f;
            [JsonProperty("NPC damage scale")]
            public float npcDamageScale = 1f;
        }

        private class ConfigData
        {
            [JsonProperty("Allow only the event owner (the one who entered the dungeon first) into the dungeon")]
            public bool onlyOwner = true;
            [JsonProperty("Allow owner's teammates to enter the dungeon")]
            public bool teammates = true;
            [JsonProperty("Time before ownership is lost after leaving the server(in seconds)")]
            public int ownerLeaveTimer = 300;
            [JsonProperty("Event marker on the map")]
            public bool eventMarker = true;
            [JsonProperty("Event marker name")]
            public string markerName = "Dungeon Base";
            [JsonProperty("Event marker transparency(0-1)")]
            public float markerAlpha = 0.55f;
            [JsonProperty("Event marker radius")]
            public float markerRadius = 0.5f;
            [JsonProperty("Event marker color.R(0-1)")]
            public float markerColorR = 1.0f;
            [JsonProperty("Event marker color.G(0-1)")]
            public float markerColorG = 0f;
            [JsonProperty("Event marker color.B(0-1)")]
            public float markerColorB = 0f;
            [JsonProperty("Display event owner name on marker")]
            public bool markerOwnerName = true;
            [JsonProperty("Display the time remaining until the end of the event on the marker")]
            public bool markerTime = true;
            [JsonProperty("Autostart event(disable if you want to trigger the event only manually)")]
            public bool autoStart = true;
            [JsonProperty("Calculate the time until the next event only after the previous one has finished")]
            public bool afterTime = false;
            [JsonProperty("Minimum time to event start(in seconds)")]
            public int minimumRemainToEvent = 3600;
            [JsonProperty("Maximum time to event start(in seconds)")]
            public int maximumRemainToEvent = 7200;
            [JsonProperty("Minimum event duration(in seconds)")]
            public int minimumEventDuration = 2000;
            [JsonProperty("Maximum event duration(in seconds)")]
            public int maximumEventDuration = 3000;
            [JsonProperty("Minimum number of online players to trigger an event")]
            public int minOnline = 1;
            [JsonProperty("List of NPC names")]
            public List<string> npcNamesList = new List<string> { "Dungeon NPC", "Dungeon Keeper", "Dungeon guard" };
            [JsonProperty("Dungeons list")]
            public List<string> dungeonList = new List<string> { "#dung#base1", "#dung#base2", "#dung#base3", "#dung#base4" };
            [JsonProperty("Entrances list")]
            public List<string> entrancesList = new List<string> { "#dung#entrance1", "#dung#entrance2", "#dung#entrance3", "#dung#entrance4" };
            [JsonProperty("List of zones where dungeon spawning is not allowed")]
            public List<Vector3> blacklistedZones = new();
            [JsonProperty("Random order of choosing a dungeon from the list (if false, will be selected in turn)")]
            public bool randomDungList = true;
            [JsonProperty("Random order of choosing the entrance to the dungeon from the list (if false, will be selected in turn)")]
            public bool randomEntranceList = true;
            [JsonProperty("Change the time of day when entering the dungeon(from 0 to 23, if -1 - do not change the time)")]
            public float dungTime = 0;
            [JsonProperty("How long before the end of the event does radiation start to affect players inside the dungeon")]
            public int radiationTime = 180;
            [JsonProperty("How long before the event ends will a warning message be displayed to players")]
            public int warningMessageTime = 300;
            [JsonProperty("How long after the event ends should the entrance be destroyed")]
            public int destroyTime = 60;
            [JsonProperty("Close the entrance and exit to the dungeon when the event time is over")]
            public bool closeEvent = true;
            [JsonProperty("Will autoturrets attack NPCs")]
            public bool turretNpcAttack = false;
            [JsonProperty("Turret damage scale to NPCs")]
            public float turretNpcDmgScale = 0;
            [JsonProperty("Will flameturrets and guntraps attack NPCs")]
            public bool guntrapNpcAttack = false;
            [JsonProperty("Save event data (If true, the event will be saved and will continue even if you restart the server or plugin. Disable this if you get lag when saving)")]
            public bool saveEvent = true;
            [JsonProperty("SteamID for chat message icon")]
            public ulong iconID = 0;
            [JsonProperty("Notify message type(-1 do not use the Notify plugin)")]
            public int notifyType = -1;
            [JsonProperty("Place a note with a code inside the NPC's corpse (if false, the note will fall next to the body)")]
            public bool codeInsideBody = true;
            [JsonProperty("Dungeon height offset (from -30 to 30). Sometimes needed on custom maps if the dungeon spawns and intersects with the subway. Use with caution!")]
            public float baseOffsetY = 0f;
            [JsonProperty("Difficulty tiers for procedurally generated dungeons")]
            public Dictionary<string, DifficultyConfig> tiers = new Dictionary<string, DifficultyConfig>
            {
                ["easy"] = new DifficultyConfig
                {
                    minSize = 1,
                    maxSize = 10,
                    greenRoomChance = 70,
                    blueRoomChance = 20,
                    redRoomChance = 10,
                    greenMinNpc = 0,
                    greenMaxNpc = 0,
                    blueMinNpc = 0,
                    blueMaxNpc = 1,
                    redMinNpc = 1,
                    redMaxNpc = 2,
                    corridorNpcDensity = 10,
                    corridorLootDensity = 5,
                    npcMinHealth = 50,
                    npcMaxHealth = 80,
                    npcDamageScale = 0.5f,
                    npcWeapons = new List<string> { "pistol.revolver", "pistol.m92" }
                },
                ["normal"] = new DifficultyConfig
                {
                    minSize = 10,
                    maxSize = 15,
                    greenRoomChance = 60,
                    blueRoomChance = 30,
                    redRoomChance = 10,
                    greenMinNpc = 0,
                    greenMaxNpc = 1,
                    blueMinNpc = 1,
                    blueMaxNpc = 2,
                    redMinNpc = 2,
                    redMaxNpc = 3,
                    corridorNpcDensity = 20,
                    corridorLootDensity = 10,
                    npcMinHealth = 80,
                    npcMaxHealth = 120,
                    npcDamageScale = 1f,
                    npcWeapons = new List<string> { "rifle.semiauto", "pistol.m92", "smg.mp5" }
                },
                ["hard"] = new DifficultyConfig
                {
                    minSize = 15,
                    maxSize = 20,
                    greenRoomChance = 50,
                    blueRoomChance = 35,
                    redRoomChance = 15,
                    greenMinNpc = 1,
                    greenMaxNpc = 2,
                    blueMinNpc = 2,
                    blueMaxNpc = 3,
                    redMinNpc = 3,
                    redMaxNpc = 5,
                    corridorNpcDensity = 50,
                    corridorLootDensity = 20,
                    npcMinHealth = 120,
                    npcMaxHealth = 180,
                    npcDamageScale = 1.5f,
                    npcWeapons = new List<string> { "rifle.ak", "rifle.lr300", "shotgun.spas12", "smg.mp5" }
                },
                ["nightmare"] = new DifficultyConfig
                {
                    minSize = 20,
                    maxSize = 30,
                    greenRoomChance = 30,
                    blueRoomChance = 40,
                    redRoomChance = 30,
                    greenMinNpc = 2,
                    greenMaxNpc = 3,
                    blueMinNpc = 3,
                    blueMaxNpc = 5,
                    redMinNpc = 5,
                    redMaxNpc = 8,
                    corridorNpcDensity = 80,
                    corridorLootDensity = 30,
                    npcMinHealth = 180,
                    npcMaxHealth = 300,
                    npcDamageScale = 2f,
                    npcWeapons = new List<string> { "rifle.ak", "lmg.m249", "rifle.lr300", "smg.mp5", "minigun" }
                }
            };
        }

        private bool IsSoftcoreMode()
        {
            try
            {
                var gamemode = ConVar.Server.gamemode;
                return string.Equals(gamemode, "softcore", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        protected override void LoadDefaultMessages()
        {
            lang.RegisterMessages(new Dictionary<string, string>()
            {
                { "EntryDeniedMessage", "You cannot enter the dungeon without being the owner of the event or its teammate" },
                { "StartMessage", "The dungeon bases event has started, find the entrance to the base and get the loot"},
                { "EndMessage", "The dungeon bases event has ended" },
                { "LocationMessage", "The entrance to the dungeon is located at coordinates {0}" },
                { "WarningMessage", "Attention! Leave the dungeon immediately! The exit will be closed in 5 minutes. In 2 minutes the radiation background will rise to a level dangerous to life!" },
                { "ClosedMessage", "Time is up, the entrance and exit to the dungeon are closed forever!" }

            }, this);

            lang.RegisterMessages(new Dictionary<string, string>
            {
                { "EntryDeniedMessage", "Вы не можете войти в подземелье, не являясь владельцем события или его напарником" },
                { "StartMessage", "Событие 'Данжи' началось. Найдите вход на базу и получите добычу" },
                { "EndMessage", "Событие 'Данжи' завершилось" },
                { "LocationMessage", "Вход в подземелье находится в координатах {0}" },
                { "WarningMessage", "Внимание! Немедленно покиньте подземелье! Выход будет закрыт через 5 минут. Через 2 минуты радиационный фон поднимется до опасного для жизни уровня!" },
                { "ClosedMessage", "Время истекло, вход и выход в подземелье закрыты навсегда!" }

            }, this, "ru");
        }

        string GetMessage(string key, IPlayer player, params string[] args)
        {
            try
            {
                return String.Format(lang.GetMessage(key, this, player.Id), args);
            }
            catch (FormatException ex)
            {
                PrintError("A coordinate message can have only one argument, and other messages cannot have any arguments!");
                return lang.GetMessage(key, this, player.Id);
            }
        }

        [AutoPatch]
        [HarmonyPatch(typeof(ScientistNPC))]
        [HarmonyPatch("displayName", MethodType.Getter)]
        public static class DisplayNameScientistDBE
        {
            static bool Prefix(ref string __result, ScientistNPC __instance)
            {
                if (__instance != null)
                {
                    BasePlayer bot = __instance.gameObject.GetComponent<BasePlayer>();
                    string npcname = "Scientist";

                    if (bot)
                    {
                        if (bot._lastSetName != "#Scientist1818")
                            return true;
                        npcname = bot._name;
                    }

                    __result = npcname;
                    return false;
                }
                return true;
            }
        }

        private const string PluginID = "DungeonBasesEvent";
        private Harmony harmonyInstance;

        protected override void SaveConfig() => Config.WriteObject(Configuration, true);

        protected override void LoadConfig()
        {
            base.LoadConfig();
            base.Config.Settings.ObjectCreationHandling = ObjectCreationHandling.Replace;
            Configuration = Config.ReadObject<ConfigData>();
            SaveConfig();
        }

        protected override void LoadDefaultConfig()
        {
            Configuration = new ConfigData();
            SaveConfig();
        }

        private void Init()
        {
            Instance = this;
            UnsubscribeAll();
        }
        private void OnServerInitialized()
        {
            softcoreMode = IsSoftcoreMode();

            if (!SimpleLootTable)
                PrintWarning("SimpleLootTable plugin not found, if you need to use custom loot tables, use this plugin");

            AddMonuments();

            foreach (var item in BaseNetworkable.serverEntities.OfType<BuildingPrivlidge>())
                blackList.Add(new Vector3(item.transform.position.x, 100, item.transform.position.z));

            foreach (var item in BaseNetworkable.serverEntities.OfType<SphereEntity>())
                if (item._name == "dungSphere")
                    item.Kill();

            manualSpawnPoint = manualSpawnPointRef;
            CalcTime();
            duration = 999999;

            eventTimer = timer.Every(1f, () =>
                {
                    //Puts(remain.ToString() + " " + duration.ToString());
                    //Puts(ownerTimerRemain.ToString());
                    remain--;
                    ownerTimerRemain--;

                    if (ownerTimerRemain == 0)
                        RemoveOwner();

                    if (Configuration.afterTime && isEventActive)
                        remain++;

                    duration--;
                    eventCooldown--;

                    if (remain == 0)
                        EventStart();


                    if (duration < Configuration.radiationTime)
                    {
                        foreach (var player in dungeonPlayers)
                        {
                            player.metabolism.radiation_poison.value += 400f / Configuration.radiationTime;
                            player.Hurt(player.metabolism.radiation_poison.value / 100f);
                        }

                        if (duration == -Configuration.destroyTime)
                            EventEnd();


                    }

                    if (duration == Configuration.warningMessageTime)
                    {
                        foreach (BasePlayer player in dungeonPlayers)
                            SendMessage(player, GetMessage("WarningMessage", player.IPlayer));
                    }
                });

            if (Configuration.autoStart)
                Puts("The event will be triggered in auto mode");
            else
                Puts("The event will be triggered only in manual mode");

            timer.Every(10f, () =>
                {
                    VendingUpdate(eventOwner);
                    int count = duration;
                    if (duration < 0) count = 0;
                    foreach (var counter in counterList)
                    {
                        counter.counterNumber = count;
                        counter.UpdateOutputs();
                    }
                });

            if (Configuration.saveEvent)
                timer.Every(60f, () =>
                    {
                        eventData["0", "duration"] = duration;
                        eventData.Save();
                        SaveNpcData();
                    });

            LoadSuperCardConfig();
            LoadCopyPasteConfig();
            inception = false;

            if (Configuration.saveEvent)
            {
                LoadData(false);
                LoadTcData();
                LoadTurretsData();
                LoadNpcData(false);
                LoadPlayersData();
                InitEntities();
                InitHatch();
            }

            notifyType = Configuration.notifyType;

            if (notifyType > -1 && Notify == null)
            {
                PrintWarning("Notify plugin not found");
                notifyType = -1;
            }
        }

        private void LoadTcData()
        {
            if (entitiesList == null || entitiesList.Count == 0)
                return;

            foreach (var tc in entitiesList)
            {
                if (tc == null)
                    continue;

                if (tc.name.Contains("/tool cupboard/"))
                    tcList.Add(tc as BuildingPrivlidge);
            }
        }

        private void LoadTurretsData()
        {
            if (entitiesList == null || entitiesList.Count == 0)
                return;

            foreach (var turret in entitiesList)
            {
                if (turret == null)
                    continue;

                if (turret.name == "assets/prefabs/npc/autoturret/autoturret_deployed.prefab")
                    turretsList.Add(turret as AutoTurret);
            }
        }

        private void AddNPCtoTC(BasePlayer playerNPC)
        {
            if (tcList == null || tcList.Count == 0) return;

            ulong playerNameID = playerNPC.userID;

            foreach (var tc in tcList)
            {
                if (!tc.authorizedPlayers.Contains(playerNameID))
                    tc.authorizedPlayers.Add(playerNameID);
            }
        }

        private void AddNPCtoTurret(BasePlayer playerNPC)
        {
            if (turretsList == null || turretsList.Count == 0) return;

            ulong playerNameID = playerNPC.userID;

            foreach (var turret in turretsList)
            {
                if (!turret.authorizedPlayers.Contains(playerNameID))
                    turret.authorizedPlayers.Add(playerNameID);
            }
        }

        private void RemoveOwner()
        {
            if (eventOwner && dungeonPlayers.Contains(eventOwner) && !eventOwner.IsConnected)
            {
                dungeonPlayers.Remove(eventOwner);
                eventOwner.Hurt(999);
            }

            if (dungeonPlayers.Count > 0)
            {
                ChangeOwner(dungeonPlayers[0]);
                if (!eventOwner.IsConnected)
                    ownerTimerRemain = Configuration.ownerLeaveTimer;
            }
            else
                ChangeOwner(null);
        }

        private void SendMessage(BasePlayer player, string message)
        {
            if (notifyType < 0)
                player.SendConsoleCommand("chat.add", 2, Configuration.iconID, message);
            else
                Notify?.Call("SendNotify", player, notifyType, message);
        }

        private void InitEntities()
        {
            foreach (var item in entitiesList)
            {
                InitDoorList(item);

                switch (item.PrefabName)
                {
                    case "assets/bundled/prefabs/static/door.hinged.bunker_hatch.prefab":
                        hatchPair.Add(item as Door);
                        break;
                    case "assets/prefabs/io/electric/switches/cardreader.prefab":
                        InitCardReaders(item as CardReader);
                        break;
                    case "assets/prefabs/deployable/playerioents/counter/counter.prefab":
                        InitCounter(item as PowerCounter);
                        break;
                }
            }
        }

        private void InitCounter(PowerCounter counter)
        {
            if (counter.targetCounterNumber == 707)
            {
                IOEntity ioEntity = counter as IOEntity;
                ioEntity.UpdateFromInput(99, 0);
                counterList.Add(counter);
            }
        }

        private void InitHatch()
        {
            if (hatchPair.Count < 2) return;

            if (hatchPair[0] == null) return;
            if (hatchPair[1] == null) return;

            if (hatchPair[0].transform.position.y < hatchPair[1].transform.position.y)
            {
                Door temp;
                temp = hatchPair[0];
                hatchPair[0] = hatchPair[1];
                hatchPair[1] = temp;
            }

            HatchComponent hatch1 = hatchPair[0].gameObject.AddComponent<HatchComponent>();
            HatchComponent hatch2 = hatchPair[1].gameObject.AddComponent<HatchComponent>();
            hatch1.position = hatchPair[1].transform.position + Vector3.down * 2 - hatchPair[1].transform.forward * 1.5f;
            hatch2.position = hatchPair[0].transform.position - hatchPair[0].transform.forward + Vector3.up * 0.5f;
            hatch1.time = Configuration.dungTime;
            hatch2.time = -1;
            hatch1.entrance = true;
            hatch2.entrance = false;
        }

        private void InitDoorList(BaseEntity item)
        {
            if (item == null) return;
            if (doorNameList == null || doorNameList.Length == 0) return;

            KeyLock keyLock;
            Door door;

            foreach (var itemName in doorNameList)
                if (item.PrefabName == itemName)
                {
                    keyLock = item.gameObject.GetComponentInChildren<KeyLock>();

                    if (!keyLock)
                    {
                        door = item as Door;
                        if (!door) return;
                        door.pickup.enabled = false;
                        doorsList.Add(door);
                        AddTrigger.AddToEntity(item);
                    }
                }
        }

        BaseCorpse OnCorpsePopulate(BasePlayer npcPlayer, BaseCorpse corpse)
        {
            SlabNPC slabNPC = npcPlayer.GetComponent<SlabNPC>();
            if (slabNPC == null) return null;
            LootableCorpse container = corpse.GetComponentInParent<LootableCorpse>();
            BaseEntity entity = corpse.GetComponent<BaseEntity>();

            if (slabNPC.tableName != "")
                timer.Once(2f, () =>
                {
                    SimpleLootTable?.Call("GetSetItems", entity, slabNPC.tableName, slabNPC.tableMinItems, slabNPC.tableMaxItems, 1f);
                });

            if (slabNPC.code != "")
            {
                Item additem = ItemManager.CreateByName("note", 1);
                additem.text = slabNPC.code;
                ItemContainer corpseContainer = container.containers[0];

                if (Configuration.codeInsideBody)
                {
                    additem.MoveToContainer(corpseContainer);
                }
                else
                {
                    BaseEntity storage = GameManager.server.CreateEntity("assets/prefabs/deployable/small stash/small_stash_deployed.prefab", corpse.transform.position);
                    storage.Spawn();
                    StorageContainer inv = storage.GetComponent<StorageContainer>();
                    BaseCombatEntity ent = storage.GetComponent<BaseCombatEntity>();
                    additem.MoveToContainer(inv.inventory);
                    ent.DieInstantly();
                }
            }

            return null;
        }

        private void ChangeWeapon(BasePlayer npcPlayer, string weaponName)
        {
            if (weaponName == "") return;

            Item weapon = ItemManager.CreateByName(weaponName, 1);

            if (weapon == null)
            {
                PrintWarning("Weapon with shortname '" + weaponName + "' not found");
                return;
            }

            npcPlayer.inventory.containerBelt.Clear();
            weapon.MoveToContainer(npcPlayer.inventory.containerBelt, 0);
            npcPlayer.UpdateActiveItem(weapon.uid);
        }

        private void InitNPC(BaseEntity npc, string displayName, string code, bool isStatic, string weaponName, string tableName, int tableMinItems, int tableMaxItems, string kit, float dmgScale)
        {
            if (npcList == null || npc == null) return;

            npcList.Add(npc);
            npc.name = "DungBaseNPC";

            SlabNPC slabNPC = npc.gameObject.AddComponent<SlabNPC>();
            ScientistBrain brain = npc.gameObject.GetComponent<ScientistBrain>();
            BaseNavigator navigator = npc.GetComponent<BaseNavigator>();
            RaycastHit check;
            BasePlayer npcPlayer = npc as BasePlayer;

            navigator.CanUseNavMesh = false;

            slabNPC.code = code;
            slabNPC.weapon = weaponName;
            slabNPC.isStatic = isStatic;
            Vector3 spawnPos = npc.transform.position;
            slabNPC.moveTarget = spawnPos;
            slabNPC.contact = false;

            timer.Once(5f, () =>
            {
                if (npc != null && !npc.IsDestroyed)
                {
                    npc.transform.position = spawnPos;
                    npc.SendNetworkUpdate();
                }
            });
            slabNPC.tableName = tableName;
            slabNPC.tableMinItems = tableMinItems;
            slabNPC.tableMaxItems = tableMaxItems;
            slabNPC.kit = kit;
            slabNPC.dmgScale = dmgScale;



            ScientistNPC scientistNPC = npc.gameObject.GetComponent<ScientistNPC>();
            TunnelDweller tunnelDweller = npc.gameObject.GetComponent<TunnelDweller>();
            UnderwaterDweller underwaterDweller = npc.gameObject.GetComponent<UnderwaterDweller>();

            if (underwaterDweller)
                underwaterDweller.damageScale = slabNPC.dmgScale;

            if (tunnelDweller)
                tunnelDweller.damageScale = slabNPC.dmgScale;

            if (scientistNPC)
                scientistNPC.damageScale = slabNPC.dmgScale;

            if (kit != "")
            {
                if (Kits != null)
                {
                    npcPlayer.inventory.Strip();
                    Kits?.Call("GiveKit", npcPlayer, slabNPC.kit);
                    Item item = npcPlayer.inventory.containerBelt.GetSlot(0);
                    if (item != null)
                    {
                        npcPlayer.UpdateActiveItem(item.uid);
                    }
                }
                else
                {
                    PrintWarning("Kits plugin not found, kits for your NPCs will not be equipped");
                }
            }


            npcPlayer._name = displayName;
            npcPlayer._lastSetName = "#Scientist1818";

            ChangeWeapon(npcPlayer, weaponName);

            slabNPC.range = 0.5f;
            slabNPC.mainTarget = npc;
            Vector3 vec;
            BaseEntity entity;
            float distance;
            Vector3 offset = Vector3.zero;

            slabNPC.timerAI = timer.Every(1f, () =>
            {
                if (!npc)
                {
                    if (slabNPC.timerAI != null)
                        slabNPC.timerAI.Destroy();
                    return;
                }

                npc.transform.rotation = new Quaternion(0, 0, 0, 1);

                offset = new Vector3(UnityEngine.Random.Range(-0.2f, 0.2f), 0, UnityEngine.Random.Range(-0.2f, 0.2f));

                if (brain.Senses.Players.Count > 0)
                {
                    if (brain.Senses.Players[0] == null) return;

                    if (slabNPC.mainTarget != brain.Senses.Players[0]) slabNPC.contact = false;
                    distance = Vector3.Distance(npc.transform.position, brain.Senses.Players[0].transform.position);

                    vec = new Vector3(brain.Senses.Players[0].transform.position.x - npc.transform.position.x, brain.Senses.Players[0].transform.position.y - npc.transform.position.y, brain.Senses.Players[0].transform.position.z - npc.transform.position.z) + Vector3.up * 0.5f;

                    if (Physics.Raycast(npc.transform.position + Vector3.up * 0.2f, vec, out check, distance, layerS))
                    {
                        entity = check.GetEntity();

                        if (entity)
                            if (entity == brain.Senses.Players[0])
                            {
                                slabNPC.contact = true;
                                slabNPC.targetIsVisible = true;
                                slabNPC.range = 5f;
                                slabNPC.wayPoints.Clear();
                                slabNPC.mainTarget = brain.Senses.Players[0];
                            }
                            else
                            {
                                slabNPC.targetIsVisible = false;
                                if (distance < 1)
                                    slabNPC.range = 1f;
                                else
                                    slabNPC.range = 0.5f;
                            }
                    }
                }
                else
                {
                    slabNPC.mainTarget = npc;
                    slabNPC.contact = false;
                }
            });

            slabNPC.timer = timer.Every(0.2f, () =>
            {
                if (!npc) return;

                if (brain.Senses.Players.Count > 0)
                {
                    if (brain.Senses.Players[0] == null) return;
                    if (slabNPC.isStatic) return;

                    if (slabNPC.contact)
                    {
                        if (Math.Abs(brain.Senses.Players[0].transform.position.y - npc.transform.position.y) > 2.5f)
                        {
                            slabNPC.contact = false;
                            return;
                        }
                        else
                        {
                            vec = brain.Senses.Players[0].transform.position;
                            slabNPC.wayPoints.Add(vec + offset);
                        }

                        if (slabNPC.moveTarget == npc.transform.position)
                            slabNPC.moveTarget = slabNPC.wayPoints[0];

                        if (slabNPC.wayPoints.Count > 99)
                            slabNPC.wayPoints.RemoveAt(0);

                        if (slabNPC.moveTarget != npc.transform.position)
                        {
                            if (Vector3.Distance(npc.transform.position, slabNPC.moveTarget) < slabNPC.range)
                            {
                                if (slabNPC.range < 0.6f)
                                    slabNPC.wayPoints.RemoveAt(0);

                                if (slabNPC.wayPoints.Count > 0)
                                    slabNPC.moveTarget = slabNPC.wayPoints[0];
                                else
                                    slabNPC.moveTarget = npc.transform.position;
                            }

                            if (Vector3.Distance(npc.transform.position, slabNPC.moveTarget) > 0.2f)
                            {
                                Vector3 move = Vector3.Normalize(new Vector3(slabNPC.moveTarget.x - npc.transform.position.x, 0, slabNPC.moveTarget.z - npc.transform.position.z));

                                if (Vector3.Distance(npc.transform.position, slabNPC.mainTarget.transform.position) < 5 && slabNPC.targetIsVisible)
                                    move = Vector3.zero;

                                npc.transform.position += move * 0.6f;
                            }
                        }
                    }
                }
            });
        }

        private void InitCardReaders(CardReader cardReader)
        {
            if (cardReader == null) return;

            foreach (var door in entitiesList)
                if (door)
                    if (Vector3.Distance(door.transform.position, cardReader.transform.position) < 1.5f)
                    {
                        if (!door.PrefabName.Contains("door.hinged.security")) continue;

                        CardReaderAdd cardReaderAdd = cardReader.gameObject.AddComponent<CardReaderAdd>();
                        cardReaderAdd.door = door as Door;

                        switch (door.PrefabName)
                        {
                            case "assets/bundled/prefabs/static/door.hinged.security.red.prefab":
                                cardReader.accessLevel = 3;
                                break;
                            case "assets/bundled/prefabs/static/door.hinged.security.blue.prefab":
                                cardReader.accessLevel = 2;
                                break;
                            case "assets/bundled/prefabs/static/door.hinged.security.green.prefab":
                                cardReader.accessLevel = 1;
                                break;
                        }
                    }
        }

        private void LoadSuperCardConfig()
        {
            if (!SuperCard) return;
            DynamicConfigFile sc = SuperCard.Config;
            if (sc == null) return;
            object preloadData = sc["Item settings"] as object;
            if (preloadData == null) return;
            Dictionary<string, object> dataItem = preloadData as Dictionary<string, object>;
            superCardSkinID = Convert.ToUInt64(dataItem["SkinID"]);
        }

        private void LoadCopyPasteConfig()
        {
            if (!CopyPaste) return;
            DynamicConfigFile cp = CopyPaste.Config;
            if (cp == null) return;
            object preloadData = cp["Paste Options"] as object;
            if (preloadData == null) return;
            Dictionary<string, object> dataItem = preloadData as Dictionary<string, object>;
            CopyPasteInventory = Convert.ToBoolean(dataItem["Inventories (true/false)"]);
            if (!CopyPasteInventory)
                PrintWarning("For the plugin to work correctly, be sure to set the value in the CopyPaste plugin config \"Inventories (true/false)\": true!");
        }

        private void LoadData(bool kill)
        {
            eventData = Interface.Oxide.DataFileSystem.GetDatafile("DungeonBases/eventData");

            if (eventData == null) return;

            int count = 0;
            foreach (var key in eventData)
                count++;

            if (count == 0) return;

            object preloadData1 = eventData["0"] as object;

            if (preloadData1 == null) return;

            var dataItem = preloadData1 as Dictionary<string, object>;


            if (dataItem == null || dataItem.Count <= 2) return;

            if (!kill)
                duration = (int)dataItem["duration"];

            basePosition = new Vector3((int)dataItem["basePositionX"], (int)dataItem["basePositionY"], (int)dataItem["basePositionZ"]);
            eventOwnerID = Convert.ToUInt64(dataItem["eventOwnerID"]);

            if (duration > 0 && duration != 999999)
            {
                isEventActive = true;
                SubscribeAll();

                if (eventOwnerID != 0)
                    foreach (var player in BasePlayer.allPlayerList)
                        if (player.userID == eventOwnerID)
                        {
                            eventOwner = player;
                        }
                CreateMarker();
            }

            List<object> objectList = dataItem["zObjects"] as List<object>;

            List<string> idList = new();
            int index = 0;
            Dictionary<string, object> item1;
            Vector3 pos = Vector3.zero;
            string id = "#";

            foreach (Dictionary<string, object> item in objectList)
                idList.Add(item["objectID"].ToString());

            var baseNetworkableList = Facepunch.Pool.Get<List<BaseEntity>>();
            try
            {
                foreach (var item in BaseNetworkable.serverEntities)
                    if (idList.Contains(item.net.ID.ToString()) && item is BaseEntity entity)
                        baseNetworkableList.Add(entity);

                entitiesList.Clear();
                foreach (var item in baseNetworkableList)
                {
                    entitiesList.Add(item);
                }
            }
            finally
            {
                Facepunch.Pool.FreeUnmanaged(ref baseNetworkableList);
            }

            foreach (var item in entitiesList)
            {
                if (item.net == null) continue;
                id = item.net.ID.ToString();

                if (idList.Contains(id))
                {
                    index = idList.FindIndex(x => x == id);
                    item1 = objectList[index] as Dictionary<string, object>;

                    if (item1["name"] != null)
                        item._name = item1["name"].ToString();

                    if (kill)
                        item?.Kill();
                }
            }

            if (kill)
            {
                eventData.Clear();
                eventData.Save();
            }
        }

        private void LoadNpcData(bool kill)
        {
            npcData = Interface.Oxide.DataFileSystem.GetDatafile("DungeonBases/npcData");

            if (npcData == null) return;

            List<object> preloadData = npcData["0"] as List<object>;

            if (preloadData == null) return;
            if (preloadData.Count == 0) return;

            Dictionary<string, object> dataItem = preloadData[0] as Dictionary<string, object>;
            List<string> idList = new();
            Vector3 pos = Vector3.zero;
            List<BaseEntity> _npcList = new();

            foreach (Dictionary<string, object> item in preloadData)
                idList.Add(item["objectID"].ToString());

            var baseNetworkableList = Facepunch.Pool.Get<List<BaseEntity>>();
            try
            {
                foreach (var item in BaseNetworkable.serverEntities)
                    if (idList.Contains(item.net.ID.ToString()) && item is BaseEntity entity)
                        baseNetworkableList.Add(entity);

                foreach (var item in baseNetworkableList)
                    _npcList.Add(item);
            }
            finally
            {
                Facepunch.Pool.FreeUnmanaged(ref baseNetworkableList);
            }

            bool flag;

            if (kill)
            {
                foreach (var item in _npcList)
                    if (item) item?.Kill();

                _npcList.Clear();
                npcList.Clear();
            }
            else
                foreach (Dictionary<string, object> item in preloadData)
                {
                    flag = false;
                    foreach (var npc in _npcList)
                        if (npc.net.ID.ToString() == item["objectID"].ToString())
                        {
                            InitNPC(npc, item["name"].ToString(), item["code"].ToString(), Convert.ToBoolean(item["isStatic"]), item["weapon"].ToString(),
                            item["tableName"].ToString(), Convert.ToInt16(item["tableMinItems"]), Convert.ToInt16(item["tableMaxItems"]), item["kit"].ToString(), Convert.ToSingle(item["dmgScale"]));
                            flag = true;
                        }
                    if (flag) continue;

                    pos = new Vector3(Convert.ToSingle(item["x"]), Convert.ToSingle(item["y"]), Convert.ToSingle(item["z"]));

                    string[] args = { "prefab", item["prefab"].ToString(),
                                      "displayname", item["name"].ToString(),
                                      "health", item["health"].ToString(),
                                      "weapon", item["weapon"].ToString(),
                                      "static", item["isStatic"].ToString(),
                                      "tableName", item["tableName"].ToString(),
                                      "tableMinItems", item["tableMinItems"].ToString(),
                                      "tableMaxItems", item["tableMaxItems"].ToString(),
                                      "kit", item["kit"].ToString(),
                                      "dmgScale", item["dmgScale"].ToString() };

                    ReplaceEntity(null, pos, args, item["code"].ToString());

                }

            SaveNpcData();
        }

        private void LoadPlayersData()
        {
            playersData = Interface.Oxide.DataFileSystem.GetDatafile("DungeonBases/playersData");
            if (playersData == null) return;

            List<string> playersList = new();
            List<object> preloadData = playersData["0"] as List<object>;

            if (preloadData == null || preloadData.Count == 0) return;

            dungeonPlayers.Clear();

            foreach (var item in preloadData)
                playersList.Add(item.ToString());

            foreach (var player in BasePlayer.allPlayerList)
                if (playersList.Contains(player.userID.ToString()))
                    dungeonPlayers.Add(player);
        }

        private void AddMonuments()
        {
            foreach (var monument in TerrainMeta.Path.Monuments)
            {
                if (monument.name.Contains("monument/small"))
                    blackList.Add(new Vector3(monument.transform.position.x, 200, monument.transform.position.z));

                if (monument.name.Contains("monument/medium"))
                    blackList.Add(new Vector3(monument.transform.position.x, 300, monument.transform.position.z));

                if (monument.name.Contains("monument/large"))
                    blackList.Add(new Vector3(monument.transform.position.x, 400, monument.transform.position.z));

                if (monument.name.Contains("monument/xlarge"))
                    blackList.Add(new Vector3(monument.transform.position.x, 600, monument.transform.position.z));

                if (monument.name.Contains("monument/roadside"))
                    blackList.Add(new Vector3(monument.transform.position.x, 100, monument.transform.position.z));
            }
        }

        private void OnEntitySpawned(BuildingPrivlidge entity)
        {
            blackList.Add(new Vector3(entity.transform.position.x, 100, entity.transform.position.z));
        }

        private void OnEntityKill(BuildingPrivlidge entity)
        {
            blackList.Remove(new Vector3(entity.transform.position.x, 100, entity.transform.position.z));
        }

        private void CalcTime()
        {
            remain = UnityEngine.Random.Range(Configuration.minimumRemainToEvent, Configuration.maximumRemainToEvent);
            string message = "Next event will start in " + remain.ToString() + " seconds";

            if (Configuration.afterTime && isEventActive)
                message = "The next event will start " + remain.ToString() + " seconds after the current event ends";

            if (Configuration.autoStart)
                Puts(message);
            else
                remain = -1;
        }

        private void EventStart()
        {
            if (eventCooldown > 0)
            {
                PrintWarning("You can't trigger the event that often");
                return;
            }

            eventCooldown = 10;

            if (!CopyPaste)
            {
                PrintWarning("CopyPaste plugin not found");
                PrintWarning("CopyPaste plugin is required for the plugin to work correctly");
                remain = 600;
                return;
            }

            if (!CopyPasteInventory)
            {
                PrintWarning("For the plugin to work correctly, be sure to set the value in the CopyPaste plugin config \"Inventories (true/false)\": true!");
                remain = 600;
                return;
            }

            inception = true;
            buildingComplete = 0;


            EventEnd();
            if (BasePlayer.activePlayerList.Count > Configuration.minOnline - 1)
            {
                Vector3 point = manualSpawnPoint;

                if (manualSpawnPoint == manualSpawnPointRef)
                {
                    point = FindEventPoint();

                    if (point == Vector3.zero)
                    {
                        PrintWarning("At the moment, there is no suitable place on the map for the event, the event will not be launched");
                        if (Configuration.autoStart)
                            CalcTime();
                        return;
                    }
                }

                EventStartPos(point);
                manualSpawnPoint = manualSpawnPointRef;
            }
            else
                NotEnough();
        }

        private void EventEnd()
        {
            duration = 999999;

            if (Configuration.saveEvent)
            {
                LoadData(true);
                LoadNpcData(true);
            }
            else
                RemoveDungeon();

            List<BasePlayer> killList = new();
            foreach (var player in dungeonPlayers)
            {
                ChangeTime(player, -1);
                killList.Add(player);
            }

            dungeonPlayers.Clear();

            SavePlayersData();

            foreach (var player in killList)
                player.Hurt(999);

            if (isEventActive)
            {
                foreach (BasePlayer player in BasePlayer.activePlayerList)
                    SendMessage(player, GetMessage("EndMessage", player.IPlayer));

                Puts("Event ended");
                Interface.CallHook("DungeonBasesEventEnded");
            }

            if (vending && !vending.IsDestroyed) vending.Kill();
            UnsubscribeAll();

            if (Configuration.saveEvent && isEventActive)
                timer.Once(3, () => server.Command("save"));

            isEventActive = false;
        }

        private void RemoveDungeon()
        {
            foreach (var item in entitiesList)
                if (item && !item.IsDestroyed)
                    item.Kill();

            foreach (var item in npcList)
                if (item && !item.IsDestroyed)
                    item.Kill();
        }

        private void NotEnough()
        {
            Puts("Not enough online players on the server, event will not start!");
            if (Configuration.autoStart)
                CalcTime();
        }

        private void OnCardSwipe(CardReader cardReader, Keycard Keycard, BasePlayer BasePlayer)
        {
            CardReaderAdd cardReaderAdd = cardReader.GetComponent<CardReaderAdd>();
            if (!cardReaderAdd) return;

            if (Keycard.accessLevel == cardReader.accessLevel || Keycard.skinID == superCardSkinID)
                if (cardReaderAdd.door)
                    cardReaderAdd.door.SetOpen(true);
        }

        private object OnSwipeAccessLevelBypass(BasePlayer BasePlayer, CardReader cardReader, Keycard Keycard)
        {
            CardReaderAdd cardReaderAdd = cardReader.GetComponent<CardReaderAdd>();

            if (cardReaderAdd && cardReaderAdd.door)
                return true;

            return null;
        }

        private void OnPasteFinished(List<BaseEntity> pastedEntities, string filename, IPlayer player, Vector3 startPos)
        {
            if (!inception) return;
            if (!filename.Contains("#dung#")) return;
            BaseInit(pastedEntities);
        }

        private void SetLock(StorageContainer storageContainer)
        {
            if (!softcoreMode) return;
            if (storageContainer == null) return;
            if (storageContainer.PrefabName.Contains("lantern")) return;

            var existingLock = storageContainer.GetSlot(BaseEntity.Slot.Lock) as BaseLock;
            if (existingLock != null) return;

            var lockEntity = GameManager.server.CreateEntity("assets/prefabs/locks/keylock/lock.key.prefab", new Vector3(0, 3000, 0)) as BaseLock;

            lockEntity.OwnerID = 0;
            storageContainer.SetSlot(BaseEntity.Slot.Lock, lockEntity);
            lockEntity.SetFlagLocal(BaseEntity.Flags.Locked, false);
            lockEntity.Spawn();
            lockEntity.SetParent(storageContainer);
            lockEntity.transform.localPosition = new Vector3(0, 3000, 0);
            entitiesList.Add(lockEntity);
            lockEntity.SendNetworkUpdateImmediate();
            storageContainer.SendNetworkUpdateImmediate();
        }

        private void BaseInit(List<BaseEntity> pastedEntities)
        {
            buildingComplete++;
            float cooldown = 0f;
            CodeLock codeLock;
            string code = "";
            Item slotItem1;
            Item slotItem2;

            foreach (var item in pastedEntities)
            {
                if (item == null || item.name == null) continue;

                if (item.name.Contains("/tool cupboard/"))
                    tcList.Add(item as BuildingPrivlidge);

                var storageContainer = item.GetComponent<StorageContainer>();
                if (storageContainer) SetLock(storageContainer);

                if (!Configuration.saveEvent)
                {
                    item.EnableSaving(false);
                }

                item._name = "#dung#undestr#";
                item.OwnerID = 0;

                if (item.PrefabName.Contains("modularcar") || item.PrefabName == "modular_car_fuel_storage")
                {
                    item._name = "";
                    continue;
                }

                entitiesList.Add(item);

                InitDoorList(item);

                switch (item.PrefabName)
                {
                    case "assets/prefabs/npc/flame turret/flameturret.deployed.prefab":
                        item._name = "";
                        break;
                    case "assets/prefabs/deployable/planters/planter.large.deployed.prefab":
                        StorageContainer storage = item.gameObject.GetComponent<StorageContainer>();
                        slotItem1 = storage.inventory.GetSlot(0);
                        slotItem2 = storage.inventory.GetSlot(5);
                        if (slotItem1 != null && slotItem2 != null)
                            if (slotItem1.info.shortname == "fertilizer" && slotItem1.amount == 1 && slotItem2.info.shortname == "fertilizer" && slotItem2.amount == 999)
                            {
                                ReplaceHatch(item, item.transform.forward);
                                item.Kill();
                                entitiesList.Remove(item);
                            }
                        break;
                    case "assets/prefabs/building/floor.ladder.hatch/floor.ladder.hatch.prefab":
                        codeLock = item.gameObject.GetComponentInChildren<CodeLock>();
                        if (!codeLock) continue;
                        if (codeLock.code == "0707")
                        {
                            codeLock.code = "18549";
                            ReplaceHatch(item, item.transform.right + Vector3.up * 0.1f);
                        }
                        break;
                    case "assets/prefabs/locks/keypad/lock.code.prefab":
                        codeLock = item.gameObject.GetComponent<CodeLock>();
                        if (codeLock.code == "1818")
                            codeLock.code = "0";
                        break;
                    case "assets/prefabs/building/door.hinged/door.hinged.wood.prefab":
                        ReplaceDoor(item, "assets/bundled/prefabs/static/door.hinged.security.green.prefab");
                        break;
                    case "assets/prefabs/building/door.hinged/door.hinged.metal.prefab":
                        ReplaceDoor(item, "assets/bundled/prefabs/static/door.hinged.security.blue.prefab");
                        break;
                    case "assets/prefabs/building/door.hinged/door.hinged.toptier.prefab":
                        ReplaceDoor(item, "assets/bundled/prefabs/static/door.hinged.security.red.prefab");
                        break;
                    case "assets/prefabs/deployable/playerioents/gates/branch/electrical.branch.deployed.prefab":
                        ElectricalBranch branch = item as ElectricalBranch;
                        if (branch.branchAmount == 1234560)
                            timer.Once(cooldown + 2f, () => ReplaceCardReader(item, false));
                        if (branch.branchAmount == 1234561)
                            timer.Once(cooldown + 2f, () => ReplaceFuseBox(item));
                        if (branch.branchAmount == 1234569)
                            timer.Once(cooldown + 2f, () => ReplaceCardReader(item, true));
                        break;
                    case "assets/prefabs/deployable/woodenbox/woodbox_deployed.prefab":
                        storage = item.gameObject.GetComponent<StorageContainer>();
                        var boxItem = storage.inventory.GetSlot(0);
                        if (boxItem == null) break;
                        if (boxItem.text == null) break;
                        char[] separators = new char[] { '=', '\n' };
                        string[] args = boxItem.text.Split(separators);

                        timer.Once(cooldown + 2f, () =>
                        {
                            code = "";
                            if (storage && storage.inventory.GetSlot(17) != null)
                                code = storage.inventory.GetSlot(17).text;

                            ReplaceEntity(item, Vector3.zero, args, code);
                        });
                        break;
                    case "assets/prefabs/npc/autoturret/autoturret_deployed.prefab":
                        item._name = "#dung#turret#";
                        SetupTurret(item);
                        turretsList.Add(item as AutoTurret);
                        break;
                    case "assets/prefabs/deployable/single shot trap/guntrap.deployed.prefab":
                        item._name = "#dung#turret#";
                        StorageContainer container = item.GetComponent<StorageContainer>();
                        if (container.inventory.GetSlot(5) != null && container.inventory.GetSlot(5).amount == 1)
                            item._name = "#dung#undestr#";
                        break;
                    case "assets/prefabs/deployable/playerioents/doormanipulators/doorcontroller.deployed.prefab":
                        Door door = item.gameObject.GetComponentInParent<Door>();
                        IOEntity iOEntity = item.GetComponent<IOEntity>().outputs[0].connectedTo.ioEnt;
                        if (!iOEntity) break;
                        CodeLock codeLockLink = door.gameObject.GetComponentInChildren<CodeLock>();
                        if (!codeLockLink) break;
                        if (iOEntity.PrefabName == "assets/prefabs/deployable/playerioents/gates/rfbroadcaster/rfbroadcaster.prefab")
                            timer.Once(cooldown + 1f, () => codeLockLink.code = LinkCode(item, iOEntity));
                        break;
                    case "assets/prefabs/deployable/playerioents/counter/counter.prefab":
                        InitCounter(item as PowerCounter);
                        break;
                }
            }
        }

        private void SetupTurret(BaseEntity turret)
        {
            IOEntity iOEntity = turret.GetComponent<IOEntity>().inputs[0].connectedTo.ioEnt;
            if (!iOEntity) return;

            if (iOEntity.PrefabName == "assets/prefabs/deployable/playerioents/gates/branch/electrical.branch.deployed.prefab")
            {
                ElectricalBranch branch = iOEntity as ElectricalBranch;
                string str = branch.branchAmount.ToString() + "000000";
                if (str[0].ToString() != "9") return;
                if (str[1].ToString() != "9") return;
                if (str[2].ToString() == "1") turret._name += "undestr#";
                if (str[3].ToString() == "1") turret._name += "autofill#";
                if (str[4].ToString() == "1") turret._name += "nodrop#";
            }

            if (iOEntity.PrefabName == "assets/prefabs/deployable/playerioents/gates/blocker/electrical.blocker.deployed.prefab")
                turret._name = "#dung#turret#undestr#";

            if (turret._name.Contains("#autofill#"))
            {
                var autoTurret = turret as AutoTurret;
                var weapon = autoTurret.GetAttachedWeapon();
                if (!weapon) return;
                Item newItem = ItemManager.CreateByName(weapon.primaryMagazine.ammoType.shortname);
                newItem.amount = 9999999;

                if (autoTurret.inventory.GetSlot(1) != null)
                    autoTurret.inventory.GetSlot(1).Remove();

                timer.Once(2f, () =>
                {
                    if (!autoTurret) return;
                    newItem.MoveToContainer(autoTurret.inventory);
                    autoTurret.UpdateTotalAmmo();
                });
            }
        }

        private void SaveDungeonData()
        {
            List<ObjectSettings> objectsList = new();
            BasePlayer basePlayer;
            foreach (var item in entitiesList)
            {
                basePlayer = item as BasePlayer;

                if (basePlayer) continue;

                if (item)
                    objectsList.Add(new ObjectSettings { objectID = item.net.ID.ToString(), name = item._name, prefab = item.PrefabName });
                else
                    objectsList.Add(new ObjectSettings { objectID = "#", name = item._name, prefab = item.PrefabName });

            }

            eventData.Clear();
            eventData["0", "eventOwnerID"] = eventOwnerID;
            eventData["0", "basePositionX"] = (int)basePosition.x;
            eventData["0", "basePositionY"] = (int)basePosition.y;
            eventData["0", "basePositionZ"] = (int)basePosition.z;
            eventData["0", "duration"] = duration;
            eventData["0", "zObjects"] = objectsList;
            eventData.Save();
        }

        private void SaveNpcData()
        {
            List<NPCSettings> _objectsList = new();
            ScientistBrain brain;
            BaseCombatEntity entity;
            SlabNPC slabNPC;

            foreach (var item in npcList)
            {
                if (item == null) continue;
                brain = item.gameObject.GetComponent<ScientistBrain>();
                entity = item as BaseCombatEntity;
                slabNPC = item.GetComponent<SlabNPC>();

                if (brain)
                    _objectsList.Add(new NPCSettings
                    {
                        weapon = slabNPC.weapon,
                        isStatic = slabNPC.isStatic,
                        code = slabNPC.code,
                        objectID = entity.net.ID.ToString(),
                        health = entity.health,
                        name = item._name,
                        x = item.transform.position.x,
                        y = item.transform.position.y,
                        z = item.transform.position.z,
                        tableName = slabNPC.tableName,
                        tableMinItems = slabNPC.tableMinItems,
                        tableMaxItems = slabNPC.tableMaxItems,
                        prefab = item.PrefabName,
                        kit = slabNPC.kit,
                        dmgScale = slabNPC.dmgScale
                    });
            }

            npcData.Clear();
            npcData["0"] = _objectsList;
            npcData.Save();
        }

        private void SavePlayersData()
        {
            if (!Configuration.saveEvent) return;

            if (playersData == null) return;

            if (dungeonPlayers == null)
                return;

            List<ulong> _playersList = new();

            foreach (var player in dungeonPlayers)
                if (player != null)
                    _playersList.Add(player.userID);

            playersData.Clear();
            playersData["0"] = _playersList;
            playersData.Save();
        }

        private string LinkCode(BaseEntity item, IOEntity iOEntity)
        {
            StorageContainer container;
            string secretCode = UnityEngine.Random.Range(1000, 10000).ToString();
            foreach (var entity in entitiesList)
                if (entity && iOEntity)
                    if (Vector3.Distance(iOEntity.transform.position, entity.transform.position) < 1f)
                    {
                        container = entity.GetComponent<StorageContainer>();
                        if (container == null) continue;
                        Item newItem = ItemManager.CreateByName("note", 1);
                        newItem.text = secretCode;
                        newItem.MoveToContainer(container.inventory, container.inventory.capacity - 1);
                        break;
                    }
            entitiesList.Remove(item);
            entitiesList.Remove(iOEntity);
            item.Kill();
            iOEntity.Kill();

            return secretCode;

        }

        private void ReplaceEntity(BaseEntity item, Vector3 position, string[] args, string code)
        {
            string prefab = "";
            string displayName = "";
            float height = 0;
            float forward = 0;
            float right = 0;
            float health = 0;
            string weaponName = "";
            string tableName = "";
            int tableMinItems = 0;
            int tableMaxItems = 0;
            bool isStatic = false;
            string kit = "";
            float dmgScale = 1f;
            Vector3 pos;
            Quaternion rot;

            for (int i = 0; i < args.Length; i = i + 2)
            {
                switch (args[i].ToLower())
                {
                    case "prefab":
                        prefab = args[i + 1];
                        break;
                    case "displayname":
                        displayName = args[i + 1];
                        break;
                    case "height":
                        if (float.TryParse(args[i + 1], out float parsedHeight))
                            height = parsedHeight;
                        break;
                    case "forward":
                        forward = Convert.ToSingle(args[i + 1]);
                        break;
                    case "right":
                        right = Convert.ToSingle(args[i + 1]);
                        break;
                    case "health":
                        health = Convert.ToSingle(args[i + 1]);
                        break;
                    case "weapon":
                        weaponName = args[i + 1];
                        break;
                    case "static":
                        isStatic = Convert.ToBoolean(args[i + 1]);
                        break;
                    case "tablename":
                        tableName = args[i + 1];
                        break;
                    case "tableminitems":
                        tableMinItems = Convert.ToInt16(args[i + 1]);
                        break;
                    case "tablemaxitems":
                        tableMaxItems = Convert.ToInt16(args[i + 1]);
                        break;
                    case "kit":
                        kit = args[i + 1];
                        break;
                    case "dmgscale":
                        dmgScale = Convert.ToSingle(args[i + 1]);
                        break;
                }
            }

            if (item == null)
            {
                pos = position;
                rot = new Quaternion(0, 0, 0, 0);
            }
            else
            {
                pos = item.transform.position;
                rot = item.transform.rotation;
                pos += Vector3.up * height + item.transform.forward * forward + item.transform.right * right;
                StorageContainer container = item.GetComponent<StorageContainer>();

                if (prefab == "")
                {
                    if (container)
                        container.inventory.GetSlot(0).Remove();

                    if (tableName != "")
                        SimpleLootTable?.Call("GetSetItems", item, tableName, tableMinItems, tableMaxItems, 1f, false);
                    return;
                }
                entitiesList.Remove(item);
                item.Kill();
            }

            var entity = GameManager.server.CreateEntity(prefab, pos, rot);
            if (!entity)
            {
                PrintWarning("Entity prefab no exist " + prefab);
                return;
            }
            entity.Spawn();
            entity.OwnerID = 0;

            if (!Configuration.saveEvent)
                entity.EnableSaving(false);

            var player = entity as BasePlayer;

            if (!player && tableName != "")
                SimpleLootTable?.Call("GetSetItems", entity, tableName, tableMinItems, tableMaxItems, 1f);

            var bradley = entity.gameObject.GetComponent<BradleyAPC>();

            if (bradley)
                bradley.ClearPath();

            if (player)
            {
                player.transform.position = pos;
                if (health > 0)
                {
                    player.startHealth = health;
                    player.health = health;
                }

                if (displayName == "" && Configuration.npcNamesList.Count > 0)
                {
                    displayName = Configuration.npcNamesList[UnityEngine.Random.Range(0, Configuration.npcNamesList.Count)];
                }

                if (displayName == "") displayName = player.displayName;
                InitNPC(entity, displayName, code, isStatic, weaponName, tableName, tableMinItems, tableMaxItems, kit, dmgScale);

                if (!Configuration.guntrapNpcAttack)
                    AddNPCtoTC(player);

                if (!Configuration.turretNpcAttack)
                    AddNPCtoTurret(player);

                return;
            }

            entitiesList.Add(entity);
        }

        private class AddTrigger : MonoBehaviour
        {
            public static void AddToEntity(BaseEntity entity)
            {
                BoxCollider collider = entity.gameObject.AddComponent<BoxCollider>();
                collider.isTrigger = true;
                entity.gameObject.layer = (int)Rust.Layer.Reserved1;
                entity.gameObject.AddComponent<CollisionListener>();
            }
        }

        public class CollisionListener : MonoBehaviour
        {
            private void OnTriggerEnter(Collider collider)
            {
                BasePlayer player = collider?.ToBaseEntity()?.ToPlayer();
                CodeLock codeLock;
                if (player == null) return;

                SlabNPC slabNPC = player.gameObject.GetComponent<SlabNPC>();

                if (slabNPC == null) return;

                foreach (var door in doorsList)
                    if (door != null)
                        if (Vector3.Distance(door.transform.position, slabNPC.transform.position) < 2)
                        {
                            codeLock = door.GetComponentInChildren<CodeLock>();
                            if (codeLock && codeLock.skinID == 0) return;
                            door.SetOpen(true);
                        }

            }
        }

        private void OnCodeEntered(CodeLock codeLock, BasePlayer player, string code)
        {
            if (codeLock._name != "#dung#undestr#") return;
            if (code == codeLock.code)
                codeLock.skinID = 1;
        }

        private void ReplaceFuseBox(BaseEntity item)
        {
            if (item == null)
            {
                PrintWarning("ReplaceFuseBox: Item is null! Skipping replacement.");
                return;
            }
            string prefab = "assets/prefabs/io/electric/switches/fusebox/fusebox.prefab";
            var fusebox = GameManager.server.CreateEntity(prefab, item.transform.position + Vector3.down * 1.38f, item.transform.rotation);
            fusebox.Spawn();
            fusebox.OwnerID = 0;
            entitiesList.Add(fusebox);

            if (!Configuration.saveEvent)
                fusebox.EnableSaving(false);

            IOEntity iOEntity1 = item.GetComponent<IOEntity>().inputs[0].connectedTo.ioEnt;
            IOEntity iOEntity2 = fusebox.GetComponent<IOEntity>();
            IOEntity iOEntity3 = item.GetComponent<IOEntity>().outputs[0].connectedTo.ioEnt;
            ConnectIO(iOEntity1, iOEntity2);
            ConnectIO(iOEntity2, iOEntity3);
            item.Kill();
            entitiesList.Remove(item);
        }

        private void ReplaceCardReader(BaseEntity item, bool permanentPower = false)
        {
            if (item == null)
            {
                PrintWarning("ReplaceCardReader: Item is null! Skipping replacement.");
                return;
            }

            string prefab = "assets/prefabs/io/electric/switches/cardreader.prefab";
            var cardReader = GameManager.server.CreateEntity(prefab, item.transform.position + Vector3.down * 1.38f, item.transform.rotation) as CardReader;

            if (cardReader == null)
            {
                PrintWarning("ReplaceCardReader: Failed to create CardReader from prefab!");
                return;
            }

            InitCardReaders(cardReader);
            cardReader.Spawn();
            cardReader.OwnerID = 0;
            entitiesList.Add(cardReader);

            if (!Configuration.saveEvent)
                cardReader.EnableSaving(false);

            if (permanentPower)
            {
                cardReader.UpdateHasPower(1, 1);
                RemoveItem(item);
                return;
            }

            IOEntity itemIO = item.GetComponent<IOEntity>();
            if (itemIO == null)
            {
                PrintWarning($"ReplaceCardReader: {item} does not have IOEntity component! Skipping connection.");
                RemoveItem(item);
                return;
            }

            var input0 = itemIO.inputs[0];
            if (input0 == null || input0.connectedTo == null || input0.connectedTo.ioEnt == null)
            {
                PrintWarning($"ReplaceCardReader: {item}'s input[0] has no connected IOEntity! Skipping connection.");
                RemoveItem(item);
                return;
            }

            IOEntity iOEntity1 = input0.connectedTo.ioEnt;
            IOEntity iOEntity2 = cardReader.GetComponent<IOEntity>();
            ConnectIO(iOEntity1, iOEntity2);
            RemoveItem(item);
        }

        private void RemoveItem(BaseEntity item)
        {
            item.Kill();
            entitiesList.Remove(item);
        }

        private void ReplaceHatch(BaseEntity item, Vector3 offset)
        {
            if (item == null)
            {
                PrintWarning("ReplaceHatch: Item is null! Skipping replacement.");
                return;
            }

            BaseEntity entity = SpawnReplace("assets/bundled/prefabs/static/door.hinged.bunker_hatch.prefab", item, offset);
            entity.Spawn();

            if (!Configuration.saveEvent)
                entity.EnableSaving(false);

            if (offset == item.transform.right + Vector3.up * 0.1f)
                entity.transform.rotation *= Quaternion.Euler(0f, 90f, 0f);

            entitiesList.Add(entity);
            hatchPair.Add(entity as Door);
        }

        private void ReplaceDoor(BaseEntity item, string prefab)
        {
            CodeLock codeLock = item.gameObject.GetComponentInChildren<CodeLock>();
            if (!codeLock) return;

            if (codeLock.code == "0707")
            {
                BaseEntity entity = SpawnReplace(prefab, item, Vector3.zero);
                entity.Spawn();
                entity.OwnerID = 0;

                if (!Configuration.saveEvent)
                    entity.EnableSaving(false);

                entitiesList.Add(entity);
                item.Kill();
                entitiesList.Remove(item);
                entitiesList.Remove(codeLock);
            }

        }
        private BaseEntity SpawnReplace(string prefab, BaseEntity entity, Vector3 offset)
        {
            var replace = GameManager.server.CreateEntity(prefab, entity.transform.position + offset, entity.transform.rotation);
            return replace;
        }

        private void ChangeTime(BasePlayer player, float timevalue)
        {
            if (player.IsAdmin)
                player.SendConsoleCommand("admintime", timevalue);
            else
            {
                player.SetPlayerFlag(BasePlayer.PlayerFlags.IsAdmin, true);
                player.SendNetworkUpdateImmediate();
                player.SendConsoleCommand("admintime", timevalue);
                player.SetPlayerFlag(BasePlayer.PlayerFlags.IsAdmin, false);
                player.SendNetworkUpdateImmediate();
            }
        }

        private object CanEntityTakeDamage(AutoTurret turret, HitInfo info)
        {
            if (turret._name == null) return null;
            if (turret._name.Contains("#dung#turret#") && !turret._name.Contains("#undestr#")) return true;
            return null;
        }

        private void OnEntityTakeDamage(BaseCombatEntity entity, HitInfo hitinfo)
        {
            if (entity == null || hitinfo == null) return;

            if (entity._name != null && entity._name == "#dung#undestr#")
                hitinfo.damageTypes.ScaleAll(0);
        }

        private void OnEntityTakeDamage(BasePlayer player, HitInfo hitinfo)
        {
            if (player == null || hitinfo == null || dungeonPlayers == null || !dungeonPlayers.Contains(player) || hitinfo.damageTypes == null) return;
            if (hitinfo.damageTypes.Get(Rust.DamageType.Suicide) == 0) return;

            hitinfo.DoHitEffects = false;
            hitinfo.HitMaterial = 0;
            hitinfo.PointStart = Vector3.zero;
            hitinfo.HitPositionWorld = Vector3.zero;
            hitinfo.HitEntity = null;
            hitinfo.damageTypes.ScaleAll(0);
        }

        private void OnEntityTakeDamage(AutoTurret turret, HitInfo thitinfo)
        {
            if (turret == null || thitinfo == null || turret._name == null || !turret._name.Contains("#undestr#")) return;
            thitinfo.damageTypes.ScaleAll(0);
        }

        private void OnEntityDeath(AutoTurret turret, HitInfo dhitinfo)
        {
            if (turret._name == null) return;

            if (turret._name.Contains("#nodrop#"))
                turret.inventory.Clear();

            if (turret._name.Contains("#autofill#") && turret.inventory.GetSlot(1) != null)
                turret.inventory.GetSlot(1).Remove();
        }

        private void OnEntityTakeDamage(NPCPlayer npc, HitInfo nhitinfo)
        {
            if (npc == null || nhitinfo == null) return;

            var brain = npc.GetComponent<SlabNPC>();
            if (brain == null) return;

            var initiator = nhitinfo.Initiator;
            if (initiator != null)
            {
                if (initiator.name != null && initiator.name == "DungBaseNPC")
                    nhitinfo.damageTypes.ScaleAll(0);

                if (initiator._name != null && initiator._name.Contains("#dung#turret") && Configuration != null)
                    nhitinfo.damageTypes.ScaleAll(Configuration.turretNpcDmgScale);
            }

            if (nhitinfo.ProjectilePrefab == null || brain.contact) return;

            var initiatorPlayer = nhitinfo.InitiatorPlayer;
            if (initiatorPlayer == null) return;

            brain.contact = true;
            brain.mainTarget = initiator;

            if (initiator != null && initiator.transform != null)
                brain.wayPoints.Add(initiator.transform.position);
        }

        private Vector3 FindEventPoint()
        {
            int mapSize = (int)TerrainMeta.Size.x;
            float x = 0;
            float y = 0;
            float z = 0;
            Vector3 startPoint;
            Vector3 findPoint = Vector3.zero;
            List<Vector3> pointsList = new();
            bool flag = true;
            float radius = 8f;
            float step = 2.2f;
            float height = 1.6f;

            for (int i = 0; i < 9999; i++)
            {
                pointsList.Clear();
                x = UnityEngine.Random.Range(-mapSize / 2, mapSize / 2);
                z = UnityEngine.Random.Range(-mapSize / 2, mapSize / 2);
                startPoint = new Vector3(x, 500, z);
                flag = false;
                findPoint = FindPoint(startPoint);

                if (findPoint != Vector3.zero)
                {
                    flag = true;
                    y = -999f;
                    pointsList.Add(findPoint);

                    for (x = startPoint.x - radius; x < startPoint.x + radius; x += step)
                        for (z = startPoint.z - radius; z < startPoint.z + radius; z += step)
                        {
                            pointsList.Add(FindPoint(new Vector3(x, 500, z)));
                        }

                    foreach (var item in pointsList)
                    {
                        if (y < item.y) y = item.y;
                        if (item == Vector3.zero) flag = false;
                        if (Math.Abs(item.y - findPoint.y) > height) flag = false;
                    }

                    if (flag)
                    {
                        //Puts(i.ToString());
                        //foreach (var item in pointsList)
                        //    BasePlayer.activePlayerList[0].SendConsoleCommand("ddraw.text", 5f, Color.red, item, "<size=>" + i.ToString() + "</size>");
                        //BasePlayer.activePlayerList[0].SendConsoleCommand("ddraw.text", 5f, Color.red, findPoint, "<size=>" + "center" + "</size>");
                        //BasePlayer.activePlayerList[0].Teleport(findPoint + Vector3.up * 10);
                        break;
                    }
                }
            }

            if (flag)
                return new Vector3(findPoint.x, y, findPoint.z);
            else
                return Vector3.zero;
        }

        private Vector3 FindPoint(Vector3 point)
        {
            foreach (var item in blackList)
                if (Vector3.Distance(point, new Vector3(item.x, point.y, item.z)) < item.y)
                    return Vector3.zero;

            if (Physics.Raycast(point, Vector3.down, out hit, 999, layerS))
                if ((hit.collider.name == "Terrain" || hit.collider.name.Contains("ice_lake_")) && WaterLevel.GetWaterDepth(hit.point, false, false) < 0.1f)
                    point = hit.point;
                else
                    point = Vector3.zero;

            return point;
        }


        [Command("dungbase_start")]
        private void dungbase_start(IPlayer iplayer, string command, string[] args)
        {
            if (iplayer.IsAdmin)
            {
                float testCoord;
                bool shortForm = args.Length >= 3 && float.TryParse(args[0], out testCoord);

                if (shortForm)
                {
                    entranceName = "";
                    baseName = "";
                    float x, y, z;
                    float.TryParse(args[0], out x);
                    float.TryParse(args[1], out y);
                    float.TryParse(args[2], out z);
                    manualSpawnPoint = new Vector3(x, y, z);
                    Puts("Manual spawn point set to " + manualSpawnPoint);
                    timer.Once(3, () => { remain = 0; EventStart(); });
                    return;
                }

                var nonCoordArgs = args.TakeWhile(a => !float.TryParse(a, out _)).ToList();
                float? mx = null, my = null, mz = null;
                int coordStart = nonCoordArgs.Count;
                if (args.Length >= coordStart + 3
                    && float.TryParse(args[coordStart], out var px)
                    && float.TryParse(args[coordStart + 1], out var py)
                    && float.TryParse(args[coordStart + 2], out var pz))
                {
                    mx = px; my = py; mz = pz;
                    manualSpawnPoint = new Vector3(px, py, pz);
                    Puts($"Manual spawn point set to {manualSpawnPoint}");
                }

                entranceName = "";
                baseName = "";

                foreach (var a in nonCoordArgs)
                {
                    var lower = a.ToLower();
                    if (a.StartsWith("procedural_", StringComparison.OrdinalIgnoreCase))
                        baseName = a;
                    else if (lower == "random")
                    {
                        if (entranceName == "" && baseName == "")
                            entranceName = "_random_";
                        else if (baseName == "")
                            baseName = "_random_";
                    }
                    else if (entranceName == "")
                        entranceName = a;
                    else
                        baseName = a;
                }

                if (entranceName == "_random_") entranceName = "";
                if (baseName == "_random_") baseName = "";

                timer.Once(3, () =>
                    {
                        remain = 0;
                        EventStart();
                    });
            }

        }

        [Command("dungbase_stop")]
        private void dungbase_stop(IPlayer iplayer)
        {
            if (iplayer.IsAdmin)
                duration = 3 - Configuration.destroyTime;

        }

        private void ConnectIO(IOEntity ioEntity1, IOEntity ioEntity2)
        {
            ioEntity1.outputs[0].connectedTo = new IOEntity.IORef();
            ioEntity1.outputs[0].connectedTo.Set(ioEntity2);
            ioEntity1.outputs[0].connectedToSlot = 0;
            ioEntity1.outputs[0].connectedTo.Init();

            ioEntity2.inputs[0].connectedTo = new IOEntity.IORef();
            ioEntity2.inputs[0].connectedTo.Set(ioEntity1);
            ioEntity2.inputs[0].connectedToSlot = 0;
            ioEntity2.inputs[0].connectedTo.Init();

            ioEntity1.MarkDirtyForceUpdateOutputs();
            ioEntity1.SendNetworkUpdate();

            ioEntity2.MarkDirtyForceUpdateOutputs();
            ioEntity2.SendNetworkUpdate();
        }

        [Command("dungbase_addblack")]
        private void dungbase_addblack(IPlayer iplayer, string command, string[] args)
        {
            if (iplayer.IsAdmin)
            {
                var player = (BasePlayer)iplayer.Object;

                if (!player) return;

                float radius = 100;

                if (args.Length > 0)
                    float.TryParse(args[0], out radius);

                Vector3 zone = new Vector3(player.transform.position.x, radius, player.transform.position.z);

                blackList.Add(zone);
                Configuration.blacklistedZones.Add(zone);

                SaveConfig();

                SendMessage(player, "Zone with radius " + radius.ToString() + " successfully added");
            }
        }

        private void EventStartPos(Vector3 position)
        {
            EventEnd();
            entitiesList.Clear();
            npcList.Clear();
            hatchPair.Clear();
            tcList.Clear();
            turretsList.Clear();

            if (Configuration.randomEntranceList)
                entranceIndex = UnityEngine.Random.Range(0, Configuration.entrancesList.Count);

            if (Configuration.randomDungList)
                dungeonIndex = UnityEngine.Random.Range(0, Configuration.dungeonList.Count);

            basePosition = new Vector3(position.x, Math.Clamp(Configuration.baseOffsetY, -30, 30) - 90, position.z);

            string[] options = new string[] { "stability", "true", "autoheight", "false" };

            if (entranceName == "")
                entranceName = Configuration.entrancesList[entranceIndex];

            if (baseName == "")
                baseName = Configuration.dungeonList[dungeonIndex];

            if (!entranceName.Contains("#dung#"))
            {
                PrintWarning("The entrance name must contain \"#dung#\"");
                EventError();
                return;
            }

            bool isProcedural = baseName.StartsWith("procedural_", StringComparison.OrdinalIgnoreCase);
            bool isTierBase = Configuration.tiers.ContainsKey(baseName.ToLower());
            if (!isProcedural && !isTierBase && !baseName.Contains("#dung#"))
            {
                var tiersList = string.Join("/", Configuration.tiers.Keys);
                PrintWarning($"The dungeon name must contain \"#dung#\" or be a tier name ({tiersList}) or \"procedural_tier\"");
                EventError();
                return;
            }

            var file1 = Interface.Oxide.DataFileSystem.GetFile("copypaste/" + entranceName);
            if (!file1.Exists())
            {
                PrintWarning("File " + entranceName + " does not exist");
                EventError();
                return;
            }

            if (!isProcedural && !isTierBase)
            {
                var file2 = Interface.Oxide.DataFileSystem.GetFile("copypaste/" + baseName);
                if (!file2.Exists())
                {
                    PrintWarning("File " + baseName + " does not exist");
                    EventError();
                    return;
                }
            }

            var base1 = CopyPaste?.Call("TryPasteFromVector3", position, 0.75f, entranceName, options);

            if (isProcedural)
            {
                var tier = baseName.Substring("procedural_".Length);
                GenerateBaseAtByTier(basePosition, Vector3.forward, tier);
            }
            else if (isTierBase)
            {
                GenerateBaseAtByTier(basePosition, Vector3.forward, baseName);
            }
            else
            {
                CopyPaste?.Call("TryPasteFromVector3", basePosition, 90f, baseName, options);
            }

            bool flag = true;

            startTimer = timer.Repeat(4f, 15, () =>
            {
                if (buildingComplete < 2)
                    return;

                if (hatchPair.Count != 2)
                {
                    PrintWarning("No hatch found, or both hatches not found");
                    EventError();
                    if (startTimer != null)
                        startTimer.Destroy();
                    return;

                }

                baseName = "";
                entranceName = "";
                inception = false;
                buildingComplete = 0;

                if (flag)
                {
                    eventOwner = null;
                    eventOwnerID = 0;
                    Puts("Event started");
                    Interface.CallHook("DungeonBasesEventStarted");
                    duration = UnityEngine.Random.Range(Configuration.minimumEventDuration, Configuration.maximumEventDuration);

                    InitHatch();

                    isEventActive = true;
                    SubscribeAll();
                    dungeonPlayers.Clear();
                    CreateMarker();
                    CalcTime();

                    foreach (var tree in BaseNetworkable.serverEntities.OfType<TreeEntity>())
                        if (Vector3.Distance(tree.transform.position, position) < 10)
                            tree.Kill();

                    IPlayer iplayer;
                    string msg;
                    foreach (BasePlayer player in BasePlayer.activePlayerList)
                    {
                        iplayer = player.IPlayer;
                        msg = GetMessage("LocationMessage", iplayer, MapHelper.PositionToString(position));

                        SendMessage(player, GetMessage("StartMessage", iplayer));

                        if (msg != "")
                            SendMessage(player, msg);
                    }

                    if (Configuration.saveEvent)
                        timer.Once(3, () =>
                        {
                            SaveDungeonData();
                            SaveNpcData();
                        });
                }
                else
                    EventError();

                dungeonIndex++;
                if (dungeonIndex > Configuration.dungeonList.Count - 1)
                    dungeonIndex = 0;

                entranceIndex++;
                if (entranceIndex > Configuration.entrancesList.Count - 1)
                    entranceIndex = 0;

                if (Configuration.saveEvent)
                    server.Command("save");

                if (startTimer != null)
                    startTimer.Destroy();
            });
        }

        private void EventError()
        {
            PrintWarning("The event will not start");
            RemoveDungeon();
            EventEnd();
        }

        private void OnDoorOpened(Door door, BasePlayer player)
        {
            if (hatchPair.Contains(door))
            {
                door.SetOpen(false);

                if (Configuration.closeEvent && duration < 1)
                {
                    string msg = GetMessage("ClosedMessage", player.IPlayer);
                    if (msg != "")
                        SendMessage(player, msg);
                    return;
                }

                HatchComponent hatch = door.gameObject.GetComponent<HatchComponent>();


                if (hatch && hatch.entrance)
                {
                    if (!Configuration.onlyOwner)
                    {
                        DungTeleportPlayer(player, hatch);
                        return;
                    }
                    if (eventOwnerID == 0)
                    {
                        ChangeOwner(player);
                        DungTeleportPlayer(player, hatch);
                    }
                    else
                    {
                        string msg = GetMessage("EntryDeniedMessage", player.IPlayer);
                        if (!Configuration.teammates)
                        {
                            SendMessage(player, msg);
                            return;
                        }
                        else
                        {
                            if (eventOwner.Team == null)
                            {
                                SendMessage(player, msg);
                                return;
                            }

                            if (eventOwner.Team.members.Contains(player.userID))
                            {
                                DungTeleportPlayer(player, hatch);
                            }
                            else
                            {
                                SendMessage(player, msg);
                                return;
                            }
                        }
                    }
                }
                else
                    DungTeleportPlayer(player, hatch);

                return;
            }
        }

        private bool CanWake(BasePlayer player)
        {
            return player.IsOnGround() || player.limitNetworking || player.IsFlying || player.IsAdmin;
        }

        private object OnPlayerViolation(BasePlayer player, AntiHackType type)
        {
            if (type == AntiHackType.InsideTerrain && dungeonPlayers.Contains(player)) return false;
            if (player.IsDead()) return false;
            return null;
        }

        private void DungTeleportPlayer(BasePlayer player, HatchComponent hatch)
        {
            if (!dungeonPlayers.Contains(player))
                dungeonPlayers.Add(player);

            player.PauseFlyHackDetection(5f);
            player.PauseSpeedHackDetection(5f);
            player.ApplyStallProtection(4f);
            player.UpdateActiveItem(default);
            player.EnsureDismounted();
            player.Server_CancelGesture();
            player.StartSleeping();
            player.SetPlayerFlag(BasePlayer.PlayerFlags.ReceivingSnapshot, b: true);
            player.ClientRPC(RpcTarget.Player(false ? "StartLoading_Quick" : "StartLoading", player), arg1: true);
            player.Teleport(hatch.position);

            if (player.IsConnected)
            {
                player.SetPlayerFlag(BasePlayer.PlayerFlags.ReceivingSnapshot, true);
                player.UpdateNetworkGroup();
                player.SendNetworkUpdateImmediate();
                player.ClearEntityQueue(null);
                player.SendCompleteSnapshot();


                if (CanWake(player)) player.Invoke(() =>
                    {
                        if (player && player.IsConnected)
                        {
                            if (player.limitNetworking) player.EndSleeping();
                            else player.EndSleeping();
                        }
                    }, 0.5f);
            }
        }

        private void ChangeOwner(BasePlayer player)
        {
            if (player)
            {
                eventOwner = player;
                eventOwnerID = player.userID;
            }
            else
            {
                eventOwner = null;
                eventOwnerID = 0;
            }

            if (Configuration.saveEvent)
            {
                eventData["0", "eventOwnerID"] = eventOwnerID;
                eventData.Save();
            }
        }

        private void ChangeDungeonPlayers(BasePlayer player, bool addPlayer, float dungTime)
        {
            if (addPlayer)
            {
                if (!dungeonPlayers.Contains(player))
                    dungeonPlayers.Add(player);
            }
            else
                dungeonPlayers.Remove(player);

            if (player.IsConnected)
                ChangeTime(player, dungTime);

            SavePlayersData();

            if (dungeonPlayers.Count == 0)
                ChangeOwner(null);

            if (!addPlayer && player == eventOwner && dungeonPlayers.Count > 0)
                ChangeOwner(dungeonPlayers[0]);

        }

        private void OnPlayerDeath(BasePlayer player, HitInfo info)
        {
            NextFrame(() => ChangeDungeonPlayers(player, false, -1));
        }

        private void OnPlayerDeath(NPCPlayer player)
        {
            if (npcList.Contains(player) && Configuration.saveEvent)
                timer.Once(1, () => SaveNpcData());
        }

        private void OnPlayerConnected(BasePlayer player)
        {
            if (dungeonPlayers.Contains(player))
                ChangeDungeonPlayers(player, true, Configuration.dungTime);

        }

        private void Unload()
        {
            if (Configuration.saveEvent)
            {
                if (eventData == null)
                {
                    PrintWarning("Event data is not initialized. Cannot save changes.");
                }
                else
                {
                    try
                    {
                        eventData["0", "duration"] = duration;
                        eventData.Save();
                    }
                    finally { }
                }
            }
            else
                EventEnd();

            if (vending && !vending.IsDestroyed) vending.Kill();
        }

        private void CreateMarker()
        {
            if (!Configuration.eventMarker) return;

            string markerPrefab = "assets/prefabs/tools/map/genericradiusmarker.prefab";
            marker = GameManager.server.CreateEntity(markerPrefab, basePosition).GetComponent<MapMarkerGenericRadius>();
            markerPrefab = "assets/prefabs/deployable/vendingmachine/vending_mapmarker.prefab";
            vending = GameManager.server.CreateEntity(markerPrefab, basePosition).GetComponent<VendingMachineMapMarker>();
            vending.markerShopName = Configuration.markerName;
            vending.enableSaving = false;
            vending.Spawn();
            marker.radius = Configuration.markerRadius;
            marker.alpha = Configuration.markerAlpha;
            Color markerColor = Color.green;
            markerColor.r = Configuration.markerColorR;
            markerColor.g = Configuration.markerColorG;
            markerColor.b = Configuration.markerColorB;
            marker.color1 = markerColor;
            marker.enableSaving = false;
            marker.Spawn();
            marker.SetParent(vending);
            marker.transform.localPosition = new Vector3(0, 0, 0);
            marker.SendUpdate();
            vending.SendNetworkUpdate();
        }

        private void VendingUpdate(BasePlayer player)
        {
            if (vending && isEventActive)
            {
                vending.markerShopName = Configuration.markerName;

                if (Configuration.markerTime)
                    if (duration > 0)
                        vending.markerShopName += "(" + (int)duration / 60 + "m" + duration % 60 + "s)";
                    else
                        vending.markerShopName += "(the event has ended)";

                if (player != null && Configuration.markerOwnerName)
                    vending.markerShopName += "(" + eventOwner.displayName + ")";

                vending.SendNetworkUpdate();
            }

        }

        private object OnPlayerSleep(BasePlayer player)
        {
            int radius = 60;

            timer.Once(0.1f, () =>
                {
                    if (player == null)
                        return;

                    if (Vector3.Distance(basePosition, player.transform.position) > radius)
                        ChangeDungeonPlayers(player, false, -1);
                    else
                        ChangeDungeonPlayers(player, true, Configuration.dungTime);
                });

            return null;
        }

        private void OnPlayerSleepEnded(BasePlayer player)
        {
            if (vending)
            {
                marker.SendUpdate();
                vending.SendNetworkUpdate();
            }
        }

        private void OnPlayerDisconnected(BasePlayer player)
        {
            if (eventOwner && player == eventOwner)
                ownerTimerRemain = Configuration.ownerLeaveTimer;
        }

        private void SubscribeAll()
        {
            Subscribe("OnPlayerConnected");
            Subscribe("OnPlayerDeath");
            Subscribe("OnDoorOpened");
            Subscribe("OnEntityTakeDamage");
            Subscribe("CanEntityTakeDamage");
            Subscribe("OnCorpsePopulate");
            Subscribe("OnPlayerSleepEnded");
            Subscribe("OnPlayerSleep");
            Subscribe("OnPlayerDisconnected");
            Subscribe("OnEntityDeath");
        }

        private void UnsubscribeAll()
        {
            Unsubscribe("OnPlayerConnected");
            Unsubscribe("OnPlayerDeath");
            Unsubscribe("OnDoorOpened");
            Unsubscribe("OnEntityTakeDamage");
            Unsubscribe("CanEntityTakeDamage");
            Unsubscribe("OnCorpsePopulate");
            Unsubscribe("OnPlayerSleepEnded");
            Unsubscribe("OnPlayerSleep");
            Unsubscribe("OnPlayerDisconnected");
            Unsubscribe("OnEntityDeath");
        }

        public void GenerateBase(int size, Action<List<BaseEntity>> onComplete = null)
        {
            var origin = new Vector3(0, 100, 0);
            var fwd = Vector3.forward;
            var rightV = Vector3.right;
            GenerateBaseInternal(size, origin, fwd, rightV, null, onComplete);
        }

        public void GenerateBaseAt(Vector3 origin, Vector3 forward, int size)
        {
            forward.y = 0f; forward.Normalize();
            var rightV = Vector3.Cross(Vector3.up, forward).normalized;
            GenerateBaseInternal(size, origin, forward, rightV, null, null);
        }

        private void GenerateBaseInternal(int count, Vector3 origin, Vector3 fwd, Vector3 rightV, IPlayer iplayer, Action<List<BaseEntity>> onComplete = null)
        {
            var pastedEntities = new List<BaseEntity>();
            roomColors.Clear();
            buildingID = BuildingManager.server.NewBuildingID();

            var (cells, owner, doors, corrPairs) = Layout(count);
            if (cells.Count == 0) { iplayer?.Reply("Placement failed."); return; }

            var fMap = new Dictionary<(int, int), BuildingBlock>();
            foreach (var c in cells)
            {
                var p = origin + rightV * (c.Item1 * 3f) + fwd * (c.Item2 * 3f);
                p.y = origin.y;
                var fb = GameManager.server.CreateEntity(Found, p, R0) as BuildingBlock;
                if (fb == null) continue;
                fb.Spawn();
                pastedEntities.Add(fb);
                InitBlock(fb, BuildingGrade.Enum.Stone);
                fMap[c] = fb;
            }

            NextTick(() =>
            {
                var walls = new Dictionary<(int, int, int, int), BuildingBlock>();
                foreach (var c in cells)
                {
                    var fb = fMap.GetValueOrDefault(c);
                    if (fb == null) continue;
                    for (int d = 0; d < 4; d++)
                    {
                        var n = (c.Item1 + Dirs[d].dx, c.Item2 + Dirs[d].dz);
                        var key = Sk(c, n);
                        if (walls.ContainsKey(key)) continue;
                        var (lp, lr) = Lp(c, n);
                        var w = GameManager.server.CreateEntity(Wall, fb.transform.position) as BuildingBlock;
                        if (w == null) continue;
                        w.SetParent(fb);
                        w.transform.localPosition = lp;
                        w.transform.localRotation = lr;
                        w.Spawn();
                        pastedEntities.Add(w);
                        walls[key] = w;
                    }
                }

                foreach (var c in cells)
                {
                    int oa = owner.GetValueOrDefault(c, -1);
                    for (int d = 0; d < 4; d++)
                    {
                        var n = (c.Item1 + Dirs[d].dx, c.Item2 + Dirs[d].dz);
                        if (!cells.Contains(n)) continue;
                        int ob = owner.GetValueOrDefault(n, -2);
                        if (oa != ob) continue;
                        var key = Sk(c, n);
                        if (walls.TryGetValue(key, out var w) && w && !w.IsDestroyed) w.Kill();
                        walls.Remove(key);
                    }
                }

                var entranceLobby = fMap.GetValueOrDefault((0, 0));
                if (entranceLobby != null)
                {
                    var lobbyWalls = new List<(int, int)>();
                    for (int d = 0; d < 4; d++)
                    {
                        var n = (0 + Dirs[d].dx, 0 + Dirs[d].dz);
                        if (corrPairs.Any(p => (p.Item1.Item1 == n.Item1 && p.Item1.Item2 == n.Item2) || (p.Item2.Item1 == n.Item1 && p.Item2.Item2 == n.Item2)))
                        {
                            lobbyWalls.Add(n);
                            var key = Sk((0, 0), n);
                            if (!walls.ContainsKey(key))
                            {
                                var (wlp, wlr) = Lp((0, 0), n);
                                var ww = GameManager.server.CreateEntity(Wall, entranceLobby.transform.position) as BuildingBlock;
                                if (ww != null) { ww.SetParent(entranceLobby); ww.transform.localPosition = wlp; ww.transform.localRotation = wlr; ww.Spawn(); walls[key] = ww; }
                            }
                        }
                    }
                    if (lobbyWalls.Count > 0)
                    {
                        var lobbyRng = new System.Random();
                        var doorNeighbor = lobbyWalls[lobbyRng.Next(lobbyWalls.Count)];
                        var dk = Sk((0, 0), doorNeighbor);
                        if (walls.TryGetValue(dk, out var dw) && dw && !dw.IsDestroyed) dw.Kill();
                        walls.Remove(dk);
                        var (dlp, dlr) = Lp((0, 0), doorNeighbor);
                        var edf = GameManager.server.CreateEntity(DoorF, entranceLobby.transform.position) as BuildingBlock;
                        if (edf != null) { edf.SetParent(entranceLobby); edf.transform.localPosition = dlp; edf.transform.localRotation = dlr; edf.Spawn(); pastedEntities.Add(edf); }
                        var efd = GameManager.server.CreateEntity("assets/prefabs/misc/permstore/factorydoor/door.hinged.industrial.d.prefab", entranceLobby.transform.position);
                        if (efd != null) { efd.SetParent(edf); efd.transform.localPosition = Vector3.zero; efd.transform.localRotation = Quaternion.identity; efd.Spawn(); pastedEntities.Add(efd); }
                    }
                }

                var turns = new HashSet<int>();
                for (int i = 2; i < corrPairs.Count - 1; i++)
                {
                    var c0 = (corrPairs[i - 1].Item1.Item1 + corrPairs[i - 1].Item2.Item1,
                              corrPairs[i - 1].Item1.Item2 + corrPairs[i - 1].Item2.Item2);
                    var c1 = (corrPairs[i].Item1.Item1 + corrPairs[i].Item2.Item1,
                              corrPairs[i].Item1.Item2 + corrPairs[i].Item2.Item2);
                    var c2 = (corrPairs[i + 1].Item1.Item1 + corrPairs[i + 1].Item2.Item1,
                              corrPairs[i + 1].Item1.Item2 + corrPairs[i + 1].Item2.Item2);
                    var d1 = (c1.Item1 - c0.Item1, c1.Item2 - c0.Item2);
                    var d2 = (c2.Item1 - c1.Item1, c2.Item2 - c1.Item2);
                    if (d1.Item1 != d2.Item1 || d1.Item2 != d2.Item2)
                        turns.Add(i);
                }

                (Vector3, Quaternion) LpCross((int, int) cell, (int dx, int dz) dir) =>
                    dir switch
                    {
                        (1, 0) => (new Vector3(1.5f, 0, 0), R0),
                        (-1, 0) => (new Vector3(-1.5f, 0, 0), R180),
                        (0, 1) => (new Vector3(0, 0, 1.5f), R270),
                        (0, -1) => (new Vector3(0, 0, -1.5f), R90),
                        _ => (Vector3.zero, R0)
                    };

                var rng = new System.Random();
                int gap = 0;
                bool onLeft = rng.Next(2) == 0;
                for (int i = 0; i < corrPairs.Count - 1; i++)
                {
                    if (i <= 1 || i >= corrPairs.Count - 3) continue;
                    if (turns.Contains(i) || turns.Contains(i - 1)) continue;
                    if (gap > 0) { gap--; continue; }
                    gap = 1 + rng.Next(3);

                    var center0 = (corrPairs[i].Item1.Item1 + corrPairs[i].Item2.Item1,
                                   corrPairs[i].Item1.Item2 + corrPairs[i].Item2.Item2);
                    var center1 = (corrPairs[i + 1].Item1.Item1 + corrPairs[i + 1].Item2.Item1,
                                   corrPairs[i + 1].Item1.Item2 + corrPairs[i + 1].Item2.Item2);
                    var dir = (center1.Item1 - center0.Item1, center1.Item2 - center0.Item2);
                    if (dir.Item1 == 0 && dir.Item2 == 0) continue;
                    dir = (dir.Item1 > 0 ? 1 : dir.Item1 < 0 ? -1 : 0,
                           dir.Item2 > 0 ? 1 : dir.Item2 < 0 ? -1 : 0);

                    var parent = onLeft ? corrPairs[i].Item1 : corrPairs[i].Item2;
                    onLeft = !onLeft;
                    var fb = fMap.GetValueOrDefault(parent);
                    if (fb == null) continue;
                    var (lp, lr) = LpCross(parent, dir);
                    var cw = GameManager.server.CreateEntity(Wall, fb.transform.position) as BuildingBlock;
                    if (cw == null) continue;
                    cw.SetParent(fb);
                    cw.transform.localPosition = lp;
                    cw.transform.localRotation = lr;
                    cw.Spawn();
                    pastedEntities.Add(cw);
                    walls[Sk(corrPairs[i].Item1, corrPairs[i].Item2)] = cw;
                }

                var rngDoor = new System.Random();
                foreach (var (roomCell, corrCell) in doors)
                {
                    if ((corrCell.Item1 == 0 && corrCell.Item2 == 0) || (corrCell.Item1 == 0 && corrCell.Item2 == 1)) continue;
                    var key = Sk(roomCell, corrCell);
                    if (walls.TryGetValue(key, out var w) && w && !w.IsDestroyed) w.Kill();
                    walls.Remove(key);
                    var fb = fMap.GetValueOrDefault(roomCell);
                    if (fb == null) continue;

                    var (lp, lr) = Lp(roomCell, corrCell);
                    var df = GameManager.server.CreateEntity(DoorF, fb.transform.position) as BuildingBlock;
                    if (df != null) { df.SetParent(fb); df.transform.localPosition = lp; df.transform.localRotation = lr; df.Spawn(); pastedEntities.Add(df); }

                    var roomId = owner.GetValueOrDefault(roomCell, -1);
                    (int, int)? extraRoomCell = null;
                    Vector3 extraRoomDoorLp = Vector3.zero;
                    Quaternion extraRoomDoorLr = Quaternion.identity;
                    bool tryFactory = rngDoor.Next(3) == 0 && roomId >= 0;
                    if (tryFactory)
                    {
                        var roomCells = owner.Where(kv => kv.Value == roomId).Select(kv => kv.Key).ToList();
                        var sorted = roomCells.OrderByDescending(c =>
                            Math.Abs(c.Item1 - roomCell.Item1) + Math.Abs(c.Item2 - roomCell.Item2)).ToList();
                        foreach (var rc in sorted)
                        {
                            foreach (var dI in Dirs)
                            {
                                var adj = (rc.Item1 + dI.dx, rc.Item2 + dI.dz);
                                if (cells.Contains(adj)) continue;
                                foreach (var rt in RoomTypes.OrderBy(_ => rngDoor.Next()))
                                {
                                    int rw = rt.w, rd = rt.d;
                                    bool ok = true;
                                    for (int x = 0; x < rw && ok; x++)
                                        for (int z = 0; z < rd && ok; z++)
                                        {
                                            var cc = (adj.Item1 + x, adj.Item2 + z);
                                            if (cells.Contains(cc)) ok = false;
                                            bool touches = false;
                                            foreach (var dd in Dirs)
                                            {
                                                var nn = (cc.Item1 + dd.dx, cc.Item2 + dd.dz);
                                                if (owner.GetValueOrDefault(nn, -1) == roomId) touches = true;
                                            }
                                        }
                                    if (!ok) continue;
                                    bool touchesRoom = false;
                                    foreach (var dd in Dirs)
                                    {
                                        var tn = (adj.Item1 + dd.dx, adj.Item2 + dd.dz);
                                        if (owner.GetValueOrDefault(tn, -1) == roomId) { touchesRoom = true; break; }
                                    }
                                    if (!touchesRoom) continue;

                                    int newRoomId = owner.Values.Max() + 1;
                                    for (int x = 0; x < rw; x++)
                                        for (int z = 0; z < rd; z++)
                                        {
                                            var cc = (adj.Item1 + x, adj.Item2 + z);
                                            cells.Add(cc);
                                            owner[cc] = newRoomId;
                                            var pCc = origin + rightV * (cc.Item1 * 3f) + fwd * (cc.Item2 * 3f);
                                            pCc.y = origin.y;
                                            var fbCc = GameManager.server.CreateEntity(Found, pCc, R0) as BuildingBlock;
                                            if (fbCc != null)
                                            {
                                                fbCc.Spawn();
                                                pastedEntities.Add(fbCc);
                                                InitBlock(fbCc, BuildingGrade.Enum.Stone);
                                                fMap[cc] = fbCc;
                                            }
                                        }
                                    extraRoomCell = adj;
                                    var (blp, blr) = Lp(rc, adj);
                                    extraRoomDoorLp = blp;
                                    extraRoomDoorLr = blr;
                                    break;
                                }
                                if (extraRoomCell != null) break;
                            }
                            if (extraRoomCell != null) break;
                        }
                    }

                    if (extraRoomCell != null)
                    {
                        var doorWallKey = (0, 0, 0, 0);
                        var fd = GameManager.server.CreateEntity("assets/prefabs/misc/permstore/factorydoor/door.hinged.industrial.d.prefab", fb.transform.position);
                        if (fd != null) { fd.SetParent(df); fd.transform.localPosition = Vector3.zero; fd.transform.localRotation = Quaternion.identity; fd.Spawn(); pastedEntities.Add(fd); }

                        var fbFar = fMap.GetValueOrDefault(roomCell);
                        var key2 = Sk(roomCell, extraRoomCell.Value);
                        string dpInForColor = null;

                        foreach (var dD in Dirs)
                        {
                            var n = (extraRoomCell.Value.Item1 + dD.dx, extraRoomCell.Value.Item2 + dD.dz);
                            if (owner.GetValueOrDefault(n, -1) == roomId)
                            {
                                key2 = Sk(n, extraRoomCell.Value);
                                var (lpInner, lrInner) = Lp(n, extraRoomCell.Value);
                                var fbInner = fMap.GetValueOrDefault(n);
                                if (fbInner != null)
                                {
                                    var keyIn = Sk(n, extraRoomCell.Value);
                                    doorWallKey = keyIn;
                                    if (walls.TryGetValue(keyIn, out var wIn) && wIn && !wIn.IsDestroyed) wIn.Kill();
                                    walls.Remove(keyIn);
                                    var dfIn = GameManager.server.CreateEntity(DoorF, fbInner.transform.position) as BuildingBlock;
                                    if (dfIn != null) { dfIn.SetParent(fbInner); dfIn.transform.localPosition = lpInner; dfIn.transform.localRotation = lrInner; dfIn.Spawn(); pastedEntities.Add(dfIn); }
                                    var dpIn = DoorTypes[rngDoor.Next(DoorTypes.Length)];
                                    dpInForColor = dpIn;
                                    var drIn = GameManager.server.CreateEntity(dpIn, fbInner.transform.position);
                                    if (drIn != null) { drIn.SetParent(dfIn); drIn.transform.localPosition = Vector3.zero; drIn.transform.localRotation = Quaternion.identity; drIn.Spawn(); pastedEntities.Add(drIn); }
                                    PlaceDoorLockAndBranch(drIn, fbInner, lpInner, lrInner * R180, pastedEntities);
                                }
                                break;
                            }
                        }

                        int erId = owner.GetValueOrDefault(extraRoomCell.Value, -1);
                        if (erId >= 0 && dpInForColor != null) SetRoomColor(erId, dpInForColor);
                        var erCells = owner.Where(kv => kv.Value == erId).Select(kv => kv.Key);
                        foreach (var ec in erCells)
                        {
                            var eb = fMap.GetValueOrDefault(ec);
                            if (eb == null) continue;
                            foreach (var dE in Dirs)
                            {
                                var ne = (ec.Item1 + dE.dx, ec.Item2 + dE.dz);
                                var ke = Sk(ec, ne);
                                if (walls.ContainsKey(ke)) continue;
                                if (ke.Equals(doorWallKey)) continue;
                                if (cells.Contains(ne) && owner.GetValueOrDefault(ec, 0) == owner.GetValueOrDefault(ne, -1)) continue;
                                var (lpe, lre) = Lp(ec, ne);
                                var we = GameManager.server.CreateEntity(Wall, eb.transform.position) as BuildingBlock;
                                if (we != null) { we.SetParent(eb); we.transform.localPosition = lpe; we.transform.localRotation = lre; we.Spawn(); pastedEntities.Add(we); walls[ke] = we; }
                            }

                            var fl = GameManager.server.CreateEntity(Floor, eb.transform.position) as BuildingBlock;
                            if (fl != null) { fl.SetParent(eb); fl.transform.localPosition = new Vector3(0, 3, 0); fl.transform.localRotation = R0; fl.Spawn(); pastedEntities.Add(fl); }
                        }
                    }
                    else
                    {
                        var dp = DoorTypes[rngDoor.Next(DoorTypes.Length)];
                        var dr = GameManager.server.CreateEntity(dp, fb.transform.position);
                        if (dr != null && df != null) { dr.SetParent(df); dr.transform.localPosition = Vector3.zero; dr.transform.localRotation = Quaternion.identity; dr.Spawn(); pastedEntities.Add(dr); }
                        PlaceDoorLockAndBranch(dr, fb, lp, lr, pastedEntities);
                        if (roomId >= 0) SetRoomColor(roomId, dp);
                    }
                }

                var wndRng = new System.Random();
                var windowPrefab = "assets/prefabs/building core/wall.window/wall.window.prefab";
                var windowGroups = owner.Where(kv => kv.Value >= 0).GroupBy(kv => kv.Value);
                foreach (var room in windowGroups)
                {
                    if (wndRng.Next(100) >= 30) continue;
                    var roomWalls = new List<((int, int) roomCell, (int, int) corrCell)>();
                    foreach (var cell in room)
                    {
                        for (int d = 0; d < 4; d++)
                        {
                            var n = (cell.Key.Item1 + Dirs[d].dx, cell.Key.Item2 + Dirs[d].dz);
                            if (cells.Contains(n) && owner.GetValueOrDefault(n, -1) == -1)
                            {
                                var key = Sk(cell.Key, n);
                                if (walls.ContainsKey(key))
                                    roomWalls.Add((cell.Key, n));
                            }
                        }
                    }
                    if (roomWalls.Count == 0) continue;
                    var pick = roomWalls[wndRng.Next(roomWalls.Count)];
                    var rk = Sk(pick.roomCell, pick.corrCell);
                    if (walls.TryGetValue(rk, out var ww) && ww && !ww.IsDestroyed) ww.Kill();
                    walls.Remove(rk);
                    var fbW = fMap.GetValueOrDefault(pick.roomCell);
                    if (fbW != null)
                    {
                        var (wlp, wlr) = Lp(pick.roomCell, pick.corrCell);
                        var wnd = GameManager.server.CreateEntity(windowPrefab, fbW.transform.position) as BuildingBlock;
                        if (wnd != null) { wnd.SetParent(fbW); wnd.transform.localPosition = wlp; wnd.transform.localRotation = wlr; wnd.Spawn(); pastedEntities.Add(wnd); InitBlock(wnd, BuildingGrade.Enum.Stone); }
                        var glass = GameManager.server.CreateEntity("assets/prefabs/building/wall.window.reinforcedglass/wall.window.glass.reinforced.prefab", fbW.transform.position);
                        if (glass != null) { glass.SetParent(fbW); glass.transform.localPosition = wlp + Vector3.up * 1.0f; glass.transform.localRotation = wlr; glass.Spawn(); pastedEntities.Add(glass); }
                    }
                }

                foreach (var kv in fMap)
                {
                    var c = kv.Key;
                    if (c.Item1 == 0 && c.Item2 == 0 && owner.GetValueOrDefault(c, 0) < 0) continue;
                    var fb = kv.Value;
                    var fl = GameManager.server.CreateEntity(Floor, fb.transform.position) as BuildingBlock;
                    if (fl != null) { fl.SetParent(fb); fl.transform.localPosition = new Vector3(0, 3, 0); fl.transform.localRotation = R0; fl.Spawn(); pastedEntities.Add(fl); }
                }

                var entranceFb = fMap.GetValueOrDefault((0, 0));
                if (entranceFb != null && corrPairs.Count > 1)
                {
                    var p0 = (corrPairs[0].Item1.Item1 + corrPairs[0].Item2.Item1,
                              corrPairs[0].Item1.Item2 + corrPairs[0].Item2.Item2);
                    var p1 = (corrPairs[1].Item1.Item1 + corrPairs[1].Item2.Item1,
                              corrPairs[1].Item1.Item2 + corrPairs[1].Item2.Item2);
                    var dir = (p1.Item1 - p0.Item1, p1.Item2 - p0.Item2);
                    dir = (dir.Item1 > 0 ? 1 : dir.Item1 < 0 ? -1 : 0,
                           dir.Item2 > 0 ? 1 : dir.Item2 < 0 ? -1 : 0);
                    Quaternion hatchRot = dir switch
                    {
                        (1, 0) => R180,
                        (-1, 0) => R0,
                        (0, 1) => R90,
                        (0, -1) => R270,
                        _ => R0
                    };

                    var frame = GameManager.server.CreateEntity(FloorFrame, entranceFb.transform.position) as BuildingBlock;
                    if (frame != null)
                    {
                        frame.SetParent(entranceFb);
                        frame.transform.localPosition = new Vector3(0, 3, 0);
                        frame.transform.localRotation = R0;
                        frame.Spawn();
                        pastedEntities.Add(frame);
                        InitBlock(frame, BuildingGrade.Enum.Stone);

                        var hatch = GameManager.server.CreateEntity(LadderHatch, entranceFb.transform.position);
                        if (hatch != null)
                        {
                            hatch.SetParent(frame);
                            hatch.transform.localPosition = Vector3.zero;
                            hatch.transform.localRotation = hatchRot;
                            hatch.Spawn();
                            pastedEntities.Add(hatch);
                            hatch.SetFlagLocal(BaseEntity.Flags.Open, true);

                            var lockEnt = GameManager.server.CreateEntity(CodeLock, hatch.transform.position);
                            if (lockEnt != null)
                            {
                                lockEnt.SetParent(hatch, hatch.GetSlotAnchorName(BaseEntity.Slot.Lock));
                                lockEnt.transform.localPosition = Vector3.zero;
                                lockEnt.transform.localRotation = Quaternion.identity;
                                lockEnt.Spawn();
                                pastedEntities.Add(lockEnt);
                                var codeLock = lockEnt as CodeLock;
                                if (codeLock != null)
                                {
                                    codeLock.code = "0707";
                                    codeLock.SetFlagLocal(BaseEntity.Flags.Locked, true);
                                    hatch.SetSlot(BaseEntity.Slot.Lock, codeLock);
                                }
                            }
                        }
                    }
                }

                var lightPositions = new List<Vector3>();
                var corrPairsSet = new HashSet<(int, int)>();
                foreach (var p in corrPairs) { corrPairsSet.Add(p.Item1); corrPairsSet.Add(p.Item2); }

                for (int i = 0; i < corrPairs.Count - 1; i++)
                {
                    var a = corrPairs[i].Item1;
                    var b = corrPairs[i].Item2;
                    var c = corrPairs[i + 1].Item1;
                    var d = corrPairs[i + 1].Item2;

                    var allCells = new[] { a, b, c, d };
                    int minX = allCells.Min(x => x.Item1);
                    int maxX = allCells.Max(x => x.Item1);
                    int minZ = allCells.Min(x => x.Item2);
                    int maxZ = allCells.Max(x => x.Item2);
                    if (maxX - minX > 1 || maxZ - minZ > 1) continue;
                    if (allCells.Distinct().Count() != 4) continue;

                    bool hasWall = false;
                    for (int j = 0; j < 4 && !hasWall; j++)
                    {
                        for (int k = j + 1; k < 4 && !hasWall; k++)
                        {
                            if (Math.Abs(allCells[j].Item1 - allCells[k].Item1) + Math.Abs(allCells[j].Item2 - allCells[k].Item2) == 1)
                                if (walls.ContainsKey(Sk(allCells[j], allCells[k])))
                                    hasWall = true;
                        }
                    }
                    if (hasWall) continue;

                    var pos = Vector3.zero;
                    foreach (var cell in allCells)
                    {
                        var fb = fMap.GetValueOrDefault(cell);
                        if (fb != null) pos += fb.transform.position;
                    }
                    pos /= 4f;
                    pos.y += 3f;

                    bool tooClose = false;
                    foreach (var existing in lightPositions)
                    {
                        if (Vector3.Distance(pos, existing) < 4f) { tooClose = true; break; }
                    }
                    if (tooClose) continue;

                    lightPositions.Add(pos);

                    var light = GameManager.server.CreateEntity(CeilingLight, pos, Quaternion.identity);
                    if (light != null)
                    {
                        light.Spawn();
                        light.SetFlagLocal(BaseEntity.Flags.On, true);
                        pastedEntities.Add(light);
                        var ioLight = light as IOEntity;
                        if (ioLight != null)
                        {
                            ioLight.UpdateHasPower(1, 1);
                            ioLight.SendNetworkUpdate();
                        }
                    }
                }

                var roomGroups = owner.Where(kv => kv.Value >= 0).GroupBy(kv => kv.Value);
                foreach (var room in roomGroups)
                {
                    var pos = Vector3.zero;
                    int count = 0;
                    foreach (var cell in room)
                    {
                        var fb = fMap.GetValueOrDefault(cell.Key);
                        if (fb != null) { pos += fb.transform.position; count++; }
                    }
                    if (count == 0) continue;
                    pos /= count;
                    pos.y += 3f;

                    var light = GameManager.server.CreateEntity(CeilingLight, pos, Quaternion.identity);
                    if (light != null)
                    {
                        light.Spawn();
                        light.SetFlagLocal(BaseEntity.Flags.On, true);
                        pastedEntities.Add(light);
                        var ioLight = light as IOEntity;
                        if (ioLight != null)
                        {
                            ioLight.UpdateHasPower(1, 1);
                            ioLight.SendNetworkUpdate();
                        }
                    }
                }

                var lanternPositions = new List<Vector3>();
                var corrList = owner.Where(kv => kv.Value < 0).Select(kv => kv.Key).ToList();
                var rngLantern = new System.Random();
                var doorCells = new HashSet<(int, int)>(doors.SelectMany(dd => new[] { dd.Item1, dd.Item2 }));
                foreach (var c in corrList)
                {
                    var fbL = fMap.GetValueOrDefault(c);
                    if (fbL == null) continue;
                    if (doorCells.Contains(c)) continue;

                    var wallDirs = new List<int>();
                    for (int d = 0; d < 4; d++)
                    {
                        var n = (c.Item1 + Dirs[d].dx, c.Item2 + Dirs[d].dz);
                        var key = Sk(c, n);
                        if (walls.ContainsKey(key) && owner.GetValueOrDefault(n, -1) != -1)
                            wallDirs.Add(d);
                    }
                    if (wallDirs.Count == 0) continue;

                    if (rngLantern.Next(2) == 0) continue;
                    int wd = wallDirs[rngLantern.Next(wallDirs.Count)];
                    var neighbor = (c.Item1 + Dirs[wd].dx, c.Item2 + Dirs[wd].dz);
                    var (wlPos, wlRot) = Lp(c, neighbor);
                    var lanternWorld = fbL.transform.position + fbL.transform.rotation * (wlPos + wlPos.normalized * 0.1f + Vector3.up * 1.0f);

                    bool tooClose = false;
                    foreach (var existing in lanternPositions)
                        if (Vector3.Distance(lanternWorld, existing) < 6f) { tooClose = true; break; }
                    if (tooClose) continue;
                    lanternPositions.Add(lanternWorld);

                    var lantern = GameManager.server.CreateEntity(Lantern, lanternWorld, Quaternion.identity);
                    if (lantern != null)
                    {
                        lantern.SetParent(fbL);
                        lantern.transform.localPosition = wlPos - wlPos.normalized * 0.25f + Vector3.up * 0.1f;
                        lantern.transform.localRotation = Quaternion.identity;
                        lantern.Spawn();
                        lantern.SetFlagLocal(BaseEntity.Flags.On, true);
                        pastedEntities.Add(lantern);

                        var storage = lantern.GetComponent<StorageContainer>() ?? lantern.GetComponent<BaseOven>();
                        if (storage != null)
                        {
                            var fuel = ItemManager.CreateByName("lowgradefuel", 1000);
                            if (fuel != null) fuel.MoveToContainer(storage.inventory);
                        }
                    }
                }

                var corrListAll = owner.Where(kv => kv.Value < 0).Select(kv => kv.Key).ToList();
                var barrelRng = new System.Random();
                var barrelPositions = new List<Vector3>();
                foreach (var clc in corrListAll)
                {
                    if (clc.Item1 == 0 && clc.Item2 == 0) continue;
                    if (doorCells.Contains(clc)) continue;
                    for (int d = 0; d < 4; d++)
                    {
                        var n = (clc.Item1 + Dirs[d].dx, clc.Item2 + Dirs[d].dz);
                        if (!walls.ContainsKey(Sk(clc, n))) continue;
                        if (!cells.Contains(n)) continue;
                        if (owner.GetValueOrDefault(n, -1) == -1) continue;
                        if (barrelRng.Next(100) >= 30) continue;
                        var (bwp, bwr) = Lp(clc, n);
                        var bp = fMap.GetValueOrDefault(clc)?.transform.position ?? Vector3.zero;
                        var barrelPos = bp + (fMap.GetValueOrDefault(clc)?.transform.rotation ?? Quaternion.identity) * (bwp - bwp.normalized * 0.8f);
                        barrelPos.y = bp.y + 0.05f;
                        if (barrelPositions.Any(p => Vector3.Distance(p, barrelPos) < 1.5f)) continue;
                        barrelPositions.Add(barrelPos);
                        var barrel = GameManager.server.CreateEntity(WaterBarrel, barrelPos, bwr * R270);
                        if (barrel != null) { barrel.Spawn(); pastedEntities.Add(barrel); }
                    }
                }

                var boxPrefab = "assets/prefabs/deployable/woodenbox/woodbox_deployed.prefab";
                if (currentTier != null)
                {
                    var boxRng = new System.Random();
                    var doneRooms = new HashSet<int>();
                    foreach (var kv in owner)
                    {
                        int rid = kv.Value;
                        if (rid < 0 || doneRooms.Contains(rid)) continue;
                        doneRooms.Add(rid);
                        if (!roomColors.TryGetValue(rid, out string color)) continue;
                        int minNpc, maxNpc, minLoot, maxLoot;
                        List<string> lootPrefabs;
                        switch (color)
                        {
                            case "red":
                                minNpc = currentTier.redMinNpc; maxNpc = currentTier.redMaxNpc;
                                minLoot = currentTier.redMinLoot; maxLoot = currentTier.redMaxLoot;
                                lootPrefabs = currentTier.redLootPrefabs;
                                break;
                            case "blue":
                                minNpc = currentTier.blueMinNpc; maxNpc = currentTier.blueMaxNpc;
                                minLoot = currentTier.blueMinLoot; maxLoot = currentTier.blueMaxLoot;
                                lootPrefabs = currentTier.blueLootPrefabs;
                                break;
                            default:
                                minNpc = currentTier.greenMinNpc; maxNpc = currentTier.greenMaxNpc;
                                minLoot = currentTier.greenMinLoot; maxLoot = currentTier.greenMaxLoot;
                                lootPrefabs = currentTier.greenLootPrefabs;
                                break;
                        }

                        var roomCells = owner.Where(o => o.Value == rid).Select(o => o.Key).ToList();
                        var roomBoxPositions = new List<Vector3>();

                        int boxCount = boxRng.Next(minNpc, maxNpc + 1);
                        for (int b = 0; b < boxCount; b++)
                        {
                            var rc = roomCells[boxRng.Next(roomCells.Count)];
                            var fbBox = fMap.GetValueOrDefault(rc);
                            if (fbBox == null) continue;
                            Vector3 boxPos = Vector3.zero;
                            bool placed = false;
                            for (float minDist = 1.5f; minDist >= 0.3f; minDist -= 0.4f)
                            {
                                for (int attempts = 0; attempts < 30; attempts++)
                                {
                                    boxPos = fbBox.transform.position + new Vector3(boxRng.Next(-10, 11) * 0.05f, 0.05f, boxRng.Next(-10, 11) * 0.05f);
                                    boxPos.y = fbBox.transform.position.y + 0.05f;
                                    if (!roomBoxPositions.Any(p => Vector3.Distance(p, boxPos) < minDist))
                                    {
                                        placed = true;
                                        break;
                                    }
                                }
                                if (placed) break;
                            }
                            if (!placed) continue;
                            roomBoxPositions.Add(boxPos);

                            var box = GameManager.server.CreateEntity(boxPrefab, boxPos, Quaternion.identity);
                            if (box == null) continue;
                            box.Spawn();
                            pastedEntities.Add(box);

                            var storage = box.GetComponent<StorageContainer>();
                            if (storage == null) continue;
                            var weapon = currentTier.npcWeapons[boxRng.Next(currentTier.npcWeapons.Count)];
                            var health = boxRng.Next((int)currentTier.npcMinHealth, (int)currentTier.npcMaxHealth + 1);
                            var text = "prefab=assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab\n"
                                     + $"weapon={weapon}\n"
                                     + $"dmgscale={currentTier.npcDamageScale}\n"
                                     + $"health={health}";
                            var note = ItemManager.CreateByName("note");
                            if (note != null)
                            {
                                note.text = text;
                                note.MoveToContainer(storage.inventory);
                            }
                        }

                        int lootCount = boxRng.Next(minLoot, maxLoot + 1);
                        for (int l = 0; l < lootCount; l++)
                        {
                            var rc2 = roomCells[boxRng.Next(roomCells.Count)];
                            var fbLoot = fMap.GetValueOrDefault(rc2);
                            if (fbLoot == null) continue;
                            var avoidWalls = Vector3.zero;
                            foreach (var d in Dirs)
                            {
                                var n = (rc2.Item1 + d.dx, rc2.Item2 + d.dz);
                                if (walls.ContainsKey(Sk(rc2, n)))
                                    avoidWalls -= new Vector3(d.dx, 0, d.dz);
                            }
                            Vector3 lootPos = Vector3.zero;
                            bool placed = false;
                            for (float minDist = 0.8f; minDist >= 0.1f; minDist -= 0.35f)
                            {
                                for (int la = 0; la < 50; la++)
                                {
                                    var offset = avoidWalls.normalized * 0.6f + new Vector3(boxRng.Next(-5, 6) * 0.1f, 0, boxRng.Next(-5, 6) * 0.1f);
                                    lootPos = fbLoot.transform.position + fbLoot.transform.rotation * offset;
                                    lootPos.y = fbLoot.transform.position.y + 0.05f;
                                    if (!roomBoxPositions.Any(p => Vector3.Distance(p, lootPos) < minDist) && !TooClose(lootPos, minDist, pastedEntities))
                                    {
                                        placed = true;
                                        break;
                                    }
                                }
                                if (placed) break;
                            }
                            if (!placed) continue;
                            roomBoxPositions.Add(lootPos);

                            var lprefab = lootPrefabs[boxRng.Next(lootPrefabs.Count)];
                            var lootCrate = GameManager.server.CreateEntity(lprefab, lootPos, Quaternion.identity);
                            if (lootCrate != null) { lootCrate.Spawn(); pastedEntities.Add(lootCrate); }
                        }
                    }
                }

                if (currentTier != null && currentTier.corridorNpcDensity > 0)
                {
                    var corrBoxes = new List<Vector3>();
                    var corrBoxRng = new System.Random();
                    var corrCells = owner.Where(kv => kv.Value < 0).Select(kv => kv.Key).ToList();
                    foreach (var cc in corrCells)
                    {
                        if (cc.Item1 == 0 && cc.Item2 == 0) continue;
                        int chance = corrBoxRng.Next(100);
                        if (chance >= currentTier.corridorNpcDensity) continue;
                        var fbC = fMap.GetValueOrDefault(cc);
                        if (fbC == null) continue;
                        var awayFromWalls = Vector3.zero;
                        foreach (var d in Dirs)
                        {
                            var n = (cc.Item1 + d.dx, cc.Item2 + d.dz);
                            if (walls.ContainsKey(Sk(cc, n)) && owner.GetValueOrDefault(n, -1) != -1)
                                awayFromWalls -= new Vector3(d.dx, 0, d.dz);
                        }
                        Vector3 pos;
                        int att = 0;
                        do
                        {
                            pos = fbC.transform.position + fbC.transform.rotation * (awayFromWalls.normalized * 0.6f + new Vector3(corrBoxRng.Next(-8, 9) * 0.1f, 0, corrBoxRng.Next(-8, 9) * 0.1f));
                            pos.y = fbC.transform.position.y + 0.05f;
                            att++;
                        } while (att < 15 && (corrBoxes.Any(p => Vector3.Distance(p, pos) < 1.5f) || TooClose(pos, 1.0f, pastedEntities)));
                        if (att >= 15 && (corrBoxes.Any(p => Vector3.Distance(p, pos) < 1.5f) || TooClose(pos, 1.0f, pastedEntities))) continue;
                        corrBoxes.Add(pos);

                        var cb = GameManager.server.CreateEntity(boxPrefab, pos, Quaternion.identity);
                        if (cb != null) { cb.Spawn(); pastedEntities.Add(cb); }
                        var cstorage = cb?.GetComponent<StorageContainer>();
                        if (cstorage != null)
                        {
                            var cweapon = currentTier.npcWeapons[corrBoxRng.Next(currentTier.npcWeapons.Count)];
                            var chealth = corrBoxRng.Next((int)currentTier.npcMinHealth, (int)currentTier.npcMaxHealth + 1);
                            var ctext = "prefab=assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab\n"
                                     + $"weapon={cweapon}\n"
                                     + $"dmgscale={currentTier.npcDamageScale}\n"
                                     + $"health={chealth}";
                            var cnote = ItemManager.CreateByName("note");
                            if (cnote != null) { cnote.text = ctext; cnote.MoveToContainer(cstorage.inventory); }
                        }
                    }
                }

                if (currentTier != null && currentTier.corridorLootDensity > 0 && currentTier.corridorLootPrefabs.Count > 0)
                {
                    var lootPositions = new List<Vector3>();
                    var lootRng = new System.Random();
                    var corrLootCells = owner.Where(kv => kv.Value < 0).Select(kv => kv.Key).ToList();
                    foreach (var clc in corrLootCells)
                    {
                        if (clc.Item1 == 0 && clc.Item2 == 0) continue;
                        int spawns = currentTier.corridorLootDensity >= 50 ? (currentTier.corridorLootDensity >= 100 ? 2 : 1) : (lootRng.Next(50) < currentTier.corridorLootDensity ? 1 : 0);
                        for (int si = 0; si < spawns; si++)
                        {
                            var fbL = fMap.GetValueOrDefault(clc);
                            if (fbL == null) continue;
                            var avoidWalls = Vector3.zero;
                            foreach (var d in Dirs)
                            {
                                var n = (clc.Item1 + d.dx, clc.Item2 + d.dz);
                                if (walls.ContainsKey(Sk(clc, n)) && owner.GetValueOrDefault(n, -1) != -1)
                                    avoidWalls -= new Vector3(d.dx, 0, d.dz);
                            }
                            Vector3 pos;
                            int att = 0;
                            do
                            {
                                var offset = avoidWalls.normalized * 0.7f + new Vector3(lootRng.Next(-6, 7) * 0.1f, 0, lootRng.Next(-6, 7) * 0.1f);
                                pos = fbL.transform.position + fbL.transform.rotation * offset;
                                pos.y = fbL.transform.position.y + 0.05f;
                                att++;
                            } while (att < 30 && (lootPositions.Any(p => Vector3.Distance(p, pos) < 1.5f) || TooClose(pos, 0.5f, pastedEntities)));
                            if (att >= 30 && (lootPositions.Any(p => Vector3.Distance(p, pos) < 1.5f) || TooClose(pos, 0.5f, pastedEntities))) continue;
                            lootPositions.Add(pos);

                            var prefab = currentTier.corridorLootPrefabs[lootRng.Next(currentTier.corridorLootPrefabs.Count)];
                            var loot = GameManager.server.CreateEntity(prefab, pos, Quaternion.identity);
                            if (loot != null) { loot.Spawn(); pastedEntities.Add(loot); }
                        }
                    }
                }

                var rackRng = new System.Random();
                var racked = new HashSet<(int, int, int, int)>();
                var entrance = fMap.GetValueOrDefault((0, 0));
                IOEntity prevIO = null;
                var genCell = new[] { (0, 1), (1, 0), (0, -1), (-1, 0) }
                    .Select(c => ((int, int)?)c)
                    .FirstOrDefault(c => cells.Contains(c.Value) && owner.GetValueOrDefault(c.Value, -1) == -1);
                var genFoundation = genCell != null ? fMap.GetValueOrDefault(genCell.Value) : entrance;
                if (genFoundation != null)
                {
                    var gen = GameManager.server.CreateEntity("assets/prefabs/deployable/playerioents/generators/generator.small.prefab", genFoundation.transform.position) as BaseEntity;
                    if (gen != null)
                    {
                        gen.SetParent(genFoundation);
                        gen.transform.localPosition = new Vector3(0, 3.1f, 0);
                        gen.transform.localRotation = R180;
                        gen.Spawn();
                        gen.SetFlagLocal(BaseEntity.Flags.On, true);
                        gen.EnableSaving(false);
                        pastedEntities.Add(gen);
                        prevIO = gen.GetComponent<IOEntity>();
                    }
                    var tc = GameManager.server.CreateEntity("assets/prefabs/deployable/tool cupboard/cupboard.tool.deployed.prefab", genFoundation.transform.position) as BaseEntity;
                    if (tc != null)
                    {
                        tc.SetParent(genFoundation);
                        tc.transform.localPosition = new Vector3(1.0f, 3.1f, 0);
                        tc.transform.localRotation = R180;
                        tc.Spawn();
                        tc.EnableSaving(false);
                        pastedEntities.Add(tc);
                    }
                }
                foreach (var clc in corrListAll)
                {
                    for (int d = 0; d < 4; d++)
                    {
                        var n = (clc.Item1 + Dirs[d].dx, clc.Item2 + Dirs[d].dz);
                        var key = Sk(clc, n);
                        if (!walls.ContainsKey(key)) continue;
                        if (!cells.Contains(n)) continue;
                        if (racked.Contains(key)) continue;
                        racked.Add(key);
                        var wallKey = key;
                        if (!walls.TryGetValue(wallKey, out var wallEntity) || wallEntity == null) continue;
                        for (int side = 0; side < 2; side++)
                        {
                            if (rackRng.Next(100) >= 20) continue;
                            var rackPrefab = side == 0 ? WeaponRackH : WeaponRackW;
                            var rack = GameManager.server.CreateEntity(rackPrefab, wallEntity.transform.position) as BaseEntity;
                            if (rack == null) continue;
                            rack.SetParent(wallEntity);
                            rack.transform.localPosition = side == 0 ? new Vector3(0.1f, 1.5f, 0) : new Vector3(-0.15f, 1.5f, 0);
                            rack.transform.localRotation = side == 0 ? R90 : R270;
                            rack.Spawn();
                            rack.SetFlagLocal(BaseEntity.Flags.On, true);
                            rack.EnableSaving(false);
                            pastedEntities.Add(rack);
                            if (prevIO != null)
                            {
                                NextTick(() =>
                                {
                                    if (rack == null || rack.IsDestroyed) return;
                                    foreach (var child in rack.children)
                                    {
                                        var childIO = child?.GetComponent<IOEntity>();
                                        if (childIO != null)
                                        {
                                            ConnectIO(prevIO, childIO);
                                            prevIO = childIO;
                                            break;
                                        }
                                    }
                                });
                            }
                        }
                    }
                }

                NextTick(() =>
                {
                    foreach (var w in walls.Values) if (w && !w.IsDestroyed) InitBlock(w, BuildingGrade.Enum.Stone);
                    foreach (var kv in fMap)
                    {
                        foreach (Transform child in kv.Value.transform)
                        {
                            var bb = child.GetComponent<BuildingBlock>();
                            if (bb && !bb.IsDestroyed && bb.buildingID != buildingID)
                                InitBlock(bb, BuildingGrade.Enum.Stone);
                        }
                    }
                });

                int rooms = owner.Values.Where(v => v >= 0).Distinct().Count();
                Puts($"The dungeon was generated successfully: {rooms} rooms, {cells.Count} foundations");
                BaseInit(pastedEntities);
                onComplete?.Invoke(pastedEntities);
            });
        }

        public void GenerateBaseByTier(string tier, Action<List<BaseEntity>> onComplete = null)
        {
            if (Configuration.tiers.Count == 0)
            {
                PrintWarning("No tiers configured, cannot generate base");
                return;
            }
            if (!Configuration.tiers.TryGetValue(tier.ToLower(), out var tc))
            {
                tc = Configuration.tiers.Values.First();
                PrintWarning($"Unknown tier '{tier}', using '{Configuration.tiers.First().Key}'");
            }
            currentTier = tc;
            var rng = new System.Random();
            int size = Mathf.Clamp(rng.Next(tc.minSize, tc.maxSize + 1), 1, 30);
            var origin = new Vector3(0, 100, 0);
            GenerateBaseInternal(size, origin, Vector3.forward, Vector3.right, null, onComplete);
        }

        public void GenerateBaseAtByTier(Vector3 origin, Vector3 forward, string tier)
        {
            if (Configuration.tiers.Count == 0)
            {
                PrintWarning("No tiers configured, cannot generate base");
                return;
            }
            if (!Configuration.tiers.TryGetValue(tier.ToLower(), out var tc))
            {
                tc = Configuration.tiers.Values.First();
                PrintWarning($"Unknown tier '{tier}', using '{Configuration.tiers.First().Key}'");
            }
            currentTier = tc;
            var rng = new System.Random();
            int size = Mathf.Clamp(rng.Next(tc.minSize, tc.maxSize + 1), 1, 30);
            forward.y = 0f; forward.Normalize();
            var rightV = Vector3.Cross(Vector3.up, forward).normalized;
            GenerateBaseInternal(size, origin, forward, rightV, null, null);
        }

        private void PlaceDoorLockAndBranch(BaseEntity dr, BuildingBlock fb, Vector3 lp, Quaternion lr, List<BaseEntity> pastedEntities)
        {
            if (dr == null || fb == null) return;
            var doorLock = GameManager.server.CreateEntity(CodeLock, dr.transform.position);
            if (doorLock != null)
            {
                doorLock.SetParent(dr, dr.GetSlotAnchorName(BaseEntity.Slot.Lock));
                doorLock.transform.localPosition = Vector3.zero;
                doorLock.transform.localRotation = Quaternion.identity;
                doorLock.Spawn();
                pastedEntities.Add(doorLock);
                var doorCodeLock = doorLock as CodeLock;
                if (doorCodeLock != null)
                {
                    doorCodeLock.code = "0707";
                    doorCodeLock.SetFlagLocal(BaseEntity.Flags.Locked, true);
                    dr.SetSlot(BaseEntity.Slot.Lock, doorCodeLock);
                }
            }

            var branch = GameManager.server.CreateEntity(ElecBranch, dr.transform.position);
            if (branch != null)
            {
                branch.SetParent(fb);
                branch.transform.localPosition = lp + lr * new Vector3(0.05f, 1.23f, 0.96f);
                branch.transform.localRotation = lr * R90;
                branch.Spawn();
                pastedEntities.Add(branch);
                var eb = branch as ElectricalBranch;
                if (eb != null)
                {
                    eb.branchAmount = 1234569;
                    eb.SendNetworkUpdate();
                }
            }
        }

        private void SetRoomColor(int roomId, string doorPrefab)
        {
            if (roomColors.ContainsKey(roomId)) return;
            if (doorPrefab.Contains("toptier")) roomColors[roomId] = "red";
            else if (doorPrefab.Contains("metal")) roomColors[roomId] = "blue";
            else roomColors[roomId] = "green";
        }

        bool TooClose(Vector3 pos, float minDist, List<BaseEntity> list)
        {
            foreach (var e in list)
                if (e != null && e.IsValid() && Vector3.Distance(e.transform.position, pos) < minDist)
                    return true;
            return false;
        }

        private void InitBlock(BuildingBlock b, BuildingGrade.Enum g)
        {
            b.blockDefinition = PrefabAttribute.server.Find<Construction>(b.prefabID);
            b.SetGrade(g);
            b.AttachToBuilding(buildingID);
            b.buildingID = buildingID;
            b.EnableSaving(false);
            b.SetHealthToMax();
            b.UpdateSkin();
            b.SendNetworkUpdate();
            b.ResetUpkeepTime();
            b.GetComponent<DecayEntity>().lastDecayTick = 999999;
        }

        (HashSet<(int, int)> cells, Dictionary<(int, int), int> owner, List<((int, int), (int, int))> doors, List<((int, int), (int, int))> corrPairs)
            Layout(int target)
        {
            var rng = new System.Random();
            var cells = new HashSet<(int, int)>();
            var owner = new Dictionary<(int, int), int>();
            var doors = new List<((int, int), (int, int))>();
            var corrPairs = new List<((int, int), (int, int))>();
            int nextRid = 0;
            int curX = 0, curZ = 0, curDir = 0;
            int stepsInSeg = 0, segMax = rng.Next(8, 17);

            while (cells.Count < target * 3 + 6)
            {
                if (stepsInSeg >= segMax) { stepsInSeg = 0; segMax = rng.Next(8, 17); curDir = (curDir + (rng.Next(2) == 0 ? 1 : 3)) % 4; }
                int pr = (curDir + 1) % 4;
                var c1 = (curX, curZ);
                var c2 = (curX + Dirs[pr].dx, curZ + Dirs[pr].dz);
                corrPairs.Add((c1, c2));
                if (!cells.Contains(c1)) { cells.Add(c1); owner[c1] = -1; }
                if (!cells.Contains(c2)) { cells.Add(c2); owner[c2] = -1; }
                stepsInSeg++; curX += Dirs[curDir].dx; curZ += Dirs[curDir].dz;
            }

            for (int pass = 0; pass < 4 && nextRid < target * 2; pass++)
            {
                var corrList = cells.Where(c => owner.GetValueOrDefault(c, -2) < 0).OrderBy(_ => rng.Next()).ToList();
                foreach (var cc in corrList)
                {
                    if ((cc.Item1 == 0 && cc.Item2 == 0) || (cc.Item1 == 0 && cc.Item2 == 1)) continue;
                    for (int side = 0; side < 4; side++)
                    {
                        var rc = (cc.Item1 + Dirs[side].dx, cc.Item2 + Dirs[side].dz);
                        if (cells.Contains(rc)) continue;
                        foreach (var type in RoomTypes.OrderBy(_ => rng.Next()))
                        {
                            int tw = type.w, td = type.d, rw, rd, rx, rz, off;
                            if (side <= 1) { rw = tw; rd = td; off = rng.Next(tw); rz = side == 0 ? rc.Item2 : rc.Item2 - td + 1; rx = rc.Item1 - off; }
                            else { rw = td; rd = tw; off = rng.Next(tw); rx = side == 2 ? rc.Item1 : rc.Item1 - td + 1; rz = rc.Item2 - off; }
                            if (rw <= 0 || rd <= 0) continue;
                            bool ok = true;
                            for (int x = 0; x < rw && ok; x++) for (int z = 0; z < rd && ok; z++) if (cells.Contains((rx + x, rz + z))) ok = false;
                            if (!ok) continue;
                            for (int x = 0; x < rw; x++) for (int z = 0; z < rd; z++) { var c = (rx + x, rz + z); cells.Add(c); owner[c] = nextRid; }
                            doors.Add((rc, cc)); nextRid++; break;
                        }
                    }
                }
            }
            return (cells, owner, doors, corrPairs);
        }

        (int, int, int, int) Sk((int, int) a, (int, int) b) =>
            a.Item1 < b.Item1 || (a.Item1 == b.Item1 && a.Item2 < b.Item2) ? (a.Item1, a.Item2, b.Item1, b.Item2) : (b.Item1, b.Item2, a.Item1, a.Item2);

        (Vector3, Quaternion) Lp((int, int) c, (int, int) n) =>
            c.Item1 == n.Item1 ? (c.Item2 < n.Item2 ? (new Vector3(0, 0, 1.5f), R270) : (new Vector3(0, 0, -1.5f), R90)) :
            (c.Item1 < n.Item1 ? (new Vector3(1.5f, 0, 0), R0) : (new Vector3(-1.5f, 0, 0), R180));
    }
}
