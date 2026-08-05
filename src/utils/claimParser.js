/**
 * Strict claim format: claim [quantity]x [product]
 * Example: claim 2x mega dream
 */
const CLAIM_PATTERN = /^claim\s+(\d+)\s*x\s+(.+)$/i;

export function parseClaim(content) {
  const trimmed = content.trim();
  const match = trimmed.match(CLAIM_PATTERN);

  if (!match) {
    return null;
  }

  const quantity = Number(match[1]);
  const productName = match[2].trim().replace(/\s+/g, ' ');

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return null;
  }

  if (!productName) {
    return null;
  }

  return { quantity, productName };
}

export function looksLikeClaimAttempt(content) {
  return /^\s*claim\b/i.test(content.trim());
}
