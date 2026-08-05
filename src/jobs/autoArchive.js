import { getOrdersReadyToArchive, markArchived } from '../services/orderService.js';

async function archiveThread(client, order) {
  if (!order.thread_id) return;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    if (!thread?.isThread()) return;

    if (!thread.archived) {
      await thread.send('This shipped order ticket is now auto-archiving. Ping staff if you still need help.');
      await thread.setArchived(true, 'Auto-archive 7 days after shipped');
    }
  } catch (err) {
    console.error(`Failed to archive thread ${order.thread_id}:`, err.message);
  }
}

export async function processShippedArchives(client) {
  const ready = getOrdersReadyToArchive();
  if (!ready.length) return;

  for (const order of ready) {
    try {
      await archiveThread(client, order);
      markArchived(order.id);
      console.log(`Archived shipped order: ${order.reference_code}`);
    } catch (err) {
      console.error(`Error archiving ${order.reference_code}:`, err);
    }
  }
}

export function startAutoArchiveJob(client, intervalMs = 5 * 60_000) {
  const tick = () => {
    processShippedArchives(client).catch((err) => {
      console.error('autoArchive job failed:', err);
    });
  };

  tick();
  return setInterval(tick, intervalMs);
}
