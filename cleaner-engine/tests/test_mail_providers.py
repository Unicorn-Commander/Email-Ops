"""
Provider-level tests for the unified mail client (threads / thread / send).

These exercise the REAL provider mapping logic (folder->query, conversation
grouping, MIME/JSON build, direction inference) by faking the Gmail API
``service`` object and the Microsoft Graph ``requests`` layer.
"""
from __future__ import annotations

import base64
import email
from email import policy

import pytest

from providers.gmail_provider import GmailProvider, _FOLDER_QUERY
from providers.microsoft_provider import MicrosoftGraphProvider, _FOLDER_ID


# ---------------------------------------------------------------------------
# Gmail fakes
# ---------------------------------------------------------------------------

class _GmailExec:
    def __init__(self, value):
        self._value = value

    def execute(self, **kwargs):
        return self._value


class _FakeThreads:
    def __init__(self, list_result, get_results, sink):
        self._list_result = list_result
        self._get_results = get_results
        self._sink = sink

    def list(self, **kwargs):
        self._sink.append(("threads.list", kwargs))
        return _GmailExec(self._list_result)

    def get(self, **kwargs):
        self._sink.append(("threads.get", kwargs))
        return _GmailExec(self._get_results[kwargs["id"]])


class _FakeMessages:
    def __init__(self, send_result, sink):
        self._send_result = send_result
        self._sink = sink

    def send(self, **kwargs):
        self._sink.append(("messages.send", kwargs))
        return _GmailExec(self._send_result)

    def batchModify(self, **kwargs):
        self._sink.append(("messages.batchModify", kwargs))
        return _GmailExec({})

    def import_(self, **kwargs):
        self._sink.append(("messages.import_", kwargs))
        return _GmailExec({"id": "imported-1"})


class _FakeUsers:
    def __init__(self, threads, messages):
        self._threads = threads
        self._messages = messages

    def threads(self):
        return self._threads

    def messages(self):
        return self._messages


class _FakeGmailService:
    def __init__(self, threads, messages):
        self._users = _FakeUsers(threads, messages)

    def users(self):
        return self._users


def _headers(**kv):
    return [{"name": k, "value": v} for k, v in kv.items()]


def _make_gmail(list_result=None, get_results=None, send_result=None):
    sink: list = []
    threads = _FakeThreads(list_result or {}, get_results or {}, sink)
    messages = _FakeMessages(send_result or {}, sink)
    provider = GmailProvider()
    provider.service = _FakeGmailService(threads, messages)
    return provider, sink


def test_gmail_list_threads_maps_folder_and_shapes():
    list_result = {"threads": [{"id": "t1"}]}
    get_results = {
        "t1": {
            "id": "t1",
            "messages": [
                {
                    "id": "m1",
                    "threadId": "t1",
                    "labelIds": ["INBOX", "UNREAD"],
                    "internalDate": "1704067200000",
                    "snippet": "first",
                    "payload": {"headers": _headers(Subject="Hello", **{"From": "Alice <a@example.com>", "To": "me@example.com"})},
                },
                {
                    "id": "m2",
                    "threadId": "t1",
                    "labelIds": ["INBOX"],
                    "internalDate": "1704153600000",
                    "snippet": "second",
                    "payload": {"headers": _headers(**{"From": "Bob <b@example.com>", "To": "me@example.com"})},
                },
            ],
        }
    }
    provider, sink = _make_gmail(list_result=list_result, get_results=get_results)

    threads = provider.list_threads(folder="archive", limit=10)

    # Folder mapping was applied as the Gmail query.
    list_call = next(c for c in sink if c[0] == "threads.list")
    assert list_call[1]["q"] == _FOLDER_QUERY["archive"]

    assert len(threads) == 1
    t = threads[0]
    assert t.id == "t1"
    assert t.subject == "Hello"
    assert t.message_count == 2
    assert t.unread is True
    assert t.last_snippet == "second"
    assert t.last_message_at.startswith("2024-01-02")
    addrs = {p.address for p in t.participants}
    assert addrs == {"a@example.com", "b@example.com", "me@example.com"}


def test_gmail_get_thread_infers_direction():
    get_results = {
        "t1": {
            "id": "t1",
            "messages": [
                {
                    "id": "m1",
                    "threadId": "t1",
                    "labelIds": ["INBOX"],
                    "internalDate": "1704067200000",
                    "snippet": "incoming",
                    "payload": {"headers": _headers(Subject="Hi", **{"From": "a@example.com", "To": "me@example.com", "Date": "Mon, 01 Jan 2024 00:00:00 +0000"})},
                },
                {
                    "id": "m2",
                    "threadId": "t1",
                    "labelIds": ["SENT"],
                    "snippet": "reply",
                    "payload": {"headers": _headers(**{"From": "me@example.com", "To": "a@example.com"})},
                },
                {
                    "id": "m3",
                    "threadId": "t1",
                    "labelIds": ["DRAFT"],
                    "snippet": "draft",
                    "payload": {"headers": _headers(**{"From": "me@example.com"})},
                },
            ],
        }
    }
    provider, _ = _make_gmail(get_results=get_results)

    messages = provider.get_thread("t1")
    assert [m.direction for m in messages] == ["received", "sent", "draft"]
    assert messages[0].sender.address == "a@example.com"
    assert messages[0].to[0].address == "me@example.com"
    assert messages[0].sent_at.startswith("2024-01-01")


def test_gmail_send_builds_mime_and_threads_reply():
    # threads.get is consulted for the In-Reply-To reference on replies.
    get_results = {
        "t1": {
            "id": "t1",
            "messages": [
                {"id": "m1", "payload": {"headers": _headers(**{"Message-Id": "<orig@example.com>"})}},
            ],
        }
    }
    provider, sink = _make_gmail(get_results=get_results, send_result={"id": "sent-99", "threadId": "t1"})

    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Re: Hi",
        body="hello body",
        in_reply_to_thread_id="t1",
    )

    assert result.accepted is True
    assert result.provider_message_id == "sent-99"
    assert result.thread_id == "t1"

    send_call = next(c for c in sink if c[0] == "messages.send")
    body = send_call[1]["body"]
    assert body["threadId"] == "t1"
    decoded = base64.urlsafe_b64decode(body["raw"].encode("ascii"))
    parsed = email.message_from_bytes(decoded, policy=policy.default)
    assert parsed["To"] == "you@example.com"
    assert parsed["From"] == "me@example.com"
    assert parsed["Subject"] == "Re: Hi"
    assert parsed["In-Reply-To"] == "<orig@example.com>"
    assert "hello body" in parsed.get_content()


def test_gmail_batch_spam_adds_spam_and_drops_inbox():
    """Spam is a LABEL edit: add SPAM, remove INBOX (batchModify, one call/100)."""
    provider, sink = _make_gmail()

    assert provider.batch_spam(["m1", "m2"]) == 2

    modify_calls = [c for c in sink if c[0] == "messages.batchModify"]
    assert len(modify_calls) == 1
    assert modify_calls[0][1]["body"] == {
        "ids": ["m1", "m2"],
        "addLabelIds": ["SPAM"],
        "removeLabelIds": ["INBOX"],
    }


def test_gmail_batch_restore_inbox_adds_inbox_and_drops_spam_trash():
    """Restore reverses spam AND trash in one edit: batch_trash trashes by ADDING
    the TRASH label (batchModify), so removing SPAM+TRASH here untrashes too —
    no separate untrash call."""
    provider, sink = _make_gmail()

    assert provider.batch_restore_inbox(["m1"]) == 1

    modify_calls = [c for c in sink if c[0] == "messages.batchModify"]
    assert len(modify_calls) == 1
    assert modify_calls[0][1]["body"] == {
        "ids": ["m1"],
        "addLabelIds": ["INBOX"],
        "removeLabelIds": ["SPAM", "TRASH"],
    }


def test_gmail_import_message_reapplies_labels_and_filters_trash():
    """Restore fidelity: import re-applies the archived label state so read/star/labels
    survive a permanent-delete undo, but drops TRASH/SPAM so it never lands back in
    trash/spam. UNREAD is preserved only if it was in the archived set (read stays read).
    """
    provider, sink = _make_gmail()

    # A read (no UNREAD), starred, custom-labeled message that had been trashed.
    new_id = provider.import_message(
        b"raw-mime-bytes",
        label_ids=["INBOX", "STARRED", "IMPORTANT", "Label_5", "TRASH", "SPAM"],
    )
    assert new_id == "imported-1"

    imports = [c for c in sink if c[0] == "messages.import_"]
    assert len(imports) == 1
    body = imports[0][1]["body"]
    # TRASH + SPAM filtered out; everything else re-applied (order preserved).
    assert body["labelIds"] == ["INBOX", "STARRED", "IMPORTANT", "Label_5"]
    assert imports[0][1]["neverMarkSpam"] is True
    assert imports[0][1]["internalDateSource"] == "dateHeader"


def test_gmail_import_message_without_labels_omits_labelids():
    """A legacy (<=2.0) archive entry has no labels → import must not send an empty
    labelIds (which would strip the message to no labels)."""
    provider, sink = _make_gmail()
    provider.import_message(b"raw", label_ids=None)
    body = [c for c in sink if c[0] == "messages.import_"][0][1]["body"]
    assert "labelIds" not in body


# ---------------------------------------------------------------------------
# Microsoft Graph fakes (mock the `requests` layer the provider uses)
# ---------------------------------------------------------------------------

class _FakeResp:
    def __init__(self, status_code=200, json_data=None):
        self.status_code = status_code
        self._json = json_data or {}
        self.headers = {}

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")


def _make_ms(monkeypatch, get_router=None, post_router=None):
    provider = MicrosoftGraphProvider.__new__(MicrosoftGraphProvider)
    provider.client_id = ""
    provider.client_secret = ""
    provider.tenant_id = "common"
    provider._access_token = "token"
    sink: list = []

    def fake_get(url, headers=None, params=None, timeout=None):
        sink.append(("GET", url, params))
        return (get_router or (lambda u, p: _FakeResp()))(url, params)

    def fake_post(url, headers=None, json=None, timeout=None):
        sink.append(("POST", url, json))
        return (post_router or (lambda u, b: _FakeResp(status_code=202)))(url, json)

    monkeypatch.setattr("providers.microsoft_provider.requests.get", fake_get)
    monkeypatch.setattr("providers.microsoft_provider.requests.post", fake_post)
    return provider, sink


def test_ms_list_threads_groups_by_conversation(monkeypatch):
    messages_page = {
        "value": [
            {
                "id": "m1",
                "conversationId": "c1",
                "subject": "Topic A",
                "from": {"emailAddress": {"address": "a@example.com", "name": "A"}},
                "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
                "receivedDateTime": "2024-01-02T10:00:00Z",
                "isRead": False,
                "bodyPreview": "newer",
            },
            {
                "id": "m2",
                "conversationId": "c1",
                "subject": "Topic A",
                "from": {"emailAddress": {"address": "b@example.com", "name": "B"}},
                "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
                "receivedDateTime": "2024-01-01T10:00:00Z",
                "isRead": True,
                "bodyPreview": "older",
            },
            {
                "id": "m3",
                "conversationId": "c2",
                "subject": "Topic B",
                "from": {"emailAddress": {"address": "c@example.com"}},
                "toRecipients": [],
                "receivedDateTime": "2024-01-03T10:00:00Z",
                "isRead": True,
                "bodyPreview": "other",
            },
        ]
    }

    def get_router(url, params):
        assert _FOLDER_ID["spam"] in url  # folder mapping applied
        return _FakeResp(json_data=messages_page)

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    threads = provider.list_threads(folder="spam", limit=10)

    assert len(threads) == 2
    by_id = {t.id: t for t in threads}
    assert by_id["c1"].message_count == 2
    assert by_id["c1"].unread is True  # one unread message in the conversation
    assert by_id["c1"].last_snippet == "newer"
    assert {p.address for p in by_id["c1"].participants} == {"a@example.com", "b@example.com", "me@example.com"}
    assert by_id["c2"].unread is False


def test_ms_get_thread_infers_direction(monkeypatch):
    thread_page = {
        "value": [
            {
                "id": "m1",
                "conversationId": "c1",
                "subject": "Hi",
                "from": {"emailAddress": {"address": "a@example.com"}},
                "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
                "sentDateTime": "2024-01-01T10:00:00Z",
                "isDraft": False,
            },
            {
                "id": "m2",
                "conversationId": "c1",
                "subject": "Re: Hi",
                "from": {"emailAddress": {"address": "me@example.com"}},
                "toRecipients": [{"emailAddress": {"address": "a@example.com"}}],
                "sentDateTime": "2024-01-02T10:00:00Z",
                "isDraft": False,
            },
            {
                "id": "m3",
                "conversationId": "c1",
                "from": {"emailAddress": {"address": "me@example.com"}},
                "isDraft": True,
            },
        ]
    }

    def get_router(url, params):
        if url.endswith("/me"):
            return _FakeResp(json_data={"mail": "me@example.com"})
        return _FakeResp(json_data=thread_page)

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    messages = provider.get_thread("c1")
    assert [m.direction for m in messages] == ["received", "sent", "draft"]
    assert messages[0].sent_at.startswith("2024-01-01")


def test_ms_get_thread_escapes_odata_single_quote(monkeypatch):
    """A thread_id with a single quote must not break out of the $filter literal.

    OData escapes a single quote by doubling it, so an injected ``'`` becomes
    ``''`` and stays inside the string literal.
    """
    provider, sink = _make_ms(monkeypatch)
    # Without escaping, this would close the literal and inject an OData clause.
    provider.get_thread("c1' or isRead eq true or conversationId eq 'x")

    messages_calls = [
        params for (verb, url, params) in sink
        if verb == "GET" and url.endswith("/me/messages") and params and "$filter" in params
    ]
    assert messages_calls, "expected a /me/messages GET carrying a $filter"
    filt = messages_calls[0]["$filter"]
    # The injected single quotes are doubled, keeping everything inside the literal.
    assert filt == "conversationId eq 'c1'' or isRead eq true or conversationId eq ''x'"
    # And the dangerous *unescaped* form must NOT appear.
    assert "conversationId eq 'c1' or isRead eq true" not in filt


def test_ms_get_thread_no_orderby_sorts_client_side(monkeypatch):
    """Graph returns 400 when $orderby names a property other than the one in
    $filter (we filter on conversationId), so get_thread must NOT send $orderby
    and must sort the conversation chronologically client-side instead."""
    # Graph returns the messages OUT of chronological order on purpose.
    thread_page = {
        "value": [
            {
                "id": "m2",
                "conversationId": "c1",
                "from": {"emailAddress": {"address": "a@example.com"}},
                "receivedDateTime": "2024-01-02T10:00:00Z",
                "sentDateTime": "2024-01-02T10:00:00Z",
                "isDraft": False,
            },
            {
                "id": "m1",
                "conversationId": "c1",
                "from": {"emailAddress": {"address": "a@example.com"}},
                "receivedDateTime": "2024-01-01T10:00:00Z",
                "sentDateTime": "2024-01-01T10:00:00Z",
                "isDraft": False,
            },
        ]
    }

    def get_router(url, params):
        if url.endswith("/me"):
            return _FakeResp(json_data={"mail": "me@example.com"})
        return _FakeResp(json_data=thread_page)

    provider, sink = _make_ms(monkeypatch, get_router=get_router)
    messages = provider.get_thread("c1")

    # The conversationId-filtered query must NOT carry $orderby (avoids Graph 400).
    msg_calls = [
        params for (verb, url, params) in sink
        if verb == "GET" and url.endswith("/me/messages") and params and "$filter" in params
    ]
    assert msg_calls, "expected a /me/messages GET with a $filter"
    assert "$orderby" not in msg_calls[0]
    # Sorted chronologically client-side despite Graph returning them reversed.
    assert [m.id for m in messages] == ["m1", "m2"]


def test_ms_translate_query_escapes_from_sender_single_quote(monkeypatch):
    """A from: sender containing a single quote is OData-escaped (doubled)."""
    provider, _ = _make_ms(monkeypatch)
    filt = provider.translate_query("from:a' or isRead eq true or x eq 'b")
    assert filt == "from/emailAddress/address eq 'a'' or isRead eq true or x eq ''b'"
    assert "address eq 'a' or isRead eq true" not in filt


def test_ms_send_posts_sendmail(monkeypatch):
    captured = {}

    def post_router(url, body):
        captured["url"] = url
        captured["body"] = body
        return _FakeResp(status_code=202)

    provider, _ = _make_ms(monkeypatch, post_router=post_router)
    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Hello",
        body="body text",
        in_reply_to_thread_id="c1",
    )

    assert result.accepted is True
    assert result.thread_id == "c1"
    assert captured["url"].endswith("/me/sendMail")
    msg = captured["body"]["message"]
    assert msg["subject"] == "Hello"
    assert msg["toRecipients"][0]["emailAddress"]["address"] == "you@example.com"
    assert msg["body"]["content"] == "body text"


def test_ms_send_returns_accepted_false_on_error_status(monkeypatch):
    provider, _ = _make_ms(monkeypatch, post_router=lambda u, b: _FakeResp(status_code=403))
    result = provider.send_message("me@example.com", "you@example.com", "s", "b")
    assert result.accepted is False
    assert result.reason == "graph_status_403"


def _ms_move_router(folder_key: str, folder_id: str, captured: list):
    """Routers for the $batch move verbs: serve the well-known folder id on GET,
    capture + succeed each /$batch POST."""

    def get_router(url, params):
        assert url.endswith(f"/me/mailFolders/{folder_key}")
        return _FakeResp(json_data={"id": folder_id})

    def post_router(url, body):
        assert url.endswith("/$batch")
        captured.append(body)
        return _FakeResp(
            status_code=200,
            json_data={"responses": [{"id": r["id"], "status": 201} for r in body["requests"]]},
        )

    return get_router, post_router


def test_ms_batch_spam_moves_to_junkemail(monkeypatch):
    """Spam is a folder MOVE to the junkemail well-known folder (Graph $batch)."""
    captured: list = []
    get_router, post_router = _ms_move_router("junkemail", "junk-folder-id", captured)
    provider, _ = _make_ms(monkeypatch, get_router=get_router, post_router=post_router)

    assert provider.batch_spam(["m1", "m2"]) == 2

    assert len(captured) == 1
    requests_ = captured[0]["requests"]
    assert [r["url"] for r in requests_] == ["/me/messages/m1/move", "/me/messages/m2/move"]
    assert all(r["body"] == {"destinationId": "junk-folder-id"} for r in requests_)


def test_ms_batch_restore_inbox_moves_to_inbox(monkeypatch):
    """Restore is a folder MOVE back to the inbox well-known folder."""
    captured: list = []
    get_router, post_router = _ms_move_router("inbox", "inbox-folder-id", captured)
    provider, _ = _make_ms(monkeypatch, get_router=get_router, post_router=post_router)

    assert provider.batch_restore_inbox(["m1"]) == 1

    assert len(captured) == 1
    requests_ = captured[0]["requests"]
    assert [r["url"] for r in requests_] == ["/me/messages/m1/move"]
    assert requests_[0]["body"] == {"destinationId": "inbox-folder-id"}


def test_ms_get_thread_degrades_when_account_lookup_fails(monkeypatch):
    """If /me fails, account lookup degrades to '' and direction falls back to received."""
    thread_page = {
        "value": [
            {
                "id": "m1",
                "conversationId": "c1",
                "from": {"emailAddress": {"address": "me@example.com"}},
                "toRecipients": [],
                "sentDateTime": "2024-01-01T10:00:00Z",
                "isDraft": False,
            }
        ]
    }

    def get_router(url, params):
        if url.endswith("/me"):
            return _FakeResp(status_code=500)
        return _FakeResp(json_data=thread_page)

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    messages = provider.get_thread("c1")
    # account == '' so even a self-sent message is reported as received (safe default)
    assert messages[0].direction == "received"
