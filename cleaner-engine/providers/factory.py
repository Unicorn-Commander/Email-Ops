"""
Provider factory - creates the appropriate email provider instance.
"""

import os
from providers.base import EmailProvider, ProviderType


def create_provider(provider_type: str, **kwargs) -> EmailProvider:
    """Create an email provider by type string.

    Args:
        provider_type: 'gmail' or 'microsoft'
        **kwargs: provider-specific config (client_id, client_secret, etc.)
                  Falls back to environment variables if not provided.

    Returns:
        An EmailProvider instance (not yet authenticated).
    """
    ptype = ProviderType(provider_type)

    if ptype == ProviderType.GMAIL:
        from providers.gmail_provider import GmailProvider
        return GmailProvider(
            client_id=kwargs.get('client_id', os.environ.get('GOOGLE_CLIENT_ID', '')),
            client_secret=kwargs.get('client_secret', os.environ.get('GOOGLE_CLIENT_SECRET', '')),
        )

    elif ptype == ProviderType.MICROSOFT:
        from providers.microsoft_provider import MicrosoftGraphProvider
        return MicrosoftGraphProvider(
            client_id=kwargs.get('client_id', os.environ.get('MICROSOFT_CLIENT_ID', '')),
            client_secret=kwargs.get('client_secret', os.environ.get('MICROSOFT_CLIENT_SECRET', '')),
            tenant_id=kwargs.get('tenant_id', os.environ.get('MICROSOFT_TENANT_ID', 'common')),
        )

    raise ValueError(f"Unknown provider type: {provider_type}")
