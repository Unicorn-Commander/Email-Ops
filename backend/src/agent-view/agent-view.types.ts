import { AgentInboxView, ThreadView } from '../email/email.types';

export interface AgentViewMailboxSummary {
  id: string;
  address: string;
  provider: string;
}

export interface AgentViewAgentSummary {
  id: string;
  name: string;
  handle: string;
  avatarUrl?: string;
  mailbox: AgentViewMailboxSummary | null;
}

export interface AgentMailboxStats {
  unread?: number;
  total?: number;
  lastActivityAt?: string | null;
}

export interface AgentMailboxViewResponse {
  agent: AgentViewAgentSummary;
  threads: ThreadView[];
  agentInbox: {
    pending: AgentInboxView[];
    counts: {
      pending: number;
      approved: number;
      rejected: number;
    };
  };
  stats: AgentMailboxStats;
}

export interface AgentMailboxRosterItem {
  agent: AgentViewAgentSummary;
  mailbox: {
    address: string | null;
    unread: number;
    pending: number;
  };
}

export interface AgentMailboxRosterResponse {
  items: AgentMailboxRosterItem[];
  count: number;
}
