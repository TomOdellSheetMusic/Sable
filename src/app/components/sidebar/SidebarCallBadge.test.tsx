import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SidebarCallBadge } from './SidebarCallBadge';

vi.mock('./SidebarItem', () => ({
  SidebarItemBadge: ({ mode, children }: { mode: string; children: ReactNode }) => (
    <div data-testid="sidebar-item-badge" data-mode={mode}>
      {children}
    </div>
  ),
}));

vi.mock('folds', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span data-testid="badge">{children}</span>,
  Box: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  config: { space: { S300: '16px' } },
}));

vi.mock('$components/icons/phosphor', () => ({
  sizedIcon: () => <span data-testid="call-icon" />,
  Phone: () => null,
}));

describe('SidebarCallBadge', () => {
  it('renders a call-mode badge with the phone icon', () => {
    render(<SidebarCallBadge />);

    expect(screen.getByTestId('sidebar-item-badge')).toHaveAttribute('data-mode', 'call');
    expect(screen.getByTestId('call-icon')).toBeInTheDocument();
  });
});
