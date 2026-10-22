/**
 * What goes in a shipping label's reference box.
 *
 * By default it is the order reference and what is in the box, which is
 * what Lachy packs from. When an order changes outside the bot (a buyer
 * swaps a product in a DM, adds a box, splits a parcel), staff write their
 * own text with /label and that prints instead. Every label path (the
 * Print labels file, the sheet's Labels tab and /export) asks here, so they
 * can never disagree.
 */

export function defaultLabelReference(order) {
  return `${order.reference_code}: ${order.quantity}x ${order.product_name}`;
}

export function labelReferenceFor(order) {
  const custom = String(order.label_reference ?? '').trim();
  return custom || defaultLabelReference(order);
}
