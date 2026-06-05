"""
Email Provider Abstraction Layer
Supports Gmail and Microsoft 365 (Graph API)
"""

from providers.base import (
    EmailProvider,
    EmailProfile,
    EmailMessage,
    EmailAttachment,
    InboxStats,
    ProviderType,
)
from providers.factory import create_provider

__all__ = [
    'EmailProvider',
    'EmailProfile',
    'EmailMessage',
    'EmailAttachment',
    'InboxStats',
    'ProviderType',
    'create_provider',
]
