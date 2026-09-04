"""
Gmail provider - wraps Google Gmail API.
"""

import base64
import socket
from datetime import datetime, timezone
from email.message import EmailMessage as MimeMessage
from typing import List, Optional, Tuple

import google_auth_httplib2
import httplib2
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

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
    MailAttachment,
    SendResult,
    ThreadMessage,
    ThreadSummary,
    clamp_limit,
    epoch_ms_to_iso8601,
    parse_address,
    parse_address_list,
    recipient_list,
    to_iso8601,
)


# ---------------------------------------------------------------------------
# Network hardening: prefer IPv4 for outbound calls (applied once, at import).
#
# Google publishes both A and AAAA records, but this engine container has no
# routable IPv6 (v4-only interfaces). Python's getaddrinfo still returns the
# AAAA records (it does not apply AI_ADDRCONFIG), and httplib2 has no
# Happy-Eyeballs — so a Gmail call can attempt an unreachable v6 address and
# stall, surfacing as the intermittent "SSL handshake operation timed out" 500s
# that make Cleanup/Insights silently return nothing. Filtering getaddrinfo to
# IPv4 (only when the caller didn't request a specific family, and only when an
# A record exists) routes every call down the fast, working v4 path. Safe here:
# every host this engine reaches — Google, Microsoft, the internal gateway — is
# reachable over IPv4.
# ---------------------------------------------------------------------------
if not getattr(socket, '_uc_ipv4_pref', False):
    _uc_orig_getaddrinfo = socket.getaddrinfo

    def _uc_ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        results = _uc_orig_getaddrinfo(host, port, family, type, proto, flags)
        if family == 0:
            v4 = [r for r in results if r[0] == socket.AF_INET]
            if v4:
                return v4
        return results

    socket.getaddrinfo = _uc_ipv4_getaddrinfo
    socket._uc_ipv4_pref = True


SCOPES = [
    # Full Gmail scope: batch_delete uses users.messages.batchDelete, which
    # Google only permits under https://mail.google.com/ (gmail.modify is NOT
    # sufficient). Must match the Keycloak google IdP defaultScope.
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
]

# Canonical folder -> Gmail list query. ``archive`` = mail no longer in INBOX
# and not in trash/spam.
_FOLDER_QUERY = {
    'inbox': 'in:inbox',
    'sent': 'in:sent',
    'drafts': 'in:drafts',
    'trash': 'in:trash',
    'spam': 'in:spam',
    'archive': '-in:inbox -in:trash -in:spam -in:drafts',
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


class GmailProvider(EmailProvider):
    """Gmail API provider implementation."""

    provider_type = ProviderType.GMAIL

    def __init__(self, client_id: str = '', client_secret: str = ''):
        self.client_id = client_id
        self.client_secret = client_secret
        self.service = None
        self._credentials = None

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def authenticate(self, credentials: dict) -> bool:
        """Authenticate using a credentials dict (token, refresh_token, etc.)."""
        self._credentials = Credentials(
            token=credentials.get('token'),
            refresh_token=credentials.get('refresh_token'),
            token_uri=credentials.get('token_uri', 'https://oauth2.googleapis.com/token'),
            client_id=credentials.get('client_id', self.client_id),
            client_secret=credentials.get('client_secret', self.client_secret),
            scopes=credentials.get('scopes'),
        )

        if self._credentials.expired and self._credentials.refresh_token:
            self._credentials.refresh(Request())

        # Explicit-timeout transport: default httplib2 has no socket timeout, so a
        # stalled TLS handshake would hang the whole request instead of failing
        # fast. AuthorizedHttp keeps the credentials refreshing transparently.
        authed_http = google_auth_httplib2.AuthorizedHttp(
            self._credentials,
            http=httplib2.Http(timeout=30),
        )
        self.service = build('gmail', 'v1', http=authed_http, cache_discovery=False)
        return True

    def get_oauth_url(self, redirect_uri: str) -> str:
        flow = self._make_flow(redirect_uri)
        auth_url, _ = flow.authorization_url(prompt='consent')
        return auth_url

    def exchange_code(self, code: str, redirect_uri: str) -> dict:
        flow = self._make_flow(redirect_uri)
        flow.fetch_token(code=code)
        creds = flow.credentials
        return {
            'token': creds.token,
            'refresh_token': creds.refresh_token,
            'token_uri': creds.token_uri,
            'client_id': creds.client_id,
            'client_secret': creds.client_secret,
            'scopes': list(creds.scopes) if creds.scopes else None,
        }

    def _make_flow(self, redirect_uri: str) -> Flow:
        return Flow.from_client_config(
            {
                'web': {
                    'client_id': self.client_id,
                    'client_secret': self.client_secret,
                    'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                    'token_uri': 'https://oauth2.googleapis.com/token',
                }
            },
            scopes=SCOPES,
            redirect_uri=redirect_uri,
        )

    # ------------------------------------------------------------------
    # Profile & Stats
    # ------------------------------------------------------------------

    def get_profile(self) -> EmailProfile:
        profile = self.service.users().getProfile(userId='me').execute(num_retries=3)
        return EmailProfile(
            email=profile.get('emailAddress', ''),
            total_messages=profile.get('messagesTotal', 0),
            total_threads=profile.get('threadsTotal', 0),
            storage_used_bytes=0,  # Gmail API doesn't expose this directly
        )

    def get_inbox_stats(self) -> InboxStats:
        profile = self.get_profile()
        stats = InboxStats(
            total_messages=profile.total_messages,
            total_threads=profile.total_threads,
        )

        # Quick estimates via resultSizeEstimate. total_messages/unread_count are
        # scoped to the INBOX (in:inbox) so they match the sovereign counts surface
        # and Microsoft's /mailFolders/inbox — the method is get_INBOX_stats, and a
        # whole-mailbox total next to an inbox total in the same badge row is wrong.
        for query, attr in [
            ('category:promotions', 'promotional_count'),
            ('in:inbox is:unread', 'unread_count'),
            ('category:social', 'social_count'),
            ('in:inbox', 'total_messages'),
        ]:
            try:
                result = self.service.users().messages().list(
                    userId='me', q=query, maxResults=1
                ).execute(num_retries=3)
                setattr(stats, attr, result.get('resultSizeEstimate', 0))
            except Exception:
                pass

        return stats

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    def list_messages(
        self,
        query: str = '',
        max_results: int = 100,
        page_token: Optional[str] = None,
        folder: Optional[str] = None,
    ) -> Tuple[List[EmailMessage], Optional[str]]:
        effective_query = query
        if folder:
            folder_q = _FOLDER_QUERY.get(folder, '')
            effective_query = f'{folder_q} {query}'.strip() if query else folder_q

        result = self.service.users().messages().list(
            userId='me',
            q=effective_query,
            maxResults=min(max_results, 500),
            pageToken=page_token,
        ).execute(num_retries=3)

        messages = []
        for msg in result.get('messages', []):
            messages.append(EmailMessage(id=msg['id'], thread_id=msg.get('threadId', '')))

        return messages, result.get('nextPageToken')

    def get_message(self, message_id: str, format: str = 'metadata') -> EmailMessage:
        gmail_format = format
        if format == 'metadata':
            msg = self.service.users().messages().get(
                userId='me',
                id=message_id,
                format='metadata',
                metadataHeaders=[
                    'From',
                    'To',
                    'Subject',
                    'Date',
                    'List-Unsubscribe',
                    'List-Unsubscribe-Post',
                ],
            ).execute(num_retries=3)
        else:
            msg = self.service.users().messages().get(
                userId='me', id=message_id, format=gmail_format
            ).execute(num_retries=3)

        headers = {
            h['name']: h['value']
            for h in msg.get('payload', {}).get('headers', [])
        }
        labels = msg.get('labelIds', [])

        email = EmailMessage(
            id=msg['id'],
            thread_id=msg.get('threadId', ''),
            subject=headers.get('Subject', ''),
            sender=headers.get('From', ''),
            recipient=headers.get('To', ''),
            date=headers.get('Date', ''),
            snippet=msg.get('snippet', ''),
            labels=labels,
            is_read='UNREAD' not in labels,
            is_starred='STARRED' in labels,
            has_attachments=any(
                p.get('filename') for p in self._iter_parts(msg.get('payload', {}))
            ),
            size_bytes=msg.get('sizeEstimate', 0),
            internal_date=int(msg.get('internalDate', 0)),
            headers=headers,
            raw_data=msg,
        )

        # Extract body if full format
        if format == 'full':
            email.body_text, email.body_html = self._extract_body(msg.get('payload', {}))

        return email

    def _extract_body(self, payload: dict) -> Tuple[str, str]:
        text = ''
        html = ''
        for part in self._iter_parts(payload):
            mime = part.get('mimeType', '')
            data = part.get('body', {}).get('data', '')
            if not data:
                continue
            decoded = base64.urlsafe_b64decode(data).decode('utf-8', errors='ignore')
            if mime == 'text/plain':
                text += decoded
            elif mime == 'text/html':
                html += decoded
        return text, html

    def _iter_parts(self, payload: dict):
        """Recursively iterate message parts."""
        if 'parts' in payload:
            for part in payload['parts']:
                yield from self._iter_parts(part)
        else:
            yield payload

    def _extract_attachments(self, payload: dict) -> List[MailAttachment]:
        """Attachment METADATA (no bytes) for the reader. A Gmail attachment part
        carries body.attachmentId (bytes fetched on demand via get_attachment)."""
        out: List[MailAttachment] = []
        for part in self._iter_parts(payload):
            body = part.get('body', {})
            attachment_id = body.get('attachmentId')
            if not attachment_id:
                continue
            headers = {h.get('name', '').lower(): h.get('value', '') for h in part.get('headers', [])}
            disposition = headers.get('content-disposition', '')
            cid = (headers.get('content-id') or '').strip('<>') or None
            is_inline = 'inline' in disposition.lower() or bool(cid)
            out.append(MailAttachment(
                id=attachment_id,
                filename=part.get('filename') or None,
                mime_type=part.get('mimeType') or None,
                size=int(body.get('size') or 0),
                is_inline=is_inline,
                cid=cid,
            ))
        return out

    # ------------------------------------------------------------------
    # Unified mail client (threads / thread / send)
    # ------------------------------------------------------------------

    def list_threads(
        self,
        folder: str = 'inbox',
        limit: int = 50,
        query: str = '',
        page_token: Optional[str] = None,
    ) -> Tuple[List[ThreadSummary], Optional[str]]:
        """List threads for a folder (optionally filtered), newest first.

        Gmail paginates with an opaque ``pageToken`` — never a numeric offset.
        Returns ``(summaries, next_page_token)``; ``next_page_token`` is None when
        there is no further page (honest has-more signal).
        """
        limit = clamp_limit(limit)
        folder_q = _FOLDER_QUERY.get(folder, _FOLDER_QUERY['inbox'])
        user_q = (query or '').strip()
        effective = f'{folder_q} {user_q}'.strip() if user_q else folder_q
        list_kwargs: dict = {
            'userId': 'me',
            'q': effective,
            'maxResults': limit,
        }
        if page_token:
            list_kwargs['pageToken'] = page_token
        result = self.service.users().threads().list(**list_kwargs).execute()

        summaries: List[ThreadSummary] = []
        for stub in result.get('threads', [])[:limit]:
            thread = self.service.users().threads().get(
                userId='me',
                id=stub['id'],
                format='metadata',
                metadataHeaders=['From', 'To', 'Subject', 'Date'],
            ).execute()
            summaries.append(self._thread_summary(thread))
        return summaries, result.get('nextPageToken')

    def _thread_summary(self, thread: dict) -> ThreadSummary:
        messages = thread.get('messages', [])
        participants: List[Address] = []
        seen: set = set()
        subject: Optional[str] = None
        unread = False
        flagged = False

        for msg in messages:
            headers = {
                h['name']: h['value']
                for h in msg.get('payload', {}).get('headers', [])
            }
            if subject is None and headers.get('Subject'):
                subject = headers['Subject']
            labels = msg.get('labelIds', [])
            if 'UNREAD' in labels:
                unread = True
            if 'STARRED' in labels:
                flagged = True
            for raw in (headers.get('From'), headers.get('To')):
                for addr in parse_address_list(raw):
                    key = addr.address.lower()
                    if key not in seen:
                        seen.add(key)
                        participants.append(addr)

        last = messages[-1] if messages else {}
        return ThreadSummary(
            id=thread.get('id', ''),
            subject=subject,
            participants=participants,
            last_message_at=epoch_ms_to_iso8601(int(last['internalDate'])) if last.get('internalDate') else None,
            last_snippet=last.get('snippet') or None,
            message_count=len(messages),
            unread=unread,
            flagged=flagged,
        )

    def get_thread(self, thread_id: str) -> List[ThreadMessage]:
        """Return the messages of a single thread in chronological order.

        Uses ``format='full'`` so the /mail READER gets real message bodies
        (text + HTML), not just the ~200-char snippet. A single
        ``threads().get`` returns every message in the thread fully, so this is
        one API call per opened thread — no per-message fan-out. This is the
        reader-only exception to the cleaner's metadata-only privacy rail
        (see ThreadMessage.body_* and the cleaner analysis path, which is
        unchanged and still never fetches bodies).
        """
        thread = self.service.users().threads().get(
            userId='me',
            id=thread_id,
            format='full',
        ).execute()

        out: List[ThreadMessage] = []
        for msg in thread.get('messages', []):
            payload = msg.get('payload', {})
            headers = {
                h['name']: h['value']
                for h in payload.get('headers', [])
            }
            labels = msg.get('labelIds', [])
            if 'DRAFT' in labels:
                direction = 'draft'
            elif 'SENT' in labels:
                direction = 'sent'
            else:
                direction = 'received'
            body_text, body_html = self._extract_body(payload)
            out.append(ThreadMessage(
                id=msg.get('id', ''),
                thread_id=msg.get('threadId', thread_id),
                sender=parse_address(headers.get('From')),
                to=parse_address_list(headers.get('To')),
                subject=headers.get('Subject') or None,
                sent_at=to_iso8601(headers.get('Date')) or epoch_ms_to_iso8601(
                    int(msg['internalDate']) if msg.get('internalDate') else None
                ),
                preview=msg.get('snippet') or None,
                direction=direction,
                body_text=body_text or None,
                body_html=body_html or None,
                attachments=self._extract_attachments(payload),
            ))
        return out

    def poll_inbound(self, since_iso: Optional[str]) -> dict:
        """Detect NEW inbox mail past a high-water cursor (external-mailbox parity
        with the sovereign James ``pollInbound``).

        BASELINE (``since_iso`` is None): capture the cursor (the newest inbox
        ``received_at``, or NOW for an empty inbox so the cursor is never null and
        the very next arrival is treated as new) and process NO backlog.

        INCREMENTAL (``since_iso`` set): ``new_messages`` = messages strictly newer
        than the cursor, ascending; the returned cursor advances to the max
        ``received_at`` seen (else ``since_iso``). ISO-8601 UTC strings sort
        chronologically, so the compare is lexical (matches James).

        EFFICIENCY: on an incremental poll narrow the fetch with a Gmail
        ``after:<epoch>`` query (day/second-granular + inclusive-ish — the strict
        ``received_at > since_iso`` filter below is authoritative); on baseline
        list only the newest one just to stamp the cursor.

        Degrade-clean: any provider error -> {'cursor': since_iso, 'new_messages': []}.
        """
        try:
            if since_iso:
                epoch = self._iso_to_epoch(since_iso)
                query = f'in:inbox after:{epoch - 1}' if epoch is not None else 'in:inbox'
                max_results = 50
            else:
                query = 'in:inbox'
                max_results = 1

            listed = self.service.users().messages().list(
                userId='me', q=query, maxResults=max_results,
            ).execute(num_retries=3)

            refs: List[dict] = []
            for stub in listed.get('messages', []):
                msg = self.service.users().messages().get(
                    userId='me',
                    id=stub['id'],
                    format='metadata',
                    # X-UC-Agent-Autoreply must be requested explicitly: with
                    # format='metadata' Gmail returns ONLY the metadataHeaders asked
                    # for, and this is the Wave-7 loop-protection marker.
                    metadataHeaders=['From', 'To', 'Subject', 'Date', 'X-UC-Agent-Autoreply'],
                ).execute(num_retries=3)
                payload_headers = msg.get('payload', {}).get('headers', [])
                headers = {h['name']: h['value'] for h in payload_headers}
                received_at = to_iso8601(headers.get('Date')) or epoch_ms_to_iso8601(
                    int(msg['internalDate']) if msg.get('internalDate') else None
                )
                if not received_at:
                    continue
                sender = parse_address(headers.get('From'))
                refs.append({
                    'thread_id': msg.get('threadId', ''),
                    'from_address': sender.address if sender else None,
                    # The REAL To recipients — rules' 'to' conditions match these.
                    'to_addresses': [a.address for a in parse_address_list(headers.get('To'))],
                    'subject': headers.get('Subject') or None,
                    'received_at': received_at,
                    # Present + non-empty header ⇒ an agent runtime auto-sent this.
                    'agent_autoreply': any(
                        (h.get('name') or '').lower() == 'x-uc-agent-autoreply'
                        and (h.get('value') or '').strip()
                        for h in payload_headers
                    ),
                })

            return _poll_result(refs, since_iso)
        except Exception:  # noqa: BLE001 - degrade clean like the other read routes
            return {'cursor': since_iso, 'new_messages': []}

    @staticmethod
    def _iso_to_epoch(value: str) -> Optional[int]:
        """Parse an ISO-8601 timestamp to integer epoch seconds (UTC), or None."""
        try:
            text = value.strip()
            if text.endswith('Z'):
                text = text[:-1] + '+00:00'
            dt = datetime.fromisoformat(text)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except (ValueError, TypeError):
            return None

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
        to_addrs: Optional[List[str]] = None,
    ) -> SendResult:
        """Send a new message or reply within a thread."""
        mime = MimeMessage()
        if from_addr:
            mime['From'] = from_addr
        tos = recipient_list(to_addr, to_addrs)
        mime['To'] = ', '.join(tos) if tos else to_addr
        if cc:
            mime['Cc'] = ', '.join([a for a in cc if a])
        # Bcc is deliberately NOT written as a header — Gmail strips it from the
        # delivered copy, and writing it would leak the blind list to every
        # recipient. It rides in the envelope via the raw send instead.
        if bcc:
            mime['Bcc'] = ', '.join([a for a in bcc if a])
        mime['Subject'] = subject or ''
        if body_html:
            mime.set_content(body or '')
            mime.add_alternative(body_html, subtype='html')
        else:
            mime.set_content(body or '')

        # add_attachment restructures the message into multipart/mixed as needed;
        # each attachment carries its bytes + a Content-Disposition filename.
        for att in (attachments or []):
            maintype, _, subtype = (att.get('mime_type') or 'application/octet-stream').partition('/')
            mime.add_attachment(
                att.get('data') or b'',
                maintype=maintype or 'application',
                subtype=subtype or 'octet-stream',
                filename=att.get('filename') or 'attachment',
            )

        send_body: dict = {}
        if in_reply_to_thread_id:
            send_body['threadId'] = in_reply_to_thread_id
            ref = self._thread_reply_reference(in_reply_to_thread_id)
            if ref:
                mime['In-Reply-To'] = ref
                mime['References'] = ref

        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode('ascii')
        send_body['raw'] = raw

        sent = self.service.users().messages().send(userId='me', body=send_body).execute()
        return SendResult(
            accepted=True,
            provider_message_id=sent.get('id'),
            thread_id=sent.get('threadId', in_reply_to_thread_id),
        )

    def _thread_reply_reference(self, thread_id: str) -> Optional[str]:
        """Best-effort Message-Id of the last message in a thread for In-Reply-To."""
        try:
            thread = self.service.users().threads().get(
                userId='me',
                id=thread_id,
                format='metadata',
                metadataHeaders=['Message-Id'],
            ).execute()
            messages = thread.get('messages', [])
            if not messages:
                return None
            headers = {
                h['name'].lower(): h['value']
                for h in messages[-1].get('payload', {}).get('headers', [])
            }
            return headers.get('message-id')
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Batch operations
    # ------------------------------------------------------------------

    def batch_trash(self, message_ids: List[str]) -> int:
        trashed = 0
        for i in range(0, len(message_ids), 100):
            batch = message_ids[i:i + 100]
            self.service.users().messages().batchModify(
                userId='me',
                body={'ids': batch, 'addLabelIds': ['TRASH']},
            ).execute()
            trashed += len(batch)
        return trashed

    def batch_delete(self, message_ids: List[str]) -> int:
        deleted = 0
        for i in range(0, len(message_ids), 100):
            batch = message_ids[i:i + 100]
            self.service.users().messages().batchDelete(
                userId='me', body={'ids': batch}
            ).execute()
            deleted += len(batch)
        return deleted

    def batch_archive(self, message_ids: List[str], label: Optional[str] = None) -> int:
        changed = 0
        # Archiving in Gmail = remove INBOX (done below). A reserved canonical folder
        # name (e.g. 'archive') is NOT a Gmail label id — real user labels are
        # 'Label_N' and system labels are UPPERCASE — so sending it as addLabelIds
        # would 400. Only a genuine label id is added on top of the archive.
        add_labels = [label] if label and label not in _FOLDER_QUERY else []
        for i in range(0, len(message_ids), 100):
            batch = message_ids[i:i + 100]
            self.service.users().messages().batchModify(
                userId='me',
                body={
                    'ids': batch,
                    'removeLabelIds': ['INBOX'],
                    'addLabelIds': add_labels,
                },
            ).execute()
            changed += len(batch)
        return changed

    def batch_set_read(self, message_ids: List[str], read: bool = True) -> int:
        """Set/clear the UNREAD label (read=True removes it). Returns count changed."""
        changed = 0
        label_op = 'removeLabelIds' if read else 'addLabelIds'
        for i in range(0, len(message_ids), 100):
            batch = message_ids[i:i + 100]
            self.service.users().messages().batchModify(
                userId='me',
                body={'ids': batch, label_op: ['UNREAD']},
            ).execute()
            changed += len(batch)
        return changed

    def batch_set_flagged(self, message_ids: List[str], flagged: bool = True) -> int:
        """Set/clear the STARRED label (Gmail's star). Returns count changed."""
        changed = 0
        label_op = 'addLabelIds' if flagged else 'removeLabelIds'
        for i in range(0, len(message_ids), 100):
            batch = message_ids[i:i + 100]
            self.service.users().messages().batchModify(
                userId='me',
                body={'ids': batch, label_op: ['STARRED']},
            ).execute()
            changed += len(batch)
        return changed

    def batch_spam(self, message_ids: List[str]) -> int:
        """Report messages as spam: add SPAM, drop INBOX (a label edit, like trash).

        Returns count changed.
        """
        changed = 0
        for i in range(0, len(message_ids), 100):
            batch = message_ids[i:i + 100]
            self.service.users().messages().batchModify(
                userId='me',
                body={
                    'ids': batch,
                    'addLabelIds': ['SPAM'],
                    'removeLabelIds': ['INBOX'],
                },
            ).execute()
            changed += len(batch)
        return changed

    def batch_restore_inbox(self, message_ids: List[str]) -> int:
        """Restore messages to the inbox: add INBOX, drop SPAM + TRASH.

        ``batch_trash`` trashes by ADDING the TRASH label (batchModify, not the
        messages.trash endpoint), so the symmetric restore REMOVES it here — no
        separate untrash call needed. Returns count changed.
        """
        changed = 0
        for i in range(0, len(message_ids), 100):
            batch = message_ids[i:i + 100]
            self.service.users().messages().batchModify(
                userId='me',
                body={
                    'ids': batch,
                    'addLabelIds': ['INBOX'],
                    'removeLabelIds': ['SPAM', 'TRASH'],
                },
            ).execute()
            changed += len(batch)
        return changed

    def export_messages(self, message_ids: List[str]):
        for message_id in message_ids:
            msg = self.service.users().messages().get(
                userId='me',
                id=message_id,
                format='raw',
            ).execute(num_retries=3)
            raw = msg.get('raw')
            if not raw:
                raise ValueError(f'Message {message_id} did not include raw RFC822 data')
            # Raw RFC822 carries none of Gmail's per-message state (read/starred/labels)
            # — capture labelIds from the SAME response so restore can re-apply them.
            label_ids = msg.get('labelIds', []) or []
            yield message_id, base64.urlsafe_b64decode(raw.encode('ascii')), label_ids

    # Labels that must NOT be re-applied on restore: re-adding TRASH/SPAM would land
    # the restored message straight back in trash/spam.
    _RESTORE_LABEL_DENY = {'TRASH', 'SPAM'}

    def import_message(self, raw_mime_bytes: bytes, label_ids: Optional[List[str]] = None) -> str:
        encoded = base64.urlsafe_b64encode(raw_mime_bytes).decode('ascii')
        body: dict = {'raw': encoded}
        if label_ids:
            # Re-apply the archived label state (INBOX / STARRED / CATEGORY_* / custom
            # Label_*, and UNREAD only if it was unread at archive time) so a restored
            # message keeps its read/star/labels instead of coming back as a bare unread.
            restore = [l for l in label_ids if l not in self._RESTORE_LABEL_DENY]
            if restore:
                body['labelIds'] = restore
        result = self.service.users().messages().import_(
            userId='me',
            body=body,
            internalDateSource='dateHeader',
            neverMarkSpam=True,
        ).execute(num_retries=3)
        return result.get('id', '')

    # ------------------------------------------------------------------
    # Attachments
    # ------------------------------------------------------------------

    def get_attachment(self, message_id: str, attachment_id: str) -> EmailAttachment:
        att = self.service.users().messages().attachments().get(
            userId='me', messageId=message_id, id=attachment_id
        ).execute()

        data = base64.urlsafe_b64decode(att['data'])

        return EmailAttachment(
            id=attachment_id,
            message_id=message_id,
            filename='',  # Caller should set from message part info
            size_bytes=len(data),
            data=data,
        )

    # ------------------------------------------------------------------
    # Query translation (Gmail is the canonical syntax)
    # ------------------------------------------------------------------

    def translate_query(self, canonical_query: str) -> str:
        # Gmail uses the canonical syntax natively
        return canonical_query
