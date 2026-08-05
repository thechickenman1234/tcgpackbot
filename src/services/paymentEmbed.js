import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';

export function formatShipTo({ name, phone, shippingAddress, city, state, zip }) {
  return [
    name,
    phone,
    shippingAddress,
    [city, state, zip].filter(Boolean).join(', '),
  ].filter(Boolean).join('\n');
}

export function buildPaymentEmbed(order, shipping) {
  const deadlineUnix = Math.floor(new Date(order.payment_deadline_at).getTime() / 1000);
  const shippingCents = order.shipping_cents || 0;
  const itemsSubtotal = order.unit_price_cents * order.quantity;

  const amountFields = [
    { name: 'Items', value: `${order.quantity}x ${order.product_name} (${formatAud(itemsSubtotal)})`, inline: false },
  ];

  if (shippingCents > 0) {
    amountFields.push({ name: 'Shipping', value: formatAud(shippingCents), inline: true });
  }

  amountFields.push(
    { name: 'Amount owed', value: `**${formatAud(order.total_cents)}**`, inline: true },
    { name: 'Order reference', value: `\`${order.reference_code}\``, inline: true },
  );

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
      ...amountFields,
      {
        name: 'Payment deadline',
        value: `<t:${deadlineUnix}:F> (<t:${deadlineUnix}:R>)`,
        inline: false,
      },
      { name: 'Ship to', value: formatShipTo(shipping), inline: false },
    )
    .setFooter({ text: 'Missing the deadline without payment results in a claim ban.' });
}
