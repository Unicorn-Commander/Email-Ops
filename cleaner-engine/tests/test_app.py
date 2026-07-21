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

    def list_messages(self, query: str = "", max_results: int = 100, page_token: str | None = None, folder: str | None = None):
        self.calls.append(("list_messages", (), {"query": query, "max_results": max_results, "page_token": page_token, "folder": folder}))
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

    def batch_set_read(self, message_ids: list[str], read: bool = True) -> int:
        self.calls.append(("batch_set_read", tuple(message_ids), {"read": read}))
        return len(message_ids)

    def batch_spam(self, message_ids: list[str]) -> int:
        self.calls.append(("batch_spam", tuple(message_ids), {}))
        return len(message_ids)

    def batch_restore_inbox(self, message_ids: list[str]) -> int:
        self.calls.append(("batch_restore_inbox", tuple(message_ids), {}))
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
            ).encode("utf-8"), ["INBOX", "STARRED", f"Label_{message_id}", "TRASH"]

    def import_message(self, raw_mime_bytes: bytes, label_ids=None) -> str:
        self.calls.append(("import_message", (raw_mime_bytes,), {"label_ids": label_ids}))
        return f"restored-{len(self.calls)}"

    def get_attachment(self, message_id: str, attachment_id: str):
        self.calls.append(("get_attachment", (message_id, attachment_id), {}))
        return SimpleNamespace(id=attachment_id, message_id=message_id, filename="file.txt", size_bytes=3, data=b"abc")

    def translate_query(self, canonical_query: str) -> str:
        self.calls.append(("translate_query", (canonical_query,), {}))
        return canonical_query

    def list_threads(self, folder: str = "inbox", limit: int = 50):
        from providers.mail_client import Address, ThreadSummary

        self.calls.append(("list_threads", (), {"folder": folder, "limit": limit}))
        return [
            ThreadSummary(
                id="thread-1",
                subject="Thread 1",
                participants=[Address(address="a@example.com", name="A")],
                last_message_at="2024-01-01T00:00:00+00:00",
                last_snippet="Snippet 1",
                message_count=2,
                unread=True,
            )
        ]

    def get_thread(self, thread_id: str):
        from providers.mail_client import Address, ThreadMessage

        self.calls.append(("get_thread", (thread_id,), {}))
        return [
            ThreadMessage(
                id="msg-1",
                thread_id=thread_id,
                sender=Address(address="a@example.com", name="A"),
                to=[Address(address="me@example.com", name=None)],
                subject="Thread subject",
                sent_at="2024-01-01T00:00:00+00:00",
                preview="Preview",
                direction="received",
            )
        ]

    def send_message(self, from_addr, to_addr, subject, body, in_reply_to_thread_id=None):
        from providers.mail_client import SendResult

        self.calls.append((
            "send_message",
            (),
            {
                "from_addr": from_addr,
                "to_addr": to_addr,
                "subject": subject,
                "body": body,
                "in_reply_to_thread_id": in_reply_to_thread_id,
            },
        ))
        return SendResult(
            accepted=True,
            provider_message_id="sent-1",
            thread_id=in_reply_to_thread_id or "thread-new",
        )


class FailingProvider(FakeProvider):
    """A provider that authenticates but whose mail methods raise (degrade-clean)."""

    def list_threads(self, folder: str = "inbox", limit: int = 50):
        raise RuntimeError("401 auth error")

    def get_thread(self, thread_id: str):
        raise RuntimeError("403 forbidden")

    def send_message(self, from_addr, to_addr, subject, body, in_reply_to_thread_id=None):
        raise RuntimeError("token expired")


class MixedThreadProvider(FakeProvider):
    """A provider whose thread carries received + sent + draft messages, to prove
    the triage routes' direction filtering (drafts never; sent skipped only for
    Microsoft's move-semantics archive/trash)."""

    def get_thread(self, thread_id: str):
        from providers.mail_client import Address, ThreadMessage

        self.calls.append(("get_thread", (thread_id,), {}))
        return [
            ThreadMessage(id="m-received", thread_id=thread_id, direction="received",
                          sender=Address(address="a@example.com")),
            ThreadMessage(id="m-sent", thread_id=thread_id, direction="sent",
                          sender=Address(address="me@example.com")),
            ThreadMessage(id="m-draft", thread_id=thread_id, direction="draft",
                          sender=Address(address="me@example.com")),
        ]


class UnauthenticatableProvider(FakeProvider):
    """A provider whose authenticate() raises (e.g. expired token, missing msal)."""

    def authenticate(self, credentials):
        raise RuntimeError("invalid_grant: token expired")


class FakeProviderFactory:
    def __init__(self, provider_cls=FakeProvider):
        self.provider_cls = provider_cls
        self.instances: list[FakeProvider] = []

    def create_provider(self, provider_type: str, **kwargs):
        provider = self.provider_cls(provider_type)
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


def test_cleanup_trash_surfaces_provider_failure_as_502(client, monkeypatch):
    # A mutating cleanup verb must NOT swallow a provider error into a 200 {"count": 0}
    # (indistinguishable from "0 matched" — the backend would then record a COMPLETED
    # cleanup that silently did nothing). It surfaces a clean 502 instead.
    class RaisingProvider(FakeProvider):
        def batch_trash(self, message_ids):
            raise RuntimeError("gmail 429 rate limited")

    factory = FakeProviderFactory(provider_cls=RaisingProvider)
    monkeypatch.setattr(app.provider_factory, "create_provider", factory.create_provider)

    response = client.post(
        "/cleanup/trash",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "message_ids": ["a", "b"]},
    )
    assert response.status_code == 502


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
    # Restore fidelity: the per-message label/read/star state is captured into the
    # manifest at archive time and handed back to import_message on restore (the real
    # provider then filters TRASH/SPAM and re-applies the rest, so a restored message
    # keeps its labels/star/read instead of coming back as a bare unread).
    assert restore_calls[0][2]["label_ids"] == ["INBOX", "STARRED", "Label_msg-1", "TRASH"]


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


@pytest.mark.parametrize("provider", ["gmail", "microsoft"])
def test_mail_threads_happy_path(client, fake_provider_factory, provider):
    response = client.post(
        "/mail/threads",
        headers=_auth_headers(),
        json={"provider": provider, "credentials": {"token": "abc"}, "folder": "inbox", "limit": 25},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["threads"]) == 1
    thread = body["threads"][0]
    assert thread["id"] == "thread-1"
    assert thread["unread"] is True
    assert thread["message_count"] == 2
    assert thread["participants"][0] == {"address": "a@example.com", "name": "A"}
    assert fake_provider_factory.instances[-1].calls[-1] == (
        "list_threads",
        (),
        {"folder": "inbox", "limit": 25},
    )


@pytest.mark.parametrize("provider", ["gmail", "microsoft"])
def test_mail_thread_happy_path(client, fake_provider_factory, provider):
    response = client.post(
        "/mail/thread",
        headers=_auth_headers(),
        json={"provider": provider, "credentials": {"token": "abc"}, "thread_id": "thread-1"},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["messages"]) == 1
    msg = body["messages"][0]
    # Contract: the sender field is serialised as "from".
    assert "from" in msg and "sender" not in msg
    assert msg["from"] == {"address": "a@example.com", "name": "A"}
    assert msg["thread_id"] == "thread-1"
    assert msg["direction"] == "received"


@pytest.mark.parametrize("provider", ["gmail", "microsoft"])
def test_mail_send_happy_path(client, fake_provider_factory, provider):
    response = client.post(
        "/mail/send",
        headers=_auth_headers(),
        json={
            "provider": provider,
            "credentials": {"token": "abc"},
            "from": "me@example.com",
            "to": "you@example.com",
            "subject": "Hi",
            "body": "Hello there",
            "in_reply_to_thread_id": "thread-1",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is True
    assert body["provider_message_id"] == "sent-1"
    assert body["thread_id"] == "thread-1"
    sent_call = fake_provider_factory.instances[-1].calls[-1]
    assert sent_call[0] == "send_message"
    assert sent_call[2]["from_addr"] == "me@example.com"
    assert sent_call[2]["to_addr"] == "you@example.com"
    assert sent_call[2]["in_reply_to_thread_id"] == "thread-1"


def test_mail_routes_require_auth(client):
    for path, payload in [
        ("/mail/threads", {"provider": "gmail", "credentials": {"token": "abc"}}),
        ("/mail/thread", {"provider": "gmail", "credentials": {"token": "abc"}, "thread_id": "t"}),
        ("/mail/send", {"provider": "gmail", "credentials": {"token": "abc"}, "to": "x@example.com"}),
        ("/mail/threads/t/archive", {"provider": "gmail", "credentials": {"token": "abc"}}),
        ("/mail/threads/t/trash", {"provider": "gmail", "credentials": {"token": "abc"}}),
        ("/mail/threads/t/read", {"provider": "gmail", "credentials": {"token": "abc"}, "read": True}),
        ("/mail/threads/t/spam", {"provider": "gmail", "credentials": {"token": "abc"}}),
        ("/mail/threads/t/inbox", {"provider": "gmail", "credentials": {"token": "abc"}}),
    ]:
        response = client.post(path, json=payload)
        assert response.status_code == 401, path


def _client_with_factory(monkeypatch, provider_cls):
    monkeypatch.setenv("ENGINE_SHARED_SECRET", "test-secret")
    factory = FakeProviderFactory(provider_cls)
    monkeypatch.setattr(app.provider_factory, "create_provider", factory.create_provider)
    return TestClient(app.app), factory


def test_mail_threads_degrades_clean_on_provider_error(monkeypatch):
    cli, _ = _client_with_factory(monkeypatch, FailingProvider)
    response = cli.post(
        "/mail/threads",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "folder": "inbox"},
    )
    assert response.status_code == 200
    assert response.json() == {"threads": []}


def test_mail_thread_degrades_clean_on_provider_error(monkeypatch):
    cli, _ = _client_with_factory(monkeypatch, FailingProvider)
    response = cli.post(
        "/mail/thread",
        headers=_auth_headers(),
        json={"provider": "microsoft", "credentials": {"access_token": "abc"}, "thread_id": "t"},
    )
    assert response.status_code == 200
    assert response.json() == {"messages": []}


def test_mail_send_degrades_clean_on_provider_error(monkeypatch):
    cli, _ = _client_with_factory(monkeypatch, FailingProvider)
    response = cli.post(
        "/mail/send",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "abc"}, "to": "x@example.com", "body": "hi"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is False
    assert body["reason"] == "send_failed"


@pytest.mark.parametrize("provider", ["gmail", "microsoft"])
def test_mail_thread_archive_happy_path(client, fake_provider_factory, provider):
    response = client.post(
        "/mail/threads/thread-1/archive",
        headers=_auth_headers(),
        json={"provider": provider, "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "moved": 1}
    fake = fake_provider_factory.instances[-1]
    # Resolved the thread's ids, then archived them (no label).
    assert fake.calls[-2] == ("get_thread", ("thread-1",), {})
    assert fake.calls[-1] == ("batch_archive", ("msg-1",), {"label": None})


@pytest.mark.parametrize("provider", ["gmail", "microsoft"])
def test_mail_thread_trash_happy_path(client, fake_provider_factory, provider):
    response = client.post(
        "/mail/threads/thread-1/trash",
        headers=_auth_headers(),
        json={"provider": provider, "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "moved": 1}
    fake = fake_provider_factory.instances[-1]
    assert fake.calls[-1] == ("batch_trash", ("msg-1",), {})


@pytest.mark.parametrize("provider,read", [("gmail", True), ("gmail", False), ("microsoft", False)])
def test_mail_thread_read_happy_path(client, fake_provider_factory, provider, read):
    response = client.post(
        "/mail/threads/thread-1/read",
        headers=_auth_headers(),
        json={"provider": provider, "credentials": {"token": "abc"}, "read": read},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "moved": 1}
    fake = fake_provider_factory.instances[-1]
    assert fake.calls[-1] == ("batch_set_read", ("msg-1",), {"read": read})


@pytest.mark.parametrize("provider", ["gmail", "microsoft"])
def test_mail_thread_spam_happy_path(client, fake_provider_factory, provider):
    response = client.post(
        "/mail/threads/thread-1/spam",
        headers=_auth_headers(),
        json={"provider": provider, "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "moved": 1}
    fake = fake_provider_factory.instances[-1]
    # Resolved the thread's ids, then reported them as spam.
    assert fake.calls[-2] == ("get_thread", ("thread-1",), {})
    assert fake.calls[-1] == ("batch_spam", ("msg-1",), {})


@pytest.mark.parametrize("provider", ["gmail", "microsoft"])
def test_mail_thread_restore_inbox_happy_path(client, fake_provider_factory, provider):
    response = client.post(
        "/mail/threads/thread-1/inbox",
        headers=_auth_headers(),
        json={"provider": provider, "credentials": {"token": "abc"}},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "moved": 1}
    fake = fake_provider_factory.instances[-1]
    assert fake.calls[-1] == ("batch_restore_inbox", ("msg-1",), {})


def test_mail_thread_triage_direction_filtering(monkeypatch):
    """Drafts are never touched; Microsoft's move-semantics archive/trash skip
    SENT copies (a Gmail label edit keeps them, so the whole thread goes)."""
    cli, factory = _client_with_factory(monkeypatch, MixedThreadProvider)

    cli.post("/mail/threads/t/archive", headers=_auth_headers(),
             json={"provider": "gmail", "credentials": {"token": "abc"}})
    assert factory.instances[-1].calls[-1] == ("batch_archive", ("m-received", "m-sent"), {"label": None})

    cli.post("/mail/threads/t/archive", headers=_auth_headers(),
             json={"provider": "microsoft", "credentials": {"access_token": "abc"}})
    assert factory.instances[-1].calls[-1] == ("batch_archive", ("m-received",), {"label": None})

    cli.post("/mail/threads/t/trash", headers=_auth_headers(),
             json={"provider": "microsoft", "credentials": {"access_token": "abc"}})
    assert factory.instances[-1].calls[-1] == ("batch_trash", ("m-received",), {})

    # Read is a flag flip on BOTH providers: sent copies included, drafts not.
    cli.post("/mail/threads/t/read", headers=_auth_headers(),
             json={"provider": "microsoft", "credentials": {"access_token": "abc"}, "read": True})
    assert factory.instances[-1].calls[-1] == ("batch_set_read", ("m-received", "m-sent"), {"read": True})

    # Spam/inbox-restore are label edits on Gmail (whole thread) but folder
    # MOVES on Microsoft (received copies only — Sent Items stay put).
    cli.post("/mail/threads/t/spam", headers=_auth_headers(),
             json={"provider": "gmail", "credentials": {"token": "abc"}})
    assert factory.instances[-1].calls[-1] == ("batch_spam", ("m-received", "m-sent"), {})

    cli.post("/mail/threads/t/spam", headers=_auth_headers(),
             json={"provider": "microsoft", "credentials": {"access_token": "abc"}})
    assert factory.instances[-1].calls[-1] == ("batch_spam", ("m-received",), {})

    cli.post("/mail/threads/t/inbox", headers=_auth_headers(),
             json={"provider": "gmail", "credentials": {"token": "abc"}})
    assert factory.instances[-1].calls[-1] == ("batch_restore_inbox", ("m-received", "m-sent"), {})

    cli.post("/mail/threads/t/inbox", headers=_auth_headers(),
             json={"provider": "microsoft", "credentials": {"access_token": "abc"}})
    assert factory.instances[-1].calls[-1] == ("batch_restore_inbox", ("m-received",), {})


def test_mail_thread_triage_accepts_slash_bearing_thread_ids(client, fake_provider_factory):
    """Microsoft conversation ids are base64 and can contain '/'; the ``:path``
    route converter must still resolve them after percent-decoding."""
    response = client.post(
        "/mail/threads/AAQkAD%2FAbc%3D/archive",
        headers=_auth_headers(),
        json={"provider": "microsoft", "credentials": {"access_token": "abc"}},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
    fake = fake_provider_factory.instances[-1]
    assert fake.calls[-2] == ("get_thread", ("AAQkAD/Abc=",), {})


def test_mail_thread_triage_degrades_clean_on_provider_error(monkeypatch):
    cli, _ = _client_with_factory(monkeypatch, FailingProvider)
    for path in [
        "/mail/threads/t/archive",
        "/mail/threads/t/trash",
        "/mail/threads/t/read",
        "/mail/threads/t/spam",
        "/mail/threads/t/inbox",
    ]:
        response = cli.post(
            path,
            headers=_auth_headers(),
            json={"provider": "gmail", "credentials": {"token": "abc"}},
        )
        assert response.status_code == 200, path
        assert response.json() == {"ok": False, "moved": 0}, path


def test_mail_thread_triage_degrades_clean_on_auth_failure(monkeypatch):
    cli, _ = _client_with_factory(monkeypatch, UnauthenticatableProvider)
    response = cli.post(
        "/mail/threads/t/trash",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "expired"}},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": False, "moved": 0}


def test_mail_threads_degrades_clean_on_auth_failure(monkeypatch):
    """A provider whose authenticate() raises (expired token) must yield empty + 200."""
    cli, _ = _client_with_factory(monkeypatch, UnauthenticatableProvider)
    response = cli.post(
        "/mail/threads",
        headers=_auth_headers(),
        json={"provider": "microsoft", "credentials": {"access_token": "expired"}},
    )
    assert response.status_code == 200
    assert response.json() == {"threads": []}


def test_mail_send_degrades_clean_on_auth_failure(monkeypatch):
    cli, _ = _client_with_factory(monkeypatch, UnauthenticatableProvider)
    response = cli.post(
        "/mail/send",
        headers=_auth_headers(),
        json={"provider": "gmail", "credentials": {"token": "expired"}, "to": "x@example.com"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is False
    assert body["reason"] == "provider_unavailable"


def test_ai_generate_falls_back_to_frontier(monkeypatch, ai_enabled):
    call_log: list[dict[str, Any]] = []
    monkeypatch.setattr("ai.llm_analyzer.OpenAI", _fake_openai_factory(call_log, fail_local=True))
    from ai.llm_analyzer import LLMAnalyzer

    analyzer = LLMAnalyzer()
    result = analyzer.categorize_emails([{"id": "msg-1", "sender": "a@example.com", "subject": "s", "snippet": "n"}])
    assert result[0]["category"] == "promotional"
    assert call_log[0]["model"] == "local/qwen3.5-9b"
    assert call_log[-1]["model"] == "frontier/model"


# ---------------------------------------------------------------------------
# Auth gate fails closed when no shared secret is configured.
# ---------------------------------------------------------------------------


@pytest.fixture
def client_no_secret(monkeypatch, fake_provider_factory):
    """A client whose engine boots with NO shared secret configured."""
    monkeypatch.delenv("ENGINE_SHARED_SECRET", raising=False)
    return TestClient(app.app)


@pytest.mark.parametrize(
    "headers",
    [
        {},  # missing token previously bypassed the gate (compare_digest("","")==True)
        {"X-Engine-Token": ""},  # explicit empty token
        {"X-Engine-Token": "anything"},  # arbitrary token
    ],
)
def test_auth_gate_fails_closed_when_secret_unset(headers, client_no_secret, fake_provider_factory):
    response = client_no_secret.post(
        "/accounts/stats",
        headers=headers,
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == 401


@pytest.fixture
def client_blank_secret(monkeypatch, fake_provider_factory):
    """A client whose engine boots with a blank/whitespace-only shared secret."""
    monkeypatch.setenv("ENGINE_SHARED_SECRET", "   ")
    return TestClient(app.app)


def test_auth_gate_fails_closed_when_secret_blank(client_blank_secret, fake_provider_factory):
    # A whitespace-only secret must be treated as "no secret" -> deny all.
    response = client_blank_secret.post(
        "/accounts/stats",
        headers={"X-Engine-Token": "   "},
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    "headers, expected_status",
    [
        ({"X-Engine-Token": "test-secret"}, 200),  # correct token passes
        ({"X-Engine-Token": "wrong"}, 401),  # wrong token rejected
        ({"X-Engine-Token": ""}, 401),  # empty token rejected
        ({}, 401),  # missing token rejected
    ],
)
def test_auth_gate_with_secret_set(headers, expected_status, client, fake_provider_factory):
    response = client.post(
        "/accounts/stats",
        headers=headers,
        json={"provider": "gmail", "credentials": {"token": "abc"}},
    )
    assert response.status_code == expected_status


def test_startup_logs_loud_warning_when_secret_unset(monkeypatch, caplog):
    monkeypatch.delenv("ENGINE_SHARED_SECRET", raising=False)
    with caplog.at_level("ERROR", logger="app"):
        # Entering the TestClient context runs the app lifespan (startup).
        with TestClient(app.app):
            pass
    assert any("ENGINE_SHARED_SECRET is not set" in rec.message for rec in caplog.records)


def test_startup_quiet_when_secret_set(monkeypatch, caplog):
    monkeypatch.setenv("ENGINE_SHARED_SECRET", "test-secret")
    with caplog.at_level("ERROR", logger="app"):
        with TestClient(app.app):
            pass
    assert not any("ENGINE_SHARED_SECRET is not set" in rec.message for rec in caplog.records)
