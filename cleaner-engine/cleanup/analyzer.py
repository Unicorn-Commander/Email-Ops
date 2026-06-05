"""
Inbox analysis - statistical breakdown of email patterns.
"""
from __future__ import annotations

import logging
import re
import time
from collections import defaultdict
from dataclasses import asdict
from typing import Any

logger = logging.getLogger(__name__)


class InboxAnalyzer:
    """Analyze inbox contents for patterns and cleanup opportunities."""

    def analyze_sender_frequency(self, messages: list[Any]) -> dict[str, Any]:
        """Count messages grouped by sender domain.

        Args:
            messages: List of EmailMessage dataclass instances or dicts.

        Returns:
            Dict with 'by_domain' (domain -> count), 'by_sender' (address -> count),
            'top_domains' (sorted list), 'top_senders' (sorted list).
        """
        by_domain: dict[str, int] = defaultdict(int)
        by_sender: dict[str, int] = defaultdict(int)

        for msg in messages:
            sender = self._get_field(msg, "sender")
            if not sender:
                continue

            # Extract email address from "Name <email>" format
            address = self._extract_email(sender)
            domain = self._extract_domain(address)

            by_sender[address] += 1
            if domain:
                by_domain[domain] += 1

        top_domains = sorted(by_domain.items(), key=lambda x: x[1], reverse=True)[:20]
        top_senders = sorted(by_sender.items(), key=lambda x: x[1], reverse=True)[:20]

        return {
            "by_domain": dict(by_domain),
            "by_sender": dict(by_sender),
            "top_domains": [{"domain": d, "count": c} for d, c in top_domains],
            "top_senders": [{"sender": s, "count": c} for s, c in top_senders],
            "unique_domains": len(by_domain),
            "unique_senders": len(by_sender),
        }

    def analyze_age_distribution(self, messages: list[Any]) -> dict[str, Any]:
        """Group messages by age.

        Args:
            messages: List of EmailMessage dataclass instances or dicts.

        Returns:
            Dict with age buckets and counts.
        """
        now = time.time() * 1000  # epoch ms
        buckets: dict[str, int] = {
            "past_week": 0,
            "past_month": 0,
            "past_quarter": 0,
            "past_year": 0,
            "older": 0,
        }

        week_ms = 7 * 24 * 3600 * 1000
        month_ms = 30 * 24 * 3600 * 1000
        quarter_ms = 90 * 24 * 3600 * 1000
        year_ms = 365 * 24 * 3600 * 1000

        for msg in messages:
            internal_date = self._get_field(msg, "internal_date")
            if not internal_date:
                buckets["older"] += 1
                continue

            try:
                ts = int(internal_date)
            except (ValueError, TypeError):
                buckets["older"] += 1
                continue

            age = now - ts
            if age <= week_ms:
                buckets["past_week"] += 1
            elif age <= month_ms:
                buckets["past_month"] += 1
            elif age <= quarter_ms:
                buckets["past_quarter"] += 1
            elif age <= year_ms:
                buckets["past_year"] += 1
            else:
                buckets["older"] += 1

        return {
            "buckets": buckets,
            "total": len(messages),
        }

    def analyze_categories(self, messages: list[Any]) -> dict[str, Any]:
        """Count messages by label/category.

        Args:
            messages: List of EmailMessage dataclass instances or dicts.

        Returns:
            Dict with category counts and label counts.
        """
        by_label: dict[str, int] = defaultdict(int)
        read_count = 0
        unread_count = 0
        starred_count = 0

        for msg in messages:
            labels = self._get_field(msg, "labels") or []
            is_read = self._get_field(msg, "is_read")
            is_starred = self._get_field(msg, "is_starred")

            if is_read:
                read_count += 1
            else:
                unread_count += 1

            if is_starred:
                starred_count += 1

            for label in labels:
                by_label[label] += 1

        return {
            "by_label": dict(by_label),
            "read_count": read_count,
            "unread_count": unread_count,
            "starred_count": starred_count,
            "total": len(messages),
        }

    def analyze_size_distribution(self, messages: list[Any]) -> dict[str, Any]:
        """Group messages by size.

        Args:
            messages: List of EmailMessage dataclass instances or dicts.

        Returns:
            Dict with size buckets and total bytes.
        """
        buckets: dict[str, int] = {
            "tiny": 0,       # < 10 KB
            "small": 0,      # 10 KB - 100 KB
            "medium": 0,     # 100 KB - 1 MB
            "large": 0,      # 1 MB - 10 MB
            "huge": 0,       # > 10 MB
        }

        total_bytes = 0
        sizes: list[int] = []

        for msg in messages:
            size = self._get_field(msg, "size_bytes") or 0
            try:
                size = int(size)
            except (ValueError, TypeError):
                size = 0

            total_bytes += size
            sizes.append(size)

            if size < 10_240:
                buckets["tiny"] += 1
            elif size < 102_400:
                buckets["small"] += 1
            elif size < 1_048_576:
                buckets["medium"] += 1
            elif size < 10_485_760:
                buckets["large"] += 1
            else:
                buckets["huge"] += 1

        return {
            "buckets": buckets,
            "total_bytes": total_bytes,
            "total_messages": len(messages),
            "average_bytes": total_bytes // max(len(messages), 1),
            "largest_bytes": max(sizes) if sizes else 0,
        }

    def get_full_analysis(self, messages: list[Any]) -> dict[str, Any]:
        """Combine all analyses into a single report.

        Args:
            messages: List of EmailMessage dataclass instances or dicts.

        Returns:
            Dict containing all analysis sections.
        """
        logger.info("Running full inbox analysis on %d messages", len(messages))

        return {
            "sender_frequency": self.analyze_sender_frequency(messages),
            "age_distribution": self.analyze_age_distribution(messages),
            "categories": self.analyze_categories(messages),
            "size_distribution": self.analyze_size_distribution(messages),
            "total_messages": len(messages),
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
    def _extract_email(sender: str) -> str:
        """Extract email address from 'Display Name <email@example.com>' format."""
        match = re.search(r"<([^>]+)>", sender)
        if match:
            return match.group(1).lower()
        # Might already be a bare address
        if "@" in sender:
            return sender.strip().lower()
        return sender.lower()

    @staticmethod
    def _extract_domain(email: str) -> str:
        """Extract domain from an email address."""
        if "@" in email:
            return email.split("@", 1)[1]
        return ""
