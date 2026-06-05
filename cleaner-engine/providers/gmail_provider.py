"""
Gmail provider - wraps Google Gmail API.
"""

import base64
from typing import List, Optional, Tuple

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

SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.readonly',
]


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

        self.service = build('gmail', 'v1', credentials=self._credentials)
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
        profile = self.service.users().getProfile(userId='me').execute()
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

        # Quick estimates via resultSizeEstimate
        for query, attr in [
            ('category:promotions', 'promotional_count'),
            ('is:unread', 'unread_count'),
            ('category:social', 'social_count'),
        ]:
            try:
                result = self.service.users().messages().list(
                    userId='me', q=query, maxResults=1
                ).execute()
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
    ) -> Tuple[List[EmailMessage], Optional[str]]:
        result = self.service.users().messages().list(
            userId='me',
            q=query,
            maxResults=min(max_results, 500),
            pageToken=page_token,
        ).execute()

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
                metadataHeaders=['From', 'To', 'Subject', 'Date', 'List-Unsubscribe'],
            ).execute()
        else:
            msg = self.service.users().messages().get(
                userId='me', id=message_id, format=gmail_format
            ).execute()

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
        add_labels = [label] if label else []
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

    def export_messages(self, message_ids: List[str]):
        for message_id in message_ids:
            msg = self.service.users().messages().get(
                userId='me',
                id=message_id,
                format='raw',
            ).execute()
            raw = msg.get('raw')
            if not raw:
                raise ValueError(f'Message {message_id} did not include raw RFC822 data')
            yield message_id, base64.urlsafe_b64decode(raw.encode('ascii'))

    def import_message(self, raw_mime_bytes: bytes) -> str:
        encoded = base64.urlsafe_b64encode(raw_mime_bytes).decode('ascii')
        result = self.service.users().messages().import_(
            userId='me',
            body={'raw': encoded},
        ).execute()
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
