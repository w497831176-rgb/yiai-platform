import { describe, it, expect } from 'vitest';
import { stripThinkContent } from './message';

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
