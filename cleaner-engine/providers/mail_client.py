"""
Shared helpers for the unified mail-client capability (threads / thread / send).

These build the FROZEN response shapes returned by the /mail/* routes and provide
small reusable utilities (RFC 5322 address parsing, ISO 8601 normalisation, folder
name validation) used by both the Gmail and Microsoft Graph providers.

The route layer in ``app.py`` is responsible for the DEGRADE-CLEAN contract (any
provider/auth error -> empty result + HTTP 200); the provider methods may raise.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime, getaddresses
from typing import List, Optional

# Canonical folder names accepted by the /mail/* routes.
FOLDERS = ("inbox", "archive", "spam", "trash", "sent", "drafts")

DEFAULT_THREAD_LIMIT = 50
MAX_THREAD_LIMIT = 200


@dataclass
class Address:
    address: str
    name: Optional[str] = None


@dataclass
class ThreadSummary:
    id: str
    subject: Optional[str] = None
    participants: List[Address] = field(default_factory=list)
    last_message_at: Optional[str] = None
    last_snippet: Optional[str] = None
    message_count: int = 0
    unread: bool = False


@dataclass
class ThreadMessage:
    id: str
    thread_id: str
    subject: Optional[str] = None
    sent_at: Optional[str] = None
    preview: Optional[str] = None
    direction: str = "received"  # received | sent | draft
    sender: Optional[Address] = None  # serialised as "from"
    to: List[Address] = field(default_factory=list)


@dataclass
class SendResult:
    accepted: bool
    provider_message_id: Optional[str] = None
    thread_id: Optional[str] = None
    reason: Optional[str] = None


def clamp_limit(limit: Optional[int]) -> int:
    """Clamp the caller-supplied limit to [1, MAX_THREAD_LIMIT]."""
    if not limit or limit <= 0:
        return DEFAULT_THREAD_LIMIT
    return min(int(limit), MAX_THREAD_LIMIT)


def normalize_folder(folder: Optional[str]) -> str:
    """Lower-case + validate a folder name, defaulting to ``inbox``."""
    value = (folder or "inbox").strip().lower()
    return value if value in FOLDERS else "inbox"


def parse_address(raw: Optional[str]) -> Optional[Address]:
    """Parse a single RFC 5322 address string into an Address (or None)."""
    if not raw:
        return None
    parsed = getaddresses([raw])
    if not parsed:
        return None
    name, addr = parsed[0]
    if not addr:
        return None
    return Address(address=addr, name=name or None)


def parse_address_list(raw: Optional[str]) -> List[Address]:
    """Parse a comma-separated RFC 5322 address list into Address objects."""
    if not raw:
        return []
    out: List[Address] = []
    for name, addr in getaddresses([raw]):
        if addr:
            out.append(Address(address=addr, name=name or None))
    return out


def to_iso8601(value: Optional[str]) -> Optional[str]:
    """Normalise a date header / Graph timestamp to an ISO 8601 string.

    Accepts RFC 2822 ('Mon, 01 Jan 2024 ...') and ISO ('2024-01-01T...Z')
    forms. Returns None when the value is missing or unparseable.
    """
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    # ISO-ish (Graph receivedDateTime / sentDateTime) first.
    try:
        iso = text.replace("Z", "+00:00") if text.endswith("Z") else text
        return datetime.fromisoformat(iso).isoformat()
    except ValueError:
        pass
    # RFC 2822 email Date header.
    try:
        dt = parsedate_to_datetime(text)
        if dt is not None:
            return dt.isoformat()
    except (TypeError, ValueError):
        pass
    return None


def epoch_ms_to_iso8601(value: Optional[int]) -> Optional[str]:
    """Convert epoch milliseconds (Gmail internalDate) to an ISO 8601 string."""
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000.0, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None
