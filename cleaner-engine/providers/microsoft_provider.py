"""
Microsoft 365 provider - uses MSAL for auth and Microsoft Graph API for mail.
"""

import time
import base64
import logging
from datetime import datetime, timezone
from typing import List, Optional, Tuple, Dict, Any

import requests

try:
    import msal
except ImportError:
    msal = None  # Optional dependency; error raised on use

logger = logging.getLogger(__name__)

from providers.base import (
    EmailProvider,
    EmailProfile,
    EmailMessage,
    EmailAttachment,
    InboxStats,
    ProviderType,
)
from providers.mail_client import (
    Address,
    DraftResult,
    MailAttachment,
    SendResult,
    ThreadMessage,
    ThreadSummary,
    clamp_limit,
    to_iso8601,
)

GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
SCOPES = ['Mail.ReadWrite', 'Mail.Send', 'User.Read']

# Canonical folder -> Graph well-known mailFolder id.
_FOLDER_ID = {
    'inbox': 'inbox',
    'sent': 'sentitems',
    'drafts': 'drafts',
    'trash': 'deleteditems',
    'spam': 'junkemail',
    'archive': 'archive',
}


def _poll_result(refs: List[dict], since_iso: Optional[str]) -> dict:
    """Assemble the frozen poll-inbound shape from mapped inbox message refs.

    Mirrors the sovereign James ``pollInbound`` cursor logic exactly: on baseline
    (``since_iso`` is None) stamp the newest ``received_at`` (or NOW when the inbox
    is empty — never a null cursor) and return no backlog; otherwise return the
    strictly-newer messages ascending and advance the cursor to the max seen.
    ISO-8601 UTC strings sort chronologically, so every compare is lexical.
    """
    max_cursor = since_iso or ''
    for r in refs:
        if r['received_at'] > max_cursor:
            max_cursor = r['received_at']
    if since_iso is None:
        return {
            'cursor': max_cursor or datetime.now(timezone.utc).isoformat(),
            'new_messages': [],
        }
    new_messages = sorted(
        (r for r in refs if r['received_at'] > since_iso),
        key=lambda r: r['received_at'],
    )
    return {'cursor': max_cursor or since_iso, 'new_messages': new_messages}


class MicrosoftGraphProvider(EmailProvider):
    """Microsoft 365 / Graph API provider."""

    provider_type = ProviderType.MICROSOFT

    def __init__(
        self,
        client_id: str = '',
        client_secret: str = '',
        tenant_id: str = 'common',
    ):
        if msal is None:
            raise ImportError('msal package is required for Microsoft provider: pip install msal')

        self.client_id = client_id
        self.client_secret = client_secret
        self.tenant_id = tenant_id
        self._access_token: Optional[str] = None
        self._msal_app = msal.ConfidentialClientApplication(
            client_id=self.client_id,
            client_credential=self.client_secret,
            authority=f'https://login.microsoftonline.com/{self.tenant_id}',
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict:
        return {
            'Authorization': f'Bearer {self._access_token}',
            'Content-Type': 'application/json',
        }

    def _auth_headers(self) -> dict:
        return {'Authorization': f'Bearer {self._access_token}'}

    def _graph_get(self, path: str, params: dict = None) -> dict:
        url = f'{GRAPH_BASE}{path}'
        # GETs are idempotent, so a 429 is retried after Retry-After (bounded).
        # Write verbs must NOT get this treatment — a retried POST could
        # double-send mail — they keep the sleep-and-raise in _handle_throttle.
        for attempt in range(3):
            resp = requests.get(url, headers=self._headers(), params=params, timeout=30)
            if resp.status_code == 429 and attempt < 2:
                time.sleep(int(resp.headers.get('Retry-After', 5)))
                continue
            self._handle_throttle(resp)
            resp.raise_for_status()
            return resp.json()

    def _graph_post(self, path: str, json_body: dict = None) -> requests.Response:
        url = f'{GRAPH_BASE}{path}'
        resp = requests.post(url, headers=self._headers(), json=json_body, timeout=30)
        self._handle_throttle(resp)
        return resp

    def _graph_delete(self, path: str) -> requests.Response:
        url = f'{GRAPH_BASE}{path}'
        resp = requests.delete(url, headers=self._headers(), timeout=30)
        self._handle_throttle(resp)
        return resp

    def _graph_patch(self, path: str, json_body: dict = None) -> requests.Response:
        url = f'{GRAPH_BASE}{path}'
        resp = requests.patch(url, headers=self._headers(), json=json_body, timeout=30)
        self._handle_throttle(resp)
        return resp

    def _handle_throttle(self, resp: requests.Response):
        """Handle 429 throttling with Retry-After."""
        if resp.status_code == 429:
            retry_after = int(resp.headers.get('Retry-After', 5))
            time.sleep(retry_after)
            # Re-raise so caller can retry
            resp.raise_for_status()

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def authenticate(self, credentials: dict) -> bool:
        """Authenticate using tokens from MSAL.
        credentials dict should have 'access_token' or 'refresh_token'.
        """
        if 'access_token' in credentials:
            self._access_token = credentials['access_token']
            return True

        # Try to acquire token using refresh token / cache
        accounts = self._msal_app.get_accounts()
        if accounts:
            result = self._msal_app.acquire_token_silent(
                scopes=[f'https://graph.microsoft.com/{s}' for s in SCOPES],
                account=accounts[0],
            )
            if result and 'access_token' in result:
                self._access_token = result['access_token']
                return True

        return False

    def get_oauth_url(self, redirect_uri: str) -> str:
        return self._msal_app.get_authorization_request_url(
            scopes=[f'https://graph.microsoft.com/{s}' for s in SCOPES],
            redirect_uri=redirect_uri,
        )

    def exchange_code(self, code: str, redirect_uri: str) -> dict:
        result = self._msal_app.acquire_token_by_authorization_code(
            code=code,
            scopes=[f'https://graph.microsoft.com/{s}' for s in SCOPES],
            redirect_uri=redirect_uri,
        )
        if 'access_token' not in result:
            raise ValueError(f"Token exchange failed: {result.get('error_description', result.get('error'))}")

        self._access_token = result['access_token']
        return {
            'access_token': result['access_token'],
            'refresh_token': result.get('refresh_token', ''),
            'id_token': result.get('id_token', ''),
            'expires_in': result.get('expires_in', 3600),
        }

    # ------------------------------------------------------------------
    # Profile & Stats
    # ------------------------------------------------------------------

    def get_profile(self) -> EmailProfile:
        me = self._graph_get('/me')
        # Get mailbox settings for message count
        folder = self._graph_get('/me/mailFolders/inbox')
        return EmailProfile(
            email=me.get('mail', me.get('userPrincipalName', '')),
            display_name=me.get('displayName', ''),
            total_messages=folder.get('totalItemCount', 0),
        )

    def get_inbox_stats(self) -> InboxStats:
        inbox = self._graph_get('/me/mailFolders/inbox')
        junk = self._graph_get('/me/mailFolders/junkemail')

        stats = InboxStats(
            total_messages=inbox.get('totalItemCount', 0),
            unread_count=inbox.get('unreadItemCount', 0),
            promotional_count=junk.get('totalItemCount', 0),
        )

        return stats

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    # PidTagMessageSize — the MAPI extended property carrying the message's size in
    # bytes. Graph does not expose size on the message resource itself, so we
    # $expand this property to report REAL sizes instead of a fake 0.
    _SIZE_PROPERTY = "singleValueExtendedProperties($filter=id eq 'Integer 0x0E08')"

    @staticmethod
    def _message_size_bytes(msg: dict) -> Optional[int]:
        """PidTagMessageSize from an expanded extended property, or None.

        None means UNKNOWN (property missing / expand not honoured) — never a
        fake 0, so the backend can tell "no size" from "zero bytes".
        """
        for prop in msg.get('singleValueExtendedProperties') or []:
            # Graph normalises the id casing ('Integer 0xe08' vs 'Integer 0x0E08').
            prop_id = str(prop.get('id') or '').lower().replace(' ', '')
            if prop_id in ('integer0xe08', 'integer0x0e08'):
                try:
                    return int(prop.get('value'))
                except (TypeError, ValueError):
                    return None
        return None

    def list_messages(
        self,
        query: str = '',
        max_results: int = 100,
        page_token: Optional[str] = None,
        folder: Optional[str] = None,
    ) -> Tuple[List[EmailMessage], Optional[str]]:
        params: Dict[str, Any] = {
            '$top': min(max_results, 50),  # Graph limit per page
            '$select': 'id,conversationId,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,importance,categories',
            '$orderby': 'receivedDateTime desc',
            '$expand': self._SIZE_PROPERTY,
        }

        # Same honesty gate as list_threads: an unmappable query RAISES instead
        # of silently fetching the whole (unfiltered) mailbox — the live bug had
        # plan_cleanup review the newest 500 messages of ALL mail and mark the
        # user's own correspondence "safe".
        user_q = (query or '').strip()
        client_sort = False
        if user_q:
            odata = self._thread_search_filter(user_q)
            if odata is None:
                raise ValueError(
                    f"microsoft search not supported for query {user_q!r} — "
                    "refusing unfiltered results"
                )
            if odata:
                params['$filter'] = odata
                # Graph 400s when $orderby names a property not in $filter (see
                # get_thread), so drop it and sort the page client-side instead.
                params.pop('$orderby', None)
                client_sort = True
            else:
                # Pure free text: use $search instead of $filter. Graph rejects
                # $search combined with $orderby, and expects quoted terms —
                # escape embedded double quotes so the term stays one literal.
                params.pop('$orderby', None)
                # Graph silently DROPS the singleValueExtendedProperties
                # $expand under $search: rows come back (no error) but without
                # the property — observed live as every $search row sized 0
                # while the identical expand returned real sizes on the
                # $filter path. Don't send the dead-weight expand; these rows
                # are honestly size-unknown (size_bytes=None) and the backend
                # enriches them per message via get_message, whose expand
                # works standalone.
                params.pop('$expand', None)
                escaped = user_q.replace('"', '\\"')
                params['$search'] = f'"{escaped}"'

        # Scope to a mail folder the Graph-correct way (an OData path segment),
        # rather than a $filter — /me/messages spans every folder incl. Sent.
        if folder:
            folder_id = _FOLDER_ID.get(folder, folder)
            endpoint = f'/me/mailFolders/{folder_id}/messages'
        else:
            endpoint = '/me/messages'

        if page_token:
            # page_token is a full URL for Graph API (it carries the same query
            # options, so filter/search mode is preserved across pages).
            resp = requests.get(page_token, headers=self._headers(), timeout=30)
            resp.raise_for_status()
            data = resp.json()
        else:
            data = self._graph_get(endpoint, params=params)

        rows = data.get('value', [])
        if client_sort:
            # receivedDateTime is ISO-8601, so a lexical sort is chronological.
            rows = sorted(rows, key=lambda m: m.get('receivedDateTime') or '', reverse=True)

        messages = []
        for msg in rows:
            from_addr = ''
            if msg.get('from', {}).get('emailAddress'):
                from_addr = msg['from']['emailAddress'].get('address', '')

            messages.append(EmailMessage(
                id=msg['id'],
                thread_id=msg.get('conversationId', ''),
                subject=msg.get('subject', ''),
                sender=from_addr,
                date=msg.get('receivedDateTime', ''),
                snippet=msg.get('bodyPreview', ''),
                labels=list(msg.get('categories') or []),
                is_read=msg.get('isRead', False),
                is_starred=msg.get('importance', '') == 'high',
                has_attachments=msg.get('hasAttachments', False),
                size_bytes=self._message_size_bytes(msg),
                raw_data=msg,
            ))

        next_link = data.get('@odata.nextLink')
        return messages, next_link

    def get_message(self, message_id: str, format: str = 'metadata') -> EmailMessage:
        select = (
            'id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,'
            'importance,categories,hasAttachments,bodyPreview,internetMessageHeaders'
        )
        if format == 'full':
            select += ',body'

        msg = self._graph_get(
            f'/me/messages/{message_id}',
            params={'$select': select, '$expand': self._SIZE_PROPERTY},
        )

        from_addr = ''
        if msg.get('from', {}).get('emailAddress'):
            from_addr = msg['from']['emailAddress'].get('address', '')

        to_addrs = []
        for r in msg.get('toRecipients', []):
            if r.get('emailAddress'):
                to_addrs.append(r['emailAddress'].get('address', ''))

        headers: Dict[str, str] = {}
        for h in msg.get('internetMessageHeaders') or []:
            name = h.get('name')
            value = h.get('value')
            if name and value is not None:
                headers[str(name)] = str(value)

        email = EmailMessage(
            id=msg['id'],
            thread_id=msg.get('conversationId', ''),
            subject=msg.get('subject', ''),
            sender=from_addr,
            recipient=', '.join(to_addrs),
            date=msg.get('receivedDateTime', ''),
            snippet=msg.get('bodyPreview', ''),
            labels=list(msg.get('categories') or []),
            is_read=msg.get('isRead', False),
            is_starred=msg.get('importance', '') == 'high',
            has_attachments=msg.get('hasAttachments', False),
            size_bytes=self._message_size_bytes(msg),
            headers=headers,
            raw_data=msg,
        )

        if format == 'full' and msg.get('body'):
            content_type = msg['body'].get('contentType', 'text')
            content = msg['body'].get('content', '')
            if content_type == 'html':
                email.body_html = content
            else:
                email.body_text = content

        return email

    # ------------------------------------------------------------------
    # Unified mail client (threads / thread / send)
    # ------------------------------------------------------------------

    @staticmethod
    def _address(email_address: Optional[dict]) -> Optional[Address]:
        if not email_address:
            return None
        addr = email_address.get('address', '')
        if not addr:
            return None
        return Address(address=addr, name=email_address.get('name') or None)

    def _account_address(self) -> str:
        """The signed-in user's primary SMTP address (best effort)."""
        try:
            me = self._graph_get('/me', params={'$select': 'mail,userPrincipalName'})
            return (me.get('mail') or me.get('userPrincipalName') or '').lower()
        except Exception:
            return ''

    def list_threads(
        self,
        folder: str = 'inbox',
        limit: int = 50,
        query: str = '',
        page_token: Optional[str] = None,
    ) -> Tuple[List[ThreadSummary], Optional[str]]:
        """List threads (conversations) for a folder, newest first.

        Returns ``(summaries, next_page_token)``. Graph paginates with an opaque
        ``@odata.nextLink`` URL (used as page_token) — never a numeric offset.

        Search: when ``query`` is set, only a small set of mappable operators is
        applied (``from:``, ``is:unread``, ``has:attachment``). Unsupported query
        shapes raise ``ValueError`` with a clear message so the route can surface
        an honest "unsupported" signal rather than silently returning unfiltered
        results.
        """
        limit = clamp_limit(limit)
        folder_id = _FOLDER_ID.get(folder, 'inbox')
        user_q = (query or '').strip()

        # Graph page_token is a full nextLink URL.
        if page_token:
            resp = requests.get(page_token, headers=self._headers(), timeout=30)
            resp.raise_for_status()
            data = resp.json()
        else:
            # Over-fetch a little so grouping by conversation still yields ~limit threads.
            params: Dict[str, Any] = {
                '$top': min(limit * 2, 200),
                '$select': 'id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,flag',
                '$orderby': 'receivedDateTime desc',
            }
            if user_q:
                odata = self._thread_search_filter(user_q)
                if odata is None:
                    raise ValueError(
                        f"microsoft search not supported for query {user_q!r} — "
                        "refusing unfiltered results"
                    )
                if odata:
                    params['$filter'] = odata
                elif odata == '' and user_q:
                    # Pure free text: use $search instead of $filter.
                    # Graph rejects $search combined with $orderby.
                    params.pop('$orderby', None)
                    # VERIFY-AT-GATE: Graph $search expects quoted search terms.
                    params['$search'] = f'"{user_q}"'
            data = self._graph_get(f'/me/mailFolders/{folder_id}/messages', params=params)

        threads: Dict[str, ThreadSummary] = {}
        order: List[str] = []
        seen_participants: Dict[str, set] = {}

        for msg in data.get('value', []):
            conv = msg.get('conversationId') or msg.get('id', '')
            if conv not in threads:
                if len(order) >= limit:
                    continue
                order.append(conv)
                threads[conv] = ThreadSummary(
                    id=conv,
                    subject=msg.get('subject') or None,
                    last_message_at=to_iso8601(msg.get('receivedDateTime')),
                    last_snippet=msg.get('bodyPreview') or None,
                    message_count=0,
                    unread=False,
                )
                seen_participants[conv] = set()

            summary = threads[conv]
            summary.message_count += 1
            if not msg.get('isRead', True):
                summary.unread = True
            if (msg.get('flag') or {}).get('flagStatus') == 'flagged':
                summary.flagged = True

            for candidate in [msg.get('from', {}).get('emailAddress')] + [
                r.get('emailAddress') for r in msg.get('toRecipients', [])
            ]:
                addr = self._address(candidate)
                if addr and addr.address.lower() not in seen_participants[conv]:
                    seen_participants[conv].add(addr.address.lower())
                    summary.participants.append(addr)

        next_link = data.get('@odata.nextLink')
        return [threads[c] for c in order], next_link

    def _thread_search_filter(self, query: str) -> Optional[str]:
        """Map a small Gmail-ish query subset to Graph $filter, or None if unsupported.

        Returns '' when the query is empty or pure free text (no operators).
        Returns None when the query contains unsupported or mixed operators.
        """
        q = (query or '').strip()
        if not q:
            return ''
        
        # Check if query contains any operator-like tokens
        # Supported operators: from:, is:, has:, older_than:, category:
        import re
        # Look for word-boundary followed by operator:
        has_operators = bool(re.search(r'\b(?:from|is|has|older_than|category):', q))
        
        if has_operators:
            # Try to translate
            translated = self.translate_query(q)
            if translated:
                return translated
            # If translate_query returned '' but we had operators, it's unsupported
            return None
        else:
            # Pure free text
            return ''

    def get_thread(self, thread_id: str) -> List[ThreadMessage]:
        """Return the messages of one conversation in chronological order."""
        account = self._account_address()
        # OData escapes a single quote inside a string literal by doubling it.
        # ``thread_id`` is caller-supplied, so escape before interpolating to
        # prevent breaking out of the literal ($filter injection).
        safe_thread_id = thread_id.replace("'", "''")
        params = {
            '$filter': f"conversationId eq '{safe_thread_id}'",
            # ``body`` gives the /mail READER the full message (text/HTML), not
            # just bodyPreview — the reader-only exception to the cleaner's
            # metadata-only rail. Fetched in the same $filter call, so no extra
            # round-trips per thread.
            '$select': 'id,conversationId,subject,from,toRecipients,sentDateTime,receivedDateTime,isDraft,bodyPreview,body,hasAttachments',
            # NOTE: attachment METADATA is fetched per-message below (only when
            # hasAttachments) — NOT via $expand here: Graph 400s on
            # $expand=attachments over a $filter'd /me/messages collection, and
            # that would break the whole thread read (bodies included).
            # NOTE: deliberately NO $orderby. Microsoft Graph returns 400 Bad
            # Request when $orderby names a property other than the one in
            # $filter (here we filter on conversationId), so we sort the
            # conversation chronologically client-side below instead.
            '$top': 100,
        }
        data = self._graph_get('/me/messages', params=params)

        messages = data.get('value', [])
        # receivedDateTime is ISO-8601, so a lexical sort is chronological (asc).
        messages.sort(key=lambda m: m.get('receivedDateTime') or '')

        out: List[ThreadMessage] = []
        for msg in messages:
            sender = self._address(msg.get('from', {}).get('emailAddress'))
            if msg.get('isDraft'):
                direction = 'draft'
            elif account and sender and sender.address.lower() == account:
                direction = 'sent'
            else:
                direction = 'received'
            body_text: Optional[str] = None
            body_html: Optional[str] = None
            body = msg.get('body') or {}
            content = body.get('content')
            if content:
                if (body.get('contentType') or 'text').lower() == 'html':
                    body_html = content
                else:
                    body_text = content
            out.append(ThreadMessage(
                id=msg.get('id', ''),
                thread_id=msg.get('conversationId', thread_id),
                sender=sender,
                to=[a for a in (self._address(r.get('emailAddress')) for r in msg.get('toRecipients', [])) if a],
                subject=msg.get('subject') or None,
                sent_at=to_iso8601(msg.get('sentDateTime') or msg.get('receivedDateTime')),
                preview=msg.get('bodyPreview') or None,
                direction=direction,
                body_text=body_text,
                body_html=body_html,
                attachments=self._message_attachments(msg),
            ))
        return out

    def _message_attachments(self, msg: dict) -> List[MailAttachment]:
        """Attachment METADATA for one message (no bytes), fetched only when the
        message actually has attachments. Kept off the thread $filter query
        because Graph 400s on $expand=attachments there. Degrade-clean: [] on any
        error — attachments are a nice-to-have, never a reason to lose the body."""
        if not msg.get('hasAttachments'):
            return []
        try:
            data = self._graph_get(
                f"/me/messages/{msg['id']}/attachments",
                params={'$select': 'id,name,contentType,size,isInline'},
            )
        except Exception as exc:  # noqa: BLE001 - degrade clean
            logger.warning("microsoft attachments fetch failed for %s: %s", msg.get('id'), exc)
            return []
        out: List[MailAttachment] = []
        for att in data.get('value', []):
            if not att.get('id'):
                continue
            out.append(MailAttachment(
                id=att.get('id', ''),
                filename=att.get('name') or None,
                mime_type=att.get('contentType') or None,
                size=int(att.get('size') or 0),
                is_inline=bool(att.get('isInline')),
            ))
        return out

    @staticmethod
    def _graph_file_attachments(attachments: Optional[List[dict]]) -> List[Dict[str, Any]]:
        """Build Graph fileAttachment objects (contentBytes = base64 STRING).
        Inline in sendMail/createDraft; Graph caps inline contentBytes at ~3MB."""
        out: List[Dict[str, Any]] = []
        for att in (attachments or []):
            out.append({
                '@odata.type': '#microsoft.graph.fileAttachment',
                'name': att.get('filename') or 'attachment',
                'contentType': att.get('mime_type') or 'application/octet-stream',
                'contentBytes': base64.b64encode(att.get('data') or b'').decode('ascii'),
            })
        return out

    def poll_inbound(self, since_iso: Optional[str]) -> dict:
        """Detect NEW inbox mail past a high-water cursor (external-mailbox parity
        with the sovereign James ``pollInbound``).

        BASELINE (``since_iso`` is None): capture the cursor (the newest inbox
        ``received_at``, or NOW for an empty inbox so the cursor is never null) and
        process NO backlog. INCREMENTAL (``since_iso`` set): ``new_messages`` =
        messages strictly newer than the cursor, ascending; the returned cursor
        advances to the max ``received_at`` seen (else ``since_iso``). ISO-8601 UTC
        strings sort chronologically, so the compare is lexical (matches James).

        EFFICIENCY: on an incremental poll Graph server-side filters with
        ``$filter=receivedDateTime gt <since_iso>`` (the ISO literal is unquoted for
        a datetimeoffset); on baseline fetch only the newest one to stamp the cursor.

        Degrade-clean: any provider error -> {'cursor': since_iso, 'new_messages': []}.
        """
        try:
            params: Dict[str, Any] = {
                '$select': (
                    'id,conversationId,subject,from,toRecipients,'
                    'receivedDateTime,internetMessageHeaders'
                ),
                '$orderby': 'receivedDateTime desc',
                '$top': 50,
            }
            if since_iso:
                # Graph accepts the ISO literal unquoted for a datetimeoffset.
                params['$filter'] = f'receivedDateTime gt {since_iso}'
            else:
                params['$top'] = 1
            data = self._graph_get('/me/mailFolders/inbox/messages', params=params)

            refs: List[dict] = []
            for msg in data.get('value', []):
                received_at = to_iso8601(msg.get('receivedDateTime'))
                if not received_at:
                    continue
                sender = self._address(msg.get('from', {}).get('emailAddress'))
                to_addresses = [
                    a.address
                    for a in (self._address(r.get('emailAddress')) for r in msg.get('toRecipients', []))
                    if a
                ]
                refs.append({
                    'thread_id': msg.get('conversationId', ''),
                    'from_address': sender.address if sender else None,
                    'to_addresses': to_addresses,
                    'subject': msg.get('subject') or None,
                    'received_at': received_at,
                    # Present + non-empty header ⇒ an agent runtime auto-sent this.
                    'agent_autoreply': any(
                        str(h.get('name') or '').lower() == 'x-uc-agent-autoreply'
                        and str(h.get('value') or '').strip()
                        for h in (msg.get('internetMessageHeaders') or [])
                    ),
                })

            return _poll_result(refs, since_iso)
        except Exception:  # noqa: BLE001 - degrade clean like the other read routes
            return {'cursor': since_iso, 'new_messages': []}

    def send_message(
        self,
        from_addr: str,
        to_addr: str,
        subject: str,
        body: str,
        in_reply_to_thread_id: Optional[str] = None,
        cc: Optional[List[str]] = None,
        bcc: Optional[List[str]] = None,
        body_html: Optional[str] = None,
        attachments: Optional[List[dict]] = None,
    ) -> SendResult:
        """Send a new message, or a THREADED reply when a reply target is given.

        With ``in_reply_to_thread_id`` set, the reply is built server-side via
        ``POST /me/messages/{id}/createReply`` so Graph stamps In-Reply-To /
        References and Outlook threads it into the conversation; we then PATCH
        the draft's body/recipients and ``/send`` it. Without a target (or when
        the target cannot be resolved) we fall back to the plain
        ``/me/sendMail`` lane, which cannot thread.
        """
        if in_reply_to_thread_id:
            target_id = self._resolve_reply_target(in_reply_to_thread_id)
            if target_id:
                reply = self._send_reply(
                    target_id=target_id,
                    in_reply_to_thread_id=in_reply_to_thread_id,
                    from_addr=from_addr,
                    to_addr=to_addr,
                    subject=subject,
                    body=body,
                    cc=cc,
                    bcc=bcc,
                    body_html=body_html,
                    attachments=attachments,
                )
                if reply is not None:
                    return reply
            # Unresolvable / un-creatable reply target: degrade to the plain
            # send lane (previous behavior) rather than refusing to send.

        message: Dict[str, Any] = {
            'subject': subject or '',
            'body': {
                'contentType': 'HTML' if body_html else 'Text',
                'content': body_html if body_html else (body or ''),
            },
            'toRecipients': [{'emailAddress': {'address': to_addr}}],
        }
        if cc:
            message['ccRecipients'] = [{'emailAddress': {'address': a}} for a in cc if a]
        if bcc:
            message['bccRecipients'] = [{'emailAddress': {'address': a}} for a in bcc if a]
        if from_addr:
            message['from'] = {'emailAddress': {'address': from_addr}}
        file_atts = self._graph_file_attachments(attachments)
        if file_atts:
            message['attachments'] = file_atts

        resp = self._graph_post('/me/sendMail', json_body={'message': message, 'saveToSentItems': True})
        if resp.status_code in (200, 202):
            # sendMail returns 202 Accepted with no body / no id.
            return SendResult(
                accepted=True,
                provider_message_id=None,
                thread_id=in_reply_to_thread_id,
            )
        return SendResult(accepted=False, reason=f'graph_status_{resp.status_code}')

    def _resolve_reply_target(self, reply_ref: str) -> Optional[str]:
        """Resolve a caller-supplied reply reference to a Graph MESSAGE id.

        Callers hand us whatever they stored: sometimes a message id, more
        often the conversationId our own thread listings expose. Try the
        direct message read first; otherwise treat it as a conversationId and
        pick the newest message of that conversation. Returns None when
        neither resolves.
        """
        try:
            data = self._graph_get(f'/me/messages/{reply_ref}', params={'$select': 'id'})
            if data.get('id'):
                return data['id']
        except Exception:
            pass
        # OData escapes a single quote inside a string literal by doubling it
        # (same $filter injection guard as get_thread).
        safe_ref = reply_ref.replace("'", "''")
        try:
            data = self._graph_get('/me/messages', params={
                '$filter': f"conversationId eq '{safe_ref}'",
                '$select': 'id,receivedDateTime',
                # NOTE: deliberately NO $orderby -- Graph 400s when $orderby
                # names a property other than the filtered one, so we sort
                # client-side (same as get_thread).
                '$top': 50,
            })
        except Exception:
            return None
        messages = data.get('value', [])
        if not messages:
            return None
        # receivedDateTime is ISO-8601, so a lexical sort is chronological.
        messages.sort(key=lambda m: m.get('receivedDateTime') or '')
        return messages[-1].get('id')

    def _send_reply(
        self,
        target_id: str,
        in_reply_to_thread_id: str,
        from_addr: str,
        to_addr: str,
        subject: str,
        body: str,
        cc: Optional[List[str]] = None,
        bcc: Optional[List[str]] = None,
        body_html: Optional[str] = None,
        attachments: Optional[List[dict]] = None,
    ) -> Optional[SendResult]:
        """createReply -> PATCH -> (attach) -> send.

        Returns None when the reply draft cannot even be created (the caller
        then falls back to plain sendMail); past that point failures return an
        accepted=False SendResult instead, because falling back after a
        partially-executed reply could double-send.
        """
        create = self._graph_post(f'/me/messages/{target_id}/createReply')
        if create.status_code not in (200, 201):
            return None
        try:
            draft = create.json() or {}
        except ValueError:
            draft = {}
        draft_id = draft.get('id')
        if not draft_id:
            return None

        patch_body: Dict[str, Any] = {
            'body': {
                'contentType': 'HTML' if body_html else 'Text',
                'content': body_html if body_html else (body or ''),
            },
            # createReply addresses the SENDER of the target message; a bump
            # replies to our own sent message, so always pin the recipients
            # the caller asked for.
            'toRecipients': [{'emailAddress': {'address': to_addr}}],
        }
        if subject:
            patch_body['subject'] = subject
        if cc:
            patch_body['ccRecipients'] = [{'emailAddress': {'address': a}} for a in cc if a]
        if bcc:
            patch_body['bccRecipients'] = [{'emailAddress': {'address': a}} for a in bcc if a]
        if from_addr:
            account = self._account_address()
            if account and from_addr.strip().lower() != account:
                # Same SendAs semantics as create_draft: set it explicitly so
                # Graph can accept or refuse EXPLICITLY.
                patch_body['from'] = {'emailAddress': {'address': from_addr}}

        patched = self._graph_patch(f'/me/messages/{draft_id}', json_body=patch_body)
        if patched.status_code != 200:
            # Best-effort cleanup of the orphan reply draft.
            try:
                self._graph_delete(f'/me/messages/{draft_id}')
            except Exception:
                pass
            return SendResult(accepted=False, reason=f'graph_reply_patch_{patched.status_code}')
        try:
            updated = patched.json() or {}
        except ValueError:
            updated = {}

        # Attach files to the reply draft BEFORE sending. A failed attachment
        # POST cleans up the draft and refuses (never send a reply missing the
        # file the user attached) — symmetric with the PATCH-failure path.
        for file_att in self._graph_file_attachments(attachments):
            att_resp = self._graph_post(f'/me/messages/{draft_id}/attachments', json_body=file_att)
            if att_resp.status_code not in (200, 201):
                try:
                    self._graph_delete(f'/me/messages/{draft_id}')
                except Exception:
                    pass
                return SendResult(accepted=False, reason=f'graph_reply_attach_{att_resp.status_code}')

        sent = self._graph_post(f'/me/messages/{draft_id}/send')
        if sent.status_code not in (200, 202):
            return SendResult(accepted=False, reason=f'graph_reply_send_{sent.status_code}')
        # NB: Graph message ids are folder-scoped and can change once the sent
        # message lands in Sent Items; conversationId is the durable thread key.
        return SendResult(
            accepted=True,
            provider_message_id=updated.get('id') or draft_id,
            thread_id=updated.get('conversationId') or in_reply_to_thread_id,
        )

    def create_draft(
        self,
        from_addr: str,
        to_addr: str,
        subject: str,
        body: str,
        in_reply_to_thread_id: Optional[str] = None,
        cc: Optional[List[str]] = None,
        bcc: Optional[List[str]] = None,
        body_html: Optional[str] = None,
        attachments: Optional[List[dict]] = None,
    ) -> DraftResult:
        """Create a REAL draft in the mailbox's Drafts folder (POST /me/messages).

        Nothing is sent. Graph files a message created this way under
        ``isDraft: true`` in Drafts, so it shows up in the user's own Outlook
        exactly like a draft they typed — which is the point: the human reviews
        and approves in their own client.

        NOTE on ``from``: Graph ignores/rejects a ``from`` that is not the
        authenticated mailbox (or a mailbox it has SendAs rights on). We only
        set it when it differs from the account address, and a Graph refusal is
        surfaced as created:False rather than silently dropping the identity.
        """
        message: Dict[str, Any] = {
            'subject': subject or '',
            'body': {
                'contentType': 'HTML' if body_html else 'Text',
                'content': body_html if body_html else (body or ''),
            },
            'toRecipients': [{'emailAddress': {'address': to_addr}}],
        }
        if cc:
            message['ccRecipients'] = [{'emailAddress': {'address': a}} for a in cc if a]
        if bcc:
            message['bccRecipients'] = [{'emailAddress': {'address': a}} for a in bcc if a]

        account = self._account_address()
        if from_addr and account and from_addr.strip().lower() != account:
            # Sending/drafting AS another mailbox needs an explicit SendAs grant;
            # set it so Graph can accept or refuse EXPLICITLY.
            message['from'] = {'emailAddress': {'address': from_addr}}
        file_atts = self._graph_file_attachments(attachments)
        if file_atts:
            message['attachments'] = file_atts

        resp = self._graph_post('/me/messages', json_body=message)
        if resp.status_code in (200, 201):
            data = resp.json()
            return DraftResult(
                created=True,
                draft_id=data.get('id'),
                thread_id=data.get('conversationId') or in_reply_to_thread_id,
                web_link=data.get('webLink'),
            )
        return DraftResult(created=False, reason=f'graph_status_{resp.status_code}')

    def delete_draft(self, draft_id: str) -> bool:
        """Delete a draft we previously mirrored (DELETE /me/messages/{id}).

        Used to reconcile the mirror after the approval sends (or rejects) the
        staged message, so a stale duplicate never lingers in Drafts. 404 counts
        as success — the draft is already gone, which is the desired end state.
        """
        if not draft_id:
            return False
        resp = self._graph_delete(f'/me/messages/{draft_id}')
        return resp.status_code in (200, 204, 404)

    # ------------------------------------------------------------------
    # Batch operations
    # ------------------------------------------------------------------

    def batch_trash(self, message_ids: List[str]) -> int:
        """Move messages to Deleted Items folder."""
        trashed = 0
        # Get deleted items folder ID
        deleted_folder = self._graph_get('/me/mailFolders/deleteditems')
        folder_id = deleted_folder['id']

        # Graph batch limit is 20 requests per batch
        for i in range(0, len(message_ids), 20):
            batch = message_ids[i:i + 20]
            batch_body = {
                'requests': [
                    {
                        'id': str(j),
                        'method': 'POST',
                        'url': f'/me/messages/{mid}/move',
                        'body': {'destinationId': folder_id},
                        'headers': {'Content-Type': 'application/json'},
                    }
                    for j, mid in enumerate(batch)
                ]
            }

            resp = self._graph_post('/$batch', json_body=batch_body)
            if resp.status_code == 200:
                results = resp.json().get('responses', [])
                trashed += sum(1 for r in results if r.get('status', 0) in (200, 201))

        return trashed

    def batch_delete(self, message_ids: List[str]) -> int:
        """Permanently delete messages."""
        deleted = 0

        for i in range(0, len(message_ids), 20):
            batch = message_ids[i:i + 20]
            batch_body = {
                'requests': [
                    {
                        'id': str(j),
                        'method': 'POST',
                        # NOTE: Graph DELETE moves mail to Deleted Items and may still count
                        # toward quota. permanentDelete is the purge operation used only
                        # after the orchestrator has verified an archive.
                        'url': f'/me/messages/{mid}/permanentDelete',
                    }
                    for j, mid in enumerate(batch)
                ]
            }

            resp = self._graph_post('/$batch', json_body=batch_body)
            if resp.status_code == 200:
                results = resp.json().get('responses', [])
                deleted += sum(1 for r in results if r.get('status', 0) in (200, 202, 204))

        return deleted

    def batch_archive(self, message_ids: List[str], label: Optional[str] = None) -> int:
        changed = 0
        destination_id = self._archive_destination_id(label)
        for i in range(0, len(message_ids), 20):
            batch = message_ids[i:i + 20]
            batch_body = {
                'requests': [
                    {
                        'id': str(j),
                        'method': 'POST',
                        'url': f'/me/messages/{mid}/move',
                        'body': {'destinationId': destination_id},
                        'headers': {'Content-Type': 'application/json'},
                    }
                    for j, mid in enumerate(batch)
                ]
            }
            resp = self._graph_post('/$batch', json_body=batch_body)
            if resp.status_code == 200:
                results = resp.json().get('responses', [])
                changed += sum(1 for r in results if r.get('status', 0) in (200, 201))
        return changed

    def _archive_destination_id(self, label: Optional[str]) -> str:
        if label:
            folders = self._graph_get('/me/mailFolders', params={'$top': 100}).get('value', [])
            for folder in folders:
                if folder.get('displayName', '').lower() == label.lower():
                    return folder['id']
            resp = self._graph_post('/me/mailFolders', json_body={'displayName': label})
            resp.raise_for_status()
            return resp.json()['id']
        return self._graph_get('/me/mailFolders/archive')['id']

    def _batch_move_to_folder(self, message_ids: List[str], well_known_folder: str) -> int:
        """Graph $batch move of messages into a well-known folder. Returns count moved."""
        moved = 0
        folder_id = self._graph_get(f'/me/mailFolders/{well_known_folder}')['id']
        for i in range(0, len(message_ids), 20):
            batch = message_ids[i:i + 20]
            batch_body = {
                'requests': [
                    {
                        'id': str(j),
                        'method': 'POST',
                        'url': f'/me/messages/{mid}/move',
                        'body': {'destinationId': folder_id},
                        'headers': {'Content-Type': 'application/json'},
                    }
                    for j, mid in enumerate(batch)
                ]
            }
            resp = self._graph_post('/$batch', json_body=batch_body)
            if resp.status_code == 200:
                results = resp.json().get('responses', [])
                moved += sum(1 for r in results if r.get('status', 0) in (200, 201))
        return moved

    def batch_spam(self, message_ids: List[str]) -> int:
        """Move messages to the Junk Email folder (a folder MOVE, like trash)."""
        return self._batch_move_to_folder(message_ids, 'junkemail')

    def batch_restore_inbox(self, message_ids: List[str]) -> int:
        """Move messages back to the Inbox folder (restore from junk/trash/archive)."""
        return self._batch_move_to_folder(message_ids, 'inbox')

    def batch_set_read(self, message_ids: List[str], read: bool = True) -> int:
        """PATCH isRead on each message (Graph $batch). Returns count changed."""
        changed = 0
        for i in range(0, len(message_ids), 20):
            batch = message_ids[i:i + 20]
            batch_body = {
                'requests': [
                    {
                        'id': str(j),
                        'method': 'PATCH',
                        'url': f'/me/messages/{mid}',
                        'body': {'isRead': read},
                        'headers': {'Content-Type': 'application/json'},
                    }
                    for j, mid in enumerate(batch)
                ]
            }
            resp = self._graph_post('/$batch', json_body=batch_body)
            if resp.status_code == 200:
                results = resp.json().get('responses', [])
                changed += sum(1 for r in results if r.get('status', 0) in (200, 201))
        return changed

    def batch_set_flagged(self, message_ids: List[str], flagged: bool = True) -> int:
        """PATCH flag.flagStatus on each message (Graph $batch). Returns count changed."""
        flag_status = 'flagged' if flagged else 'notFlagged'
        changed = 0
        for i in range(0, len(message_ids), 20):
            batch = message_ids[i:i + 20]
            batch_body = {
                'requests': [
                    {
                        'id': str(j),
                        'method': 'PATCH',
                        'url': f'/me/messages/{mid}',
                        'body': {'flag': {'flagStatus': flag_status}},
                        'headers': {'Content-Type': 'application/json'},
                    }
                    for j, mid in enumerate(batch)
                ]
            }
            resp = self._graph_post('/$batch', json_body=batch_body)
            if resp.status_code == 200:
                results = resp.json().get('responses', [])
                changed += sum(1 for r in results if r.get('status', 0) in (200, 201))
        return changed

    def export_messages(self, message_ids: List[str]):
        # Third tuple element = label_ids, for parity with the provider contract.
        # Graph's read/flag/category state isn't in the $value MIME; re-applying it on
        # restore is a follow-up (would need a metadata fetch + a post-create PATCH), so
        # yield an empty list for now — no worse than before, and interface-consistent.
        for message_id in message_ids:
            url = f'{GRAPH_BASE}/me/messages/{message_id}/$value'
            resp = requests.get(url, headers=self._auth_headers(), timeout=60)
            self._handle_throttle(resp)
            resp.raise_for_status()
            yield message_id, resp.content, []

    def import_message(self, raw_mime_bytes: bytes, label_ids: Optional[List[str]] = None) -> str:
        # Graph accepts MIME message creation using text/plain base64 content. label_ids
        # is accepted for contract parity but not applied here (Graph has no Gmail-label
        # model; restoring isRead/flag/categories is a follow-up).
        url = f'{GRAPH_BASE}/me/messages'
        headers = {**self._auth_headers(), 'Content-Type': 'text/plain'}
        resp = requests.post(url, headers=headers, data=base64.b64encode(raw_mime_bytes), timeout=60)
        self._handle_throttle(resp)
        resp.raise_for_status()
        return resp.json().get('id', '')

    # ------------------------------------------------------------------
    # Attachments
    # ------------------------------------------------------------------

    def get_attachment(self, message_id: str, attachment_id: str) -> EmailAttachment:
        att = self._graph_get(f'/me/messages/{message_id}/attachments/{attachment_id}')

        data = b''
        if att.get('contentBytes'):
            data = base64.b64decode(att['contentBytes'])

        return EmailAttachment(
            id=attachment_id,
            message_id=message_id,
            filename=att.get('name', ''),
            mime_type=att.get('contentType', ''),
            size_bytes=att.get('size', len(data)),
            data=data,
        )

    # ------------------------------------------------------------------
    # Query translation
    # ------------------------------------------------------------------

    def translate_query(self, canonical_query: str) -> str:
        """Translate Gmail-style queries to OData $filter syntax.

        Term-honest: EVERY term must translate or the whole query returns ''
        (the caller then decides between $search and refusing). A term is never
        silently dropped — the old best-effort version turned
        "gmktec older_than:30d" into an unscoped fetch of ALL mail older than
        30 days, which fed the cleanup lane's safe-marking.
        """
        import re

        q = canonical_query.strip()
        if not q:
            return ''

        # senderGroup criteria arrive as "from:a@x OR from:b@y" — translate the
        # whole disjunction or refuse it; collapsing it into a single eq literal
        # produced a match-nothing filter presented as a successful empty plan.
        or_parts = re.split(r'\s+OR\s+', q)
        if len(or_parts) > 1:
            clauses = []
            for part in or_parts:
                part = part.strip()
                if not part.startswith('from:'):
                    return ''
                clause = self._single_term_filter(part)
                if clause is None:
                    return ''
                clauses.append(clause)
            return '(' + ' or '.join(clauses) + ')'

        clauses = []
        for term in q.split():
            clause = self._single_term_filter(term)
            if clause is None:
                return ''
            clauses.append(clause)
        return ' and '.join(clauses)

    def _single_term_filter(self, term: str) -> Optional[str]:
        """One query term → one OData clause, or None when it has no faithful
        translation (free text included — that is the caller's $search case)."""
        import re
        from datetime import timedelta

        translations = {
            'category:promotions': "inferenceClassification eq 'other'",
            'category:social': "categories/any(c: c eq 'Social')",
            'is:unread': 'isRead eq false',
            'is:read': 'isRead eq true',
            'is:starred': "importance eq 'high'",
            'has:attachment': 'hasAttachments eq true',
        }
        if term in translations:
            return translations[term]

        match = re.fullmatch(r'older_than:(\d+)d', term)
        if match:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=int(match.group(1)))).strftime('%Y-%m-%dT%H:%M:%SZ')
            return f"receivedDateTime le {cutoff}"

        if term.startswith('from:') and len(term) > len('from:'):
            sender = term[len('from:'):].strip()
            # ``sender`` is caller-supplied; escape OData single quotes (double
            # them) before interpolating into the string literal.
            safe_sender = sender.replace("'", "''")
            return f"from/emailAddress/address eq '{safe_sender}'"

        return None
