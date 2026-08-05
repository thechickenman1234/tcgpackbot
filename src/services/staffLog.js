import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';

export async function logToStaff(client, { title, description, color = 0xe74c3c, fields = [] }) {
  try {
    const channel = await client.channels.fetch(config.staffLogChannelId);
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    if (fields.length) embed.addFields(fields);

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to write staff log:', err);
  }
}

export async function logNoShow(client, order, buyerTag) {
  await logToStaff(client, {
    title: 'No-show — unpaid claim expired',
    description: 'Payment deadline passed without a paid tag. Buyer banned from future claims.',
    color: 0xc0392b,
    fields: [
      { name: 'Buyer', value: `${buyerTag} (\`${order.buyer_id}\`)`, inline: false },
      { name: 'Product', value: `${order.quantity}x ${order.product_name}`, inline: true },
      { name: 'Amount', value: formatAud(order.total_cents), inline: true },
      { name: 'Order', value: order.reference_code, inline: true },
      { name: 'Deadline', value: `<t:${Math.floor(new Date(order.payment_deadline_at).getTime() / 1000)}:F>`, inline: false },
    ],
  });
}

export async function logBan(client, buyerId, reason, staffId = null) {
  await logToStaff(client, {
    title: 'Buyer banned',
    description: reason,
    color: 0x8e44ad,
    fields: [
      { name: 'Buyer ID', value: `\`${buyerId}\``, inline: true },
      { name: 'By', value: staffId ? `<@${staffId}>` : 'System', inline: true },
    ],
  });
}

export async function logUnban(client, buyerId, reason, staffId) {
  await logToStaff(client, {
    title: 'Buyer unbanned',
    description: reason || 'Manual unban',
    color: 0x27ae60,
    fields: [
      { name: 'Buyer ID', value: `\`${buyerId}\``, inline: true },
      { name: 'By', value: `<@${staffId}>`, inline: true },
    ],
  });
}

export async function logAppeal(client, buyerId, reason) {
  await logToStaff(client, {
    title: 'Ban appeal submitted',
    description: reason,
    color: 0xf39c12,
    fields: [
      { name: 'Buyer', value: `<@${buyerId}> (\`${buyerId}\`)`, inline: false },
      { name: 'Action', value: 'Review with `/unban` or reject with `/appeal reject`', inline: false },
    ],
  });
}
