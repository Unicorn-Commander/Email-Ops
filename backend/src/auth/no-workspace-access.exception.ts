import { ForbiddenException } from '@nestjs/common';

export const NO_WORKSPACE_ACCESS_RESPONSE = {
  error: 'no_workspace_access',
  message:
    'Your account is verified but has no workspace in Email-Ops yet. Ask your workspace admin for an invite.',
} as const;

/** A verified identity that has not been provisioned into an Email-Ops workspace. */
export class NoWorkspaceAccessException extends ForbiddenException {
  constructor() {
    super(NO_WORKSPACE_ACCESS_RESPONSE);
  }
}
