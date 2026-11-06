import { ForbiddenException } from '@nestjs/common';

export const NO_WORKSPACE_ACCESS_RESPONSE = {
  error: 'no_workspace_access',
  message: 'You are signed in but have no Email-Ops access. Contact your administrator.',
} as const;

/** A verified identity that has not been provisioned into an Email-Ops workspace. */
export class NoWorkspaceAccessException extends ForbiddenException {
  constructor() {
    super(NO_WORKSPACE_ACCESS_RESPONSE);
  }
}
