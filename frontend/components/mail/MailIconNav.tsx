'use client';

/**
 * Zone 1 of the command center: the far-left section nav.
 *
 * These are the real app sections (Overview, Mail, Approvals, Agents, Mailboxes,
 * Insights, Cleanup, Settings) — each a real route. The active item is derived
 * from the pathname; Approvals carries the live pending-approval count as a
 * badge. This replaces the global AppShell sidebar for the /mail full-bleed
 * surface, so it stays visible on mobile too (it is the only way off the mail
 * page there).
 *
 * Two widths, persisted via the section-rail store: COMPACT (52px, icons only —
 * the dense cockpit default) and EXPANDED (208px, icon + label) so the section
 * titles are legible. The chevron at the top toggles between them.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { cn } from '@/components/ui';
import { useSectionRailExpanded } from '@/state/uiCollapse';
import { sectionNavPane, usePaneWidth } from '@/state/paneWidths';
import { ResizableEdge } from '@/components/ResizableEdge';
import {
  GridIcon,
  MailIcon,
  CheckSquareIcon,
  RobotIcon,
  InboxTrayIcon,
  TrashIcon,
  GearIcon,
  DeviceIcon,
  BarChartIcon,
  ChevronRightIcon,
  QuestionIcon,
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
  { href: '/insights', label: 'Insights', icon: BarChartIcon },
];

const BOTTOM: NavItem[] = [
  { href: '/cleanup', label: 'Cleanup', icon: TrashIcon },
  { href: '/connect-device', label: 'Connect device', icon: DeviceIcon },
  { href: '/accounts', label: 'Accounts', icon: GearIcon },
  { href: '/help', label: 'Help', icon: QuestionIcon },
];

export function MailIconNav({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  const [expanded, toggleExpanded] = useSectionRailExpanded();
  // Expanded width is drag-resizable + persisted; compact stays a fixed 52px.
  const navWidth = usePaneWidth(sectionNavPane) ?? 208;
  const [resizing, setResizing] = useState(false);

  const renderItem = (item: NavItem) => {
    const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
    const Glyph = item.icon;
    const badge = item.badgeKey === 'approvals' && pendingCount > 0 ? pendingCount : 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        title={expanded ? undefined : item.label}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex h-9 items-center rounded-[9px] transition-colors duration-fast ease-token',
          expanded ? 'w-full gap-3 px-2.5' : 'w-9 justify-center',
          active
            ? 'bg-accent/12 text-accent'
            : 'text-tertiary hover:bg-surface-overlay hover:text-secondary',
        )}
      >
        {active && (
          <span className="absolute -left-[9px] top-2 bottom-2 w-[3px] rounded-r-[3px] bg-accent" />
        )}
        <Glyph className="h-[18px] w-[18px] shrink-0" />
        {expanded && (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.label}</span>
        )}
        {badge > 0 &&
          (expanded ? (
            <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-lg bg-warning px-1.5 text-[10px] font-bold leading-none text-white mono">
              {badge > 99 ? '99+' : badge}
            </span>
          ) : (
            <span className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface-raised bg-warning px-[3px] text-[9px] font-bold leading-none text-white mono">
              {badge > 99 ? '99+' : badge}
            </span>
          ))}
      </Link>
    );
  };

  return (
    <nav
      aria-label="Sections"
      style={expanded ? { width: navWidth } : undefined}
      className={cn(
        'relative flex shrink-0 flex-col gap-1 border-r border-subtle bg-surface-raised py-2.5',
        !resizing && 'transition-[width] duration-token ease-token',
        expanded ? 'items-stretch px-2.5' : 'w-[52px] items-center',
      )}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-label={expanded ? 'Collapse section menu' : 'Expand section menu'}
        aria-expanded={expanded}
        title={expanded ? 'Collapse menu' : 'Expand menu'}
        className={cn(
          'mb-0.5 flex h-9 items-center rounded-[9px] text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-secondary',
          expanded ? 'w-full gap-3 px-2.5' : 'w-9 justify-center',
        )}
      >
        <ChevronRightIcon
          className={cn('h-[18px] w-[18px] shrink-0 transition-transform', expanded && 'rotate-180')}
        />
        {expanded && (
          <span className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
            Menu
          </span>
        )}
      </button>

      {TOP.map(renderItem)}
      <div className="flex-1" />
      {BOTTOM.map(renderItem)}

      {expanded && (
        <ResizableEdge
          store={sectionNavPane}
          edge="right"
          target="parent"
          label="Resize navigation"
          onDraggingChange={setResizing}
        />
      )}
    </nav>
  );
}
