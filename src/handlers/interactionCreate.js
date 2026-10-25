import { handleAutocomplete, handleSlashCommand } from '../commands/handlers.js';
import { handleIntakeSubmit, showIntakeModal } from './intakeModal.js';
import {
  CLAIM_MODAL_PREFIX,
  CLAIM_SELECT_ID,
  handleClaimModalSubmit,
  handleClaimSelect,
} from './claimUi.js';
import {
  SHIPPING_MODAL_ID,
  SHIPPING_MODAL_USER_PREFIX,
  UPDATE_SHIPPING_BUTTON_PREFIX,
  handleShippingModalSubmit,
  handleUpdateShippingButton,
} from './shippingUi.js';
import { SHIP_METHOD_PREFIX, handleShippingMethodButton } from './shippingMethodUi.js';
import { SHIPPING_PREFIX, handleShippingPanel } from './shippingPanel.js';
import { REEL_PREFIX, handleReelInteraction } from './reelLoop.js';
import { INVOICE_PREFIX, handleInvoiceInteraction } from './invoiceMaker.js';
import { PAYPROOF_PREFIX, handlePaymentProofButton } from './paymentProof.js';
import { LABEL_PREFIX, handleLabelModal } from './labelEditor.js';
import { LABEL_DROP_PREFIX, handleLabelDropInteraction } from './labelDrop.js';
import { WS_PREFIX, handleWholesaleButton, handleWholesaleModal } from './wholesaleCards.js';
import { STOCK_PREFIX, handleStockInteraction } from './stockCard.js';
import {
  QTY_CONTEXT_MENU,
  QTY_PREFIX,
  handleQuantityButton,
  handleQuantityContextMenu,
  handleQuantityModal,
} from './quantityEditor.js';

export async function handleInteractionCreate(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    // Long-press a message in a ticket → Apps → Change quantity.
    if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === QTY_CONTEXT_MENU) {
      await handleQuantityContextMenu(interaction);
      return;
    }

    // The ticket's Change quantity button and its pop-up.
    if (interaction.isButton() && interaction.customId.startsWith(QTY_PREFIX)) {
      await handleQuantityButton(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(`${QTY_PREFIX}m:`)) {
      await handleQuantityModal(interaction);
      return;
    }

    // Discord gives autocomplete three seconds and no way to apologise late,
    // so this has to come before anything slower in the chain.
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    // The shipping panel's buttons, dropdowns and pop-ups all share one prefix.
    if (
      (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
      && interaction.customId.startsWith(SHIPPING_PREFIX)
    ) {
      await handleShippingPanel(interaction);
      return;
    }

    // Wholesale order cards: their buttons, and the shipping / boxes pop-ups.
    if (interaction.isModalSubmit() && interaction.customId.startsWith(`${WS_PREFIX}m:`)) {
      await handleWholesaleModal(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(WS_PREFIX)) {
      await handleWholesaleButton(interaction);
      return;
    }

    // Stock cards in the staff log: the step buttons and the "On its way" pop-up.
    if ((interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith(STOCK_PREFIX)) {
      await handleStockInteraction(interaction);
      return;
    }

    // The /invoice pop-up.
    if (interaction.isModalSubmit() && interaction.customId.startsWith(INVOICE_PREFIX)) {
      await handleInvoiceInteraction(interaction);
      return;
    }

    // Video feedback loops: the Log results button and its pop-up.
    if ((interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith(REEL_PREFIX)) {
      await handleReelInteraction(interaction);
      return;
    }

    // The /label pop-up.
    if (interaction.isModalSubmit() && interaction.customId.startsWith(LABEL_PREFIX)) {
      await handleLabelModal(interaction);
      return;
    }

    // The buttons under a dropped batch of shipping labels.
    if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith(LABEL_DROP_PREFIX)) {
      await handleLabelDropInteraction(interaction);
      return;
    }

    // Paid / Not paid under a buyer's payment screenshot.
    if (interaction.isButton() && interaction.customId.startsWith(PAYPROOF_PREFIX)) {
      await handlePaymentProofButton(interaction);
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

    if (interaction.isButton() && interaction.customId.startsWith(UPDATE_SHIPPING_BUTTON_PREFIX)) {
      await handleUpdateShippingButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(SHIP_METHOD_PREFIX)) {
      await handleShippingMethodButton(interaction);
      return;
    }

    if (
      interaction.isModalSubmit()
      && (interaction.customId === SHIPPING_MODAL_ID
        || interaction.customId.startsWith(SHIPPING_MODAL_USER_PREFIX))
    ) {
      await handleShippingModalSubmit(interaction);
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
