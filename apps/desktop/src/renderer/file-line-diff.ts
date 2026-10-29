export interface DiffRow { kind: 'same' | 'remove' | 'add'; text: string }
export interface FileLineDiff { rows: DiffRow[]; limited: boolean; message?: string }
const MAX_CHARS = 128_000;
const MAX_LINES = 4_000;
const MAX_ROWS = 160;
const MAX_DISPLAY_CHARS = 24_000;

function unique(lines: string[]): Map<string, number> {
  const positions = new Map<string, number>();
  lines.forEach((line, index) => positions.set(line, positions.has(line) ? -1 : index));
  return positions;
}
/** Unique common lines form patience anchors using O(n log n) LIS, not an LCS matrix. */
function anchors(before: string[], after: string[]): Array<[number, number]> {
  const old = unique(before); const next = unique(after);
  const pairs: Array<[number, number]> = [];
  for (const [line, index] of old) if (index >= 0 && (next.get(line) ?? -1) >= 0) pairs.push([index, next.get(line)!]);
  const tails: number[] = []; const previous = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let low = 0; let high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]!]![1] < pairs[i]![1]) low = mid + 1; else high = mid; }
    previous[i] = low > 0 ? tails[low - 1]! : -1; tails[low] = i;
  }
  const result: Array<[number, number]> = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) result.push(pairs[i]!);
  return result.reverse();
}

/** Bounded, exact edit script; repeated unanchored middle lines can form a larger replace block. */
export function fileLineDiff(old: string, next: string): FileLineDiff {
  if (old === next) return { rows: [], limited: false, message: '内容没有变化。' };
  if (old.length > MAX_CHARS || next.length > MAX_CHARS) return { rows: [], limited: true, message: '内容超过行差异计算上限；请展开下方完整旧新内容。' };
  const before = old === '' ? [] : old.split('\n', MAX_LINES + 1); const after = next === '' ? [] : next.split('\n', MAX_LINES + 1);
  if (before.length > MAX_LINES || after.length > MAX_LINES) return { rows: [], limited: true, message: '行数超过差异计算上限；请展开下方完整旧新内容。' };
  const rows: DiffRow[] = [];
  let oldStart = 0; let newStart = 0;
  for (const [oldEnd, newEnd] of [...anchors(before, after), [before.length, after.length] as [number, number]]) {
    while (oldStart < oldEnd && newStart < newEnd && before[oldStart] === after[newStart]) {
      rows.push({ kind: 'same', text: before[oldStart++]! }); newStart++;
    }
    let suffix = 0;
    while (oldEnd - suffix > oldStart && newEnd - suffix > newStart && before[oldEnd - suffix - 1] === after[newEnd - suffix - 1]) suffix++;
    for (let i = oldStart; i < oldEnd - suffix; i++) rows.push({ kind: 'remove', text: before[i]! });
    for (let i = newStart; i < newEnd - suffix; i++) rows.push({ kind: 'add', text: after[i]! });
    for (let i = oldEnd - suffix; i < oldEnd; i++) rows.push({ kind: 'same', text: before[i]! });
    if (oldEnd < before.length) rows.push({ kind: 'same', text: before[oldEnd]! });
    oldStart = oldEnd + 1; newStart = newEnd + 1;
  }
  const context = new Set<number>();
  rows.forEach((row, i) => { if (row.kind !== 'same') for (let n = Math.max(0, i - 3); n <= Math.min(rows.length - 1, i + 3); n++) context.add(n); });
  const shown: DiffRow[] = []; let chars = 0; let last = -1; let limited = false;
  for (let i = 0; i < rows.length; i++) {
    if (!context.has(i)) continue;
    const row = rows[i]!;
    const gap = last >= 0 && i > last + 1 ? '…（省略未变化的行）' : '';
    if (shown.length + (gap ? 2 : 1) > MAX_ROWS || chars + row.text.length + gap.length > MAX_DISPLAY_CHARS) { limited = true; break; }
    if (gap) { shown.push({ kind: 'same', text: gap }); chars += gap.length; }
    shown.push(row); chars += row.text.length; last = i;
  }
  return { rows: shown, limited, message: limited ? '差异显示已达到上限；下方可展开完整旧新内容。' : undefined };
}
