"""
Configuration for the Cleaner Engine microservice.
Reads directly from environment variables and keeps defaults safe for booting
with no env configured.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class Config:
    protected_domains: list[str] = field(default_factory=lambda: [
        # Financial
        "usaa.com",
        "bankofamerica.com",
        "chase.com",
        "paypal.com",
        "venmo.com",
        # Medical
        "mychart.com",
        "questdiagnostics.com",
    ])

    protected_suffixes: list[str] = field(default_factory=lambda: [
        ".gov",
        ".mil",
        ".edu",
    ])

    google_client_id: str = ""
    google_client_secret: str = ""
    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    microsoft_tenant_id: str = "common"

    litellm_base_url: str = ""
    litellm_api_key: str = ""
    litellm_model: str = "local/qwen3.5-9b"
    litellm_frontier_model: str = ""
    max_tokens: int = 2048
    temperature: float = 0.7
    engine_shared_secret: str = ""
    garage_s3_endpoint: str = ""
    garage_s3_region: str = "us-east-1"
    garage_s3_access_key: str = ""
    garage_s3_secret_key: str = ""
    garage_archive_bucket: str = ""


def load_config() -> Config:
    """Load configuration from environment variables."""
    config = Config(
        protected_domains=_parse_csv_env("EMAIL_CLEANER_PROTECTED_DOMAINS", Config().protected_domains),
        protected_suffixes=_parse_csv_env("EMAIL_CLEANER_PROTECTED_SUFFIXES", Config().protected_suffixes),
        google_client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
        google_client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
        microsoft_client_id=os.environ.get("MICROSOFT_CLIENT_ID", ""),
        microsoft_client_secret=os.environ.get("MICROSOFT_CLIENT_SECRET", ""),
        microsoft_tenant_id=os.environ.get("MICROSOFT_TENANT_ID", "common"),
        litellm_base_url=os.environ.get("LITELLM_BASE_URL", ""),
        litellm_api_key=os.environ.get("LITELLM_API_KEY", ""),
        litellm_model=os.environ.get("LITELLM_MODEL", "local/qwen3.5-9b"),
        litellm_frontier_model=os.environ.get("LITELLM_FRONTIER_MODEL", ""),
        max_tokens=int(os.environ.get("MAX_TOKENS", "2048")),
        temperature=float(os.environ.get("TEMPERATURE", "0.7")),
        engine_shared_secret=os.environ.get("ENGINE_SHARED_SECRET", ""),
        garage_s3_endpoint=os.environ.get("GARAGE_S3_ENDPOINT", ""),
        garage_s3_region=os.environ.get("GARAGE_S3_REGION", "us-east-1"),
        garage_s3_access_key=os.environ.get("GARAGE_S3_ACCESS_KEY", ""),
        garage_s3_secret_key=os.environ.get("GARAGE_S3_SECRET_KEY", ""),
        garage_archive_bucket=os.environ.get("GARAGE_ARCHIVE_BUCKET", ""),
    )
    return config


def _parse_csv_env(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name, "")
    if not raw:
        return list(default)
    return [value.strip() for value in raw.split(",") if value.strip()]
