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
  } else if (order.combined_with) {
    // Only ever appears on orders placed before combining was removed.
    amountFields.push({
      name: 'Shipping',
      value: `Free — packed with \`${order.combined_with}\``,
      inline: true,
    });
  }

  const paymentLines = [
    `**PayID:** \`${config.payId}\`, pay **${formatAud(order.total_cents)}**`,
  ];
  if (config.paypalEmail) {
    const paypalTotal = addPaypalSurcharge(order.total_cents);
    paymentLines.push(
      `**PayPal:** \`${config.paypalEmail}\`, pay **${formatAud(paypalTotal)}** (includes PayPal's fee, buyer covers it)`,
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
        '1. Pick **one** payment method below and transfer the exact amount shown for it.',
        '2. **Include the order reference** in the payment description.',
        '3. 📸 **Post a screenshot of your payment in this thread.**',
        '',
        "Your screenshot is how we confirm your order. Once it's here, your claim can't expire while staff check it.",
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
    .setFooter({ text: 'No payment screenshot by the deadline = claim cancelled and a claim ban.' });
}
