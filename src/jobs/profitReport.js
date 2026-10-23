import { getMeta, setMeta } from '../services/metaService.js';
import { logToStaff } from '../services/staffLog.js';
import { ZONE } from '../services/scheduleService.js';
import { estimatedCosts, missingCosts, profitFor, profitLines } from '../services/profitService.js';
import { dashboardUrl } from '../dashboard/dashboard.js';
import { untaggedPayments } from '../services/moneyService.js';

/**
 * Profit without having to ask for it, in the staff log:
 *
 *   Monday 9am   last week's sales, costs and profit, plus anything still on
 *                the quote's estimated cost
 *   daily 10am   products that sold with no cost yet, so the numbers stay right,
 *                and Wise payments still waiting to be tagged
 *
 * Each runs once a day at most: the day is stored before posting, so a
 * restart or a failed post can never send it twice.
 */

function melbourneNow(now) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(now)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hour: Number(parts.hour) % 24 };
}

function openLine() {
  const url = dashboardUrl();
  return url ? `Put them in on the dashboard: ${url} (signed out? run \`/dashboard\`)` : 'Put them in with `/dashboard`.';
}

export async function runProfitReports(client, now = new Date()) {
  const { date, weekday, hour } = melbourneNow(now);

  if (weekday === 'Mon' && hour >= 9 && getMeta('profit_report_day') !== date) {
    setMeta('profit_report_day', date);
    const lines = profitLines(profitFor('last_week', { now }));
    const estimates = estimatedCosts({ now });
    if (estimates.length) {
      lines.push(
        '',
        '🧾 **Still on estimated costs.** Know the real figures yet (discounts, freight)?',
        ...estimates.slice(0, 10).map((p) => `• ${p.product}: ${p.units} sold`),
        openLine(),
      );
    }
    await logToStaff(client, {
      title: '📈 Last week\'s profit',
      description: lines.join('\n').slice(0, 4000),
      color: 0x27ae60,
    });
  }

  if (hour >= 10 && getMeta('cost_reminder_day') !== date) {
    setMeta('cost_reminder_day', date);
    const missing = missingCosts({ now });
    if (missing.length) {
      await logToStaff(client, {
        title: '💰 Costs missing',
        description: [
          'These sold with no cost per unit, so your profit can\'t count them yet:',
          ...missing.slice(0, 15).map((m) => `• **${m.product}**: ${m.units} sold`),
          '',
          openLine(),
        ].join('\n'),
        color: 0xf1c40f,
      });
    }
    const toTag = untaggedPayments(500);
    if (toTag.length) {
      await logToStaff(client, {
        title: '💸 Wise payments to tag',
        description: [
          `${toTag.length} payment${toTag.length === 1 ? '' : 's'} in or out of Wise ${toTag.length === 1 ? "isn't" : "aren't"} tagged yet, `
            + 'so your profit and real costs may be missing them.',
          openLine(),
        ].join(' '),
        color: 0xf1c40f,
      });
    }
  }
}

export function startProfitReportJob(client, intervalMs = 10 * 60_000) {
  const tick = () => {
    runProfitReports(client).catch((err) => console.error('profitReport job failed:', err));
  };
  setTimeout(tick, 60_000);
  return setInterval(tick, intervalMs);
}
