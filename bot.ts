import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Interaction,
  PermissionFlagsBits,
  GuildMember,
} from "discord.js";
import OpenAI from "openai";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./lib/logger";

const TEMPBANS_FILE = path.join(os.tmpdir(), "tempbans.json");

interface TempBan {
  userId: string;
  guildId: string;
  expiresAt: number;
}

function loadTempBans(): TempBan[] {
  try {
    if (fs.existsSync(TEMPBANS_FILE)) {
      return JSON.parse(fs.readFileSync(TEMPBANS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveTempBans(bans: TempBan[]) {
  fs.writeFileSync(TEMPBANS_FILE, JSON.stringify(bans, null, 2));
}

function addTempBan(userId: string, guildId: string, minutes: number) {
  const bans = loadTempBans();
  const existing = bans.findIndex((b) => b.userId === userId && b.guildId === guildId);
  const entry: TempBan = { userId, guildId, expiresAt: Date.now() + minutes * 60 * 1000 };
  if (existing >= 0) bans[existing] = entry;
  else bans.push(entry);
  saveTempBans(bans);
}

async function checkExpiredBans() {
  const bans = loadTempBans();
  const now = Date.now();
  const remaining: TempBan[] = [];

  for (const ban of bans) {
    if (now >= ban.expiresAt) {
      try {
        const guild = client.guilds.cache.get(ban.guildId);
        if (guild) {
          await guild.members.unban(ban.userId, "انتهت مدة الباند المؤقت / Temp ban expired");
          logger.info(`تم رفع الباند عن: ${ban.userId}`);
        }
      } catch {
        remaining.push(ban);
      }
    } else {
      remaining.push(ban);
    }
  }
  saveTempBans(remaining);
}

const openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

async function isNSFW(imageUrl: string): Promise<boolean> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
            { type: "text", text: 'Is this image NSFW, sexually explicit, or inappropriate for people under 18? Reply with only "YES" or "NO".' },
          ],
        },
      ],
      max_tokens: 5,
    });
    const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
    return answer === "YES";
  } catch (err) {
    logger.error({ err }, "فشل تحليل الصورة");
    return false;
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buffer));
}

async function extractFrames(videoPath: string, outputDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(["-vf", "fps=1/3", "-frames:v", "5"])
      .output(path.join(outputDir, "frame_%03d.jpg"))
      .on("end", () => {
        const frames = fs.readdirSync(outputDir)
          .filter((f) => f.endsWith(".jpg"))
          .map((f) => path.join(outputDir, f));
        resolve(frames);
      })
      .on("error", reject)
      .run();
  });
}

async function isVideoNSFW(videoUrl: string): Promise<boolean> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-video-"));
  const videoPath = path.join(tmpDir, "video.mp4");
  try {
    await downloadFile(videoUrl, videoPath);
    const frames = await extractFrames(videoPath, tmpDir);
    for (const framePath of frames) {
      const base64 = fs.readFileSync(framePath).toString("base64");
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "low" } },
              { type: "text", text: 'Is this image NSFW, sexually explicit, or inappropriate for people under 18? Reply with only "YES" or "NO".' },
            ],
          },
        ],
        max_tokens: 5,
      });
      const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
      if (answer === "YES") return true;
    }
    return false;
  } catch (err) {
    logger.error({ err }, "فشل تحليل الفيديو");
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("يتحقق إذا البوت شغال"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("يعرض كل الأوامر المتاحة"),
  new SlashCommandBuilder()
    .setName("معلومات")
    .setDescription("يعطيك معلومات عن البوت"),
  new SlashCommandBuilder()
    .setName("عشوائي")
    .setDescription("يقول لك رقم عشوائي بين 1 و 100"),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("يطرد عضو من السيرفر")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName("عضو").setDescription("العضو اللي تبي تطرده").setRequired(true))
    .addStringOption((o) => o.setName("سبب").setDescription("سبب الطرد").setRequired(false)),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("يحظر عضو من السيرفر نهائياً")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName("عضو").setDescription("العضو اللي تبي تحظره").setRequired(true))
    .addStringOption((o) => o.setName("سبب").setDescription("سبب الحظر").setRequired(false)),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("يرفع الحظر عن عضو")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName("id").setDescription("ID العضو المحظور").setRequired(true)),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("يعطي تايم أوت لعضو")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName("عضو").setDescription("العضو").setRequired(true))
    .addIntegerOption((o) => o.setName("دقائق").setDescription("عدد الدقائق (1-40320)").setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption((o) => o.setName("سبب").setDescription("سبب التايم أوت").setRequired(false)),
  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("يرفع التايم أوت عن عضو")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName("عضو").setDescription("العضو").setRequired(true)),
  new SlashCommandBuilder()
    .setName("tempban")
    .setDescription("يحظر عضو مؤقتاً ثم يرفع الحظر تلقائياً")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName("عضو").setDescription("العضو").setRequired(true))
    .addIntegerOption((o) => o.setName("دقائق").setDescription("مدة الحظر بالدقائق").setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName("سبب").setDescription("سبب الحظر").setRequired(false)),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("يمسح رسائل من الشات")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName("عدد").setDescription("عدد الرسائل (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("يعطي تحذير لعضو")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName("عضو").setDescription("العضو").setRequired(true))
    .addStringOption((o) => o.setName("سبب").setDescription("سبب التحذير").setRequired(true)),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("يرسل رسالة باسم البوت")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName("نص").setDescription("الرسالة اللي تبي البوت يرسلها").setRequired(true)),
  new SlashCommandBuilder()
    .setName("testwelcome")
    .setDescription("يختبر رسالة الترحيب")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("مرحبا")
    .setDescription("يرحب فيك البوت"),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const token = process.env["DISCORD_TOKEN"]?.trim();
  if (!token) return;

  const rest = new REST({ version: "10" }).setToken(token);

  try {
    const appInfo = (await rest.get(Routes.currentApplication())) as { id: string };
    await rest.put(Routes.applicationCommands(appInfo.id), { body: commands });
    logger.info("تم تسجيل الأوامر بنجاح");
  } catch (err) {
    logger.error({ err }, "فشل تسجيل الأوامر");
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`البوت شغال: ${readyClient.user.tag}`);
  await registerCommands();
  await checkExpiredBans();
  setInterval(checkExpiredBans, 60 * 1000);
});

client.on(Events.GuildMemberAdd, async (member) => {
  const WELCOME_CHANNEL_ID = "1508087523820310578";
  try {
    const channel = await client.channels.fetch(WELCOME_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      logger.warn("قناة الترحيب ما تم إيجادها أو مو تيكست");
      return;
    }
    const memberCount = member.guild.memberCount;
    await channel.send(
      `🎉 يا هلا ويا سهلا ${member} منور السيرفر! 🌟\n` +
      `أنت العضو رقم **${memberCount}** في **${member.guild.name}** 🏆`
    );
    logger.info(`تم إرسال ترحيب لـ: ${member.user.tag}`);
  } catch (err) {
    logger.error({ err }, "فشل إرسال رسالة الترحيب");
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;

  if (message.attachments.size > 0) {
    const imageAttachments = message.attachments.filter((a) =>
      a.contentType?.startsWith("image/") ?? false
    );
    const videoAttachments = message.attachments.filter((a) =>
      a.contentType?.startsWith("video/") ?? false
    );

    for (const [, attachment] of imageAttachments) {
      const nsfw = await isNSFW(attachment.url);
      if (nsfw) {
        await message.delete().catch(() => null);
        await message.channel.send(
          `⚠️ **تحذير رسمي / Official Warning**\n` +
          `${message.author} — تم إعطاك تحذير لسبب: **نشر صورة غير لائقة (+18) / Posting NSFW image**\n` +
          `تم حذف الصورة وإعطاؤك تايم أوت 5 دقائق. ⏰`
        );
        if (message.member) {
          await message.member.timeout(5 * 60 * 1000, "نشر صورة غير لائقة / NSFW image").catch(() => null);
        }
        logger.info(`صورة مشبوهة حذفت من: ${message.author.tag}`);
        return;
      }
    }

    for (const [, attachment] of videoAttachments) {
      logger.info(`جاري تحليل مقطع من: ${message.author.tag}`);
      const nsfw = await isVideoNSFW(attachment.url);
      if (nsfw) {
        await message.delete().catch(() => null);
        await message.channel.send(
          `⚠️ **تحذير رسمي / Official Warning**\n` +
          `${message.author} — تم إعطاك تحذير لسبب: **نشر مقطع غير لائق (+18) / Posting NSFW video**\n` +
          `تم حذف المقطع وإعطاؤك تايم أوت 5 دقائق. ⏰`
        );
        if (message.member) {
          await message.member.timeout(5 * 60 * 1000, "نشر مقطع غير لائق / NSFW video").catch(() => null);
        }
        logger.info(`مقطع مشبوه حذف من: ${message.author.tag}`);
        return;
      }
    }
  }

});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction as ChatInputCommandInteraction;
  const member = interaction.member as GuildMember;

  if (cmd.commandName === "ping") {
    await cmd.reply("🏓 Pong! البوت شغال");

  } else if (cmd.commandName === "help") {
    await cmd.reply(
      "**🛡️ أوامر الإدارة:**\n" +
      "`/kick` `/ban` `/tempban` `/unban` `/timeout` `/untimeout` `/warn` `/clear` `/say` `/testwelcome`\n\n" +
      "**🎮 أوامر عامة:**\n" +
      "`/ping` `/معلومات` `/عشوائي` `/مرحبا`"
    );

  } else if (cmd.commandName === "معلومات") {
    await cmd.reply(
      "🤖 **معلومات البوت**\n" +
      `الاسم: ${client.user?.username}\n` +
      `السيرفرات: ${client.guilds.cache.size}\n` +
      "مصنوع بـ discord.js"
    );

  } else if (cmd.commandName === "عشوائي") {
    const num = Math.floor(Math.random() * 100) + 1;
    await cmd.reply(`🎲 الرقم العشوائي: **${num}**`);

  } else if (cmd.commandName === "kick") {
    const target = cmd.options.getMember("عضو") as GuildMember;
    const reason = cmd.options.getString("سبب") ?? "بدون سبب";
    if (!target) return cmd.reply({ content: "❌ العضو مو موجود!", ephemeral: true });
    await target.kick(reason).catch(() => null);
    await cmd.reply(`✅ تم طرد **${target.user.username}** — السبب: ${reason}`);

  } else if (cmd.commandName === "ban") {
    const target = cmd.options.getMember("عضو") as GuildMember;
    const reason = cmd.options.getString("سبب") ?? "بدون سبب";
    if (!target) return cmd.reply({ content: "❌ العضو مو موجود!", ephemeral: true });
    await target.ban({ reason }).catch(() => null);
    await cmd.reply(`🔨 تم حظر **${target.user.username}** — السبب: ${reason}`);

  } else if (cmd.commandName === "tempban") {
    const target = cmd.options.getMember("عضو") as GuildMember;
    const minutes = cmd.options.getInteger("دقائق") ?? 10;
    const reason = cmd.options.getString("سبب") ?? "حظر مؤقت";
    if (!target) return cmd.reply({ content: "❌ العضو مو موجود!", ephemeral: true });
    await target.ban({ reason }).catch(() => null);
    addTempBan(target.user.id, cmd.guild!.id, minutes);
    await cmd.reply(`⏳ تم حظر **${target.user.username}** لمدة **${minutes} دقيقة** — السبب: ${reason}\nسيتم رفع الباند تلقائياً ✅`);

  } else if (cmd.commandName === "unban") {
    const id = cmd.options.getString("id") ?? "";
    await cmd.guild?.members.unban(id).catch(() => null);
    await cmd.reply(`✅ تم رفع الحظر عن العضو ID: **${id}**`);

  } else if (cmd.commandName === "timeout") {
    const target = cmd.options.getMember("عضو") as GuildMember;
    const minutes = cmd.options.getInteger("دقائق") ?? 5;
    const reason = cmd.options.getString("سبب") ?? "بدون سبب";
    if (!target) return cmd.reply({ content: "❌ العضو مو موجود!", ephemeral: true });
    await target.timeout(minutes * 60 * 1000, reason).catch(() => null);
    await cmd.reply(`⏰ تم تايم أوت **${target.user.username}** لمدة **${minutes} دقيقة** — السبب: ${reason}`);

  } else if (cmd.commandName === "untimeout") {
    const target = cmd.options.getMember("عضو") as GuildMember;
    if (!target) return cmd.reply({ content: "❌ العضو مو موجود!", ephemeral: true });
    await target.timeout(null).catch(() => null);
    await cmd.reply(`✅ تم رفع التايم أوت عن **${target.user.username}**`);

  } else if (cmd.commandName === "warn") {
    const target = cmd.options.getMember("عضو") as GuildMember;
    const reason = cmd.options.getString("سبب") ?? "بدون سبب / No reason";
    if (!target) return cmd.reply({ content: "❌ العضو مو موجود!", ephemeral: true });
    await cmd.reply(
      `⚠️ **تحذير رسمي / Official Warning**\n` +
      `${target} — تم إعطاك تحذير لسبب: **${reason}**\n` +
      `يرجى الالتزام بقوانين السيرفر. / Please follow the server rules.`
    );

  } else if (cmd.commandName === "clear") {
    const amount = cmd.options.getInteger("عدد") ?? 10;
    if (cmd.channel && "bulkDelete" in cmd.channel) {
      await cmd.channel.bulkDelete(amount, true).catch(() => null);
      await cmd.reply({ content: `🗑️ تم مسح **${amount}** رسالة`, ephemeral: true });
    }

  } else if (cmd.commandName === "say") {
    const text = cmd.options.getString("نص", true);
    await cmd.reply({ content: "✅ تم الإرسال!", ephemeral: true });
    await cmd.channel?.send(text);

  } else if (cmd.commandName === "testwelcome") {
    try {
      const channel = await client.channels.fetch("1508087523820310578");
      if (!channel || !channel.isTextBased()) {
        return cmd.reply({ content: "❌ قناة الترحيب ما تم إيجادها!", ephemeral: true });
      }
      const memberCount = cmd.guild?.memberCount ?? 0;
      await channel.send(
        `🎉 يا هلا ويا سهلا ${cmd.user} منور السيرفر! 🌟\n` +
        `أنت العضو رقم **${memberCount}** في **${cmd.guild?.name}** 🏆`
      );
      await cmd.reply({ content: "✅ تم إرسال رسالة الترحيب التجريبية!", ephemeral: true });
    } catch (err) {
      await cmd.reply({ content: `❌ فشل الإرسال: ${err}`, ephemeral: true });
    }

  } else if (cmd.commandName === "مرحبا") {
    await cmd.reply(`هلا ${cmd.user}! 👋`);
  }
});

export function startBot() {
  const token = process.env["DISCORD_TOKEN"]?.trim();
  if (!token) {
    logger.error("DISCORD_TOKEN مو موجود! البوت ما راح يشتغل");
    return;
  }
  logger.info(`طول التوكن: ${token.length} حرف`);
  client.login(token).catch((err) => {
    logger.error({ err }, "فشل تسجيل الدخول للبوت");
  });
}
