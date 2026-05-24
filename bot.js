const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');

// سيرفر الويب عشان ريندر ما يقفل البوت
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is active!\n');
});
server.listen(process.env.PORT || 3000, () => {
    console.log('Web server running.');
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

// الترحيب
client.on('guildMemberAdd', async (member) => {
    const channel = member.guild.channels.cache.get('1508087523820310578');
    if (channel && channel.isTextBased()) {
        channel.send(`هلا والله بـ ${member} منور السيرفر يا بطل! 🎉`);
    }
});

// الحماية
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.attachments.size > 0 || message.content.includes('http')) {
        try {
            await message.delete();
            const warning = await message.channel.send(`${message.author}، ممنوع إرسال الصور والمقاطع هنا لحماية السيرفر! 🛑`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) {
            console.error(err);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
