import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the platform name and initialization message', () => {
    render(<App />);

    expect(screen.getByText('YIAI Platform')).toBeInTheDocument();
    expect(screen.getByText('系统初始化完成')).toBeInTheDocument();
  });
});
