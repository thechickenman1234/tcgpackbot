import { randomBytes } from 'node:crypto';

/** Unique short order reference, e.g. TCG-A1B2C3 */
export function generateOrderReference() {
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `TCG-${suffix}`;
}
