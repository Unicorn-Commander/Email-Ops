from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app
from providers.base import EmailMessage, EmailProfile, InboxStats


class FakeProvider:
    def __init__(self, provider_type: str):
        self.provider_type = provider_type
        self.authenticated = False
        self.credentials: dict[str, Any] | None = None
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def authenticate(self, credentials: dict[str, Any]) -> bool:
        self.authenticated = True
        self.credentials = credentials
        self.calls.append(("authenticate", (), {"credentials": credentials}))
        return True

    def get_oauth_url(self, redirect_uri: str) -> str:
        self.calls.append(("get_oauth_url", (redirect_uri,), {}))
        return f"https://auth.example/{self.provider_type}?redirect_uri={redirect_uri}"

    def exchange_code(self, code: str, redirect_uri: str) -> dict[str, Any]:
        self.calls.append(("exchange_code", (code, redirect_uri), {}))
        return {"access_token": f"{self.provider_type}-access", "refresh_token": "refresh"}

    def get_profile(self) -> EmailProfile:
        self.calls.append(("get_profile", (), {}))
        return EmailProfile(
            email="user@example.com",
            display_name="Test User",
            total_messages=123,
            total_threads=45,
            storage_used_bytes=6789,
        )

    def get_inbox_stats(self) -> InboxStats:
        self.calls.append(("get_inbox_stats", (), {}))
        return InboxStats(
            total_messages=123,
            total_threads=45,
            unread_count=12,
            promotional_count=34,
            social_count=5,
            storage_used_bytes=6789,
        )

    def list_messages(self, query: str = "", max_results: int = 100, page_token: str | None = None):
        self.calls.append(("list_messages", (), {"query": query, "max_results": max_results, "page_token": page_token}))
        if page_token == "page-2":
            return ([EmailMessage(id="msg-3", subject="Message 3", sender="sender3@example.com", snippet="Snippet 3")], None)
        messages = [
            EmailMessage(id="msg-1", subject="Message 1", sender="sender1@example.com", snippet="Snippet 1", labels=["CATEGORY_PROMOTIONS"]),
            EmailMessage(id="msg-2", subject="Message 2", sender="sender2@example.com", snippet="Snippet 2", labels=["CATEGORY_SOCIAL"]),
        ]
        return messages, "page-2"

    def get_message(self, message_id: str, format: str = "metadata") -> EmailMessage:
        self.calls.append(("get_message", (message_id,), {"format": format}))
        return EmailMessage(
            id=message_id,
            subject=f"Subject {message_id}",
            sender=f"{message_id}@example.com",
            recipient="recipient@example.com",
            snippet=f"Snippet {message_id}",
            body_text="Body text" if format == "full" else "",
            body_html="<p>Body</p>" if format == "full" else "",
            labels=["INBOX"],
            size_bytes=100,
            internal_date=1710000000000,
        )

    def batch_trash(self, message_ids: list[str]) -> int:
        self.calls.append(("batch_trash", tuple(message_ids), {}))
        return len(message_ids)

    def batch_delete(self, message_ids: list[str]) -> int:
        self.calls.append(("batch_delete", tuple(message_ids), {}))
        return len(message_ids)

    def batch_archive(self, message_ids: list[str], label: str | None = None) -> int:
        self.calls.append(("batch_archive", tuple(message_ids), {"label": label}))
        return len(message_ids)

    def export_messages(self, message_ids: list[str]):
        self.calls.append(("export_messages", tuple(message_ids), {}))
        for message_id in message_ids:
            yield message_id, (
                f"From: sender@example.com\r\n"
                f"To: recipient@example.com\r\n"
                f"Subject: {message_id}\r\n"
                "\r\n"
                f"Body for {message_id}\r\n"
            ).encode("utf-8")

    def import_message(self, raw_mime_bytes: bytes) -> str:
        self.calls.append(("import_message", (raw_mime_bytes,), {}))
        return f"restored-{len(self.calls)}"

    def get_attachment(self, message_id: str, attachment_id: str):
        self.calls.append(("get_attachment", (message_id, attachment_id), {}))
        return SimpleNamespace(id=attachment_id, message_id=message_id, filename="file.txt", size_bytes=3, data=b"abc")

    def translate_query(self, canonical_query: str) -> str:
        self.calls.append(("translate_query", (canonical_query,), {}))
        return canonical_query


class FakeProviderFactory:
    def __init__(self):
        self.instances: list[FakeProvider] = []

    def create_provider(self, provider_type: str, **kwargs):
        provider = FakeProvider(provider_type)
        self.instances.append(provider)
        return provider


def _fake_openai_factory(call_log: list[dict[str, Any]], fail_local: bool = False):
    class FakeResponse:
        def __init__(self, content: str):
            self.choices = [SimpleNamespace(message=SimpleNamespace(content=content))]

    class FakeCompletions:
        def create(self, **kwargs):
            call_log.append(kwargs)
            model = kwargs["model"]
            if fail_local and model == "local/qwen3.5-9b" and len(call_log) == 1:
                raise RuntimeError("primary model failed")

            system_prompt = kwargs["messages"][0]["content"] if kwargs["messages"][0]["role"] == "system" else ""
            if "Categorize these emails" in kwargs["messages"][-1]["content"]:
                return FakeResponse(
                    json.dumps([
                        {"id": "msg-1", "category": "promotional", "confidence": 0.95, "reason": "Marketing email"},
                        {"id": "msg-2", "category": "social", "confidence": 0.91, "reason": "Social notification"},
                    ])
                )
            if "Inbox statistics:" in kwargs["messages"][-1]["content"]:
                return FakeResponse(
                    json.dumps([
                        {"action": "trash", "category": "promotional", "reason": "Low value promotional mail.", "priority": "high", "estimated_messages": 10}
                    ])
                )
            if "Inbox context:" in kwargs["messages"][-1]["content"]:
                return FakeResponse("chat response")
            if "Analyze this inbox data:" in kwargs["messages"][-1]["content"]:
                return FakeResponse("Inbox summary")
            return FakeResponse(system_prompt or "fallback")

    class FakeChat:
        def __init__(self):
            self.completions = FakeCompletions()

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.chat = FakeChat()

    return FakeClient


@pytest.fixture
def fake_provider_factory(monkeypatch):
    factory = FakeProviderFactory()
    monkeypatch.setattr(app.provider_factory, "create_provider", factory.create_provider)
    return factory


@pytest.fixture
def client(monkeypatch, fake_provider_factory):
    monkeypatch.setenv("ENGINE_SHARED_SECRET", "test-secret")
    return TestClient(app.app)


@pytest.fixture
def ai_enabled(monkeypatch):
    monkeypatch.setenv("LITELLM_BASE_URL", "http://litellm.local/v1")
    monkeypatch.setenv("LITELLM_API_KEY", "test-key")
    monkeypatch.setenv("LITELLM_MODEL", "local/qwen3.5-9b")
    monkeypatch.setenv("LITELLM_FRONTIER_MODEL", "frontier/model")
    monkeypatch.setenv("ENGINE_SHARED_SECRET", "test-secret")


def _auth_headers():
    return {"X-Engine-Token": "test-secret"}


class FakeS3Client:
    root: Path

    def upload_file(self, filename: str, bucket: str, key: str, ExtraArgs: dict[str, Any] | None = None) -> None:
        target = self.root / bucket / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(Path(filename).read_bytes())

    def download_file(self, bucket: str, key: str, filename: str) -> None:
        Path(filename).write_bytes((self.root / bucket / key).read_bytes())


@pytest.fixture
def fake_s3(monkeypatch, tmp_path):
    client = FakeS3Client()
    client.root = tmp_path / "s3"
    monkeypatch.setattr("backup.manager.BackupManager._s3_client", lambda _self, _cfg: client)
    return client


def test_health_returns_status_and_version(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.1.0"}


@pytest.mark.parametrize(
    "headers, expected_status",
    [
        ({}, 401),
        ({"X-Engine-Token": "wrong"}, 401),
        (_auth_headers(), 200),
    ],
)
def test_auth_gate(headers, expected_status, client, fake_provider_factory):
    response = client.post(
        "/accounts/stats",
        headers=headers,
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == expected_status


def test_accounts_stats_happy_path(client, fake_provider_factory):
    response = client.post(
        "/accounts/stats",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    assert response.json()["total_messages"] == 123
    assert fake_provider_factory.instances[-1].authenticated is True
    assert fake_provider_factory.instances[-1].credentials == {"token": "abc"}


def test_auth_oauth_url(client):
    response = client.post(
        "/auth/oauth-url",
        headers=_auth_headers(),
        json={"provider": "gmail", "redirect_uri": "https://example.com/callback"},
    )
    assert response.status_code == 200
    assert response.json()["url"].startswith("https://auth.example/gmail")


def test_auth_exchange_returns_credentials(client):
    response = client.post(
        "/auth/exchange",
        headers=_auth_headers(),
        json={"provider": "gmail", "code": "abc", "redirect_uri": "https://example.com/callback"},
    )
    assert response.status_code == 200
    assert response.json()["access_token"] == "gmail-access"


def test_accounts_profile(client):
    response = client.post(
        "/accounts/profile",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    assert response.json()["email"] == "user@example.com"


def test_messages_list(client):
    response = client.post(
        "/messages/list",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "query": "is:unread", "max_results": 25, "page_token": None},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["messages"]) == 2
    assert body["next_token"] == "page-2"


def test_messages_get(client):
    response = client.post(
        "/messages/get",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "message_id": "msg-1", "format": "full"},
    )
    assert response.status_code == 200
    assert response.json()["body_text"] == "Body text"


def test_cleanup_trash(client):
    response = client.post(
        "/cleanup/trash",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "message_ids": ["a", "b"]},
    )
    assert response.status_code == 200
    assert response.json() == {"count": 2}


def test_cleanup_delete(client):
    response = client.post(
        "/cleanup/delete",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "message_ids": ["a", "b"]},
    )
    assert response.status_code == 200
    assert response.json() == {"count": 2}


def test_cleanup_organize(client, fake_provider_factory):
    response = client.post(
        "/cleanup/organize",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "message_ids": ["a", "b"], "label": "Receipts"},
    )
    assert response.status_code == 200
    assert response.json() == {"count": 2}
    assert fake_provider_factory.instances[-1].calls[-1] == (
        "batch_archive",
        ("a", "b"),
        {"label": "Receipts"},
    )


def test_backup_create_and_verify(client, tmp_path):
    backup_path = tmp_path / "backup"
    response = client.post(
        "/backup/create",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "query": "", "path": str(backup_path)},
    )
    assert response.status_code == 200
    manifest = response.json()
    assert manifest["total_messages"] == 3

    verify = client.post("/backup/verify", headers=_auth_headers(), json={"path": str(backup_path)})
    assert verify.status_code == 200
    assert verify.json()["success"] is True


def test_archive_create_verify_restore_round_trip(client, fake_s3, fake_provider_factory):
    create = client.post(
        "/archive/create",
        headers=_auth_headers(),
        json={
            "provider": "gmail",
            "credentials": {"token": "abc"},
            "message_ids": ["msg-1", "msg-2"],
            "garage": {"bucket": "archives", "key_prefix": "workspaces/ws-1/archive.zip"},
            "workspace_id": "ws-1",
            "expires_at": "2026-06-12T00:00:00.000Z",
        },
    )
    assert create.status_code == 200
    archive = create.json()
    assert archive["bucket"] == "archives"
    assert archive["key"] == "workspaces/ws-1/archive.zip"
    assert archive["format"] == "eml_zip"
    assert archive["total_messages"] == 2
    assert archive["sha256"]

    verify = client.post(
        "/archive/verify",
        headers=_auth_headers(),
        json={"bucket": archive["bucket"], "key": archive["key"]},
    )
    assert verify.status_code == 200
    assert verify.json()["success"] is True
    assert verify.json()["total_messages"] == 2

    restore = client.post(
        "/archive/restore",
        headers=_auth_headers(),
        json={
            "provider": "gmail",
            "credentials": {"token": "abc"},
            "bucket": archive["bucket"],
            "key": archive["key"],
        },
    )
    assert restore.status_code == 200
    assert restore.json() == {"restored": 2, "failed": []}
    restore_calls = [c for c in fake_provider_factory.instances[-1].calls if c[0] == "import_message"]
    assert len(restore_calls) == 2


def test_archive_routes_require_auth(client):
    response = client.post("/archive/verify", json={"bucket": "archives", "key": "missing.zip"})
    assert response.status_code == 401


def test_ai_analyze_with_mocked_ai(monkeypatch, fake_provider_factory, ai_enabled):
    call_log: list[dict[str, Any]] = []
    monkeypatch.setattr("ai.llm_analyzer.OpenAI", _fake_openai_factory(call_log))
    client = TestClient(app.app)

    response = client.post(
        "/ai/analyze",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    text = response.text
    assert "event: progress" in text
    assert "event: result" in text
    assert '"ai_categories":' in text
    assert '"recommendations":' in text
    assert '"promotional"' in text
    assert len(call_log) >= 2


def test_ai_chat_with_mocked_ai(monkeypatch, ai_enabled):
    call_log: list[dict[str, Any]] = []
    monkeypatch.setattr("ai.llm_analyzer.OpenAI", _fake_openai_factory(call_log))
    client = TestClient(app.app)

    response = client.post(
        "/ai/chat",
        headers=_auth_headers(),
        json={"message": "What should I delete?", "context": {"total_messages": 1}},
    )
    assert response.status_code == 200
    assert response.json()["response"] == "chat response"


def test_ai_models_returns_configured_models(client, monkeypatch):
    monkeypatch.setenv("LITELLM_BASE_URL", "")
    monkeypatch.setenv("LITELLM_MODEL", "local/model-a")
    monkeypatch.setenv("LITELLM_FRONTIER_MODEL", "frontier/model-b")
    response = client.post("/ai/models", headers=_auth_headers(), json={})
    assert response.status_code == 200
    assert response.json()["models"] == ["local/model-a", "frontier/model-b"]


def test_ai_chat_degrades_clean_when_ai_unavailable(client, monkeypatch):
    monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
    response = client.post(
        "/ai/chat",
        headers=_auth_headers(),
        json={"message": "help", "context": {}},
    )
    assert response.status_code == 200
    assert response.json()["response"].startswith("ai_unavailable")


def test_ai_analyze_degrades_clean_when_ai_unavailable(client, monkeypatch):
    monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
    response = client.post(
        "/ai/analyze",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    assert "ai_unavailable" in response.text
    assert '"ai_categories": []' in response.text


def test_ai_generate_falls_back_to_frontier(monkeypatch, ai_enabled):
    call_log: list[dict[str, Any]] = []
    monkeypatch.setattr("ai.llm_analyzer.OpenAI", _fake_openai_factory(call_log, fail_local=True))
    from ai.llm_analyzer import LLMAnalyzer

    analyzer = LLMAnalyzer()
    result = analyzer.categorize_emails([{"id": "msg-1", "sender": "a@example.com", "subject": "s", "snippet": "n"}])
    assert result[0]["category"] == "promotional"
    assert call_log[0]["model"] == "local/qwen3.5-9b"
    assert call_log[-1]["model"] == "frontier/model"
