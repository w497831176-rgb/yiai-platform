export function stripThinkContent(text: string): string {
  const withCompleteRemoved = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const unclosedStart = withCompleteRemoved.indexOf('<think>');
  if (unclosedStart !== -1) {
    return withCompleteRemoved.slice(0, unclosedStart);
  }
  return withCompleteRemoved;
}

export function normalizeYiaiTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    // 10 digits ≈ seconds, 13 digits ≈ milliseconds
    return value < 1e11 ? value * 1000 : value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
      }
      return trimmed.length <= 10 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(trimmed);
    const time = parsed.getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  }

  return null;
}

export function formatShanghaiTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(timestamp))
    .replace(/\//g, '-');
}
