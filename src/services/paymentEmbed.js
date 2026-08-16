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

/**
 * PayPal charges the seller a fee (default 2.9% + $0.30). Since the buyer
 * covers it here, this adds that surcharge on top of the base total so the
 * seller still nets the full order amount after PayPal takes its cut.
 */
export function addPaypalSurcharge(totalCents) {
  const feeCents = Math.round(totalCents * (config.paypalFeePercent / 100)) + config.paypalFeeFlatCents;
  return totalCents + feeCents;
}

export function buildPaymentEmbed(order, shipping) {
  const deadlineUnix = Math.floor(new Date(order.payment_deadline_at).getTime() / 1000);
  const shippingCents = order.shipping_cents || 0;
  const itemsSubtotal = order.unit_price_cents * order.quantity;

  const amountFields = [
    { name: 'Items', value: `${order.quantity}x ${order.product_name} (${formatAud(itemsSubtotal)})`, inline: false },
  ];

  if (shippingCents > 0) {
    const methodLabel = order.shipping_method === 'express' ? ' (Express)' : ' (Standard)';
    amountFields.push({ name: 'Shipping', value: `${formatAud(shippingCents)}${methodLabel}`, inline: true });
  }

  const paymentLines = [
    `**PayID:** \`${config.payId}\` — pay **${formatAud(order.total_cents)}**`,
  ];
  if (config.paypalEmail) {
    const paypalTotal = addPaypalSurcharge(order.total_cents);
    paymentLines.push(
      `**PayPal:** \`${config.paypalEmail}\` — pay **${formatAud(paypalTotal)}** (includes PayPal's fee, buyer covers it)`,
    );
  }

  amountFields.push(
    { name: 'Order reference', value: `\`${order.reference_code}\``, inline: true },
  );

  return new EmbedBuilder()
    .setTitle('Payment details')
    .setColor(0x2ecc71)
    .setDescription(
      [
        'Pick **one** payment method below and transfer the exact amount shown for it.',
        '**Include the order reference** in the payment description, then post a screenshot of the transfer in this thread.',
        '',
        'Staff will manually confirm payment (no automatic matching in v1).',
      ].join('\n'),
    )
    .addFields(
      { name: 'How to pay', value: paymentLines.join('\n'), inline: false },
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
