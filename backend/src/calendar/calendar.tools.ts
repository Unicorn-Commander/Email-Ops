import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { enforceExtraScope, PatTaggedIdentity } from '../mcp/mcp-scopes';
import { CalendarService } from './calendar.service';
import { CalendarDraftPayload, CalendarEventInput } from './calendar.types';

interface CalendarToolEventArgs extends CalendarEventInput {
  workspace_id?: string;
  mailbox_id: string;
  calendar_id: string;
  approved?: boolean;
}

interface UpdateEventArgs extends CalendarToolEventArgs {
  event_id: string;
  etag?: string | null;
}

interface CancelEventArgs {
  workspace_id?: string;
  mailbox_id: string;
  calendar_id: string;
  event_id: string;
  etag?: string | null;
  approved?: boolean;
}

export class CalendarTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly calendar: CalendarService,
  ) {}

  async listCalendars(user: User, args: { workspace_id?: string; mailbox_id: string }) {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const items = await this.calendar.listCalendars(workspaceId, ucUidOf(user as WithWorkspaceClaim), args.mailbox_id);
    return { calendars: items, count: items.length };
  }

  async listEvents(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; calendar_id: string; start: string; end: string; timezone?: string },
  ) {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const items = await this.calendar.listEvents(workspaceId, ucUidOf(user as WithWorkspaceClaim), args);
    return { events: items, count: items.length };
  }

  async findFreeTime(
    user: User,
    args: {
      workspace_id?: string;
      mailbox_id: string;
      calendar_id: string;
      start: string;
      end: string;
      duration_minutes: number;
      timezone?: string;
      workday_start?: string;
      workday_end?: string;
      limit?: number;
    },
  ) {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.calendar.findFreeTime(workspaceId, ucUidOf(user as WithWorkspaceClaim), args);
  }

  async createEvent(user: User, args: CalendarToolEventArgs) {
    const workspaceId = await this.resolve(user, args.workspace_id);
    this.requireApprovalScope(user, args.approved === true, 'create_event(approved=true)');
    const payload: CalendarDraftPayload = {
      type: 'calendar_event_draft',
      operation: 'create',
      mailbox_id: args.mailbox_id,
      calendar_id: args.calendar_id,
      event: eventInput(args),
    };
    if (args.approved === true) {
      return this.calendar.createEvent(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
        ...eventInput(args),
        mailbox_id: args.mailbox_id,
        calendar_id: args.calendar_id,
      });
    }
    return this.calendar.stageCalendarAction(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      payload,
      `calendar-agent:${ucUidOf(user as WithWorkspaceClaim) ?? 'unknown'}`,
    );
  }

  async updateEvent(user: User, args: UpdateEventArgs) {
    const workspaceId = await this.resolve(user, args.workspace_id);
    this.requireApprovalScope(user, args.approved === true, 'update_event(approved=true)');
    const payload: CalendarDraftPayload = {
      type: 'calendar_event_draft',
      operation: 'update',
      mailbox_id: args.mailbox_id,
      calendar_id: args.calendar_id,
      event_id: args.event_id,
      etag: args.etag ?? null,
      event: eventInput(args),
    };
    if (args.approved === true) {
      return this.calendar.updateEvent(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
        ...eventInput(args),
        mailbox_id: args.mailbox_id,
        calendar_id: args.calendar_id,
        event_id: args.event_id,
        etag: args.etag,
      });
    }
    return this.calendar.stageCalendarAction(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      payload,
      `calendar-agent:${ucUidOf(user as WithWorkspaceClaim) ?? 'unknown'}`,
    );
  }

  async cancelEvent(user: User, args: CancelEventArgs) {
    const workspaceId = await this.resolve(user, args.workspace_id);
    this.requireApprovalScope(user, args.approved === true, 'cancel_event(approved=true)');
    const payload: CalendarDraftPayload = {
      type: 'calendar_event_draft',
      operation: 'cancel',
      mailbox_id: args.mailbox_id,
      calendar_id: args.calendar_id,
      event_id: args.event_id,
      etag: args.etag ?? null,
    };
    if (args.approved === true) {
      return this.calendar.deleteEvent(workspaceId, ucUidOf(user as WithWorkspaceClaim), args);
    }
    return this.calendar.stageCalendarAction(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      payload,
      `calendar-agent:${ucUidOf(user as WithWorkspaceClaim) ?? 'unknown'}`,
    );
  }

  private requireApprovalScope(user: User, approved: boolean, context: string): void {
    if (approved) enforceExtraScope(user as PatTaggedIdentity, 'agent-inbox:approve', context);
  }

  private async resolve(user: User, requested?: string): Promise<string> {
    return this.membership.resolveAndAuthorize(user, requested ?? null);
  }
}

function eventInput(args: CalendarToolEventArgs): CalendarEventInput {
  return {
    uid: args.uid,
    summary: args.summary,
    description: args.description,
    location: args.location,
    start: args.start,
    end: args.end,
    all_day: args.all_day,
    timezone: args.timezone,
    recurrence_rule: args.recurrence_rule,
    attendees: args.attendees,
    organizer: args.organizer,
    status: args.status,
    url: args.url,
  };
}
