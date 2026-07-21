"""
Abstract base class for email providers.
All providers (Gmail, Microsoft Graph, etc.) implement this interface.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, List, Optional, Tuple, Dict, Any


class ProviderType(str, Enum):
    GMAIL = 'gmail'
    MICROSOFT = 'microsoft'


@dataclass
class EmailProfile:
    email: str
    display_name: str = ''
    total_messages: int = 0
    total_threads: int = 0
    storage_used_bytes: int = 0
    storage_limit_bytes: int = 0


@dataclass
class EmailMessage:
    id: str
    thread_id: str = ''
    subject: str = ''
    sender: str = ''
    recipient: str = ''
    date: str = ''
    snippet: str = ''
    body_text: str = ''
    body_html: str = ''
    labels: List[str] = field(default_factory=list)
    is_read: bool = False
    is_starred: bool = False
    has_attachments: bool = False
    size_bytes: int = 0
    internal_date: Optional[int] = None  # epoch ms
    headers: Dict[str, str] = field(default_factory=dict)
    raw_data: Dict[str, Any] = field(default_factory=dict)


@dataclass
class EmailAttachment:
    id: str
    message_id: str
    filename: str
    mime_type: str = ''
    size_bytes: int = 0
    data: bytes = b''


@dataclass
class InboxStats:
    total_messages: int = 0
    total_threads: int = 0
    unread_count: int = 0
    promotional_count: int = 0
    social_count: int = 0
    storage_used_bytes: int = 0


class EmailProvider(ABC):
    """Abstract base class for email providers."""

    provider_type: ProviderType

    @abstractmethod
    def authenticate(self, credentials: dict) -> bool:
        """Authenticate with the provider using a credentials dict.
        Returns True on success.
        """
        ...

    @abstractmethod
    def get_profile(self) -> EmailProfile:
        """Get the authenticated user's email profile."""
        ...

    @abstractmethod
    def get_inbox_stats(self) -> InboxStats:
        """Get basic inbox statistics (counts by category)."""
        ...

    @abstractmethod
    def list_messages(
        self,
        query: str = '',
        max_results: int = 100,
        page_token: Optional[str] = None,
        folder: Optional[str] = None,
    ) -> Tuple[List[EmailMessage], Optional[str]]:
        """List messages matching a query.

        folder: optional canonical folder to scope to ('inbox', 'sent', ...). When
        given, results are restricted to that folder in a provider-correct way
        (Gmail label query vs. Graph mailFolders), independent of ``query``.
        Returns (messages, next_page_token).
        """
        ...

    @abstractmethod
    def get_message(self, message_id: str, format: str = 'metadata') -> EmailMessage:
        """Get a single message by ID.
        format: 'metadata', 'full', 'minimal'
        """
        ...

    @abstractmethod
    def batch_trash(self, message_ids: List[str]) -> int:
        """Move messages to trash. Returns count of messages trashed."""
        ...

    @abstractmethod
    def batch_delete(self, message_ids: List[str]) -> int:
        """Permanently delete messages. Returns count deleted."""
        ...

    @abstractmethod
    def batch_archive(self, message_ids: List[str], label: Optional[str] = None) -> int:
        """Archive/organize messages without deleting them. Returns count changed."""
        ...

    @abstractmethod
    def export_messages(self, message_ids: List[str]) -> Iterable[Tuple[str, bytes, List[str]]]:
        """Yield (id, raw RFC822/MIME bytes, label_ids) for each message id.

        label_ids captures the provider-side state (read/starred/labels) that the raw
        MIME cannot carry, so restore can re-apply it. Providers with no label model
        yield an empty list.
        """
        ...

    @abstractmethod
    def import_message(self, raw_mime_bytes: bytes, label_ids: Optional[List[str]] = None) -> str:
        """Import a raw RFC822/MIME message and return the new provider id.

        label_ids (if given) is re-applied so a restored message keeps its original
        read/star/label state; providers may ignore it if their import model differs.
        """
        ...

    @abstractmethod
    def get_attachment(self, message_id: str, attachment_id: str) -> EmailAttachment:
        """Download an attachment by ID."""
        ...

    @abstractmethod
    def get_oauth_url(self, redirect_uri: str) -> str:
        """Get the OAuth authorization URL for this provider."""
        ...

    @abstractmethod
    def exchange_code(self, code: str, redirect_uri: str) -> dict:
        """Exchange an authorization code for credentials.
        Returns a credentials dict suitable for authenticate().
        """
        ...

    @abstractmethod
    def translate_query(self, canonical_query: str) -> str:
        """Translate a canonical query string to the provider's native query syntax.
        Canonical queries use Gmail-style syntax (e.g. 'category:promotions').
        """
        ...
