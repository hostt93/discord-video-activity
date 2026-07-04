require('dotenv').config();
const { REST, Routes } = require('discord.js');

const { DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN, ACTIVITY_COMMAND_NAME } = process.env;

if (!DISCORD_CLIENT_ID || !DISCORD_BOT_TOKEN) {
  console.error('Missing DISCORD_CLIENT_ID or DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}

const commands = [
  {
    // Primary Entry Point command: this is Discord's built-in mechanism for
    // launching an Activity from a voice channel via a slash command.
    type: 4, // PRIMARY_ENTRY_POINT
    name: ACTIVITY_COMMAND_NAME || 'watch',
    description: 'Launch the video player activity',
    handler: 2, // DISCORD_LAUNCH_ACTIVITY - Discord launches it directly, no bot code needed
  },
  {
    // A normal chat command handled by bot.js, just to prove the bot itself is alive.
    type: 1, // CHAT_INPUT
    name: 'status',
    description: 'Check whether the video activity bot is online',
  },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('Registering application commands...');
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log(
      `Done. In a voice channel, use the rocket/apps icon or type "/${ACTIVITY_COMMAND_NAME || 'watch'}" to launch.`
    );
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
