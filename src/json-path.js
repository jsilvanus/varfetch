/**
 * Minimal JSONPath subset: `$` (whole body), dot access (`$.foo.bar`), numeric
 * index (`$.items[0].name`) and quoted keys (`$['weird key']`). No wildcards,
 * filters or recursive descent.
 *
 * @param {unknown} data parsed JSON body
 * @param {string} path
 * @returns {unknown} the value, or undefined when the path does not resolve
 */
export function evaluateJsonPath(data, path) {
  if (!path || path === '$') return data;

  let current = data;
  for (const token of tokenize(path)) {
    if (current === undefined || current === null) return undefined;
    // Own properties only, so paths like `$.constructor` or `$.__proto__` resolve to nothing.
    if (!Object.prototype.hasOwnProperty.call(Object(current), token)) return undefined;
    current = current[token];
  }
  return current;
}

function tokenize(path) {
  let rest = path.trim();
  if (rest.startsWith('$')) rest = rest.slice(1);
  if (rest.startsWith('.')) rest = rest.slice(1);

  const tokens = [];
  const re = /([^[.\]]+)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else if (m[3] !== undefined) tokens.push(m[3]);
    else if (m[4] !== undefined) tokens.push(m[4]);
  }
  return tokens;
}
