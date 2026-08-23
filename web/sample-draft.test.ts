import { describe, expect, it } from 'vitest';
import { SAMPLE_DRAFT } from './sample-draft';

describe('SAMPLE_DRAFT', () => {
  it('is non-empty prose', () => {
    expect(SAMPLE_DRAFT.trim().length).toBeGreaterThan(0);
  });

  it('splits into at least five blocks on blank lines', () => {
    const blocks = SAMPLE_DRAFT.split(/\n\n+/);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  it('stays under the 1800-char cap', () => {
    expect(SAMPLE_DRAFT.length).toBeLessThan(1800);
  });

  it('keeps every block non-empty', () => {
    const blocks = SAMPLE_DRAFT.split(/\n\n+/);
    expect(blocks.every((block) => block.trim().length > 0)).toBe(true);
  });

  it('is prose-only — no heading or list lines', () => {
    const lines = SAMPLE_DRAFT.split('\n');
    expect(lines.some((line) => /^#/.test(line.trim()))).toBe(false);
    expect(lines.some((line) => /^-/.test(line.trim()))).toBe(false);
  });
});
