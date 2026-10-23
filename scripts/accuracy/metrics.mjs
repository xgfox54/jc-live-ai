// Character error rate against official minutes. Minutes omit fillers and sometimes abridge,
// so long hypothesis-only runs and edge runs are reported separately from the raw rate.
const PROCEDURAL = /\(([^()]*?(?:의사봉|있음|회의중지|정회|속개|산회|개의|폐의|\d+\s*시|\d+\s*분|녹취|마이크|장내|웃음|박수|발언하는|퇴장|입장|보며|향하여|가리키며)[^()]*?)\)/g;
export function referenceText(minutes) {
  return minutes.replace(/[○●◯◎][^\n]*?(?: {2,}|\n|$)/g, '\n').replace(PROCEDURAL, ' ')
    .split('\n').map(line => line.trim()).filter(Boolean).join(' ');
}
export const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^가-힣a-z0-9]/g, '');

// Window edges are cut at minutes paragraph times that can be off by a few seconds, so the first and last
// trim reference characters are not scored.
export function cer(referenceRaw, hypothesisRaw, { run = 20, edge = 150, trim = 60 } = {}) {
  const r = normalize(referenceRaw); const h = normalize(hypothesisRaw);
  const n = r.length; const m = h.length; const width = m + 1;
  const ops = new Uint8Array((n + 1) * width); let previous = new Uint32Array(width); let current = new Uint32Array(width);
  for (let j = 0; j <= m; j++) { previous[j] = j; ops[j] = 2; }
  for (let i = 1; i <= n; i++) {
    current[0] = i; ops[i * width] = 3; const rc = r.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const diagonal = previous[j - 1] + (rc === h.charCodeAt(j - 1) ? 0 : 1);
      const insert = current[j - 1] + 1; const remove = previous[j] + 1;
      if (diagonal <= insert && diagonal <= remove) { current[j] = diagonal; ops[i * width + j] = rc === h.charCodeAt(j - 1) ? 0 : 1; }
      else if (insert <= remove) { current[j] = insert; ops[i * width + j] = 2; }
      else { current[j] = remove; ops[i * width + j] = 3; }
    }
    [previous, current] = [current, previous];
  }
  const path = []; let i = n; let j = m;
  while (i > 0 || j > 0) {
    const op = i === 0 ? 2 : j === 0 ? 3 : ops[i * width + j]; path.push({ op, i });
    if (op <= 1) { i--; j--; } else if (op === 2) j--; else i--;
  }
  path.reverse();
  let substitutions = 0; let insertions = 0; let deletions = 0; let excluded_insertions = 0; let excluded_deletions = 0;
  for (let k = 0; k < path.length;) {
    const op = path[k].op; let end = k; while (end < path.length && path[end].op === op) end++;
    const length = end - k;
    const atTrim = path[k].i <= trim || path[k].i >= n - trim;
    if (op !== 0 && atTrim) { if (op === 3 || op === 1) excluded_deletions += length; else excluded_insertions += length; }
    else if (op === 1) substitutions += length;
    else if (op === 2) { if (length >= run) excluded_insertions += length; else insertions += length; }
    else if (op === 3) {
      const atEdge = path[k].i <= edge || path[end - 1].i >= n - edge;
      if (length >= run && atEdge) excluded_deletions += length; else deletions += length;
    }
    k = end;
  }
  const raw = (substitutions + insertions + deletions + excluded_insertions + excluded_deletions) / Math.max(1, n);
  const adjustedN = Math.max(1, n - excluded_deletions);
  return { reference_chars: n, hypothesis_chars: m, substitutions, insertions, deletions, excluded_insertions, excluded_deletions,
    cer_raw: raw, cer: (substitutions + insertions + deletions) / adjustedN, accuracy: 1 - (substitutions + insertions + deletions) / adjustedN };
}

