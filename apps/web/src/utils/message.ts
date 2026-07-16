export function stripThinkContent(text: string): string {
  const withCompleteRemoved = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const unclosedStart = withCompleteRemoved.indexOf('<think>');
  if (unclosedStart !== -1) {
    return withCompleteRemoved.slice(0, unclosedStart);
  }
  return withCompleteRemoved;
}
