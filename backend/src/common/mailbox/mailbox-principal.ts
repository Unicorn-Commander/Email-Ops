import { AsyncLocalStorage } from 'node:async_hooks';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { defer, Observable } from 'rxjs';

/** The request-local mailbox restriction carried by a PAT principal. */
export interface MailboxPrincipalScope {
  /** Non-empty because an empty PAT allowlist means unrestricted legacy reach. */
  mailboxIds: readonly string[];
}

const mailboxPrincipalStorage = new AsyncLocalStorage<MailboxPrincipalScope>();

/** Read the authenticated PAT's mailbox restriction from the current request. */
export function currentMailboxPrincipalScope(): MailboxPrincipalScope | undefined {
  return mailboxPrincipalStorage.getStore();
}

/** Injectable seam for unit tests and non-HTTP callers that need request parity. */
export function withMailboxPrincipalScope<T>(
  mailboxIds: readonly string[],
  callback: () => T,
): T {
  return mailboxPrincipalStorage.run({ mailboxIds }, callback);
}

/**
 * Carry the PAT's mailbox allowlist from the authenticated principal into every
 * service call made during the request. The scope is intentionally request-local:
 * a user may present different PATs concurrently, and an empty list remains the
 * backwards-compatible unrestricted PAT shape.
 */
@Injectable()
export class MailboxPrincipalInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const pat = request?.user?.__patAuth as { mailboxIds?: unknown } | undefined;
    if (!pat || !Array.isArray(pat.mailboxIds) || pat.mailboxIds.length === 0) {
      return next.handle();
    }

    const mailboxIds = pat.mailboxIds.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (mailboxIds.length === 0) return next.handle();

    // Nest subscribes to the returned observable after interceptors have run;
    // defer ensures the handler and all of its awaited service calls are created
    // inside the AsyncLocalStorage context.
    return defer(() =>
      mailboxPrincipalStorage.run({ mailboxIds }, () => next.handle()),
    );
  }
}
