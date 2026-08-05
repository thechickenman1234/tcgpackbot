import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commandDefinitions } from './commands/definitions.js';

const rest = new REST({ version: '10' }).setToken(config.token);

async function main() {
  console.log(`Registering ${commandDefinitions.length} guild commands...`);

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commandDefinitions },
  );

  console.log('Slash commands registered for guild', config.guildId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
