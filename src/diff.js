// Line by line, what changed between two versions of a note: Myers' diff, the shortest list of lines
// taken out and put in. Lines the two share at the start and the end are set aside first, so a long
// note with a small change costs little.

const MAX_D = 1500; // more lines changed than this: the middle is shown as replaced whole (memory ~ D²)

/** [{ op: 'same' | 'del' | 'add', text }] turning `before` into `after`, line by line. */
export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (text) => ({ op: 'same', text });
  return [...a.slice(0, start).map(same), ...middle(a.slice(start, endA), b.slice(start, endB)), ...a.slice(endA).map(same)];
}

function middle(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text) => ({ op: 'add', text }));
  if (!m) return a.map((text) => ({ op: 'del', text }));
  const max = Math.min(n + m, MAX_D);
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  const trace = []; // trace[d]: v's diagonals -d…d as they stood before step d
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  // too far apart to be worth the search: all of the old middle out, all of the new in
  return [...a.map((text) => ({ op: 'del', text })), ...b.map((text) => ({ op: 'add', text }))];
}

function backtrack(trace, a, b, last) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = last; d > 0; d--) {
    const v = trace[d];
    const at = (k) => v[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ op: 'same', text: a[x] });
    }
    if (x === prevX) {
      y--;
      out.push({ op: 'add', text: b[y] });
    } else {
      x--;
      out.push({ op: 'del', text: a[x] });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push({ op: 'same', text: a[x] });
  }
  return out.reverse();
}

/** How many lines went in and out. */
export function diffCounts(ops) {
  let added = 0;
  let removed = 0;
  for (const { op } of ops) {
    if (op === 'add') added++;
    else if (op === 'del') removed++;
  }
  return { added, removed };
}
