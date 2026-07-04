require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'status') {
    await interaction.reply({
      content:
        'Video activity bot is online. Use the rocket icon in a voice channel, or the launch command, to start the player.',
      ephemeral: true,
    });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
