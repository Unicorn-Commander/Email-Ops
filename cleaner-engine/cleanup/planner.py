"""
Cleanup planning - generates safe deletion plans respecting protected domains.
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


class CleanupPlanner:
    """Generate cleanup plans that respect domain protection rules."""

    def __init__(
        self,
        protected_domains: list[str] | None = None,
        protected_suffixes: list[str] | None = None,
    ) -> None:
        self.protected_domains = protected_domains or []
        self.protected_suffixes = protected_suffixes or []

    def is_protected(self, sender: str) -> bool:
        """Check if a sender's domain is in the protected list.

        Args:
            sender: Email address or 'Display Name <email>' string.

        Returns:
            True if the sender's domain matches a protected domain or suffix.
        """
        domain = self._extract_domain(sender)
        if not domain:
            # If we can't determine the domain, err on the side of caution
            return True

        domain_lower = domain.lower()

        # Check exact domain matches
        if domain_lower in self.protected_domains:
            return True

        # Check suffix matches (.gov, .mil, .edu)
        for suffix in self.protected_suffixes:
            if domain_lower.endswith(suffix):
                return True

        return False

    def create_plan(
        self,
        messages: list[Any],
        categories_to_clean: list[str] | None = None,
    ) -> dict[str, Any]:
        """Generate a cleanup plan from a list of messages.

        Args:
            messages: List of EmailMessage dataclass instances or dicts.
            categories_to_clean: Optional list of categories to target
                (e.g., ['promotional', 'social']). If None, considers all
                non-important categories.

        Returns:
            Plan dict with 'safe_to_delete', 'protected', 'estimated_bytes_freed',
            and 'warnings'.
        """
        if categories_to_clean is None:
            categories_to_clean = ["promotional", "social", "newsletter"]

        safe_to_delete: list[str] = []
        protected: list[str] = []
        estimated_bytes: int = 0
        warnings: list[str] = []

        for msg in messages:
            msg_id = self._get_field(msg, "id")
            if not msg_id:
                continue

            sender = self._get_field(msg, "sender") or ""
            is_starred = self._get_field(msg, "is_starred") or False
            labels = self._get_field(msg, "labels") or []
            size = self._get_field(msg, "size_bytes") or 0
            category = self._get_field(msg, "category") or ""

            # Never touch starred emails
            if is_starred:
                protected.append(msg_id)
                continue

            # Never touch protected domain emails
            if self.is_protected(sender):
                protected.append(msg_id)
                continue

            # Check if the message's category is in our cleanup targets
            if category and category not in categories_to_clean:
                # Also check Gmail-style labels
                label_match = any(
                    label.lower().replace("category_", "") in categories_to_clean
                    for label in labels
                )
                if not label_match:
                    continue

            safe_to_delete.append(msg_id)
            try:
                estimated_bytes += int(size)
            except (ValueError, TypeError):
                pass

        # Generate warnings
        if not safe_to_delete:
            warnings.append("No messages matched the cleanup criteria.")

        if len(protected) > 0:
            warnings.append(
                f"{len(protected)} messages were excluded (starred or from protected domains)."
            )

        if estimated_bytes > 100_000_000:  # > 100 MB
            warnings.append(
                f"This plan will free approximately {estimated_bytes / 1_048_576:.1f} MB. "
                "Consider reviewing large deletions carefully."
            )

        logger.info(
            "Cleanup plan: %d to delete, %d protected, %d bytes estimated",
            len(safe_to_delete),
            len(protected),
            estimated_bytes,
        )

        return {
            "safe_to_delete": safe_to_delete,
            "protected": protected,
            "estimated_bytes_freed": estimated_bytes,
            "warnings": warnings,
            "categories_targeted": categories_to_clean,
            "total_reviewed": len(messages),
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _get_field(msg: Any, field: str) -> Any:
        """Get a field from a dataclass or dict."""
        if isinstance(msg, dict):
            return msg.get(field)
        return getattr(msg, field, None)

    @staticmethod
    def _extract_domain(sender: str) -> str:
        """Extract domain from a sender string."""
        # Try to extract email from "Name <email>" format
        match = re.search(r"<([^>]+)>", sender)
        email = match.group(1) if match else sender

        if "@" in email:
            return email.split("@", 1)[1].strip().lower()
        return ""
