import { handleSlashCommand } from '../commands/handlers.js';
import { handleIntakeSubmit, showIntakeModal } from './intakeModal.js';
import {
  CLAIM_MODAL_PREFIX,
  CLAIM_SELECT_ID,
  handleClaimModalSubmit,
  handleClaimSelect,
} from './claimUi.js';

export async function handleInteractionCreate(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === CLAIM_SELECT_ID) {
      await handleClaimSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(CLAIM_MODAL_PREFIX)) {
      await handleClaimModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('intake:')) {
      await showIntakeModal(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('intake_modal:')) {
      await handleIntakeSubmit(interaction);
      return;
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: 'Something went wrong handling that interaction.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
}
