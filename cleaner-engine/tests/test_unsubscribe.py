"""Per-sender unsubscribe branches: one-click / mailto / link_returned / unavailable / failed."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from cleanup.unsubscribe import (
    STATUS_FAILED,
    STATUS_LINK_RETURNED,
    STATUS_UNAVAILABLE,
    STATUS_UNSUBSCRIBED,
    has_one_click_post,
    parse_list_unsubscribe,
    unsubscribe_sender,
    unsubscribe_senders,
)
from providers.mail_client import SendResult


class _Msg:
    def __init__(self, mid, sender, headers):
        self.id = mid
        self.sender = sender
        self.headers = headers
        self.subject = "promo"
        self.labels = []


class _StubProvider:
    def __init__(self, message: _Msg | None, send_ok: bool = True):
        self._message = message
        self.send_ok = send_ok
        self.sent = []

    def list_messages(self, query="", max_results=100, page_token=None, folder=None):
        if self._message is None:
            return [], None
        return [SimpleNamespace(id=self._message.id)], None

    def get_message(self, message_id, format="metadata"):
        assert self._message is not None
        return self._message

    def send_message(self, from_addr, to_addr, subject, body, in_reply_to_thread_id=None):
        self.sent.append((to_addr, subject, body))
        return SendResult(accepted=self.send_ok, provider_message_id="s1", thread_id=None)


def test_parse_list_unsubscribe_angle_brackets():
    uris = parse_list_unsubscribe(
        "<https://ex.example/u>, <mailto:unsub@ex.example?subject=bye>"
    )
    assert uris == [
        "https://ex.example/u",
        "mailto:unsub@ex.example?subject=bye",
    ]


def test_has_one_click_post():
    assert has_one_click_post("List-Unsubscribe=One-Click") is True
    assert has_one_click_post("list-unsubscribe=one-click") is True
    assert has_one_click_post(None) is False
    assert has_one_click_post("something-else") is False


def test_one_click_unsubscribed():
    msg = _Msg(
        "m1",
        "Promo <promo@shop.com>",
        {
            "List-Unsubscribe": "<https://shop.example/unsub>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    )
    provider = _StubProvider(msg)
    with patch("cleanup.unsubscribe.requests.post") as post:
        post.return_value = SimpleNamespace(status_code=200)
        result = unsubscribe_sender(provider, "promo@shop.com")
    assert result.status == STATUS_UNSUBSCRIBED
    assert result.method == "one_click"
    assert result.url == "https://shop.example/unsub"
    post.assert_called_once()
    # Must be a POST with the RFC 8058 body — never a GET.
    assert post.call_args.kwargs.get("data") == {"List-Unsubscribe": "One-Click"}


def test_one_click_never_follows_redirects():
    """SECURITY INVARIANT: allow_redirects must be False.

    requests downgrades POST -> GET on a 301/302/303, so following a redirect
    would silently perform the arbitrary GET fetch this module promises never
    to do (tracker confirmation, and SSRF to an attacker-chosen Location).
    A 3xx still counts as accepted — we just decline to follow it.
    """
    msg = _Msg(
        "m1",
        "Promo <promo@shop.com>",
        {
            "List-Unsubscribe": "<https://shop.example/unsub>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    )
    provider = _StubProvider(msg)
    with patch("cleanup.unsubscribe.requests.post") as post:
        post.return_value = SimpleNamespace(status_code=302)
        result = unsubscribe_sender(provider, "promo@shop.com")
    assert post.call_args.kwargs.get("allow_redirects") is False
    # A redirect response is still a successful one-click, un-followed.
    assert result.status == STATUS_UNSUBSCRIBED


def test_one_click_failed_http():
    msg = _Msg(
        "m1",
        "Promo <promo@shop.com>",
        {
            "List-Unsubscribe": "<https://shop.example/unsub>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    )
    provider = _StubProvider(msg)
    with patch("cleanup.unsubscribe.requests.post") as post:
        post.return_value = SimpleNamespace(status_code=500)
        result = unsubscribe_sender(provider, "promo@shop.com")
    assert result.status == STATUS_FAILED
    assert result.method == "one_click"


def test_mailto_unsubscribed():
    msg = _Msg(
        "m1",
        "News <news@list.com>",
        {"List-Unsubscribe": "<mailto:leave@list.com?subject=unsubscribe>"},
    )
    provider = _StubProvider(msg)
    result = unsubscribe_sender(provider, "news@list.com")
    assert result.status == STATUS_UNSUBSCRIBED
    assert result.method == "mailto"
    assert provider.sent == [("leave@list.com", "unsubscribe", "Please unsubscribe me.")]


def test_link_returned_never_fetches_get():
    msg = _Msg(
        "m1",
        "Shop <shop@x.com>",
        {"List-Unsubscribe": "<https://x.com/unsub?token=abc>"},
    )
    provider = _StubProvider(msg)
    with patch("cleanup.unsubscribe.requests.get") as get:
        with patch("cleanup.unsubscribe.requests.post") as post:
            result = unsubscribe_sender(provider, "shop@x.com")
    assert result.status == STATUS_LINK_RETURNED
    assert result.method == "link"
    assert result.url == "https://x.com/unsub?token=abc"
    get.assert_not_called()
    post.assert_not_called()


def test_unavailable_no_headers():
    msg = _Msg("m1", "Friend <friend@example.com>", {})
    provider = _StubProvider(msg)
    result = unsubscribe_sender(provider, "friend@example.com")
    assert result.status == STATUS_UNAVAILABLE
    assert result.method == "filter"
    assert "no unsubscribe" in (result.detail or "").lower() or "filter" in (result.detail or "").lower()


def test_unavailable_no_message():
    provider = _StubProvider(None)
    result = unsubscribe_sender(provider, "missing@example.com")
    assert result.status == STATUS_UNAVAILABLE


def test_batch_per_sender_never_blanket():
    # First sender one-click, second no message → mixed outcomes in one batch.
    msg = _Msg(
        "m1",
        "A <a@x.com>",
        {
            "List-Unsubscribe": "<https://a.example/u>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    )

    class Mixed(_StubProvider):
        def list_messages(self, query="", max_results=100, page_token=None, folder=None):
            if "a@x.com" in query:
                return [SimpleNamespace(id="m1")], None
            return [], None

        def get_message(self, message_id, format="metadata"):
            return msg

    with patch("cleanup.unsubscribe.requests.post") as post:
        post.return_value = SimpleNamespace(status_code=200)
        batch = unsubscribe_senders(Mixed(msg), ["a@x.com", "b@y.com"])
    assert [r.status for r in batch.results] == [STATUS_UNSUBSCRIBED, STATUS_UNAVAILABLE]
    d = batch.to_dict()
    assert "results" in d and len(d["results"]) == 2
