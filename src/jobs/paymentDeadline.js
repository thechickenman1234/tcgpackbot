import { config } from '../config.js';
import { setBanned } from '../services/buyerService.js';
import { cancelOrder, getExpiredUnpaidOrders } from '../services/orderService.js';
import { logNoShow } from '../services/staffLog.js';

async function applyBannedRole(client, guildId, userId) {
  if (!config.bannedRoleId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    await member.roles.add(config.bannedRoleId);
  } catch (err) {
    console.error('Could not apply banned role:', err.message);
  }
}

async function closeThread(client, order) {
  if (!order.thread_id) return;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    if (!thread?.isThread()) return;

    await thread.send(
      '⏰ Payment deadline passed without a paid confirmation. This ticket is closed and you are banned from future claims. Use `/appeal submit` if you believe this was a mistake.',
    );
    await thread.setLocked(true, 'Unpaid claim expired');
    await thread.setArchived(true, 'Unpaid claim expired');
  } catch (err) {
    console.error(`Failed to close thread ${order.thread_id}:`, err.message);
  }
}

export async function processExpiredPayments(client) {
  const expired = getExpiredUnpaidOrders();
  if (!expired.length) return;

  for (const order of expired) {
    try {
      const cancelled = cancelOrder(order.id, 'payment_deadline_expired');
      if (!cancelled.ok) continue;

      setBanned(
        order.buyer_id,
        true,
        `No-show: unpaid order ${order.reference_code} (${order.quantity}x ${order.product_name})`,
        null,
      );

      await applyBannedRole(client, config.guildId, order.buyer_id);

      let buyerTag = `<@${order.buyer_id}>`;
      try {
        const user = await client.users.fetch(order.buyer_id);
        buyerTag = `${user.tag} (<@${order.buyer_id}>)`;
      } catch {
        // ignore
      }

      await logNoShow(client, cancelled.order, buyerTag);
      await closeThread(client, cancelled.order);

      console.log(`No-show processed: ${order.reference_code}`);
    } catch (err) {
      console.error(`Error processing expired order ${order.reference_code}:`, err);
    }
  }
}

export function startPaymentDeadlineJob(client, intervalMs = 60_000) {
  const tick = () => {
    processExpiredPayments(client).catch((err) => {
      console.error('paymentDeadline job failed:', err);
    });
  };

  tick();
  return setInterval(tick, intervalMs);
}
