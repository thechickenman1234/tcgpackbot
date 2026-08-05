/**
 * Flexible claim formats (case-insensitive), e.g.:
 * - claim 2x mega dream
 * - claim 2 mega dream
 * - claim x2 mega dream
 * - claim 2x / claim 2 / claim x2   (product optional if only 1 active product)
 * - 2x claim mega dream
 * - 2x claim
 * - 2x mega dream
 */
function validate(quantity, productName) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return null;
  }

  const cleaned = productName?.trim().replace(/\s+/g, ' ') || null;
  return { quantity, productName: cleaned };
}

export function parseClaim(content) {
  const t = content.trim().replace(/\s+/g, ' ');

  // 2x claim [product] / x2 claim [product]
  let m = t.match(/^(?:(\d+)\s*x|x\s*(\d+))\s+claim(?:\s+(.+))?$/i);
  if (m) {
    return validate(Number(m[1] || m[2]), m[3] || null);
  }

  // claim 2x [product] / claim x2 [product] / claim 2 [product]
  m = t.match(/^claim\s+(?:(\d+)\s*x|x\s*(\d+)|(\d+))(?:\s+(.+))?$/i);
  if (m) {
    return validate(Number(m[1] || m[2] || m[3]), m[4] || null);
  }

  // 2x [product] / x2 [product]
  m = t.match(/^(?:(\d+)\s*x|x\s*(\d+))(?:\s+(.+))?$/i);
  if (m) {
    const rest = (m[3] || '').trim();
    if (!rest || /^claim$/i.test(rest)) {
      return validate(Number(m[1] || m[2]), null);
    }
    if (/^claim\s+/i.test(rest)) {
      return validate(Number(m[1] || m[2]), rest.replace(/^claim\s+/i, ''));
    }
    return validate(Number(m[1] || m[2]), rest);
  }

  return null;
}

export function looksLikeClaimAttempt(content) {
  const t = content.trim();
  if (/^claim\b/i.test(t)) return true;
  if (/^\d+\s*x\b/i.test(t)) return true;
  if (/^x\d+\b/i.test(t)) return true;
  return false;
}

/** "Melbourne, VIC, 3000" or "Melbourne, VIC 3000" */
export function parseCityStateZip(raw) {
  const text = raw.trim().replace(/\s+/g, ' ');
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 3) {
    return {
      city: parts[0],
      state: parts[1],
      zip: parts.slice(2).join(' '),
    };
  }

  if (parts.length === 2) {
    const tail = parts[1];
    const match = tail.match(/^(.+?)\s+(\d[\w-]*)$/);
    if (match) {
      return { city: parts[0], state: match[1].trim(), zip: match[2] };
    }
    return { city: parts[0], state: tail, zip: '' };
  }

  const single = text.match(/^(.+?)\s+([A-Za-z]{2,3})\s+(\d[\w-]*)$/);
  if (single) {
    return { city: single[1], state: single[2], zip: single[3] };
  }

  return { city: text, state: '', zip: '' };
}
