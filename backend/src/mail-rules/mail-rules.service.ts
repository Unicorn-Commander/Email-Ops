import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MailRule, Prisma } from '@prisma/client';
import { assertMayActThroughMailbox } from '../common/mailbox/mailbox-fence';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import {
  CompiledRule,
  Condition,
  evaluateRules,
  InboundMessage,
  MatchNode,
  parseActions,
  parseMatch,
  RuleAction,
} from './rule-engine';
import {
  ApplyInboundSummary,
  CreateMailRuleInput,
  InboundRuleMessage,
  MailRuleRow,
  MailRuleView,
  UpdateMailRuleInput,
} from './mail-rules.types';

// Attribution sub for the applicator's fenced hit-counter writes (system path —
// no acting human; same register as the watcher's 'inbound-watcher').
const APPLICATOR_UC_UID = 'mail-rules';
const MAX_RULES_PER_MAILBOX = 100;
// Auto-assigned priorities step by 10 so a UI can insert between rules later.
const PRIORITY_STEP = 10;
// Priorities live in an int4 column; bound accepted values well inside it so
// auto-assign (max + 10) can never overflow.
const PRIORITY_MAX = 1_000_000_000;
// Structural caps for the match tree on WRITE (the engine keeps evaluating
// legacy stored shapes beyond them — see the contract in mail-rules.types.ts).
const MAX_MATCH_GROUPS = 5;
const MAX_MATCH_CONDITIONS_PER_GROUP = 10;

/**
 * Mail-rules CRUD + the inbound APPLICATOR. CRUD is workspace-member surface:
 * every query runs through withWorkspace AND scopes by BOTH workspaceId and
 * mailboxId (the explicit tenant fence alongside RLS — same doctrine as
 * scheduling). The applicator is a system path invoked per new inbound message
 * by the InboundWatcherService; it NEVER throws into the watcher (degrade-clean).
 */
@Injectable()
export class MailRulesService {
  private readonly logger = new Logger(MailRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
  ) {}

  async list(workspaceId: string, ucUid: string | null, mailboxId: string): Promise<MailRuleView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, ucUid, mailboxId);
      const rows = await tx.mailRule.findMany({
        where: { workspaceId, mailboxId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map((row) => this.view(row));
    });
  }

  async create(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    input: CreateMailRuleInput,
  ): Promise<MailRuleView> {
    // Pure validation BEFORE the transaction — a bad payload never opens a tx.
    const name = this.normalizeName(input.name);
    const match = this.compileMatch(input.match);
    const actions = this.compileActions(input.actions);
    const explicitPriority = input.priority === undefined ? null : this.normalizePriority(input.priority);

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, ucUid, mailboxId, { requireSovereign: true });
      const count = await tx.mailRule.count({ where: { workspaceId, mailboxId } });
      if (count >= MAX_RULES_PER_MAILBOX) {
        throw new BadRequestException(
          `This mailbox already has the maximum of ${MAX_RULES_PER_MAILBOX} rules.`,
        );
      }
      let priority = explicitPriority;
      if (priority === null) {
        const agg = await tx.mailRule.aggregate({
          where: { workspaceId, mailboxId },
          _max: { priority: true },
        });
        priority = (agg._max.priority ?? 0) + PRIORITY_STEP;
      }
      const row = await tx.mailRule.create({
        data: {
          workspaceId,
          mailboxId,
          name,
          enabled: input.enabled ?? true,
          priority,
          // Store the PARSED (sanitized) forms, never the raw body.
          match: match as unknown as Prisma.InputJsonValue,
          actions: actions as unknown as Prisma.InputJsonValue,
          createdBy: ucUid || null,
        },
      });
      return this.view(row);
    });
  }

  /** Null when the rule is not in this workspace+mailbox (controller → 404). */
  async update(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    ruleId: string,
    input: UpdateMailRuleInput,
  ): Promise<MailRuleView | null> {
    // Same per-field validation as create, applied only to provided fields.
    // `!= null` (not `!== undefined`): class-validator's @IsOptional also lets
    // an explicit null through, and a null must read as "not provided" — never
    // reach Prisma as a null write on a non-nullable column (500).
    const data: Prisma.MailRuleUpdateInput = {};
    if (input.name != null) data.name = this.normalizeName(input.name);
    if (input.enabled != null) data.enabled = input.enabled;
    if (input.priority != null) data.priority = this.normalizePriority(input.priority);
    if (input.match != null) {
      data.match = this.compileMatch(input.match) as unknown as Prisma.InputJsonValue;
    }
    if (input.actions != null) {
      data.actions = this.compileActions(input.actions) as unknown as Prisma.InputJsonValue;
    }

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, ucUid, mailboxId);
      const existing = await tx.mailRule.findFirst({
        where: { id: ruleId, workspaceId, mailboxId },
      });
      if (!existing) return null;
      if (Object.keys(data).length === 0) return this.view(existing); // empty PATCH = read-back
      const row = await tx.mailRule.update({ where: { id: ruleId }, data });
      return this.view(row);
    });
  }

  /** False when the rule is not in this workspace+mailbox (controller → 404). */
  async remove(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    ruleId: string,
  ): Promise<boolean> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, ucUid, mailboxId);
      const res = await tx.mailRule.deleteMany({ where: { id: ruleId, workspaceId, mailboxId } });
      return res.count === 1;
    });
  }

  /**
   * Apply this mailbox's enabled rules to one newly arrived message. Called by
   * the inbound watcher right after triage; `preloadedRules` (the watcher's
   * once-per-sweep enabled-rule load, grouped by mailbox) skips the per-message
   * query. Actions execute IN ORDER via the same engine primitives the webmail
   * uses — when several folder placements match (e.g. a MOVE then a TRASH), the
   * LAST executed placement wins, exactly like a user clicking both in sequence.
   * Degrade-clean: a dormant engine / failed action logs and continues; this
   * method NEVER throws into the watcher.
   */
  async applyInbound(
    workspaceId: string,
    mailboxId: string,
    mailboxEmail: string,
    msg: InboundRuleMessage,
    preloadedRules?: MailRuleRow[],
  ): Promise<ApplyInboundSummary> {
    const none: ApplyInboundSummary = { matched: 0, applied: 0 };
    try {
      const rows: MailRuleRow[] =
        preloadedRules ??
        (await this.prisma.systemClient.mailRule.findMany({
          where: { workspaceId, mailboxId, enabled: true },
          select: {
            id: true,
            workspaceId: true,
            mailboxId: true,
            enabled: true,
            priority: true,
            match: true,
            actions: true,
          },
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        }));
      // Belt-and-braces fence: never act on a row for another tenant/mailbox,
      // even if a caller hands over a mis-grouped preload.
      const usable = rows.filter(
        (r) => r.enabled && r.workspaceId === workspaceId && r.mailboxId === mailboxId,
      );
      if (usable.length === 0) return none;

      const compiled: CompiledRule[] = usable.map((row) => ({
        id: row.id,
        enabled: row.enabled,
        priority: row.priority,
        match: parseMatch(row.match),
        actions: parseActions(row.actions),
      }));
      const inbound: InboundMessage = {
        fromAddress: msg.fromAddress ?? '',
        // The REAL To header only. toAddress stays '' so the engine's back-compat
        // fallback can never resurface the old mailbox-address stand-in (which
        // made 'to' conditions constant-valued — always or never matching).
        toAddress: '',
        toAddresses: msg.toAddresses ?? [],
        subject: msg.subject ?? '',
      };
      // One authoritative evaluation produces the action list (STOP honored).
      const sorted = [...compiled].sort((a, b) => a.priority - b.priority);
      const actions = evaluateRules(sorted, inbound);
      // evaluateRules doesn't report WHICH rules fired, so replay its documented
      // walk (priority asc, stop after a STOP-emitting rule) with single-rule
      // calls to collect the matched ids for the hit counters.
      const matchedIds: string[] = [];
      for (const rule of sorted) {
        const ruleActions = evaluateRules([rule], inbound);
        if (ruleActions.length === 0) continue;
        matchedIds.push(rule.id);
        if (ruleActions.some((a) => a.type === 'STOP')) break;
      }
      if (matchedIds.length === 0) return none;

      let applied = 0;
      for (const action of actions) {
        if (action.type === 'STOP') continue; // evaluation terminator — no engine effect
        try {
          const ok = await this.executeAction(mailboxEmail, msg.threadId, action);
          if (ok === null) {
            this.logger.debug(`rules: skipping action ${action.type} (unsupported) mailbox=${mailboxId}`);
          } else if (ok) {
            applied += 1;
          } else {
            // Port degrade-clean (dormant engine / unknown thread): not an error.
            this.logger.debug(`rules: ${action.type} not applied (engine declined) thread=${msg.threadId}`);
          }
        } catch (err) {
          this.logger.warn(
            `rules: ${action.type} failed thread=${msg.threadId} mailbox=${mailboxId}: ${(err as Error).message}`,
          );
        }
      }

      try {
        // Fenced observability write; failure never voids the applied actions.
        await this.prisma.withWorkspace(workspaceId, APPLICATOR_UC_UID, (tx) =>
          tx.mailRule.updateMany({
            where: { id: { in: matchedIds }, workspaceId, mailboxId },
            data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
          }),
        );
      } catch (err) {
        this.logger.warn(`rules: hit-counter bump failed mailbox=${mailboxId}: ${(err as Error).message}`);
      }

      return { matched: matchedIds.length, applied };
    } catch (err) {
      this.logger.warn(
        `rules: apply failed mailbox=${mailboxId} thread=${msg.threadId}: ${(err as Error).message}`,
      );
      return none;
    }
  }

  /** True/false = engine outcome; null = unsupported here (LABEL / blank move target). */
  private async executeAction(
    mailboxEmail: string,
    threadId: string,
    action: RuleAction,
  ): Promise<boolean | null> {
    switch (action.type) {
      case 'MOVE_TO_FOLDER': {
        // Same primitive + identifier semantics as the webmail move flow
        // (PUT .../threads/:threadId/move): value is a JMAP folder id from
        // GET .../folders; the engine validates it belongs to this account.
        const folderId = (action.value ?? '').trim();
        if (!folderId) return null;
        return this.stalwart.moveThreadToMailbox(mailboxEmail, threadId, folderId);
      }
      case 'ARCHIVE':
        return this.stalwart.moveThreadToFolder(mailboxEmail, threadId, 'archive');
      case 'TRASH':
        return this.stalwart.moveThreadToFolder(mailboxEmail, threadId, 'trash');
      case 'MARK_READ':
        return this.stalwart.setThreadRead(mailboxEmail, threadId, true);
      default:
        return null; // LABEL (not supported yet) or unknown — skipped with a debug log
    }
  }

  /** Mailbox must exist in THIS workspace (404) and be actionable by the caller. */
  private async assertMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    opts?: { requireSovereign?: boolean },
  ): Promise<void> {
    const mailbox = await tx.mailboxAccount.findFirst({
      where: { id: mailboxId, workspaceId },
      select: { id: true, ownerKind: true, ownerKey: true, provider: true, active: true },
    });
    if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
    assertMayActThroughMailbox(mailbox, ucUid);
    // CREATE-only fence: the inbound watcher only ever applies rules to active
    // sovereign (James) mailboxes, so accepting a rule on a connected Gmail/
    // Microsoft or inactive mailbox would be a silent no-op — refuse loudly
    // instead (mirrors the scheduling service's sovereign fence). List/update/
    // delete stay permissive so rules on a later-disconnected mailbox remain
    // manageable.
    if (opts?.requireSovereign && (mailbox.provider !== 'stalwart' || !mailbox.active)) {
      throw new BadRequestException(
        'Mail rules run only on active sovereign mailboxes — this mailbox is external or inactive.',
      );
    }
  }

  private normalizeName(raw: string): string {
    const name = (raw ?? '').trim();
    if (name.length < 1 || name.length > 120) {
      throw new BadRequestException('name must be 1..120 characters.');
    }
    return name;
  }

  private normalizePriority(raw: number): number {
    if (!Number.isInteger(raw) || raw < 0 || raw > PRIORITY_MAX) {
      throw new BadRequestException(`priority must be an integer between 0 and ${PRIORITY_MAX}.`);
    }
    return raw;
  }

  private compileMatch(raw: unknown): MatchNode {
    const node = parseMatch(raw);
    if (this.countConditions(node) === 0) {
      throw new BadRequestException('match must contain at least one condition');
    }
    this.assertMatchShape(node);
    return node;
  }

  /**
   * Write-time structural fence for the match tree (the engine stays permissive
   * for already-stored data): exactly one mode per node, ONE level of grouping,
   * ≤5 groups, ≤10 conditions per group / top level, no empty groups. Runs on
   * the PARSED node — junk children were already dropped, so the caps count
   * what would actually be stored (same sanitize-first style as actions).
   */
  private assertMatchShape(node: MatchNode): void {
    if (node.all && node.any) {
      throw new BadRequestException(
        'match node must use either "all" or "any", not both — put the other list in a nested group',
      );
    }
    const children = node.all ?? node.any ?? [];
    const groups = children.filter((child): child is MatchNode => !('field' in child));
    if (children.length - groups.length > MAX_MATCH_CONDITIONS_PER_GROUP) {
      throw new BadRequestException(
        `match supports at most ${MAX_MATCH_CONDITIONS_PER_GROUP} conditions per group.`,
      );
    }
    if (groups.length > MAX_MATCH_GROUPS) {
      throw new BadRequestException(`match supports at most ${MAX_MATCH_GROUPS} groups.`);
    }
    for (const group of groups) {
      if (group.all && group.any) {
        throw new BadRequestException(
          'match node must use either "all" or "any", not both — put the other list in a nested group',
        );
      }
      const inner = group.all ?? group.any ?? [];
      if (inner.some((child) => !('field' in child))) {
        throw new BadRequestException(
          'match groups nest one level deep — a group may contain only conditions',
        );
      }
      if (inner.length === 0) {
        throw new BadRequestException('match groups must contain at least one condition');
      }
      if (inner.length > MAX_MATCH_CONDITIONS_PER_GROUP) {
        throw new BadRequestException(
          `match supports at most ${MAX_MATCH_CONDITIONS_PER_GROUP} conditions per group.`,
        );
      }
    }
  }

  private compileActions(raw: unknown): RuleAction[] {
    const actions = parseActions(raw);
    if (actions.length === 0) {
      throw new BadRequestException('actions must contain at least one valid action');
    }
    if (actions.some((a) => a.type === 'LABEL')) {
      throw new BadRequestException('LABEL is not supported yet');
    }
    if (actions.every((a) => a.type === 'STOP')) {
      throw new BadRequestException('actions must include at least one effectful action (not only STOP)');
    }
    return actions;
  }

  /** Count Condition LEAVES recursively — {} and nested-empty groups are dead rules. */
  private countConditions(node: MatchNode): number {
    const children: (Condition | MatchNode)[] = [...(node.all ?? []), ...(node.any ?? [])];
    let count = 0;
    for (const child of children) {
      if ('field' in child) count += 1;
      else count += this.countConditions(child);
    }
    return count;
  }

  private view(row: MailRule): MailRuleView {
    return {
      id: row.id,
      mailbox_id: row.mailboxId,
      name: row.name,
      enabled: row.enabled,
      priority: row.priority,
      match: parseMatch(row.match),
      actions: parseActions(row.actions),
      hit_count: row.hitCount,
      last_hit_at: row.lastHitAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
