require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  ActivityType
} = require("discord.js");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");

/* =========================
   EXPRESS / UPTIMEROBOT
========================= */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => res.status(200).send("Bot aktif 🔥"));
app.get("/health", (_, res) => res.status(200).send("OK"));
app.use((_, res) => res.status(200).send("Bot aktif 🔥"));

app.listen(PORT, () => {
  console.log(`Web server aktif: ${PORT}`);
});

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember
  ]
});

const PREFIX = process.env.PREFIX || ".";
const OWNER_IDS = (process.env.OWNER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const AUTO_CHANNEL_JOIN = process.env.AUTO_CHANNEL_JOIN || null;

const SETTINGS = {
  channelLogName: process.env.CHANNEL_LOG_NAME || "kanal-log",
  roleLogName: process.env.ROLE_LOG_NAME || "rol-log",
  banLogName: process.env.BAN_LOG_NAME || "ban-log",
  voiceLogName: process.env.VOICE_LOG_NAME || "voice-log",
  messageLogName: process.env.MESSAGE_LOG_NAME || "message-log",
  timeoutLogName: process.env.TIMEOUT_LOG_NAME || "timeout-log"
};

const COLORS = {
  green: 0x57F287,
  red: 0xED4245,
  yellow: 0xFEE75C,
  orange: 0xFAA61A,
  blue: 0x5865F2,
  white: 0xFFFFFF
};

/* =========================
   DATA / WHITELIST
========================= */
const dataDir = path.join(__dirname, "data");
const whitelistPath = path.join(dataDir, "whitelist.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(whitelistPath)) {
  fs.writeFileSync(whitelistPath, JSON.stringify([], null, 2));
}

function loadWhitelist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWhitelist(list) {
  fs.writeFileSync(whitelistPath, JSON.stringify([...new Set(list)], null, 2));
}

function isOwner(userId) {
  return OWNER_IDS.includes(userId);
}

function isWhitelisted(userId) {
  return loadWhitelist().includes(userId) || isOwner(userId);
}

/* =========================
   MESSAGE CACHE
========================= */
const messageCache = new Map();
const MESSAGE_CACHE_TTL = 1000 * 60 * 60;

function cacheMessage(message) {
  if (!message || !message.id) return;

  messageCache.set(message.id, {
    id: message.id,
    guildId: message.guild?.id || null,
    channelId: message.channel?.id || null,
    channelName: message.channel?.name || null,
    authorId: message.author?.id || null,
    authorTag: message.author?.tag || "Bilinmiyor",
    content: message.content || "",
    attachments: [...message.attachments.values()].map((a) => a.url),
    createdTimestamp: message.createdTimestamp || Date.now()
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, data] of messageCache.entries()) {
    if (now - (data.createdTimestamp || now) > MESSAGE_CACHE_TTL) {
      messageCache.delete(id);
    }
  }
}, 5 * 60 * 1000);

/* =========================
   HELPERS
========================= */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUser(user) {
  return user ? `${user.tag} (${user.id})` : "Bilinmiyor";
}

function formatMember(member) {
  return member ? `${member.user.tag} (${member.id})` : "Bilinmiyor";
}

function getAvatar(entity) {
  if (!entity) return null;

  if (typeof entity.displayAvatarURL === "function") {
    return entity.displayAvatarURL({
      size: 512,
      extension: "png",
      forceStatic: true
    });
  }

  if (entity.user && typeof entity.user.displayAvatarURL === "function") {
    return entity.user.displayAvatarURL({
      size: 512,
      extension: "png",
      forceStatic: true
    });
  }

  return null;
}

function truncate(text, max = 1000) {
  if (!text) return "İçerik alınamadı.";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

async function getLogChannel(guild, name) {
  return guild.channels.cache.find(
    (c) => c.name === name && c.type === ChannelType.GuildText
  ) || null;
}

async function sendLog(guild, logName, embed) {
  const channel = await getLogChannel(guild, logName);
  if (!channel) return;
  await channel.send({ embeds: [embed] }).catch(() => null);
}

function extractChangedRoleIds(changes = []) {
  const ids = new Set();

  for (const change of changes) {
    if (!change) continue;

    if (change.key === "$add" || change.key === "$remove") {
      const roles = Array.isArray(change.new)
        ? change.new
        : Array.isArray(change.old)
          ? change.old
          : [];

      for (const role of roles) {
        if (role?.id) ids.add(String(role.id));
      }
    }
  }

  return [...ids];
}

async function fetchAuditEntry(guild, type, targetId, options = {}) {
  const {
    limit = 20,
    maxAgeMs = 30000,
    retries = 6,
    retryDelay = 1500,
    matcher = null
  } = options;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelay);
    }

    try {
      const logs = await guild.fetchAuditLogs({ type, limit });
      const now = Date.now();

      const entry = logs.entries.find((entry) => {
        const entryTargetId = entry.target?.id || entry.targetId;
        const recent = now - entry.createdTimestamp < maxAgeMs;
        const sameTarget =
          targetId == null ? true : String(entryTargetId) === String(targetId);

        if (!recent || !sameTarget) return false;
        if (typeof matcher === "function" && !matcher(entry)) return false;

        return true;
      });

      if (entry) return entry;
    } catch {}
  }

  return null;
}

async function fetchRoleUpdateAuditEntry(guild, memberId, changedRoleIds = []) {
  return fetchAuditEntry(guild, AuditLogEvent.MemberRoleUpdate, memberId, {
    limit: 20,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500,
    matcher: (entry) => {
      if (!changedRoleIds.length) return true;
      const changedInEntry = extractChangedRoleIds(entry.changes || []);
      return changedRoleIds.some((id) => changedInEntry.includes(String(id)));
    }
  });
}

async function fetchMemberUpdateAuditEntry(guild, memberId) {
  return fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, memberId, {
    limit: 20,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });
}

async function fetchMessageDeleteAudit(guild, message) {
  try {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MessageDelete,
      limit: 10
    });

    const now = Date.now();

    const entry = logs.entries.find((entry) => {
      const sameTarget =
        String(entry.target?.id || "") === String(message.author?.id || "");
      const sameChannel =
        String(entry.extra?.channel?.id || "") ===
        String(message.channel?.id || "");
      const recent = now - entry.createdTimestamp < 15000;

      return sameTarget && sameChannel && recent;
    });

    return entry || null;
  } catch {
    return null;
  }
}

async function banMemberSafe(guild, userId, reason) {
  try {
    await guild.members.ban(userId, { reason });
    return true;
  } catch {
    return false;
  }
}

function permissionDiff(oldPerms, newPerms) {
  const changed = [];
  const oldArr = [...oldPerms.toArray()];
  const newArr = [...newPerms.toArray()];

  const added = newArr.filter((perm) => !oldArr.includes(perm));
  const removed = oldArr.filter((perm) => !newArr.includes(perm));

  if (added.length) changed.push(`Eklenen izinler: ${added.join(", ")}`);
  if (removed.length) changed.push(`Kaldırılan izinler: ${removed.join(", ")}`);

  return changed;
}

function overwriteTypeName(type) {
  if (type === 0) return "Rol";
  if (type === 1) return "Üye";
  return "Bilinmiyor";
}

function channelChanges(oldChannel, newChannel) {
  const changes = [];

  if (oldChannel.name !== newChannel.name) {
    changes.push(`İsim: **${oldChannel.name}** → **${newChannel.name}**`);
  }

  if ((oldChannel.topic || "") !== (newChannel.topic || "")) {
    changes.push(
      `Konu: **${oldChannel.topic || "Yok"}** → **${newChannel.topic || "Yok"}**`
    );
  }

  if ((oldChannel.nsfw ?? false) !== (newChannel.nsfw ?? false)) {
    changes.push(
      `NSFW: **${oldChannel.nsfw ? "Açık" : "Kapalı"}** → **${newChannel.nsfw ? "Açık" : "Kapalı"}**`
    );
  }

  if ((oldChannel.rateLimitPerUser || 0) !== (newChannel.rateLimitPerUser || 0)) {
    changes.push(
      `Yavaş mod: **${oldChannel.rateLimitPerUser || 0}s** → **${newChannel.rateLimitPerUser || 0}s**`
    );
  }

  if ((oldChannel.bitrate || 0) !== (newChannel.bitrate || 0)) {
    changes.push(
      `Bitrate: **${oldChannel.bitrate || 0}** → **${newChannel.bitrate || 0}**`
    );
  }

  if ((oldChannel.userLimit || 0) !== (newChannel.userLimit || 0)) {
    changes.push(
      `Kullanıcı limiti: **${oldChannel.userLimit || 0}** → **${newChannel.userLimit || 0}**`
    );
  }

  if ((oldChannel.parentId || "Yok") !== (newChannel.parentId || "Yok")) {
    const oldParent = oldChannel.parent?.name || "Yok";
    const newParent = newChannel.parent?.name || "Yok";
    changes.push(`Kategori: **${oldParent}** → **${newParent}**`);
  }

  if ((oldChannel.position ?? 0) !== (newChannel.position ?? 0)) {
    changes.push(
      `Pozisyon: **${oldChannel.position ?? 0}** → **${newChannel.position ?? 0}**`
    );
  }

  if ((oldChannel.defaultAutoArchiveDuration || 0) !== (newChannel.defaultAutoArchiveDuration || 0)) {
    changes.push(
      `Otomatik arşiv süresi: **${oldChannel.defaultAutoArchiveDuration || 0}** → **${newChannel.defaultAutoArchiveDuration || 0}**`
    );
  }

  if ((oldChannel.rtcRegion || "Otomatik") !== (newChannel.rtcRegion || "Otomatik")) {
    changes.push(
      `RTC Bölgesi: **${oldChannel.rtcRegion || "Otomatik"}** → **${newChannel.rtcRegion || "Otomatik"}**`
    );
  }

  if ((oldChannel.videoQualityMode || 1) !== (newChannel.videoQualityMode || 1)) {
    changes.push(
      `Video kalite modu: **${oldChannel.videoQualityMode || 1}** → **${newChannel.videoQualityMode || 1}**`
    );
  }

  try {
    const oldOverwrites = oldChannel.permissionOverwrites?.cache || new Map();
    const newOverwrites = newChannel.permissionOverwrites?.cache || new Map();

    for (const [id, newOverwrite] of newOverwrites) {
      const oldOverwrite = oldOverwrites.get(id);

      if (!oldOverwrite) {
        changes.push(
          `İzin eklendi: **${overwriteTypeName(newOverwrite.type)} ${id}** için kanal izni oluşturuldu.`
        );
        continue;
      }

      const permChanges = permissionDiff(oldOverwrite.allow, newOverwrite.allow);
      const denyChanges = permissionDiff(oldOverwrite.deny, newOverwrite.deny);

      for (const item of permChanges) {
        changes.push(`İzin güncellendi (${id}): ${item}`);
      }

      for (const item of denyChanges) {
        changes.push(`Engel güncellendi (${id}): ${item}`);
      }
    }

    for (const [id, oldOverwrite] of oldOverwrites) {
      if (!newOverwrites.has(id)) {
        changes.push(
          `İzin silindi: **${overwriteTypeName(oldOverwrite.type)} ${id}** için kanal izni kaldırıldı.`
        );
      }
    }
  } catch {}

  return changes.length ? changes : ["Kanal ayarlarında değişiklik yapıldı."];
}

function roleChanges(oldRole, newRole) {
  const changes = [];

  if (oldRole.name !== newRole.name) {
    changes.push(`İsim: **${oldRole.name}** → **${newRole.name}**`);
  }

  if (oldRole.color !== newRole.color) {
    changes.push(`Renk: **${oldRole.hexColor}** → **${newRole.hexColor}**`);
  }

  if (oldRole.hoist !== newRole.hoist) {
    changes.push(
      `Ayrı gösterim: **${oldRole.hoist ? "Açık" : "Kapalı"}** → **${newRole.hoist ? "Açık" : "Kapalı"}**`
    );
  }

  if (oldRole.mentionable !== newRole.mentionable) {
    changes.push(
      `Etiketlenebilirlik: **${oldRole.mentionable ? "Açık" : "Kapalı"}** → **${newRole.mentionable ? "Açık" : "Kapalı"}**`
    );
  }

  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
    const permDiffs = permissionDiff(oldRole.permissions, newRole.permissions);
    changes.push(...permDiffs);
  }

  if ((oldRole.position ?? 0) !== (newRole.position ?? 0)) {
    changes.push(`Pozisyon: **${oldRole.position}** → **${newRole.position}**`);
  }

  return changes.length ? changes : ["Rol ayarlarında değişiklik yapıldı."];
}

async function resolveMember(guild, input) {
  if (!input) return null;
  const id = input.replace(/[^0-9]/g, "");
  if (!id) return null;

  try {
    return await guild.members.fetch(id);
  } catch {
    return null;
  }
}

function parseDuration(input) {
  if (!input) return null;

  const match = input.toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return value * multipliers[unit];
}

function humanizeDuration(ms) {
  if (ms <= 0) return "0 saniye";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days) return `${days} gün`;
  if (hours) return `${hours} saat`;
  if (minutes) return `${minutes} dakika`;
  return `${seconds} saniye`;
}

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle("Yardım Menüsü")
    .setDescription([
      `**Prefix:** \`${PREFIX}\``,
      "",
      `**Moderasyon Komutları**`,
      `\`${PREFIX}ban @kişi sebep\` → Kullanıcıyı banlar`,
      `\`${PREFIX}unban ID sebep\` → Banı kaldırır`,
      `\`${PREFIX}kick @kişi sebep\` → Kullanıcıyı sunucudan atar`,
      `\`${PREFIX}timeout @kişi 1h sebep\` → Süreli timeout atar`,
      `\`${PREFIX}sil 50\` → Mesaj temizler`,
      "",
      `**Ses Komutları**`,
      `\`${PREFIX}join\` → Botu bulunduğun ses kanalına sokar`,
      `\`${PREFIX}leave\` → Botu ses kanalından çıkarır`,
      "",
      `**Whitelist Komutları**`,
      `\`${PREFIX}wl-ekle @kişi\` → Whitelist ekler`,
      `\`${PREFIX}wl-sil @kişi\` → Whitelistten çıkarır`,
      `\`${PREFIX}wl-liste\` → Whitelist listesini gösterir`,
      "",
      `**Bilgi**`,
      `\`${PREFIX}yardım\` → Tüm komutları gösterir`
    ].join("\n"))
    .setTimestamp();
}

async function recreateDeletedRole(guild, role) {
  try {
    await guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions,
      mentionable: role.mentionable,
      reason: "Whitelist dışı rol silme - rol geri oluşturuldu"
    });
  } catch {
    return null;
  }
}

/* =========================
   READY
========================= */
client.once("ready", async () => {
  console.log(`${client.user.tag} aktif oldu.`);

  client.user.setPresence({
    activities: [{ name: "Guard Sistemi Aktif", type: ActivityType.Watching }],
    status: "dnd"
  });

  if (AUTO_CHANNEL_JOIN) {
    try {
      const channel = await client.channels.fetch(AUTO_CHANNEL_JOIN).catch(() => null);

      if (!channel) {
        return console.log("AUTO_CHANNEL_JOIN kanal ID bulunamadı.");
      }

      if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
      ) {
        return console.log("AUTO_CHANNEL_JOIN bir ses kanalı değil.");
      }

      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });

      console.log(`Otomatik ses kanalına bağlandı: ${channel.name}`);
    } catch (error) {
      console.error("Otomatik ses kanalına bağlanırken hata:", error);
    }
  }
});

/* =========================
   MESSAGE CACHE EVENTS
========================= */
client.on("messageCreate", (message) => {
  if (!message.guild || message.author?.bot) return;
  cacheMessage(message);
});

client.on("messageUpdate", (_, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  cacheMessage(newMessage);
});

/* =========================
   COMMANDS
========================= */
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  if (command === "yardım" || command === "help") {
    return message.reply({ embeds: [helpEmbed()] });
  }

  if (command === "wl-ekle") {
    if (!isOwner(message.author.id)) {
      return message.reply("Bu komutu sadece bot sahibi kullanabilir.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Kullanıcı bulunamadı.");

    const list = loadWhitelist();
    if (list.includes(target.id)) {
      return message.reply("Bu kullanıcı zaten whitelistte.");
    }

    list.push(target.id);
    saveWhitelist(list);

    return message.reply(`Whitelist eklendi: **${target.user.tag}** (${target.id})`);
  }

  if (command === "wl-sil") {
    if (!isOwner(message.author.id)) {
      return message.reply("Bu komutu sadece bot sahibi kullanabilir.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Kullanıcı bulunamadı.");

    const list = loadWhitelist().filter((id) => id !== target.id);
    saveWhitelist(list);

    return message.reply(`Whitelistten çıkarıldı: **${target.user.tag}** (${target.id})`);
  }

  if (command === "wl-liste") {
    if (!isOwner(message.author.id)) {
      return message.reply("Bu komutu sadece bot sahibi kullanabilir.");
    }

    const list = loadWhitelist();
    if (!list.length) return message.reply("Whitelist boş.");

    const lines = await Promise.all(
      list.map(async (id, i) => {
        try {
          const user = await client.users.fetch(id);
          return `${i + 1}. ${user.tag} (${id})`;
        } catch {
          return `${i + 1}. Bilinmeyen Kullanıcı (${id})`;
        }
      })
    );

    return message.reply(`**Whitelist Listesi**\n${lines.join("\n")}`);
  }

  if (command === "ban") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return message.reply("Ban yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Banlanacak kullanıcı bulunamadı.");
    if (target.id === message.author.id) return message.reply("Kendini banlayamazsın.");
    if (!target.bannable) {
      return message.reply("Bu kullanıcıyı banlayamıyorum. Rol sırası veya yetkiyi kontrol et.");
    }

    const reason = args.slice(1).join(" ") || "Sebep belirtilmedi.";
    await target.ban({ reason: `${reason} | Komutu kullanan: ${message.author.tag}` });

    return message.reply(`**${target.user.tag}** banlandı. Sebep: **${reason}**`);
  }

  if (command === "unban") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return message.reply("Ban kaldırma yetkin yok.");
    }

    const userId = args[0]?.replace(/[^0-9]/g, "");
    if (!userId) {
      return message.reply("Kullanıcı ID girmelisin. Örnek: `.unban 123456789012345678 sebep`");
    }

    let bannedUser;
    try {
      bannedUser = await message.guild.bans.fetch(userId);
    } catch {
      return message.reply("Bu kullanıcı banlı görünmüyor.");
    }

    const reason = args.slice(1).join(" ") || "Sebep belirtilmedi.";
    await message.guild.members.unban(
      userId,
      `${reason} | Komutu kullanan: ${message.author.tag}`
    );

    const embed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle("Kullanıcının Banı Kaldırıldı")
      .setDescription([
        `**Banı kaldırılan kişi:** ${formatUser(bannedUser.user || bannedUser)}`,
        `**Banı kaldıran kişi:** ${formatUser(message.author)}`,
        `**Sebep:** ${reason}`
      ].join("\n"))
      .setThumbnail(getAvatar(bannedUser.user || bannedUser))
      .setTimestamp();

    await sendLog(message.guild, SETTINGS.banLogName, embed);

    return message.reply(`**${userId}** ID'li kullanıcının banı kaldırıldı. Sebep: **${reason}**`);
  }

  if (command === "kick") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return message.reply("Kick yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Atılacak kullanıcı bulunamadı.");
    if (target.id === message.author.id) return message.reply("Kendini kickleyemezsin.");
    if (!target.kickable) {
      return message.reply("Bu kullanıcıyı kickleyemiyorum. Rol sırası veya yetkiyi kontrol et.");
    }

    const reason = args.slice(1).join(" ") || "Sebep belirtilmedi.";
    await target.kick(`${reason} | Komutu kullanan: ${message.author.tag}`);

    return message.reply(`**${target.user.tag}** kicklendi. Sebep: **${reason}**`);
  }

  if (command === "timeout") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return message.reply("Timeout yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    const durationMs = parseDuration(args[1]);

    if (!target) return message.reply("Timeout atılacak kullanıcı bulunamadı.");
    if (!durationMs) {
      return message.reply("Süre formatı yanlış. Örnek: `.timeout @kullanıcı 1h sebep`");
    }
    if (!target.moderatable) {
      return message.reply("Bu kullanıcıya timeout atamıyorum.");
    }

    const reason = args.slice(2).join(" ") || "Sebep belirtilmedi.";
    await target.timeout(durationMs, `${reason} | Komutu kullanan: ${message.author.tag}`);

    return message.reply(
      `**${target.user.tag}** kullanıcısına **${humanizeDuration(durationMs)}** timeout atıldı.`
    );
  }

  if (command === "sil") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return message.reply("Mesaj silme yetkin yok.");
    }

    const amount = Number(args[0]);
    if (!amount || amount < 1 || amount > 100) {
      return message.reply("1 ile 100 arasında sayı girmelisin.");
    }

    const deleted = await message.channel.bulkDelete(amount, true).catch(() => null);
    if (!deleted) return message.reply("Mesajlar silinemedi.");

    const info = await message.channel.send(
      `#${message.channel.name} kanalından **${deleted.size}** adet mesaj sildim.`
    ).catch(() => null);

    if (info) {
      setTimeout(() => info.delete().catch(() => null), 5000);
    }
    return;
  }

  if (command === "join") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.voice.channel) {
      return message.reply("Önce bir ses kanalına girmen gerekiyor.");
    }

    joinVoiceChannel({
      channelId: message.member.voice.channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    return message.reply(`Ses kanalına girdim: **${message.member.voice.channel.name}**`);
  }

  if (command === "leave") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    const connection = getVoiceConnection(message.guild.id);
    if (!connection) return message.reply("Zaten bir ses kanalında değilim.");

    connection.destroy();
    return message.reply("Ses kanalından çıktım.");
  }
});

/* =========================
   CHANNEL GUARD + LOG
========================= */
client.on("channelCreate", async (channel) => {
  if (!channel.guild) return;

  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.green)
    .setTitle("Kanal Oluşturuldu")
    .setDescription([
      `**Kanal:** ${channel.name}`,
      `**Tür:** ${ChannelType[channel.type] || channel.type}`,
      `**Oluşturan kişi:** ${formatUser(executor)}`,
      unauthorized
        ? `**Durum:** Yetkisiz kanal oluşturma algılandı`
        : `**Durum:** Kanal oluşturuldu`
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(channel.guild, SETTINGS.channelLogName, embed);

  if (unauthorized) {
    await channel.delete("Whitelist dışı kanal oluşturma").catch(() => null);
    await banMemberSafe(channel.guild, executor.id, "Whitelist dışı kanal oluşturma");
  }
});

client.on("channelDelete", async (channel) => {
  if (!channel.guild) return;

  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.orange)
    .setTitle("Kanal Silindi")
    .setDescription([
      `**Kanal:** ${channel.name}`,
      `**Tür:** ${ChannelType[channel.type] || channel.type}`,
      `**Silen kişi:** ${formatUser(executor)}`,
      unauthorized
        ? `**Durum:** Yetkisiz kanal silme algılandı`
        : `**Durum:** Kanal silindi`
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(channel.guild, SETTINGS.channelLogName, embed);

  if (unauthorized) {
    await banMemberSafe(channel.guild, executor.id, "Whitelist dışı kanal silme");
  }
});

client.on("channelUpdate", async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;

  const changes = channelChanges(oldChannel, newChannel);

  if (
    changes.length === 1 &&
    changes[0] === "Kanal ayarlarında değişiklik yapıldı."
  ) {
    return;
  }

  const entry = await fetchAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id, {
    limit: 20,
    maxAgeMs: 30000,
    retries: 8,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.yellow)
    .setTitle("Kanal Düzenlendi")
    .setDescription([
      `**Kanal:** ${newChannel.name}`,
      `**Düzenleyen kişi:** ${formatUser(executor)}`,
      `**Yapılan değişiklikler:**`,
      changes.map((x) => `• ${x}`).join("\n")
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(newChannel.guild, SETTINGS.channelLogName, embed);

  if (unauthorized) {
    try {
      await newChannel.edit(
        {
          name: oldChannel.name,
          topic: oldChannel.topic ?? null,
          nsfw: oldChannel.nsfw ?? false,
          rateLimitPerUser: oldChannel.rateLimitPerUser ?? 0,
          bitrate: oldChannel.bitrate,
          userLimit: oldChannel.userLimit,
          parent: oldChannel.parentId ?? null,
          rtcRegion: oldChannel.rtcRegion ?? null,
          videoQualityMode: oldChannel.videoQualityMode,
          defaultAutoArchiveDuration: oldChannel.defaultAutoArchiveDuration
        },
        "Whitelist dışı kanal düzenleme geri alındı"
      ).catch(() => null);

      try {
        const oldOverwrites = oldChannel.permissionOverwrites?.cache;
        if (oldOverwrites) {
          for (const overwrite of oldOverwrites.values()) {
            await newChannel.permissionOverwrites.edit(
              overwrite.id,
              {
                ViewChannel: overwrite.allow.has("ViewChannel"),
                SendMessages: overwrite.allow.has("SendMessages"),
                ManageChannels: overwrite.allow.has("ManageChannels"),
                ManageRoles: overwrite.allow.has("ManageRoles"),
                Connect: overwrite.allow.has("Connect"),
                Speak: overwrite.allow.has("Speak")
              }
            ).catch(() => null);
          }
        }
      } catch {}
    } catch {}

    await banMemberSafe(newChannel.guild, executor.id, "Whitelist dışı kanal düzenleme");
  }
});

/* =========================
   ROLE GUARD + LOG
========================= */
client.on("roleCreate", async (role) => {
  const entry = await fetchAuditEntry(role.guild, AuditLogEvent.RoleCreate, role.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.green)
    .setTitle("Rol Oluşturuldu")
    .setDescription([
      `**Rol:** ${role.name}`,
      `**Oluşturan kişi:** ${formatUser(executor)}`,
      unauthorized
        ? `**Durum:** Yetkisiz rol oluşturma algılandı`
        : `**Durum:** Rol oluşturuldu`
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(role.guild, SETTINGS.roleLogName, embed);

  if (unauthorized) {
    await role.delete("Whitelist dışı rol oluşturma").catch(() => null);
    await banMemberSafe(role.guild, executor.id, "Whitelist dışı rol oluşturma");
  }
});

client.on("roleDelete", async (role) => {
  const entry = await fetchAuditEntry(role.guild, AuditLogEvent.RoleDelete, role.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.orange)
    .setTitle("Rol Silindi")
    .setDescription([
      `**Rol:** ${role.name}`,
      `**Silen kişi:** ${formatUser(executor)}`,
      unauthorized
        ? `**Durum:** Yetkisiz rol silme algılandı`
        : `**Durum:** Rol silindi`
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(role.guild, SETTINGS.roleLogName, embed);

  if (unauthorized) {
    await recreateDeletedRole(role.guild, role);
    await banMemberSafe(role.guild, executor.id, "Whitelist dışı rol silme");
  }
});

client.on("roleUpdate", async (oldRole, newRole) => {
  const changes = roleChanges(oldRole, newRole);

  const entry = await fetchAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.yellow)
    .setTitle("Rol Düzenlendi")
    .setDescription([
      `**Rol:** ${newRole.name}`,
      `**Düzenleyen kişi:** ${formatUser(executor)}`,
      `**Yapılan değişiklikler:**`,
      changes.map((x) => `• ${x}`).join("\n")
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(newRole.guild, SETTINGS.roleLogName, embed);

  if (unauthorized) {
    try {
      await newRole.edit(
        {
          name: oldRole.name,
          color: oldRole.color,
          hoist: oldRole.hoist,
          permissions: oldRole.permissions,
          mentionable: oldRole.mentionable
        },
        "Whitelist dışı rol düzenleme geri alındı"
      );
    } catch {}

    await banMemberSafe(newRole.guild, executor.id, "Whitelist dışı rol düzenleme");
  }
});

/* =========================
   MEMBER ROLE LOG + TIMEOUT LOG
========================= */
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const oldRoles = oldMember.roles.cache;
  const newRoles = newMember.roles.cache;

  const addedRoles = newRoles.filter(
    (role) => !oldRoles.has(role.id) && role.id !== newMember.guild.id
  );
  const removedRoles = oldRoles.filter(
    (role) => !newRoles.has(role.id) && role.id !== newMember.guild.id
  );

  if (addedRoles.size || removedRoles.size) {
    const changedRoleIds = [
      ...addedRoles.map((role) => role.id),
      ...removedRoles.map((role) => role.id)
    ];

    const entry = await fetchRoleUpdateAuditEntry(
      newMember.guild,
      newMember.id,
      changedRoleIds
    );

    const executor = entry?.executor || null;

    for (const role of addedRoles.values()) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.green)
        .setTitle("Rol Verildi")
        .setDescription([
          `**Kullanıcı:** ${formatMember(newMember)}`,
          `**Verilen rol:** ${role.name}`,
          `**Rolü veren kişi:** ${formatUser(executor)}`
        ].join("\n"))
        .setThumbnail(getAvatar(newMember))
        .setTimestamp();

      await sendLog(newMember.guild, SETTINGS.roleLogName, embed);

      if (executor && !executor.bot && !isWhitelisted(executor.id)) {
        await newMember.roles.remove(role.id, "Whitelist dışı rol verme geri alındı").catch(() => null);
        await banMemberSafe(newMember.guild, executor.id, "Whitelist dışı rol verme");
      }
    }

    for (const role of removedRoles.values()) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle("Rol Alındı")
        .setDescription([
          `**Kullanıcı:** ${formatMember(newMember)}`,
          `**Alınan rol:** ${role.name}`,
          `**Rolü alan kişi:** ${formatUser(executor)}`
        ].join("\n"))
        .setThumbnail(getAvatar(newMember))
        .setTimestamp();

      await sendLog(newMember.guild, SETTINGS.roleLogName, embed);

      if (executor && !executor.bot && !isWhitelisted(executor.id)) {
        await newMember.roles.add(role.id, "Whitelist dışı rol alma geri alındı").catch(() => null);
        await banMemberSafe(newMember.guild, executor.id, "Whitelist dışı rol alma");
      }
    }
  }

  const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
  const newTimeout = newMember.communicationDisabledUntilTimestamp || null;

  if (oldTimeout !== newTimeout) {
    const entry = await fetchMemberUpdateAuditEntry(newMember.guild, newMember.id);
    const executor = entry?.executor || null;
    const isTimeoutAdded = Boolean(newTimeout && (!oldTimeout || newTimeout > oldTimeout));

    const embed = new EmbedBuilder()
      .setColor(isTimeoutAdded ? COLORS.yellow : COLORS.green)
      .setTitle(isTimeoutAdded ? "Zaman Aşımı İşlemi" : "Zaman Aşımı Kaldırıldı")
      .setDescription([
        `**Kullanıcı:** ${formatMember(newMember)}`,
        `**İşlemi yapan kişi:** ${formatUser(executor)}`,
        isTimeoutAdded
          ? `**Süre:** ${humanizeDuration(newTimeout - Date.now())}`
          : `**Durum:** Timeout kaldırıldı`
      ].join("\n"))
      .setThumbnail(getAvatar(newMember))
      .setTimestamp();

    await sendLog(newMember.guild, SETTINGS.timeoutLogName, embed);
  }
});

/* =========================
   BAN / KICK GUARD + LOG
========================= */
client.on("guildBanAdd", async (ban) => {
  const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const reason = entry?.reason || "Sebep belirtilmedi.";

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await ban.guild.members.unban(ban.user.id, "Whitelist dışı ban geri alındı").catch(() => null);
    await banMemberSafe(ban.guild, executor.id, "Whitelist dışı sağ tık ban");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle("Kullanıcı Banlandı")
    .setDescription([
      `**Banlanan kişi:** ${formatUser(ban.user)}`,
      `**Banlayan kişi:** ${formatUser(executor)}`,
      `**Sebep:** ${reason}`
    ].join("\n"))
    .setThumbnail(getAvatar(ban.user))
    .setTimestamp();

  await sendLog(ban.guild, SETTINGS.banLogName, embed);
});

client.on("guildMemberRemove", async (member) => {
  const entry = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id, {
    limit: 10,
    maxAgeMs: 20000,
    retries: 4,
    retryDelay: 1000
  });

  if (!entry) return;

  const executor = entry.executor || null;
  const reason = entry.reason || "Sebep belirtilmedi.";

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await banMemberSafe(member.guild, executor.id, "Whitelist dışı sağ tık kick");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.orange)
    .setTitle("Kullanıcı Kicklendi")
    .setDescription([
      `**Kicklenen kişi:** ${formatMember(member)}`,
      `**Kickleyen kişi:** ${formatUser(executor)}`,
      `**Sebep:** ${reason}`
    ].join("\n"))
    .setThumbnail(getAvatar(member))
    .setTimestamp();

  await sendLog(member.guild, SETTINGS.banLogName, embed);
});

/* =========================
   MESSAGE LOG
========================= */
client.on("messageDelete", async (message) => {
  if (!message.guild) return;

  let fetched = message;
  const cachedData = messageCache.get(message.id) || null;

  if (fetched.partial) {
    try {
      fetched = await fetched.fetch();
    } catch {}
  }

  const author =
    fetched.author ||
    (cachedData
      ? { tag: cachedData.authorTag, id: cachedData.authorId }
      : null);

  if (author?.bot) return;

  const deleterEntry = author
    ? await fetchMessageDeleteAudit(message.guild, {
        author,
        channel: fetched.channel || message.channel
      })
    : null;

  const deleter = deleterEntry?.executor || null;

  const content =
    fetched.content ||
    cachedData?.content ||
    "İçerik alınamadı.";

  const attachments = [
    ...(fetched.attachments ? [...fetched.attachments.values()].map((a) => a.url) : []),
    ...(cachedData?.attachments || [])
  ];

  const uniqueAttachments = [...new Set(attachments)];

  const desc = [
    `**Mesaj atan:** ${author ? `${author.tag} (${author.id})` : "Bilinmiyor"}`,
    `**Mesajı silen:** ${formatUser(deleter)}`,
    `**Kanal:** ${fetched.channel || message.channel}`,
    `**Silinen mesaj:**`,
    truncate(content)
  ];

  if (uniqueAttachments.length) {
    desc.push("");
    desc.push(`**Ekler:**`);
    desc.push(uniqueAttachments.slice(0, 5).join("\n"));
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle("Mesaj Silindi")
    .setDescription(desc.join("\n"))
    .setThumbnail(getAvatar(fetched.author || null))
    .setTimestamp();

  await sendLog(message.guild, SETTINGS.messageLogName, embed);

  messageCache.delete(message.id);
});

client.on("messageDeleteBulk", async (messages) => {
  const first = messages.first();
  if (!first?.guild) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.orange)
    .setTitle("Toplu Mesaj Silme")
    .setDescription([
      `**Kanal:** ${first.channel}`,
      `**Silinen adet:** ${messages.size}`
    ].join("\n"))
    .setTimestamp();

  await sendLog(first.guild, SETTINGS.messageLogName, embed);

  for (const msg of messages.values()) {
    messageCache.delete(msg.id);
  }
});

/* =========================
   VOICE LOG
========================= */
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  if (oldState.channelId && !newState.channelId) {
    const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberDisconnect, oldState.id, {
      limit: 10,
      maxAgeMs: 15000,
      retries: 2,
      retryDelay: 700
    });

    const executor = entry?.executor || null;

    const embed = new EmbedBuilder()
      .setColor(COLORS.red)
      .setTitle("Ses Bağlantısı Kesildi")
      .setDescription([
        `**Bağlantısı kesilen kişi:** ${formatMember(oldState.member)}`,
        `**Bağlantıyı kesen kişi:** ${formatUser(executor)}`,
        `**Eski kanal:** ${oldState.channel?.name || "Bilinmiyor"}`
      ].join("\n"))
      .setThumbnail(getAvatar(oldState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
    return;
  }

  if (!oldState.channelId && newState.channelId) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle("Ses Kanalına Giriş")
      .setDescription([
        `**Kullanıcı:** ${formatMember(newState.member)}`,
        `**Kanal:** ${newState.channel?.name || "Bilinmiyor"}`
      ].join("\n"))
      .setThumbnail(getAvatar(newState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
    return;
  }

  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.blue)
      .setTitle("Ses Kanalı Değişti")
      .setDescription([
        `**Kullanıcı:** ${formatMember(newState.member)}`,
        `**Eski kanal:** ${oldState.channel?.name || "Bilinmiyor"}`,
        `**Yeni kanal:** ${newState.channel?.name || "Bilinmiyor"}`
      ].join("\n"))
      .setThumbnail(getAvatar(newState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
  }
});

/* =========================
   PROCESS SAFETY
========================= */
process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

/* =========================
   LOGIN
========================= */
client.login(process.env.TOKEN);
