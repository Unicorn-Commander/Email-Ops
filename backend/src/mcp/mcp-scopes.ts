import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { checkPat, PatRecord, PatScope } from '../auth/pat-scope';

/** Every MCP tool has one required PAT scope; JWT callers bypass this map. */
export const MCP_TOOL_SCOPES = {
  health: 'mail:read',
  list_my_workspaces: 'mail:read',
  email_ops_health: 'mail:read',
  list_agents: 'mail:read',
  provision_mailbox: 'admin:provision',
  provision_agent: 'admin:provision',
  set_disposition: 'mail:write',
  set_sender_policy: 'mail:write',
  list_threads_with_contact: 'mail:read',
  list_thread_messages: 'mail:read',
  compose_email: 'agent-inbox:approve',
  list_threads: 'mail:read',
  get_thread: 'mail:read',
  search_mail: 'mail:read',
  set_read: 'mail:write',
  bulk_disposition: 'mail:write',
  list_folders: 'mail:read',
  create_folder: 'mail:write',
  rename_folder: 'mail:write',
  delete_folder: 'mail:write',
  move_to_folder: 'mail:write',
  snooze_thread: 'mail:write',
  unsnooze_thread: 'mail:write',
  list_snoozed: 'mail:read',
  schedule_send: 'agent-inbox:approve',
  cancel_scheduled_send: 'mail:write',
  list_scheduled_sends: 'mail:read',
  list_agent_mailboxes: 'mail:read',
  get_agent_mailbox: 'mail:read',
  list_mail_rules: 'mail:read',
  create_mail_rule: 'mail:write',
  update_mail_rule: 'mail:write',
  delete_mail_rule: 'mail:write',
  list_connected_accounts: 'mail:read',
  get_inbox_stats: 'cleaner:run',
  analyze_inbox: 'cleaner:run',
  plan_cleanup: 'cleaner:run',
  clean_trash: 'cleaner:run',
  clean_delete: 'cleaner:run',
  organize_messages: 'cleaner:run',
  unsubscribe_sender: 'cleaner:run',
  undo_batch: 'cleaner:run',
  list_agent_inbox: 'agent-inbox:read',
  approve_agent_inbox_item: 'agent-inbox:approve',
  reject_agent_inbox_item: 'agent-inbox:approve',
  list_trusted_correspondents: 'mail:read',
  trust_correspondent: 'mail:write',
  untrust_correspondent: 'mail:write',
  list_mail_domains: 'mail:read',
  list_mail_accounts: 'mail:read',
  ensure_mail_domain: 'admin:provision',
  remove_mail_domain: 'admin:provision',
  set_mailbox_quota: 'admin:provision',
  remove_mailbox_engine: 'admin:provision',
  ui_navigate: 'ui:control',
  ui_open_thread: 'ui:control',
  ui_compose: 'ui:control',
  ui_switch_space: 'ui:control',
  ui_notify: 'ui:control',
} as const satisfies Record<string, PatScope>;

export type McpToolName = keyof typeof MCP_TOOL_SCOPES;

export interface PatTaggedIdentity {
  __patAuth?: PatRecord;
}

/** Single PAT authorization decision used by the MCP registration wrapper. */
export function enforceMcpToolScope(
  identity: PatTaggedIdentity,
  toolName: McpToolName,
  nowIso = new Date().toISOString(),
): void {
  const pat = identity.__patAuth;
  if (!pat) {
    return;
  }

  const required = MCP_TOOL_SCOPES[toolName];
  const decision = checkPat(pat, required, nowIso);
  if (decision.ok) {
    return;
  }

  if (decision.reason === 'missing-scope') {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      reason: decision.reason,
      message: `Personal access token requires scope ${required}`,
    });
  }

  throw new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    reason: decision.reason,
    message: `Personal access token ${decision.reason}`,
  });
}
