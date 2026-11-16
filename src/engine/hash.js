// Stable hashing of plain data, used to compare sim states in tests and autoplay.

/** JSON with object keys sorted, so equal data always gives equal text. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return `"__${String(value)}__"`;
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** 32-bit FNV-1a hash of any plain data, as 8 hex digits. */
export function hashState(value) {
  const text = stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Paths of any NaN or infinite numbers inside plain data. Empty means clean. */
export function findBadNumbers(value, path = 'state', out = []) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findBadNumbers(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findBadNumbers(v, `${path}.${k}`, out);
  }
  return out;
}
