import { config } from '../config.js';
import { getBuyer } from './buyerService.js';
import { getPaidUnexportedOrders, markExported } from './orderService.js';

const CSV_HEADER = [
  'to_name', 'to_business_name', 'to_street', 'to_street2', 'to_city', 'to_state', 'to_postcode',
  'from_name', 'from_business_name', 'from_street', 'from_street2', 'from_city', 'from_state', 'from_postcode',
  'phone', 'reference', 'type',
];

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function orderToRow(order) {
  const buyer = getBuyer(order.buyer_id);
  const type = order.shipping_method === 'express' ? 'EXPRESS' : 'STANDARD';

  const fields = [
    buyer?.name || '',
    '',
    buyer?.shipping_address || '',
    '',
    buyer?.city || '',
    buyer?.state || '',
    buyer?.zip || '',
    config.fromName,
    config.fromBusinessName,
    config.fromStreet,
    config.fromStreet2,
    config.fromCity,
    config.fromState,
    config.fromPostcode,
    buyer?.phone || '',
    order.reference_code,
    type,
  ];

  return fields.map(csvEscape).join(',');
}

/**
 * Builds a CSV of every paid-but-not-yet-exported order, ready to hand to
 * the label printer app. Returns null if there's nothing new to export.
 * Marks the included orders as exported so re-running this later only
 * picks up newly-paid orders, not duplicates.
 */
export function buildLabelExportCsv() {
  const orders = getPaidUnexportedOrders();
  if (!orders.length) return null;

  const rows = [CSV_HEADER.join(','), ...orders.map(orderToRow)];
  markExported(orders.map((o) => o.id));

  return { csv: rows.join('\n'), count: orders.length };
}
