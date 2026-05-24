import { Client, GatewayIntentBits } from 'discord.js';
import http from 'http';

// تشغيل سيرفر ويب وهمي عشان موقع Render ما يقفل البوت أبداً
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running smoothly!\n');
});
server.listen(process.env.PORT || 3000, () => {
    console.log('Web server is ready.');
});

// تشغيل البوت بالصلاحيات الكاملة
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user?.tag}! Bot is fully online.`);
});

// كود الترحيب
client.on('guildMemberAdd', async (member) => {
    const welcomeChannelId = '1508087523820310578'; // آي دي قناة الترحيب حقتك
    const channel = member.guild.channels.cache.get(welcomeChannelId);
    if (channel && channel.isTextBased()) {
        channel.send(`هلا والله بـ ${member} منور السيرفر يا بطل! 🎉`);
    }
});

// كود الحماية (حذف الصور والمقاطع من الشات العام)
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // إذا أرسل عضو صورة أو فيديو أو رابط ميديا
    if (message.attachments.size > 0 || message.content.includes('http')) {
        try {
            await message.delete();
            const warning = await message.channel.send(`${message.author}، ممنوع إرسال الصور والمقاطع هنا لحماية السيرفر! 🛑`);
            setTimeout(() => warning.delete().catch(() => {}), 5000); // حذف التحذير بعد 5 ثواني
        } catch (error) {
            console.error('Failed to delete message:', error);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
