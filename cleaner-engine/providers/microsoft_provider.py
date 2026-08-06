"""
Microsoft 365 provider - uses MSAL for auth and Microsoft Graph API for mail.
"""

import time
import base64
from typing import List, Optional, Tuple, Dict, Any

import requests

try:
    import msal
except ImportError:
    msal = None  # Optional dependency; error raised on use

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
        resp = requests.get(url, headers=self._headers(), params=params, timeout=30)
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

    def list_messages(
        self,
        query: str = '',
        max_results: int = 100,
        page_token: Optional[str] = None,
        folder: Optional[str] = None,
    ) -> Tuple[List[EmailMessage], Optional[str]]:
        params: Dict[str, Any] = {
            '$top': min(max_results, 50),  # Graph limit per page
            '$select': 'id,conversationId,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview',
            '$orderby': 'receivedDateTime desc',
        }

        if query:
            params['$filter'] = self.translate_query(query)

        # Scope to a mail folder the Graph-correct way (an OData path segment),
        # rather than a $filter — /me/messages spans every folder incl. Sent.
        if folder:
            folder_id = _FOLDER_ID.get(folder, folder)
            endpoint = f'/me/mailFolders/{folder_id}/messages'
        else:
            endpoint = '/me/messages'

        if page_token:
            # page_token is a full URL for Graph API
            resp = requests.get(page_token, headers=self._headers(), timeout=30)
            resp.raise_for_status()
            data = resp.json()
        else:
            data = self._graph_get(endpoint, params=params)

        messages = []
        for msg in data.get('value', []):
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
                is_read=msg.get('isRead', False),
                has_attachments=msg.get('hasAttachments', False),
                raw_data=msg,
            ))

        next_link = data.get('@odata.nextLink')
        return messages, next_link

    def get_message(self, message_id: str, format: str = 'metadata') -> EmailMessage:
        select = 'id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,importance,hasAttachments,bodyPreview'
        if format == 'full':
            select += ',body'

        msg = self._graph_get(f'/me/messages/{message_id}', params={'$select': select})

        from_addr = ''
        if msg.get('from', {}).get('emailAddress'):
            from_addr = msg['from']['emailAddress'].get('address', '')

        to_addrs = []
        for r in msg.get('toRecipients', []):
            if r.get('emailAddress'):
                to_addrs.append(r['emailAddress'].get('address', ''))

        email = EmailMessage(
            id=msg['id'],
            thread_id=msg.get('conversationId', ''),
            subject=msg.get('subject', ''),
            sender=from_addr,
            recipient=', '.join(to_addrs),
            date=msg.get('receivedDateTime', ''),
            snippet=msg.get('bodyPreview', ''),
            is_read=msg.get('isRead', False),
            is_starred=msg.get('importance', '') == 'high',
            has_attachments=msg.get('hasAttachments', False),
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

    def list_threads(self, folder: str = 'inbox', limit: int = 50) -> List[ThreadSummary]:
        """List threads (conversations) for a folder, newest first."""
        limit = clamp_limit(limit)
        folder_id = _FOLDER_ID.get(folder, 'inbox')
        # Over-fetch a little so grouping by conversation still yields ~limit threads.
        params = {
            '$top': min(limit * 2, 200),
            '$select': 'id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview',
            '$orderby': 'receivedDateTime desc',
        }
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

            for candidate in [msg.get('from', {}).get('emailAddress')] + [
                r.get('emailAddress') for r in msg.get('toRecipients', [])
            ]:
                addr = self._address(candidate)
                if addr and addr.address.lower() not in seen_participants[conv]:
                    seen_participants[conv].add(addr.address.lower())
                    summary.participants.append(addr)

        return [threads[c] for c in order]

    def get_thread(self, thread_id: str) -> List[ThreadMessage]:
        """Return the messages of one conversation in chronological order."""
        account = self._account_address()
        # OData escapes a single quote inside a string literal by doubling it.
        # ``thread_id`` is caller-supplied, so escape before interpolating to
        # prevent breaking out of the literal ($filter injection).
        safe_thread_id = thread_id.replace("'", "''")
        params = {
            '$filter': f"conversationId eq '{safe_thread_id}'",
            '$select': 'id,conversationId,subject,from,toRecipients,sentDateTime,receivedDateTime,isDraft,bodyPreview',
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
            out.append(ThreadMessage(
                id=msg.get('id', ''),
                thread_id=msg.get('conversationId', thread_id),
                sender=sender,
                to=[a for a in (self._address(r.get('emailAddress')) for r in msg.get('toRecipients', [])) if a],
                subject=msg.get('subject') or None,
                sent_at=to_iso8601(msg.get('sentDateTime') or msg.get('receivedDateTime')),
                preview=msg.get('bodyPreview') or None,
                direction=direction,
            ))
        return out

    def send_message(
        self,
        from_addr: str,
        to_addr: str,
        subject: str,
        body: str,
        in_reply_to_thread_id: Optional[str] = None,
    ) -> SendResult:
        """Send a new message or reply (via /me/sendMail)."""
        message = {
            'subject': subject or '',
            'body': {'contentType': 'Text', 'content': body or ''},
            'toRecipients': [{'emailAddress': {'address': to_addr}}],
        }
        if from_addr:
            message['from'] = {'emailAddress': {'address': from_addr}}

        resp = self._graph_post('/me/sendMail', json_body={'message': message, 'saveToSentItems': True})
        if resp.status_code in (200, 202):
            # sendMail returns 202 Accepted with no body / no id.
            return SendResult(
                accepted=True,
                provider_message_id=None,
                thread_id=in_reply_to_thread_id,
            )
        return SendResult(accepted=False, reason=f'graph_status_{resp.status_code}')

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
        This handles common patterns; complex queries may need manual adjustment.
        """
        q = canonical_query.strip()

        # Direct mappings for common canonical queries
        translations = {
            'category:promotions': "inferenceClassification eq 'other'",
            'category:social': "categories/any(c: c eq 'Social')",
            'is:unread': 'isRead eq false',
            'is:read': 'isRead eq true',
            'is:starred': "importance eq 'high'",
            'has:attachment': 'hasAttachments eq true',
        }

        if q in translations:
            return translations[q]

        # Handle 'older_than:Nd' pattern
        if 'older_than:' in q:
            import re
            from datetime import datetime, timedelta, timezone
            match = re.search(r'older_than:(\d+)d', q)
            if match:
                days = int(match.group(1))
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')
                base_filter = f"receivedDateTime le {cutoff}"

                # Combine with other parts
                remaining = q.replace(match.group(0), '').strip()
                if remaining and remaining in translations:
                    return f"{translations[remaining]} and {base_filter}"
                return base_filter

        # Handle 'from:' queries
        if q.startswith('from:'):
            sender = q[5:].strip()
            # ``sender`` is caller-supplied; escape OData single quotes (double
            # them) before interpolating into the string literal.
            safe_sender = sender.replace("'", "''")
            return f"from/emailAddress/address eq '{safe_sender}'"

        # Fallback: use $search instead of $filter for free-text
        # Return empty to let the caller use $search param instead
        return ''
