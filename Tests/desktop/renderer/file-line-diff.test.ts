import { expect, it } from 'vitest';
import { fileLineDiff } from '../../../apps/desktop/src/renderer/file-line-diff.js';

it('marks removed and added lines while preserving common context', () => {
  const value = fileLineDiff('first\nold setting\nlast', 'first\nnew setting\nlast');
  expect(value).toMatchObject({ limited: false, rows: [
    { kind: 'same', text: 'first' }, { kind: 'remove', text: 'old setting' },
    { kind: 'add', text: 'new setting' }, { kind: 'same', text: 'last' }
  ] });
});
it('retains a correct edit script for repeated lines, reorderings, pure create and delete', () => {
  for (const [before, after] of [['a\nrepeat\nx\nrepeat\nz', 'a\nrepeat\ny\nrepeat\nz'], ['a\nb\nc', 'c\na\nb'], ['', 'new'], ['old', '']]) {
    const value = fileLineDiff(before!, after!);
    expect(value.limited).toBe(false);
    expect(value.rows.filter((row) => row.kind !== 'add').map((row) => row.text).join('\n')).toBe(before);
    expect(value.rows.filter((row) => row.kind !== 'remove').map((row) => row.text).join('\n')).toBe(after);
  }
});
it('bounds compute and display without pretending a truncated diff is complete', () => {
  expect(fileLineDiff('x'.repeat(128_001), 'next')).toMatchObject({ limited: true, rows: [], message: expect.stringContaining('完整旧新') });
  expect(fileLineDiff('\n'.repeat(4_001), 'next')).toMatchObject({ limited: true, rows: [] });
  const value = fileLineDiff(Array.from({ length: 2000 }, (_, i) => `old-${i}`).join('\n'), Array.from({ length: 2000 }, (_, i) => `new-${i}`).join('\n'));
  expect(value.limited).toBe(true); expect(value.rows.length).toBeLessThanOrEqual(160);
  expect(value.rows.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(24_000);
  expect(fileLineDiff('same', 'same')).toMatchObject({ limited: false, rows: [], message: '内容没有变化。' });
});
