'use client';

/**
 * Zone 1 of the command center: the 52px far-left icon nav.
 *
 * These are the real app sections (Overview, Mail, Approvals, Agents, Mailboxes,
 * Cleanup, Settings) — each a real route. The active item is derived from the
 * pathname; Approvals carries the live pending-approval count as a badge. This
 * replaces the global AppShell sidebar for the /mail full-bleed surface, so it
 * stays visible on mobile too (it is the only way off the mail page there).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import {
  GridIcon,
  MailIcon,
  CheckSquareIcon,
  RobotIcon,
  InboxTrayIcon,
  TrashIcon,
  GearIcon,
} from './icons';

type NavItem = {
  href: string;
  label: string;
  icon: (p: { className?: string }) => ReactNode;
  badgeKey?: 'approvals';
};

const TOP: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: GridIcon },
  { href: '/mail', label: 'Mail', icon: MailIcon },
  { href: '/agent-inbox', label: 'Approvals', icon: CheckSquareIcon, badgeKey: 'approvals' },
  { href: '/agents', label: 'Agents', icon: RobotIcon },
  { href: '/mailboxes', label: 'Mailboxes', icon: InboxTrayIcon },
];

const BOTTOM: NavItem[] = [
  { href: '/cleanup', label: 'Cleanup', icon: TrashIcon },
  { href: '/accounts', label: 'Settings', icon: GearIcon },
];

export function MailIconNav({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();

  const renderItem = (item: NavItem) => {
    const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
    const Glyph = item.icon;
    const badge = item.badgeKey === 'approvals' && pendingCount > 0 ? pendingCount : 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        title={item.label}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative grid h-9 w-9 place-items-center rounded-[9px] transition-colors duration-fast ease-token',
          active
            ? 'bg-accent/12 text-accent'
            : 'text-tertiary hover:bg-surface-overlay hover:text-secondary',
        )}
      >
        {active && (
          <span className="absolute -left-[9px] top-2 bottom-2 w-[3px] rounded-r-[3px] bg-accent" />
        )}
        <Glyph className="h-[18px] w-[18px]" />
        {badge > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface-raised bg-accent px-[3px] text-[9.5px] font-bold leading-none text-white mono">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </Link>
    );
  };

  return (
    <nav
      aria-label="Sections"
      className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-subtle bg-surface-raised py-2.5"
    >
      {TOP.map(renderItem)}
      <div className="flex-1" />
      {BOTTOM.map(renderItem)}
    </nav>
  );
}
