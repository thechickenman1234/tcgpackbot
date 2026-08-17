import { config } from '../config.js';
import { getBuyer } from './buyerService.js';
import { getAllPaidOrders, getPaidUnexportedOrders, markExported } from './orderService.js';

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
  const contents = `${order.quantity}x ${order.product_name}`;
  const referenceWithContents = `${order.reference_code} — ${contents}`;

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
    referenceWithContents,
    type,
  ];

  return fields.map(csvEscape).join(',');
}

/**
 * Builds a CSV of paid orders, ready to hand to the label printer app.
 * By default, only includes orders that haven't been exported yet, and
 * marks them exported so re-running this later only picks up newly-paid
 * orders, not duplicates.
 *
 * Pass includeAlreadyExported = true to instead pull EVERY paid order,
 * regardless of past export history — useful for re-generating a full,
 * up-to-date CSV (e.g. after a format change like adding product/qty to
 * the reference field) without needing to "un-export" anything first.
 */
export function buildLabelExportCsv(includeAlreadyExported = false) {
  const orders = includeAlreadyExported ? getAllPaidOrders() : getPaidUnexportedOrders();
  if (!orders.length) return null;

  const rows = [CSV_HEADER.join(','), ...orders.map(orderToRow)];
  markExported(orders.map((o) => o.id));

  return { csv: rows.join('\n'), count: orders.length };
}
