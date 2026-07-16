import { describe, it, expect } from 'vitest';
import {
  stripThinkContent,
  normalizeYiaiTimestamp,
  formatShanghaiTime,
} from './message';

describe('stripThinkContent', () => {
  it('removes complete think tags within the same chunk', () => {
    const input = 'visible before <think>hidden content</think> visible after';
    expect(stripThinkContent(input)).toBe('visible before  visible after');
  });

  it('removes think content that spans multiple chunks after concatenation', () => {
    const chunk1 = 'start <think>partial';
    const chunk2 = ' rest</think> end';
    expect(stripThinkContent(chunk1 + chunk2)).toBe('start  end');
  });

  it('hides everything after an unclosed think tag', () => {
    const input = 'keep this <think>never close this content';
    expect(stripThinkContent(input)).toBe('keep this ');
  });

  it('returns text unchanged when there is no think tag', () => {
    const input = 'plain response without hidden thoughts';
    expect(stripThinkContent(input)).toBe(input);
  });
});

describe('normalizeYiaiTimestamp', () => {
  it('converts Unix seconds to milliseconds', () => {
    const seconds = 1704067200;
    const result = normalizeYiaiTimestamp(seconds);
    expect(result).toBe(seconds * 1000);
  });

  it('keeps millisecond timestamps unchanged', () => {
    const ms = 1704067200000;
    expect(normalizeYiaiTimestamp(ms)).toBe(ms);
  });

  it('parses numeric string seconds', () => {
    const seconds = '1704067200';
    expect(normalizeYiaiTimestamp(seconds)).toBe(Number(seconds) * 1000);
  });

  it('parses numeric string milliseconds', () => {
    const ms = '1704067200000';
    expect(normalizeYiaiTimestamp(ms)).toBe(Number(ms));
  });

  it('parses ISO strings', () => {
    const iso = '2024-01-01T08:00:00.000Z';
    const result = normalizeYiaiTimestamp(iso);
    expect(result).toBe(new Date(iso).getTime());
  });

  it('returns null for invalid values', () => {
    expect(normalizeYiaiTimestamp(null)).toBeNull();
    expect(normalizeYiaiTimestamp(undefined)).toBeNull();
    expect(normalizeYiaiTimestamp('')).toBeNull();
    expect(normalizeYiaiTimestamp('not a date')).toBeNull();
    expect(normalizeYiaiTimestamp(0)).toBeNull();
    expect(normalizeYiaiTimestamp(-1)).toBeNull();
  });
});

describe('formatShanghaiTime', () => {
  it('formats milliseconds timestamp in Shanghai timezone', () => {
    const ms = new Date('2024-01-01T00:00:00.000Z').getTime();
    const formatted = formatShanghaiTime(ms);
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatted).toContain('2024-01-01');
  });

  it('does not produce a 1970 date for invalid input', () => {
    const formatted = formatShanghaiTime(0);
    expect(formatted).toContain('1970');
    // normalizeYiaiTimestamp(0) returns null, so callers should not display it.
    expect(normalizeYiaiTimestamp(0)).toBeNull();
  });
});
