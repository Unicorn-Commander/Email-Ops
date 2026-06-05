"""
Cleanup execution - carries out deletion/trash plans in batches.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# Process in batches to avoid API rate limits and allow progress reporting
BATCH_SIZE = 50


class CleanupExecutor:
    """Execute cleanup plans against an email provider."""

    def execute_plan(
        self,
        provider: Any,
        plan: dict[str, Any],
        action: str = "trash",
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> dict[str, Any]:
        """Execute a cleanup plan by trashing or deleting messages.

        Args:
            provider: An authenticated EmailProvider instance.
            plan: Plan dict from CleanupPlanner.create_plan().
            action: "trash" (move to trash, recoverable) or "delete" (permanent).
            progress_callback: Optional callback(completed, total, message) for progress.

        Returns:
            Result dict with 'completed', 'failed', 'bytes_freed'.
        """
        message_ids = plan.get("safe_to_delete", [])
        estimated_bytes = plan.get("estimated_bytes_freed", 0)

        if not message_ids:
            logger.info("No messages to %s", action)
            return {"completed": 0, "failed": 0, "bytes_freed": 0}

        if action not in ("trash", "delete"):
            raise ValueError(f"Invalid action: {action!r}. Must be 'trash' or 'delete'.")

        total = len(message_ids)
        completed = 0
        failed = 0

        logger.info("Executing cleanup: %s %d messages (action=%s)", action, total, action)

        for i in range(0, total, BATCH_SIZE):
            batch = message_ids[i : i + BATCH_SIZE]
            batch_num = (i // BATCH_SIZE) + 1
            total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE

            if progress_callback:
                progress_callback(
                    completed,
                    total,
                    f"Processing batch {batch_num}/{total_batches} ({len(batch)} messages)",
                )

            try:
                if action == "trash":
                    count = provider.batch_trash(batch)
                else:
                    count = provider.batch_delete(batch)
                completed += count
                failed += len(batch) - count
            except Exception as e:
                logger.error(
                    "Batch %d/%d failed: %s", batch_num, total_batches, e, exc_info=True
                )
                failed += len(batch)

        # Estimate bytes freed proportionally
        if total > 0:
            bytes_freed = int(estimated_bytes * (completed / total))
        else:
            bytes_freed = 0

        if progress_callback:
            progress_callback(completed, total, "Cleanup complete")

        result = {
            "completed": completed,
            "failed": failed,
            "bytes_freed": bytes_freed,
            "action": action,
            "total_attempted": total,
        }

        logger.info(
            "Cleanup finished: %d/%d %s, %d failed, ~%d bytes freed",
            completed,
            total,
            action,
            failed,
            bytes_freed,
        )

        return result
