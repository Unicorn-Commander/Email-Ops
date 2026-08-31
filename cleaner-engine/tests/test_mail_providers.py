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
    def __init__(self, send_result, sink, list_result=None, get_results=None):
        self._send_result = send_result
        self._sink = sink
        # poll_inbound drives messages().list + messages().get (metadata).
        self._list_result = list_result or {}
        self._get_results = get_results or {}

    def send(self, **kwargs):
        self._sink.append(("messages.send", kwargs))
        return _GmailExec(self._send_result)

    def list(self, **kwargs):
        self._sink.append(("messages.list", kwargs))
        return _GmailExec(self._list_result)

    def get(self, **kwargs):
        self._sink.append(("messages.get", kwargs))
        return _GmailExec(self._get_results[kwargs["id"]])

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


def _make_gmail(
    list_result=None,
    get_results=None,
    send_result=None,
    msg_list_result=None,
    msg_get_results=None,
):
    sink: list = []
    threads = _FakeThreads(list_result or {}, get_results or {}, sink)
    messages = _FakeMessages(
        send_result or {},
        sink,
        list_result=msg_list_result,
        get_results=msg_get_results,
    )
    provider = GmailProvider()
    provider.service = _FakeGmailService(threads, messages)
    return provider, sink


def test_gmail_list_threads_maps_folder_and_shapes():
    list_result = {"threads": [{"id": "t1"}], "nextPageToken": "NEXT_1"}
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

    threads, next_token = provider.list_threads(folder="archive", limit=10)

    # Folder mapping was applied as the Gmail query.
    list_call = next(c for c in sink if c[0] == "threads.list")
    assert list_call[1]["q"] == _FOLDER_QUERY["archive"]
    assert next_token == "NEXT_1"

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


def test_gmail_list_threads_applies_search_q_and_page_token():
    list_result = {"threads": [{"id": "t9"}]}
    get_results = {
        "t9": {
            "id": "t9",
            "messages": [
                {
                    "id": "m9",
                    "threadId": "t9",
                    "labelIds": ["INBOX"],
                    "internalDate": "1704067200000",
                    "snippet": "promo",
                    "payload": {"headers": _headers(Subject="Sale", **{"From": "p@x.com", "To": "me@example.com"})},
                }
            ],
        }
    }
    provider, sink = _make_gmail(list_result=list_result, get_results=get_results)
    threads, next_token = provider.list_threads(
        folder="inbox",
        limit=5,
        query="from:p@x.com has:attachment",
        page_token="TOK_ABC",
    )
    list_call = next(c for c in sink if c[0] == "threads.list")
    assert list_call[1]["q"] == f"{_FOLDER_QUERY['inbox']} from:p@x.com has:attachment"
    assert list_call[1]["pageToken"] == "TOK_ABC"
    assert list_call[1]["maxResults"] == 5
    assert len(threads) == 1
    assert next_token is None


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


def test_gmail_send_includes_attachment_part():
    """An outbound attachment lands as a real MIME part with its filename+bytes."""
    provider, sink = _make_gmail(send_result={"id": "s1", "threadId": "t9"})
    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Files",
        body="see attached",
        attachments=[{"filename": "hello.txt", "mime_type": "text/plain", "data": b"hi there"}],
    )
    assert result.accepted is True
    send_call = next(c for c in sink if c[0] == "messages.send")
    decoded = base64.urlsafe_b64decode(send_call[1]["body"]["raw"].encode("ascii"))
    parsed = email.message_from_bytes(decoded, policy=policy.default)
    parts = list(parsed.walk())
    att = next(p for p in parts if p.get_filename() == "hello.txt")
    assert att.get_content_type() == "text/plain"
    assert att.get_content().strip() == "hi there"


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
# Gmail poll_inbound (inbound-watcher parity with the sovereign James pollInbound)
# ---------------------------------------------------------------------------

def _gmail_msg(msg_id, thread_id, internal_ms, *, from_="a@example.com",
               to="me@example.com", subject="Hi", autoreply=False):
    headers = _headers(**{"From": from_, "To": to, "Subject": subject})
    if autoreply:
        headers.append({"name": "X-UC-Agent-Autoreply", "value": "1"})
    return {
        "id": msg_id,
        "threadId": thread_id,
        "internalDate": str(internal_ms),
        "payload": {"headers": headers},
    }


def test_gmail_poll_inbound_baseline_captures_cursor_no_backlog():
    """since_iso=None: list only the newest (maxResults=1) to STAMP a non-null
    cursor and return NO backlog."""
    provider, sink = _make_gmail(
        msg_list_result={"messages": [{"id": "m1"}]},
        msg_get_results={"m1": _gmail_msg("m1", "t1", 1704196800000)},  # 2024-01-02T12:00Z
    )

    result = provider.poll_inbound(None)

    # Baseline query narrows to the single newest inbox message.
    list_call = next(c for c in sink if c[0] == "messages.list")
    assert list_call[1]["q"] == "in:inbox"
    assert list_call[1]["maxResults"] == 1

    assert result["new_messages"] == []
    assert result["cursor"] == "2024-01-02T12:00:00+00:00"


def test_gmail_poll_inbound_empty_inbox_still_stamps_cursor():
    """An empty inbox must never re-baseline to null — stamp a non-null cursor."""
    provider, _ = _make_gmail(msg_list_result={"messages": []})
    result = provider.poll_inbound(None)
    assert result["new_messages"] == []
    assert result["cursor"]  # non-null (current time)


def test_gmail_poll_inbound_incremental_only_newer_ascending():
    """since_iso set: return only strictly-newer messages, ascending, with
    from/to/subject/thread_id populated; cursor = max received_at."""
    since = "2024-01-01T12:00:00+00:00"
    provider, sink = _make_gmail(
        # Returned OUT of order on purpose to prove the ascending sort.
        msg_list_result={"messages": [{"id": "m_new2"}, {"id": "m_old"}, {"id": "m_new1"}]},
        msg_get_results={
            "m_old": _gmail_msg("m_old", "t_old", 1704067200000),   # 2024-01-01T00:00Z (older)
            "m_new1": _gmail_msg("m_new1", "t_new1", 1704196800000,  # 2024-01-02T12:00Z
                                 from_="Alice <alice@example.com>", to="me@example.com", subject="One"),
            "m_new2": _gmail_msg("m_new2", "t_new2", 1704283200000,  # 2024-01-03T12:00Z
                                 from_="bob@example.com", to="me@example.com", subject="Two"),
        },
    )

    result = provider.poll_inbound(since)

    # Incremental query narrows candidates with an epoch after: filter.
    list_call = next(c for c in sink if c[0] == "messages.list")
    assert list_call[1]["q"].startswith("in:inbox after:")
    assert list_call[1]["maxResults"] == 50

    ids = [m["thread_id"] for m in result["new_messages"]]
    assert ids == ["t_new1", "t_new2"]  # ascending, older excluded
    first = result["new_messages"][0]
    assert first["from_address"] == "alice@example.com"
    assert first["to_addresses"] == ["me@example.com"]
    assert first["subject"] == "One"
    assert first["received_at"] == "2024-01-02T12:00:00+00:00"
    assert all(m["agent_autoreply"] is False for m in result["new_messages"])
    assert result["cursor"] == "2024-01-03T12:00:00+00:00"


def test_gmail_poll_inbound_flags_agent_autoreply_header():
    """A message carrying X-UC-Agent-Autoreply is flagged agent_autoreply=True."""
    since = "2024-01-01T00:00:00+00:00"
    provider, _ = _make_gmail(
        msg_list_result={"messages": [{"id": "m1"}]},
        msg_get_results={
            "m1": _gmail_msg("m1", "t1", 1704196800000, autoreply=True),
        },
    )
    result = provider.poll_inbound(since)
    assert len(result["new_messages"]) == 1
    assert result["new_messages"][0]["agent_autoreply"] is True


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


def _make_ms(monkeypatch, get_router=None, post_router=None, patch_router=None, delete_router=None):
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

    def fake_patch(url, headers=None, json=None, timeout=None):
        sink.append(("PATCH", url, json))
        return (patch_router or (lambda u, b: _FakeResp()))(url, json)

    def fake_delete(url, headers=None, timeout=None):
        sink.append(("DELETE", url, None))
        return (delete_router or (lambda u: _FakeResp(status_code=204)))(url)

    monkeypatch.setattr("providers.microsoft_provider.requests.get", fake_get)
    monkeypatch.setattr("providers.microsoft_provider.requests.post", fake_post)
    monkeypatch.setattr("providers.microsoft_provider.requests.patch", fake_patch)
    monkeypatch.setattr("providers.microsoft_provider.requests.delete", fake_delete)
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
    threads, next_token = provider.list_threads(folder="spam", limit=10)
    assert next_token is None

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
    """A from: sender containing a single quote is OData-escaped (doubled),
    and a multi-term injection attempt is refused outright — term-honest
    translation never lets trailing terms ride inside the address literal."""
    provider, _ = _make_ms(monkeypatch)
    filt = provider.translate_query("from:o'brien@example.com")
    assert filt == "from/emailAddress/address eq 'o''brien@example.com'"
    # The old best-effort translator swallowed everything after from: into the
    # literal; now a query mixing free text/unknown terms refuses translation.
    assert provider.translate_query("from:a' or isRead eq true or x eq 'b") == ''


def test_ms_translate_query_or_of_from_builds_disjunction(monkeypatch):
    """senderGroup criteria ("from:a OR from:b") become an or-chained filter."""
    provider, _ = _make_ms(monkeypatch)
    filt = provider.translate_query("from:a@x.com OR from:b@y.com")
    assert filt == "(from/emailAddress/address eq 'a@x.com' or from/emailAddress/address eq 'b@y.com')"
    # A disjunction with a non-from operand has no faithful translation.
    assert provider.translate_query("from:a@x.com OR is:unread") == ''


def test_ms_translate_query_never_drops_terms(monkeypatch):
    """Mixed free text + operators is refused, never partially applied — the
    old code turned 'gmktec older_than:30d' into an unscoped all-old-mail
    filter by silently dropping the free text."""
    provider, _ = _make_ms(monkeypatch)
    assert provider.translate_query("gmktec older_than:30d") == ''
    # All-operator conjunctions translate every term.
    filt = provider.translate_query("is:unread older_than:30d")
    assert "isRead eq false and receivedDateTime le " in filt


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


def test_ms_send_sendmail_includes_file_attachment(monkeypatch):
    captured = {}

    def post_router(url, body):
        captured["body"] = body
        return _FakeResp(status_code=202)

    provider, _ = _make_ms(monkeypatch, post_router=post_router)
    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Files",
        body="see attached",
        attachments=[{"filename": "a.txt", "mime_type": "text/plain", "data": b"hi"}],
    )
    assert result.accepted is True
    atts = captured["body"]["message"]["attachments"]
    assert atts[0]["@odata.type"] == "#microsoft.graph.fileAttachment"
    assert atts[0]["name"] == "a.txt"
    assert base64.b64decode(atts[0]["contentBytes"]) == b"hi"


def test_ms_send_reply_attaches_before_send(monkeypatch):
    captured = {"attach_urls": []}
    get_router, post_router, patch_router = _reply_routers(captured)

    def post_with_attach(url, body):
        if url.endswith("/attachments"):
            captured["attach_urls"].append(url)
            return _FakeResp(status_code=201, json_data={"id": "att1"})
        return post_router(url, body)

    provider, sink = _make_ms(
        monkeypatch, get_router=get_router, post_router=post_with_attach, patch_router=patch_router
    )
    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Re: Hi",
        body="bump",
        in_reply_to_thread_id="m1",
        attachments=[{"filename": "a.txt", "mime_type": "text/plain", "data": b"hi"}],
    )
    assert result.accepted is True
    # the attachment POST hit the reply DRAFT, and the send happened after it
    assert captured["attach_urls"] and captured["attach_urls"][0].endswith("/me/messages/draft1/attachments")
    assert captured["send_url"].endswith("/me/messages/draft1/send")


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


def test_ms_list_threads_pure_free_text_uses_search(monkeypatch):
    """Pure free text query should use $search and drop $orderby."""
    messages_page = {
        "value": [
            {
                "id": "m1",
                "conversationId": "c1",
                "subject": "Hello",
                "from": {"emailAddress": {"address": "a@example.com"}},
                "toRecipients": [],
                "receivedDateTime": "2024-01-01T10:00:00Z",
                "isRead": True,
                "bodyPreview": "test",
            }
        ]
    }

    def get_router(url, params):
        # Verify $search is present and $orderby is absent
        assert "$search" in params
        assert params["$search"] == '"hello world"'
        assert "$orderby" not in params
        assert "$filter" not in params
        return _FakeResp(json_data=messages_page)

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    threads, _ = provider.list_threads(folder="inbox", limit=10, query="hello world")
    assert len(threads) == 1


def test_ms_list_threads_mixed_query_raises(monkeypatch):
    """Mixed free text and operators should raise ValueError."""
    def get_router(url, params):
        return _FakeResp()

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    with pytest.raises(ValueError, match="microsoft search not supported"):
        provider.list_threads(folder="inbox", limit=10, query="hello from:a@example.com")


def test_ms_list_threads_unsupported_operator_raises(monkeypatch):
    """Unsupported operator should raise ValueError."""
    def get_router(url, params):
        return _FakeResp()

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    with pytest.raises(ValueError, match="microsoft search not supported"):
        provider.list_threads(folder="inbox", limit=10, query="is:flagged")


# ---------------------------------------------------------------------------
# Microsoft Graph list_messages (cleaner lane) — criteria honesty
# ---------------------------------------------------------------------------

def _ms_list_msg(msg_id, received, **overrides):
    msg = {
        "id": msg_id,
        "conversationId": f"c-{msg_id}",
        "subject": f"Subject {msg_id}",
        "from": {"emailAddress": {"address": "a@example.com"}},
        "receivedDateTime": received,
        "isRead": True,
        "hasAttachments": False,
        "bodyPreview": "preview",
    }
    msg.update(overrides)
    return msg


def test_ms_list_messages_free_text_uses_search_no_filter_no_orderby(monkeypatch):
    """The live bug: plan_cleanup("gmktec") listed the newest 500 UNFILTERED
    messages. Free text must go through $search — never a dropped filter."""
    page = {"value": [_ms_list_msg("m1", "2024-01-01T10:00:00Z")]}
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=page))

    messages, next_token = provider.list_messages("gmktec")

    assert next_token is None
    assert [m.id for m in messages] == ["m1"]
    (_, url, params) = sink[0]
    assert url.endswith("/me/messages")
    assert params["$search"] == '"gmktec"'
    assert "$filter" not in params
    # Graph rejects $search combined with $orderby.
    assert "$orderby" not in params
    # Graph silently drops the size expand under $search — don't send it, and
    # the row is honestly size-UNKNOWN (None, never a fake 0); the backend
    # enriches per message via get_message.
    assert "$expand" not in params
    assert messages[0].size_bytes is None


def test_ms_list_messages_search_escapes_embedded_double_quotes(monkeypatch):
    page = {"value": []}
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=page))
    provider.list_messages('say "hi"')
    (_, _, params) = sink[0]
    assert params["$search"] == '"say \\"hi\\""'


def test_ms_list_messages_from_filter_no_orderby_sorts_client_side(monkeypatch):
    """from: queries were 400ing live ($filter + $orderby on different
    properties); the filter must be sent WITHOUT $orderby, sorted client-side."""
    page = {
        "value": [
            _ms_list_msg("m_old", "2024-01-01T10:00:00Z"),
            _ms_list_msg("m_new", "2024-01-03T10:00:00Z"),
            _ms_list_msg("m_mid", "2024-01-02T10:00:00Z"),
        ]
    }
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=page))

    messages, _ = provider.list_messages("from:x@y.com")

    (_, _, params) = sink[0]
    assert params["$filter"] == "from/emailAddress/address eq 'x@y.com'"
    assert "$orderby" not in params
    assert "$search" not in params
    # The $filter path KEEPS the size expand — it demonstrably works there.
    assert params["$expand"] == "singleValueExtendedProperties($filter=id eq 'Integer 0x0E08')"
    # Newest first despite Graph returning them shuffled.
    assert [m.id for m in messages] == ["m_new", "m_mid", "m_old"]


def test_ms_list_messages_filter_path_maps_real_size_search_path_none(monkeypatch):
    """$filter rows carry the REAL PidTagMessageSize; $search rows (where Graph
    drops the expand) carry None — never a fake 0 (the live freesBytes-0 bug)."""
    sized = {
        "value": [
            _ms_list_msg(
                "m1",
                "2024-01-01T10:00:00Z",
                singleValueExtendedProperties=[{"id": "Integer 0xe08", "value": "86984"}],
            ),
        ]
    }
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=sized))
    messages, _ = provider.list_messages("from:service@gmktec.com")
    assert messages[0].size_bytes == 86984

    # Same message via $search: Graph returns it WITHOUT the property.
    bare = {"value": [_ms_list_msg("m1", "2024-01-01T10:00:00Z")]}
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=bare))
    messages, _ = provider.list_messages("gmktec")
    (_, _, params) = sink[0]
    assert "$expand" not in params
    assert messages[0].size_bytes is None


def test_ms_list_messages_category_filter_no_orderby(monkeypatch):
    page = {"value": []}
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=page))

    provider.list_messages("category:promotions")

    (_, _, params) = sink[0]
    assert params["$filter"] == "inferenceClassification eq 'other'"
    assert "$orderby" not in params
    assert "$search" not in params


def test_ms_list_messages_untranslatable_query_raises_without_fetching(monkeypatch):
    """An unmappable operator query must RAISE — never silently fetch the whole
    mailbox (the root cause of 496 'safe' rows including the user's own mail)."""
    provider, sink = _make_ms(monkeypatch)

    with pytest.raises(ValueError, match="microsoft search not supported"):
        provider.list_messages("gmktec from:x@y.com")
    assert sink == []  # refused BEFORE touching Graph


def test_ms_list_messages_maps_starred_labels_and_real_size(monkeypatch):
    """Rows must carry is_starred (importance), labels (categories) and a REAL
    size from the PidTagMessageSize expand — None when unknown, never a fake 0."""
    page = {
        "value": [
            _ms_list_msg(
                "m1",
                "2024-01-02T10:00:00Z",
                importance="high",
                categories=["Promotions"],
                # Graph normalises the property id casing in responses.
                singleValueExtendedProperties=[{"id": "Integer 0xe08", "value": "2048"}],
            ),
            _ms_list_msg("m2", "2024-01-01T10:00:00Z", importance="normal"),
        ]
    }
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=page))

    messages, _ = provider.list_messages("")

    (_, _, params) = sink[0]
    assert "importance" in params["$select"] and "categories" in params["$select"]
    assert params["$expand"] == "singleValueExtendedProperties($filter=id eq 'Integer 0x0E08')"
    by_id = {m.id: m for m in messages}
    assert by_id["m1"].is_starred is True
    assert by_id["m1"].labels == ["Promotions"]
    assert by_id["m1"].size_bytes == 2048
    assert by_id["m2"].is_starred is False
    assert by_id["m2"].labels == []
    assert by_id["m2"].size_bytes is None  # unknown, not a fake 0


def test_ms_get_message_maps_labels_and_size(monkeypatch):
    msg = _ms_list_msg(
        "m1",
        "2024-01-02T10:00:00Z",
        importance="high",
        categories=["Receipts"],
        toRecipients=[],
        singleValueExtendedProperties=[{"id": "Integer 0x0E08", "value": "4096"}],
    )
    provider, sink = _make_ms(monkeypatch, get_router=lambda u, p: _FakeResp(json_data=msg))

    email_msg = provider.get_message("m1")

    (_, _, params) = sink[0]
    assert "categories" in params["$select"]
    assert "$expand" in params
    assert email_msg.is_starred is True
    assert email_msg.labels == ["Receipts"]
    assert email_msg.size_bytes == 4096


# ---------------------------------------------------------------------------
# Microsoft Graph reply threading (createReply -> PATCH -> send)
# ---------------------------------------------------------------------------

def _reply_routers(captured, resolve_direct=True, patch_status=200, send_status=202):
    """Routers that serve the reply lane: message-id probe (or conversation
    listing), createReply, PATCH, /send."""

    def get_router(url, params):
        if url.endswith("/me/messages/m1"):
            if resolve_direct:
                return _FakeResp(200, {"id": "m1"})
            return _FakeResp(404)
        if url.endswith("/me/messages"):
            # conversation fallback: newest message wins (client-side sort)
            return _FakeResp(200, {"value": [
                {"id": "m_old", "receivedDateTime": "2026-08-01T00:00:00Z"},
                {"id": "m_new", "receivedDateTime": "2026-08-20T00:00:00Z"},
            ]})
        return _FakeResp(404)

    def post_router(url, body):
        if url.endswith("/createReply"):
            captured["create_url"] = url
            return _FakeResp(201, {"id": "draft1", "conversationId": "conv9"})
        if url.endswith("/me/messages/draft1/send"):
            captured["send_url"] = url
            return _FakeResp(status_code=send_status)
        captured["unexpected_post"] = url
        return _FakeResp(status_code=202)

    def patch_router(url, body):
        captured["patch_url"] = url
        captured["patch_body"] = body
        return _FakeResp(patch_status, {"id": "draft1", "conversationId": "conv9"})

    return get_router, post_router, patch_router


def test_ms_send_reply_threads_via_createreply(monkeypatch):
    captured = {}
    get_router, post_router, patch_router = _reply_routers(captured)
    provider, sink = _make_ms(
        monkeypatch, get_router=get_router, post_router=post_router, patch_router=patch_router
    )

    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Re: Hello",
        body="bump text",
        in_reply_to_thread_id="m1",
    )

    assert result.accepted is True
    assert result.provider_message_id == "draft1"
    assert result.thread_id == "conv9"  # REAL conversationId, not the echo
    assert captured["create_url"].endswith("/me/messages/m1/createReply")
    assert captured["send_url"].endswith("/me/messages/draft1/send")
    # PATCH pins body + recipients (createReply would address ourselves on a
    # reply to our own sent message).
    assert captured["patch_body"]["body"]["content"] == "bump text"
    assert captured["patch_body"]["toRecipients"][0]["emailAddress"]["address"] == "you@example.com"
    assert captured["patch_body"]["subject"] == "Re: Hello"
    # the plain send lane must NOT be used
    assert not any(u.endswith("/me/sendMail") for verb, u, _ in sink if verb == "POST")


def test_ms_send_reply_resolves_conversation_id_to_newest_message(monkeypatch):
    captured = {}
    get_router, post_router, patch_router = _reply_routers(captured, resolve_direct=False)
    provider, _ = _make_ms(
        monkeypatch, get_router=get_router, post_router=post_router, patch_router=patch_router
    )

    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Re: Hello",
        body="bump",
        in_reply_to_thread_id="m1",  # unresolvable as a message id -> treated as conversationId
    )

    assert result.accepted is True
    assert captured["create_url"].endswith("/me/messages/m_new/createReply")


def test_ms_send_reply_patch_failure_cleans_up_without_sendmail_fallback(monkeypatch):
    captured = {}
    get_router, post_router, patch_router = _reply_routers(captured, patch_status=400)
    provider, sink = _make_ms(
        monkeypatch, get_router=get_router, post_router=post_router, patch_router=patch_router
    )

    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="s",
        body="b",
        in_reply_to_thread_id="m1",
    )

    assert result.accepted is False
    assert result.reason == "graph_reply_patch_400"
    # the orphan reply draft is cleaned up, and we never double-send
    assert any(u.endswith("/me/messages/draft1") for verb, u, _ in sink if verb == "DELETE")
    assert not any(u.endswith("/me/sendMail") for verb, u, _ in sink if verb == "POST")


def test_ms_send_without_reply_target_posts_sendmail(monkeypatch):
    captured = {}

    def post_router(url, body):
        captured["url"] = url
        captured["body"] = body
        return _FakeResp(status_code=202)

    provider, sink = _make_ms(monkeypatch, post_router=post_router)
    result = provider.send_message(
        from_addr="me@example.com",
        to_addr="you@example.com",
        subject="Hello",
        body="body text",
    )

    assert result.accepted is True
    assert result.provider_message_id is None
    assert result.thread_id is None
    assert captured["url"].endswith("/me/sendMail")
    # no reply-lane traffic at all
    assert not any(verb in ("PATCH", "DELETE") for verb, _, _ in sink)


# ---------------------------------------------------------------------------
# Microsoft Graph poll_inbound (inbound-watcher parity with James pollInbound)
# ---------------------------------------------------------------------------

def test_ms_poll_inbound_incremental_filters_and_maps(monkeypatch):
    """Incremental poll: $filter carries receivedDateTime gt, and each message
    maps conversationId->thread_id with a normalised received_at (ascending)."""
    since = "2024-01-01T00:00:00+00:00"
    page = {
        "value": [
            {
                "id": "m2",
                "conversationId": "c2",
                "subject": "Two",
                "from": {"emailAddress": {"address": "b@example.com", "name": "B"}},
                "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
                "receivedDateTime": "2024-01-03T10:00:00Z",
            },
            {
                "id": "m1",
                "conversationId": "c1",
                "subject": "One",
                "from": {"emailAddress": {"address": "a@example.com"}},
                "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
                "receivedDateTime": "2024-01-02T10:00:00Z",
            },
        ]
    }

    captured = {}

    def get_router(url, params):
        assert url.endswith("/me/mailFolders/inbox/messages")
        captured["params"] = params
        return _FakeResp(json_data=page)

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    result = provider.poll_inbound(since)

    assert captured["params"]["$filter"] == "receivedDateTime gt 2024-01-01T00:00:00+00:00"
    assert captured["params"]["$orderby"] == "receivedDateTime desc"

    # Only newer messages, ascending by received_at, conversationId -> thread_id.
    assert [m["thread_id"] for m in result["new_messages"]] == ["c1", "c2"]
    first = result["new_messages"][0]
    assert first["from_address"] == "a@example.com"
    assert first["to_addresses"] == ["me@example.com"]
    assert first["subject"] == "One"
    assert first["received_at"] == "2024-01-02T10:00:00+00:00"
    assert result["cursor"] == "2024-01-03T10:00:00+00:00"


def test_ms_poll_inbound_baseline_stamps_cursor_no_backlog(monkeypatch):
    """Baseline (since None): no $filter, $top=1, non-null cursor, no backlog."""
    page = {"value": [{
        "id": "m1", "conversationId": "c1", "subject": "Hi",
        "from": {"emailAddress": {"address": "a@example.com"}},
        "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
        "receivedDateTime": "2024-01-02T10:00:00Z",
    }]}
    captured = {}

    def get_router(url, params):
        captured["params"] = params
        return _FakeResp(json_data=page)

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    result = provider.poll_inbound(None)

    assert "$filter" not in captured["params"]
    assert captured["params"]["$top"] == 1
    assert result["new_messages"] == []
    assert result["cursor"] == "2024-01-02T10:00:00+00:00"


def test_ms_poll_inbound_flags_agent_autoreply_header(monkeypatch):
    """A message whose internetMessageHeaders carry X-UC-Agent-Autoreply is
    flagged agent_autoreply=True (case-insensitive, non-empty value)."""
    since = "2024-01-01T00:00:00+00:00"
    page = {"value": [{
        "id": "m1", "conversationId": "c1", "subject": "Auto",
        "from": {"emailAddress": {"address": "a@example.com"}},
        "toRecipients": [{"emailAddress": {"address": "me@example.com"}}],
        "receivedDateTime": "2024-01-02T10:00:00Z",
        "internetMessageHeaders": [
            {"name": "x-uc-agent-autoreply", "value": "yes"},
        ],
    }]}

    def get_router(url, params):
        return _FakeResp(json_data=page)

    provider, _ = _make_ms(monkeypatch, get_router=get_router)
    result = provider.poll_inbound(since)
    assert len(result["new_messages"]) == 1
    assert result["new_messages"][0]["agent_autoreply"] is True


def test_ms_graph_get_retries_once_after_429(monkeypatch):
    """A throttled GET is retried after Retry-After instead of failing the
    enrichment call — live plan_cleanup bursts hit Graph 429s and every 429'd
    get_message degraded its row back to size-unknown."""
    slept = []
    monkeypatch.setattr("providers.microsoft_provider.time.sleep", lambda s: slept.append(s))
    calls = {"n": 0}

    def get_router(url, params):
        calls["n"] += 1
        if calls["n"] == 1:
            resp = _FakeResp(status_code=429)
            resp.headers = {"Retry-After": "1"}
            return resp
        return _FakeResp(json_data={"id": "m1", "conversationId": "c1", "subject": "S",
                                    "from": {"emailAddress": {"address": "a@x.com"}},
                                    "toRecipients": [], "receivedDateTime": "2026-01-01T00:00:00Z",
                                    "isRead": True})

    provider, sink = _make_ms(monkeypatch, get_router=get_router)
    result = provider._graph_get("/me/messages/m1")
    assert result["id"] == "m1"
    assert calls["n"] == 2
    assert slept == [1]


def test_ms_graph_get_gives_up_after_bounded_retries(monkeypatch):
    """Persistent 429s still raise (bounded retry, no infinite loop)."""
    monkeypatch.setattr("providers.microsoft_provider.time.sleep", lambda s: None)

    def get_router(url, params):
        resp = _FakeResp(status_code=429)
        resp.headers = {"Retry-After": "0"}
        return resp

    provider, sink = _make_ms(monkeypatch, get_router=get_router)
    with pytest.raises(Exception):
        provider._graph_get("/me/messages/m1")
    assert len(sink) == 3
