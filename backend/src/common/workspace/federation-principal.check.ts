/**
 * Federation-principal startup assertion.
 *
 * WHY THIS EXISTS (2026-08-11 incident):
 * Email-Ops authorizes a cross-app SERVICE caller by minting a synthetic principal
 * `federation:<actor client_id>` (AuthService.buildFederationPrincipal) — but that
 * principal still has to be an ACTIVE MEMBER of the target workspace like anyone
 * else. The allow-list env said `customer-ops` was welcome; the membership row did
 * not exist. Every Customer-Ops -> Email-Ops federated call 403'd, and the caller
 * degraded that into an EMPTY customer-360 email panel.
 *
 * So the seam was dead and it looked exactly like "this contact has no email
 * history". Nothing was red. Nothing alerted. THAT indistinguishability — not the
 * missing row — is the actual defect, and it is what this check exists to kill.
 *
 * WHAT IT DOES, and deliberately does not do:
 *   - REQUIRED pairs (env `EMAIL_OPS_FEDERATION_REQUIRED_WORKSPACES`) MUST have a
 *     principal row. Missing => ERROR log naming the exact actor/workspace pair,
 *     plus a `fail` health check. Loud, specific, actionable.
 *   - Every OTHER workspace missing a row => a single INFO line. A workspace that
 *     no cockpit federates into legitimately has no principal (e.g. fabrikam-design
 *     has no Customer-Ops mapping), so erroring there would just train people to
 *     ignore the check — the very disease we are treating.
 *   - Principal rows for actors NOT in the allow-list => WARN. Config and data
 *     disagree; the row is inert here but is a real trap elsewhere (see below).
 *
 * IT DOES NOT FAIL THE PROCESS. Refusing to boot over a membership row would turn
 * a degraded read surface into a total outage, and would have made the original
 * incident worse, not better. It reports; a human decides.
 *
 * ⚠️ WHY THIS IS NOT SIMPLY COPIED INTO PROJECT-OPS — two real exceptions found
 *    while auditing the estate, both of which a naive fail-closed check breaks:
 *
 *    1. Project-Ops has NO `federation:meeting-ops` row anywhere, and that is
 *       CORRECT. Its FederationActorGuard short-circuits the membership check for
 *       allow-listed actors, but ONLY on the ingest / sourceLifecycle routes.
 *       Asserting a row there would demand data the design does not want.
 *
 *    2. Project-Ops DOES carry `federation:customer-ops` rows even though
 *       `customer-ops` is not in PROJECT_OPS_FEDERATION_ACTORS. That path works
 *       only via the guard's fall-through to the membership check. Config and data
 *       disagree; making that fall-through fail-closed breaks Customer-Ops ->
 *       Project-Ops instantly.
 *
 *    Hence: assert only on pairs declared REQUIRED, warn on disagreement, and let
 *    each app opt in with its own required-list once its route semantics are known.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MembershipStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** One (actor, workspace) pair that must have an active principal row. */
export interface RequiredPrincipalPair {
  actor: string;
  /** Workspace id OR slug, exactly as written in the env. */
  workspace: string;
}

export interface FederationPrincipalFinding {
  actor: string;
  workspaceId: string;
  workspaceSlug: string;
  /** 'missing' = required but absent/inactive. 'unlisted-actor' = row for an actor not allow-listed. */
  kind: 'missing' | 'unlisted-actor';
  detail: string;
}

export interface FederationPrincipalStatus {
  checked: boolean;
  checkedAt: string | null;
  actors: string[];
  requiredPairs: RequiredPrincipalPair[];
  /** REQUIRED pairs that are absent or inactive — these are failures. */
  missingRequired: FederationPrincipalFinding[];
  /** Rows present for actors not in the allow-list — config/data disagreement. */
  unlistedActorRows: FederationPrincipalFinding[];
  /** Non-required workspaces without a row — informational, usually legitimate. */
  absentOptional: { actor: string; workspaceSlug: string }[];
  /** Set when the check itself could not run (DB down at boot, etc.). */
  error: string | null;
}

export const FEDERATION_PRINCIPAL_PREFIX = 'federation:';

/** Parse `EMAIL_OPS_FEDERATION_REQUIRED_WORKSPACES` — "actor:workspace,actor:workspace". */
export function parseRequiredPairs(raw: string | undefined | null): RequiredPrincipalPair[] {
  if (!raw) return [];
  const out: RequiredPrincipalPair[] = [];
  for (const entry of raw.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const idx = token.lastIndexOf(':');
    if (idx <= 0 || idx === token.length - 1) continue; // malformed → ignored, reported by caller
    out.push({ actor: token.slice(0, idx).trim(), workspace: token.slice(idx + 1).trim() });
  }
  return out.filter((p) => p.actor && p.workspace);
}

/** Parse `EMAIL_OPS_FEDERATION_ACTORS` (same shape AuthService uses). */
export function parseActors(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

@Injectable()
export class FederationPrincipalCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(FederationPrincipalCheck.name);

  private status: FederationPrincipalStatus = {
    checked: false,
    checkedAt: null,
    actors: [],
    requiredPairs: [],
    missingRequired: [],
    unlistedActorRows: [],
    absentOptional: [],
    error: null,
  };

  constructor(private readonly prisma: PrismaService) {}

  getStatus(): FederationPrincipalStatus {
    return this.status;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  /** Runs the audit and records it. Never throws — a boot-time DB blip must not
   *  take the app down; it is recorded as an error and surfaced in health. */
  async run(): Promise<FederationPrincipalStatus> {
    const actors = parseActors(process.env.EMAIL_OPS_FEDERATION_ACTORS);
    const requiredPairs = parseRequiredPairs(process.env.EMAIL_OPS_FEDERATION_REQUIRED_WORKSPACES);

    const base: FederationPrincipalStatus = {
      checked: true,
      checkedAt: new Date().toISOString(),
      actors,
      requiredPairs,
      missingRequired: [],
      unlistedActorRows: [],
      absentOptional: [],
      error: null,
    };

    if (actors.length === 0) {
      this.logger.log(
        'Federation principals: EMAIL_OPS_FEDERATION_ACTORS is empty — no cross-app actors accepted, nothing to assert.',
      );
      this.status = base;
      return base;
    }

    try {
      const workspaces = await this.prisma.workspace.findMany({ select: { id: true, slug: true } });
      const rows = await this.prisma.membership.findMany({
        where: { userKey: { startsWith: FEDERATION_PRINCIPAL_PREFIX } },
        select: { userKey: true, workspaceId: true, status: true },
      });

      const slugById = new Map(workspaces.map((w) => [w.id, w.slug]));
      const byPair = new Map<string, MembershipStatus>();
      for (const r of rows) byPair.set(`${r.userKey}|${r.workspaceId}`, r.status);

      // Resolve a required-pair workspace token (id OR slug) to a real workspace.
      const resolveWorkspace = (token: string) =>
        workspaces.find((w) => w.id === token || w.slug === token) ?? null;

      // 1) REQUIRED pairs — the assertion.
      for (const pair of requiredPairs) {
        if (!actors.includes(pair.actor)) {
          this.logger.warn(
            `Federation principals: required pair '${pair.actor}:${pair.workspace}' names an actor that is ` +
              `NOT in EMAIL_OPS_FEDERATION_ACTORS (${actors.join(', ') || 'none'}). The row would be inert — ` +
              `the token would be rejected before membership is ever consulted. Fix the allow-list or drop the pair.`,
          );
        }
        const ws = resolveWorkspace(pair.workspace);
        if (!ws) {
          base.missingRequired.push({
            actor: pair.actor,
            workspaceId: pair.workspace,
            workspaceSlug: '(unknown)',
            kind: 'missing',
            detail: `required workspace '${pair.workspace}' does not exist in this deployment`,
          });
          continue;
        }
        const key = `${FEDERATION_PRINCIPAL_PREFIX}${pair.actor}|${ws.id}`;
        const st = byPair.get(key);
        if (st !== MembershipStatus.ACTIVE) {
          base.missingRequired.push({
            actor: pair.actor,
            workspaceId: ws.id,
            workspaceSlug: ws.slug,
            kind: 'missing',
            detail: st ? `principal row exists but status=${st}` : 'no principal row',
          });
        }
      }

      // 2) Rows for actors nobody allow-listed — config/data disagreement.
      for (const r of rows) {
        const actor = r.userKey.slice(FEDERATION_PRINCIPAL_PREFIX.length);
        if (!actors.includes(actor)) {
          base.unlistedActorRows.push({
            actor,
            workspaceId: r.workspaceId,
            workspaceSlug: slugById.get(r.workspaceId) ?? '(unknown)',
            kind: 'unlisted-actor',
            detail: `membership row present but '${actor}' is not in EMAIL_OPS_FEDERATION_ACTORS — the row is inert here`,
          });
        }
      }

      // 3) Everything else missing — informational only.
      const requiredKeys = new Set(
        requiredPairs
          .map((p) => {
            const ws = resolveWorkspace(p.workspace);
            return ws ? `${p.actor}|${ws.id}` : null;
          })
          .filter((k): k is string => !!k),
      );
      for (const actor of actors) {
        for (const ws of workspaces) {
          if (requiredKeys.has(`${actor}|${ws.id}`)) continue;
          if (byPair.get(`${FEDERATION_PRINCIPAL_PREFIX}${actor}|${ws.id}`) === MembershipStatus.ACTIVE) continue;
          base.absentOptional.push({ actor, workspaceSlug: ws.slug });
        }
      }

      this.report(base);
      this.status = base;
      return base;
    } catch (err) {
      base.error = (err as Error).message;
      this.logger.error(
        `Federation principals: the startup check could NOT RUN (${base.error}). ` +
          `Treat federation health as UNKNOWN, not healthy.`,
      );
      this.status = base;
      return base;
    }
  }

  private report(s: FederationPrincipalStatus): void {
    if (s.missingRequired.length > 0) {
      for (const f of s.missingRequired) {
        this.logger.error(
          `FEDERATION PRINCIPAL MISSING — actor '${f.actor}' has no usable membership in workspace ` +
            `'${f.workspaceSlug}' (${f.workspaceId}): ${f.detail}. ` +
            `EVERY federated call from '${f.actor}' into that workspace WILL 403, and the calling app will ` +
            `most likely degrade it into an EMPTY panel rather than an error — so this will look like ` +
            `"no data", not like a fault. Fix: INSERT INTO memberships ("userKey","workspaceId",role,status) ` +
            `VALUES ('${FEDERATION_PRINCIPAL_PREFIX}${f.actor}','${f.workspaceId}','MEMBER','ACTIVE');`,
        );
      }
      this.logger.error(
        `Federation principals: ${s.missingRequired.length} REQUIRED pair(s) missing — see the errors above. ` +
          `email_ops_health reports 'fail' until they are seeded.`,
      );
    } else if (s.requiredPairs.length > 0) {
      this.logger.log(
        `Federation principals OK — all ${s.requiredPairs.length} required (actor, workspace) pair(s) have an ` +
          `ACTIVE principal row.`,
      );
    } else {
      this.logger.warn(
        `Federation principals: actors are allow-listed (${s.actors.join(', ')}) but ` +
          `EMAIL_OPS_FEDERATION_REQUIRED_WORKSPACES is EMPTY, so nothing is asserted. A missing principal ` +
          `would still fail silently. Declare the pairs you depend on, e.g. ` +
          `EMAIL_OPS_FEDERATION_REQUIRED_WORKSPACES=${s.actors[0]}:<workspace-slug>`,
      );
    }

    for (const f of s.unlistedActorRows) {
      this.logger.warn(
        `Federation principals: workspace '${f.workspaceSlug}' has a principal row for '${f.actor}', but ` +
          `'${f.actor}' is NOT in EMAIL_OPS_FEDERATION_ACTORS. ${f.detail}. Config and data disagree — ` +
          `either allow-list the actor or remove the row, but know which way round it is before you "fix" it.`,
      );
    }

    if (s.absentOptional.length > 0) {
      const sample = s.absentOptional
        .slice(0, 8)
        .map((a) => `${a.actor}->${a.workspaceSlug}`)
        .join(', ');
      this.logger.log(
        `Federation principals: ${s.absentOptional.length} non-required (actor, workspace) pair(s) have no row ` +
          `[${sample}${s.absentOptional.length > 8 ? ', …' : ''}]. This is normal for a workspace no cockpit ` +
          `federates into; add it to EMAIL_OPS_FEDERATION_REQUIRED_WORKSPACES if it SHOULD be reachable.`,
      );
    }
  }
}
