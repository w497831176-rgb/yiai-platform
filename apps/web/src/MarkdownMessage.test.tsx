import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownMessage } from './MarkdownMessage';

describe('MarkdownMessage', () => {
  it('renders common Markdown and GFM constructs', () => {
    render(
      <MarkdownMessage
        content={'## Heading\n\n**important** with `code`\n\n- first\n- second\n\n| Item | Result |\n| --- | --- |\n| Card | Good |\n\n[Docs](https://example.com)\n\n```ts\nconst answer = 42;\n```'}
      />
    );

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('important').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByText('const answer = 42;').closest('pre')).not.toBeNull();
  });

  it('does not render raw HTML or unsafe link protocols', () => {
    const { container } = render(
      <MarkdownMessage content={'<script>alert("xss")</script>\n\n[bad](javascript:alert(1))'} />
    );

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('bad').closest('a')).not.toHaveAttribute('href', 'javascript:alert(1)');
  });
});
