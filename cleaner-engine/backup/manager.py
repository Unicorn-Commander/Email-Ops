"""
Email backup - save messages to local JSON files with a manifest.
"""
from __future__ import annotations

import json
import logging
import hashlib
import time
import zipfile
from dataclasses import asdict
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Callable, Optional

import boto3
from botocore.client import Config as BotoConfig

logger = logging.getLogger(__name__)

# Fetch messages in pages of this size
PAGE_SIZE = 100


class BackupManager:
    """Create and verify local email backups."""

    def create_backup(
        self,
        provider: Any,
        query: str = "",
        path: str = "",
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> dict[str, Any]:
        """Fetch messages and save them as JSON files.

        Args:
            provider: An authenticated EmailProvider instance.
            query: Optional search query to filter which messages to back up.
            path: Directory to store the backup. Created if it doesn't exist.
            progress_callback: Optional callback(completed, total, message).

        Returns:
            Manifest dict with backup metadata.
        """
        if not path:
            path = str(Path.home() / ".email-cleaner" / "data" / "backups" / f"backup-{int(time.time())}")

        backup_dir = Path(path)
        messages_dir = backup_dir / "messages"
        messages_dir.mkdir(parents=True, exist_ok=True)

        logger.info("Creating backup in %s (query=%r)", backup_dir, query)

        if progress_callback:
            progress_callback(0, 0, "Fetching message list...")

        # Collect all message IDs
        all_messages: list[dict[str, Any]] = []
        page_token: Optional[str] = None

        while True:
            messages, next_token = provider.list_messages(
                query=query,
                max_results=PAGE_SIZE,
                page_token=page_token,
            )

            for msg in messages:
                msg_dict = asdict(msg) if hasattr(msg, "__dataclass_fields__") else dict(msg)
                all_messages.append(msg_dict)

            if progress_callback:
                progress_callback(len(all_messages), 0, f"Found {len(all_messages)} messages...")

            if not next_token:
                break
            page_token = next_token

        total = len(all_messages)
        logger.info("Found %d messages to back up", total)

        if progress_callback:
            progress_callback(0, total, f"Backing up {total} messages...")

        # Fetch full message data and save each as JSON
        saved = 0
        errors = 0

        for i, msg_stub in enumerate(all_messages):
            msg_id = msg_stub.get("id", "")
            if not msg_id:
                errors += 1
                continue

            try:
                full_message = provider.get_message(msg_id, format="full")
                msg_data = asdict(full_message) if hasattr(full_message, "__dataclass_fields__") else dict(full_message)

                # Remove raw binary data that doesn't serialize well
                msg_data.pop("raw_data", None)

                msg_file = messages_dir / f"{msg_id}.json"
                with open(msg_file, "w", encoding="utf-8") as f:
                    json.dump(msg_data, f, ensure_ascii=False, default=str, indent=2)

                saved += 1
            except Exception as e:
                logger.warning("Failed to back up message %s: %s", msg_id, e)
                errors += 1

            if progress_callback and (i + 1) % 10 == 0:
                progress_callback(
                    saved,
                    total,
                    f"Backed up {saved}/{total} messages...",
                )

        # Write manifest
        manifest = {
            "version": "1.0",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "query": query,
            "total_messages": saved,
            "errors": errors,
            "path": str(backup_dir),
            "provider": getattr(provider, "provider_type", "unknown"),
        }

        # Convert ProviderType enum to string if needed
        if hasattr(manifest["provider"], "value"):
            manifest["provider"] = manifest["provider"].value

        manifest_file = backup_dir / "manifest.json"
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

        if progress_callback:
            progress_callback(saved, total, "Backup complete")

        logger.info("Backup complete: %d saved, %d errors", saved, errors)
        return manifest

    def verify_backup(self, path: str) -> dict[str, Any]:
        """Verify a backup directory is intact.

        Args:
            path: Path to the backup directory.

        Returns:
            Dict with 'success', 'message', and 'total_messages'.
        """
        backup_dir = Path(path)

        if not backup_dir.exists():
            return {
                "success": False,
                "message": f"Backup directory does not exist: {path}",
                "total_messages": 0,
            }

        manifest_file = backup_dir / "manifest.json"
        if not manifest_file.exists():
            return {
                "success": False,
                "message": "manifest.json not found in backup directory",
                "total_messages": 0,
            }

        try:
            with open(manifest_file, encoding="utf-8") as f:
                manifest = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            return {
                "success": False,
                "message": f"Failed to read manifest: {e}",
                "total_messages": 0,
            }

        expected_count = manifest.get("total_messages", 0)

        # Count actual message files
        messages_dir = backup_dir / "messages"
        if not messages_dir.exists():
            actual_count = 0
        else:
            actual_count = sum(1 for f in messages_dir.iterdir() if f.suffix == ".json")

        if actual_count == expected_count:
            return {
                "success": True,
                "message": f"Backup verified: {actual_count} messages intact",
                "total_messages": actual_count,
                "created_at": manifest.get("created_at", ""),
                "query": manifest.get("query", ""),
            }
        else:
            return {
                "success": False,
                "message": (
                    f"Message count mismatch: manifest says {expected_count}, "
                    f"found {actual_count} files"
                ),
                "total_messages": actual_count,
            }

    def create_archive(
        self,
        provider: Any,
        message_ids: list[str],
        bucket: str,
        key: str,
        s3_config: dict[str, str],
        query: str = "",
        metadata: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        """Create a restorable MIME archive and upload it to Garage/S3."""
        if not bucket or not key:
            raise ValueError("archive bucket and key are required")

        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        provider_name = getattr(provider, "provider_type", "unknown")
        if hasattr(provider_name, "value"):
            provider_name = provider_name.value

        total_bytes = 0
        object_sha = hashlib.sha256()
        entries: list[dict[str, Any]] = []

        with NamedTemporaryFile(suffix=".eml.zip") as tmp:
            with zipfile.ZipFile(tmp.name, "w", compression=zipfile.ZIP_STORED) as archive:
                for message_id, raw_mime, label_ids in provider.export_messages(message_ids):
                    if not isinstance(raw_mime, bytes):
                        raise TypeError(f"export_messages returned non-bytes for {message_id}")
                    digest = hashlib.sha256(raw_mime).hexdigest()
                    filename = f"messages/{self._safe_filename(message_id)}.eml"
                    archive.writestr(filename, raw_mime)
                    entries.append({
                        "id": message_id,
                        "file": filename,
                        "bytes": len(raw_mime),
                        "sha256": digest,
                        # Provider label/read/star state, so restore re-applies it. Absent
                        # on legacy (<=2.0) archives → restore just imports without labels.
                        "labels": list(label_ids or []),
                    })
                    total_bytes += len(raw_mime)

                manifest = {
                    "version": "2.1",
                    "format": "eml_zip",
                    "created_at": created_at,
                    "query": query,
                    "provider": provider_name,
                    "message_ids": message_ids,
                    "total_messages": len(entries),
                    "messages": entries,
                }
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

            with open(tmp.name, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    object_sha.update(chunk)
            object_digest = object_sha.hexdigest()
            object_bytes = Path(tmp.name).stat().st_size

            extra_args = {
                "ContentType": "application/zip",
                "ServerSideEncryption": "AES256",
                "Metadata": metadata or {},
            }
            self._s3_client(s3_config).upload_file(tmp.name, bucket, key, ExtraArgs=extra_args)

        return {
            "bucket": bucket,
            "key": key,
            "format": "eml_zip",
            "total_messages": len(entries),
            "bytes": object_bytes,
            "content_bytes": total_bytes,
            "sha256": object_digest,
            "created_at": created_at,
        }

    def verify_archive(self, bucket: str, key: str, s3_config: dict[str, str]) -> dict[str, Any]:
        """Download and verify a Garage/S3 MIME archive by manifest SHA-256."""
        object_bytes = 0
        try:
            with NamedTemporaryFile(suffix=".eml.zip") as tmp:
                self._s3_client(s3_config).download_file(bucket, key, tmp.name)
                object_sha = hashlib.sha256()
                with open(tmp.name, "rb") as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b""):
                        object_sha.update(chunk)
                object_bytes = Path(tmp.name).stat().st_size

                with zipfile.ZipFile(tmp.name, "r") as archive:
                    manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
                    entries = manifest.get("messages", [])
                    for entry in entries:
                        data = archive.read(entry["file"])
                        digest = hashlib.sha256(data).hexdigest()
                        if digest != entry.get("sha256"):
                            return {
                                "success": False,
                                "total_messages": 0,
                                "bytes": object_bytes,
                                "message": f"sha256 mismatch for {entry.get('id')}",
                            }
        except Exception as e:
            return {
                "success": False,
                "total_messages": 0,
                "bytes": object_bytes,
                "message": f"archive verification failed: {e}",
            }

        return {
            "success": True,
            "total_messages": len(entries),
            "bytes": object_bytes,
            "sha256": object_sha.hexdigest(),
            "message": f"Archive verified: {len(entries)} messages intact",
        }

    def restore_archive(
        self,
        provider: Any,
        bucket: str,
        key: str,
        s3_config: dict[str, str],
    ) -> dict[str, Any]:
        """Restore a Garage/S3 MIME archive by importing every `.eml` entry."""
        restored = 0
        failed: list[dict[str, str]] = []
        with NamedTemporaryFile(suffix=".eml.zip") as tmp:
            self._s3_client(s3_config).download_file(bucket, key, tmp.name)
            with zipfile.ZipFile(tmp.name, "r") as archive:
                manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
                for entry in manifest.get("messages", []):
                    try:
                        data = archive.read(entry["file"])
                        digest = hashlib.sha256(data).hexdigest()
                        if digest != entry.get("sha256"):
                            raise ValueError("sha256 mismatch")
                        # Re-apply the archived label/read/star state (v2.1+). Legacy
                        # archives have no "labels" → None → plain import (unchanged).
                        provider.import_message(data, label_ids=entry.get("labels"))
                        restored += 1
                    except Exception as e:
                        failed.append({"id": str(entry.get("id", "")), "error": str(e)})
        return {"restored": restored, "failed": failed}

    def _s3_client(self, s3_config: dict[str, str]):
        endpoint = s3_config.get("endpoint_url") or ""
        access_key = s3_config.get("access_key") or ""
        secret_key = s3_config.get("secret_key") or ""
        if not endpoint or not access_key or not secret_key:
            raise ValueError("Garage/S3 configuration is incomplete")
        return boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=s3_config.get("region") or "us-east-1",
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=BotoConfig(s3={"addressing_style": "path"}),
        )

    def _safe_filename(self, value: str) -> str:
        return "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in value) or "message"
