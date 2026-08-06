/**
 * Spaces types (the soft grouping layer: mailboxes + agents, switchable views).
 *
 * `SpaceView` is the snake_case wire projection the cockpit reads. The *Input
 * shapes are the service-level (camelCase) inputs the controller maps the
 * validated DTOs onto. Visibility is lowercased on the wire ('personal'|'team')
 * and the Prisma `SpaceVisibility` enum (PERSONAL|TEAM) inside the service.
 */

import { SpaceVisibility } from '@prisma/client';

/** The lowercase visibility the wire uses. */
export type SpaceVisibilityWire = 'personal' | 'team';

/** The Space wire projection (snake_case). */
export interface SpaceView {
  id: string;
  name: string;
  /** 'personal' (owner-only) | 'team' (workspace-shared). */
  visibility: SpaceVisibilityWire;
  /** Optional presentation hints the switcher renders. */
  color: string | null;
  icon: string | null;
  sort_order: number;
  /** The mailboxes that belong to this Space (the membership set). */
  mailbox_ids: string[];
  /** The agents that belong to this Space (the membership set). */
  agent_ids: string[];
}

/** Create input (service-level). visibility defaults to PERSONAL. */
export interface CreateSpaceInput {
  name: string;
  visibility?: SpaceVisibility;
  color?: string | null;
  icon?: string | null;
}

/**
 * Patch input (service-level). A field left `undefined` is unchanged; an explicit
 * `null` clears the (nullable) color/icon. Flipping `visibility` re-stamps the
 * owner: → TEAM clears ownerKey (shared); → PERSONAL claims it to the caller.
 */
export interface UpdateSpaceInput {
  name?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
  visibility?: SpaceVisibility;
}
