"""
RFC 2369 / RFC 8058 unsubscribe for a sender group.

Safety contract (load-bearing — this is why the feature was a stub):
  - Prefer one-click POST when ``List-Unsubscribe-Post: List-Unsubscribe=One-Click``
    is present (RFC 8058). A single HTTPS POST, no user interaction.
  - ``mailto:`` unsubscribe: send from the connected account.
  - NEVER auto-follow an arbitrary ``http(s)`` GET unsubscribe link — those are
    trackers / phishing vectors. Return the URL for a human to click.
  - No affordance → ``unavailable`` with an honest filter/block recommendation.
  - Results are ALWAYS per-sender. Never a blanket success.
"""
from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from email.utils import parseaddr
from typing import Any, Iterable, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

import requests

logger = logging.getLogger(__name__)

# Status values the UI / backend must render honestly.
STATUS_UNSUBSCRIBED = "unsubscribed"
STATUS_LINK_RETURNED = "link_returned"
STATUS_UNAVAILABLE = "unavailable"
STATUS_FAILED = "failed"

_ANGLE_URI = re.compile(r"<([^>]+)>")
_ONE_CLICK = re.compile(r"List-Unsubscribe\s*=\s*One-Click", re.IGNORECASE)


@dataclass
class SenderUnsubscribeResult:
    sender: str
    status: str
    method: Optional[str] = None  # one_click | mailto | link | filter
    url: Optional[str] = None
    detail: Optional[str] = None
    message_id: Optional[str] = None


@dataclass
class UnsubscribeBatchResult:
    results: List[SenderUnsubscribeResult] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"results": [asdict(r) for r in self.results]}


def _header_ci(headers: dict[str, str], name: str) -> Optional[str]:
    if not headers:
        return None
    lower = name.lower()
    for k, v in headers.items():
        if str(k).lower() == lower and v:
            return str(v)
    return None


def parse_list_unsubscribe(value: Optional[str]) -> list[str]:
    """Extract angle-bracket URIs from a List-Unsubscribe header value."""
    if not value:
        return []
    found = _ANGLE_URI.findall(value)
    if found:
        return [u.strip() for u in found if u.strip()]
    # Some senders omit angle brackets for a single URI.
    stripped = value.strip()
    return [stripped] if stripped else []


def has_one_click_post(list_unsubscribe_post: Optional[str]) -> bool:
    if not list_unsubscribe_post:
        return False
    return bool(_ONE_CLICK.search(list_unsubscribe_post))


def _classify_uris(uris: Iterable[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"https": [], "http": [], "mailto": [], "other": []}
    for uri in uris:
        lower = uri.lower()
        if lower.startswith("https:"):
            out["https"].append(uri)
        elif lower.startswith("http:"):
            out["http"].append(uri)
        elif lower.startswith("mailto:"):
            out["mailto"].append(uri)
        else:
            out["other"].append(uri)
    return out


def _parse_mailto(uri: str) -> tuple[str, str, str]:
    """Return (to, subject, body) from a mailto: URI."""
    # mailto:addr@x?subject=...&body=...
    raw = uri[7:] if uri.lower().startswith("mailto:") else uri
    if "?" in raw:
        addr_part, qs = raw.split("?", 1)
        params = parse_qs(qs, keep_blank_values=True)
    else:
        addr_part, params = raw, {}
    to = unquote(addr_part).strip()
    subject = unquote(params.get("subject", ["unsubscribe"])[0] or "unsubscribe")
    body = unquote(params.get("body", ["Please unsubscribe me."])[0] or "Please unsubscribe me.")
    return to, subject, body


def _sender_address(raw: Optional[str]) -> str:
    if not raw:
        return ""
    _name, addr = parseaddr(raw)
    return (addr or raw).strip().lower()


def _sender_matches(message_sender: Optional[str], target: str) -> bool:
    msg = _sender_address(message_sender)
    want = _sender_address(target) or target.strip().lower()
    if not msg or not want:
        return False
    if msg == want:
        return True
    # Allow domain-level groups like "@news.example.com"
    if want.startswith("@") and msg.endswith(want):
        return True
    return want in msg


def _find_message_for_sender(provider: Any, sender: str) -> Optional[Any]:
    """Locate one recent message from ``sender`` to read unsubscribe headers."""
    # Prefer an explicit from: search (Gmail/canonical). Fall back to a small
    # recent scan if the provider's translate_query can't express from:.
    candidates = [
        f"from:{_sender_address(sender) or sender}",
        sender,
    ]
    for query in candidates:
        try:
            messages, _ = provider.list_messages(query=query, max_results=5)
        except Exception as exc:  # noqa: BLE001
            logger.warning("unsubscribe list_messages failed for %s: %s", sender, exc)
            continue
        for stub in messages or []:
            try:
                full = provider.get_message(stub.id, format="metadata")
            except Exception as exc:  # noqa: BLE001
                logger.warning("unsubscribe get_message failed for %s: %s", stub.id, exc)
                continue
            if _sender_matches(getattr(full, "sender", None), sender):
                return full
            # If the query already scoped by from:, trust the first hit.
            if query.startswith("from:"):
                return full
    return None


def _one_click_post(url: str, timeout: float = 15.0) -> tuple[bool, str]:
    """RFC 8058 one-click: POST body List-Unsubscribe=One-Click. Never a GET.

    ``allow_redirects`` MUST stay False. requests downgrades POST -> GET on a
    301/302/303, which would silently perform the arbitrary GET fetch this
    module exists to refuse (tracker confirmation / SSRF via an attacker-chosen
    Location). A 3xx is still counted as accepted below — RFC 8058 endpoints
    commonly answer a successful one-click with a redirect to a confirmation
    page — we simply decline to follow it.
    """
    try:
        resp = requests.post(
            url,
            data={"List-Unsubscribe": "One-Click"},
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Email-Ops-Cleaner/0.2 (RFC8058 one-click)",
            },
            timeout=timeout,
            allow_redirects=False,
        )
        if 200 <= resp.status_code < 400:
            return True, f"one-click POST accepted (HTTP {resp.status_code})"
        return False, f"one-click POST rejected (HTTP {resp.status_code})"
    except requests.RequestException as exc:
        return False, f"one-click POST failed: {exc}"


def _mailto_unsubscribe(provider: Any, mailto_uri: str) -> tuple[bool, str]:
    to, subject, body = _parse_mailto(mailto_uri)
    if not to:
        return False, "mailto: URI had no address"
    try:
        # from_addr empty → provider uses the authenticated account identity.
        result = provider.send_message(
            from_addr="",
            to_addr=to,
            subject=subject,
            body=body,
            in_reply_to_thread_id=None,
        )
        accepted = bool(getattr(result, "accepted", False))
        if accepted:
            return True, f"mailto unsubscribe sent to {to}"
        reason = getattr(result, "reason", None) or "send rejected"
        return False, f"mailto send failed: {reason}"
    except Exception as exc:  # noqa: BLE001
        return False, f"mailto send failed: {exc}"


def unsubscribe_sender(provider: Any, sender: str) -> SenderUnsubscribeResult:
    """Resolve and act on unsubscribe affordances for a single sender."""
    target = (sender or "").strip()
    if not target:
        return SenderUnsubscribeResult(
            sender=sender or "",
            status=STATUS_FAILED,
            detail="empty sender",
        )

    message = _find_message_for_sender(provider, target)
    if message is None:
        return SenderUnsubscribeResult(
            sender=target,
            status=STATUS_UNAVAILABLE,
            method="filter",
            detail=(
                "no recent message found for this sender — no List-Unsubscribe header "
                "to act on; block or filter this sender instead"
            ),
        )

    headers = getattr(message, "headers", None) or {}
    # Microsoft Graph may surface internetMessageHeaders as a list; normalise.
    if not isinstance(headers, dict):
        headers = {}

    list_unsub = _header_ci(headers, "List-Unsubscribe")
    list_unsub_post = _header_ci(headers, "List-Unsubscribe-Post")
    uris = parse_list_unsubscribe(list_unsub)
    classified = _classify_uris(uris)
    msg_id = getattr(message, "id", None)

    # 1) One-click POST (preferred).
    if has_one_click_post(list_unsub_post):
        https_uris = classified["https"] or classified["http"]
        if https_uris:
            ok, detail = _one_click_post(https_uris[0])
            if ok:
                return SenderUnsubscribeResult(
                    sender=target,
                    status=STATUS_UNSUBSCRIBED,
                    method="one_click",
                    url=https_uris[0],
                    detail=detail,
                    message_id=msg_id,
                )
            return SenderUnsubscribeResult(
                sender=target,
                status=STATUS_FAILED,
                method="one_click",
                url=https_uris[0],
                detail=detail,
                message_id=msg_id,
            )

    # 2) mailto: from the connected account.
    if classified["mailto"]:
        ok, detail = _mailto_unsubscribe(provider, classified["mailto"][0])
        if ok:
            return SenderUnsubscribeResult(
                sender=target,
                status=STATUS_UNSUBSCRIBED,
                method="mailto",
                url=classified["mailto"][0],
                detail=detail,
                message_id=msg_id,
            )
        return SenderUnsubscribeResult(
            sender=target,
            status=STATUS_FAILED,
            method="mailto",
            url=classified["mailto"][0],
            detail=detail,
            message_id=msg_id,
        )

    # 3) HTTPS/HTTP GET-only link — return for the human; NEVER fetch.
    link = (classified["https"] or classified["http"] or [None])[0]
    if link:
        return SenderUnsubscribeResult(
            sender=target,
            status=STATUS_LINK_RETURNED,
            method="link",
            url=link,
            detail=(
                "sender offers only a browser unsubscribe link — open it yourself; "
                "Email-Ops will not auto-fetch arbitrary GET links"
            ),
            message_id=msg_id,
        )

    # 4) No affordance.
    return SenderUnsubscribeResult(
        sender=target,
        status=STATUS_UNAVAILABLE,
        method="filter",
        detail=(
            "no unsubscribe available on recent mail from this sender — "
            "block or filter instead"
        ),
        message_id=msg_id,
    )


def unsubscribe_senders(provider: Any, sender_group: list[str]) -> UnsubscribeBatchResult:
    """Run unsubscribe for each sender; always return a per-sender result list."""
    results: list[SenderUnsubscribeResult] = []
    seen: set[str] = set()
    for raw in sender_group or []:
        key = (raw or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        results.append(unsubscribe_sender(provider, raw.strip()))
    return UnsubscribeBatchResult(results=results)
