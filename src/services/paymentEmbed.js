import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';

export function buildPaymentEmbed(order, { name, phone, shippingAddress }) {
  const deadlineUnix = Math.floor(new Date(order.payment_deadline_at).getTime() / 1000);

  return new EmbedBuilder()
    .setTitle('Payment details')
    .setColor(0x2ecc71)
    .setDescription(
      [
        'Transfer the exact amount via PayID and **include the order reference** in the payment description.',
        'Then post a screenshot of the transfer in this thread.',
        '',
        'Staff will manually confirm payment (no automatic bank matching in v1).',
      ].join('\n'),
    )
    .addFields(
      { name: 'PayID', value: `\`${config.payId}\``, inline: false },
      { name: 'Amount owed', value: `**${formatAud(order.total_cents)}**`, inline: true },
      { name: 'Order reference', value: `\`${order.reference_code}\``, inline: true },
      { name: 'Items', value: `${order.quantity}x ${order.product_name}`, inline: false },
      {
        name: 'Payment deadline',
        value: `<t:${deadlineUnix}:F> (<t:${deadlineUnix}:R>)`,
        inline: false,
      },
      { name: 'Ship to', value: `${name}\n${phone}\n${shippingAddress}`, inline: false },
    )
    .setFooter({ text: 'Missing the deadline without payment results in a claim ban.' });
}
