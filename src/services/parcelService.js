/**
 * What goes in one box: one order. Always.
 *
 * The rule, from Lachy on 14 Oct 2026: "No matter what, all different orders
 * are on different packages and have to pay separate shipping." Every order
 * already pays its own shipping, so every order gets its own label, even two
 * claimed in the same sale on the same night.
 *
 * It used to be "everything a buyer has waiting goes in one parcel". That
 * glued a box from one drop to a box from a drop weeks later, and the first
 * one sat on the shelf until the second arrived.
 *
 * Claiming the same product again before paying still tops up that one
 * order rather than making a new one, so it is still one order, one box.
 *
 * Kept as its own module so labels, the shipping panel's counts and tracking
 * all ask the same question in the same place, should the rule ever change.
 */

/** Names the parcel an order goes in. One order, one parcel. */
export function parcelKeyer() {
  return (order) => `order:${order.id}`;
}

/** Groups orders into parcels: each order on its own, in the order given. */
export function groupIntoParcels(orders) {
  return orders.map((o) => [o]);
}
