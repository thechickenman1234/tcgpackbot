import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commandDefinitions } from './commands/definitions.js';

export async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);

  console.log(`Registering ${commandDefinitions.length} guild slash commands...`);

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commandDefinitions },
  );

  console.log(`Slash commands registered for guild ${config.guildId}`);
}

// Allow optional manual run: node src/registerCommands.js
const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/src/registerCommands.js');
if (isDirectRun) {
  registerSlashCommands().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
