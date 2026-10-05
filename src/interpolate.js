/**
 * {{name}} interpolation. Pure: reads whatever a variable currently holds.
 */

const VAR_RE = /\{\{\s*([\p{L}_][\p{L}\p{N}_-]*)\s*\}\}/gu;

/**
 * Replace every {{name}} in a string with its value from `variables`.
 * A missing variable renders as an empty string.
 * @param {string} text
 * @param {Record<string, unknown>} [variables]
 */
export function interpolate(text, variables) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text.replace(VAR_RE, (_match, name) => {
    const value = variables?.[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Interpolate the value of each `{ key, value }` pair (headers and query parameters).
 * @param {Array<{ key: string, value: string }>} pairs
 * @param {Record<string, unknown>} [variables]
 */
export function interpolatePairs(pairs, variables) {
  if (!Array.isArray(pairs)) return [];
  return pairs.map(({ key, value }) => ({ key, value: interpolate(value, variables) }));
}

/** Unique {{name}} references of a string, in order of first use. */
export function extractVariableNames(text) {
  if (typeof text !== 'string') return [];
  const names = new Set();
  for (const match of text.matchAll(VAR_RE)) names.add(match[1]);
  return [...names];
}
