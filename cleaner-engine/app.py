from __future__ import annotations

import base64
import hmac
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any, AsyncIterator, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ai.llm_analyzer import LLMAnalyzer
from backup.manager import BackupManager
from cleanup.analyzer import InboxAnalyzer
from cleanup.executor import CleanupExecutor
from cleanup.planner import CleanupPlanner
from config import Config, load_config
import providers.factory as provider_factory

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

VERSION = "0.1.0"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Loudly warn (do not crash) when the engine boots without a shared secret.

    The auth gate (``_require_engine_token``) fails closed in this case, so the
    API is safe-but-unusable; surface it clearly so the misconfiguration is
    obvious in the logs.
    """
    if not (load_config().engine_shared_secret or "").strip():
        logger.error(
            "SECURITY: ENGINE_SHARED_SECRET is not set. The engine API is "
            "FAILING CLOSED and will reject ALL authenticated requests with 401 "
            "until ENGINE_SHARED_SECRET is configured."
        )
    yield


app = FastAPI(title="Cleaner Engine", version=VERSION, lifespan=lifespan)


class CredentialsModel(BaseModel):
    model_config = {"extra": "allow"}


class OAuthUrlRequest(BaseModel):
    provider: str
    redirect_uri: str


class OAuthUrlResponse(BaseModel):
    url: str


class ExchangeRequest(BaseModel):
    provider: str
    code: str
    redirect_uri: str


class ProfileRequest(BaseModel):
    provider: str
    credentials: CredentialsModel


class StatsRequest(ProfileRequest):
    pass


class ListMessagesRequest(ProfileRequest):
    query: str = ""
    max_results: int = 100
    page_token: Optional[str] = None


class GetMessageRequest(ProfileRequest):
    message_id: str
    format: str = "metadata"


class MessageIdsRequest(ProfileRequest):
    message_ids: list[str]


class GarageTarget(BaseModel):
    bucket: str
    key_prefix: str


class ArchiveCreateRequest(MessageIdsRequest):
    garage: GarageTarget
    query: str = ""
    workspace_id: Optional[str] = None
    expires_at: Optional[str] = None


class ArchiveObjectRequest(BaseModel):
    bucket: str
    key: str


class ArchiveRestoreRequest(ProfileRequest):
    bucket: str
    key: str


class OrganizeRequest(MessageIdsRequest):
    label: Optional[str] = None


class MailThreadsRequest(ProfileRequest):
    folder: str = "inbox"
    limit: int = 50
    # Gmail-style search string (operators mapped by the provider). Empty = unfiltered folder.
    query: str = ""
    # Opaque provider page token (Gmail pageToken / Graph @odata.nextLink). NEVER a numeric offset.
    page_token: Optional[str] = None


class UnsubscribeRequest(ProfileRequest):
    sender_group: list[str] = Field(default_factory=list)


class MailThreadRequest(ProfileRequest):
    thread_id: str


class MailPollInboundRequest(ProfileRequest):
    # High-water cursor from the last poll (ISO-8601 UTC). None on the first poll
    # (baseline): capture the cursor, process no backlog.
    since_iso: Optional[str] = None


class MailAttachmentInput(BaseModel):
    filename: str
    mime_type: str = "application/octet-stream"
    content_base64: str


class MailSendRequest(ProfileRequest):
    from_: str = Field(default="", alias="from")
    to: str
    subject: str = ""
    body: str = ""
    in_reply_to_thread_id: Optional[str] = None
    # Carried on the EXTERNAL send lane too: dropping a cc/bcc silently is a
    # data-loss bug, and it is worse now that the draft mirror shows the user a
    # cc/bcc list that the send would otherwise not honour.
    cc: Optional[List[str]] = None
    bcc: Optional[List[str]] = None
    body_html: Optional[str] = None
    # Outbound attachment bytes (base64), staged by the backend. The provider
    # folds them into the Gmail MIME / Graph attachments array.
    attachments: Optional[List[MailAttachmentInput]] = None

    model_config = {"populate_by_name": True}


class MailDraftRequest(MailSendRequest):
    """Create a REAL draft in the provider's Drafts folder. Sends NOTHING."""


class MailDraftDeleteRequest(ProfileRequest):
    draft_id: str


class MailReadRequest(ProfileRequest):
    read: bool = True


class MailFlagRequest(ProfileRequest):
    flagged: bool = True


class MailAttachmentRequest(ProfileRequest):
    message_id: str
    attachment_id: str


class ThreadActionResponse(BaseModel):
    """Result of a thread-level triage verb; ``moved`` = messages affected."""

    ok: bool
    moved: int


class AiAnalyzeRequest(ProfileRequest):
    pass


class AiChatRequest(BaseModel):
    message: str
    context: dict[str, Any] = Field(default_factory=dict)


class AiModelsResponse(BaseModel):
    models: list[str]


class BackupCreateRequest(ProfileRequest):
    query: str = ""
    path: str


class BackupVerifyRequest(BaseModel):
    path: str


class CountResponse(BaseModel):
    count: int


class HealthResponse(BaseModel):
    status: str
    version: str


class AiUnavailableResponse(BaseModel):
    ai_status: str
    ai_categories: list[dict[str, Any]]
    recommendations: list[dict[str, Any]]


def _get_config() -> Config:
    return load_config()


def _require_engine_token(x_engine_token: Optional[str] = Header(default=None, alias="X-Engine-Token")) -> None:
    secret = _get_config().engine_shared_secret or ""
    # Fail closed: if no shared secret is configured, deny ALL authed requests
    # rather than letting an empty token match an empty secret (auth bypass).
    if not secret.strip():
        logger.error(
            "ENGINE_SHARED_SECRET is not configured; denying all authenticated "
            "requests. Set ENGINE_SHARED_SECRET to enable the engine API."
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    token = x_engine_token or ""
    if not hmac.compare_digest(token, secret):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


def _create_authenticated_provider(provider_name: str, credentials: dict[str, Any]) -> Any:
    provider = provider_factory.create_provider(provider_name)
    provider.authenticate(credentials)
    return provider


def _try_authenticated_provider(provider_name: str, credentials: dict[str, Any]) -> Optional[Any]:
    """Build + authenticate a provider, returning None (not raising) on any failure.

    Used by the unified mail-client routes which must DEGRADE CLEAN: an
    unconfigured or failed provider is treated as "empty", never an error.
    """
    try:
        return _create_authenticated_provider(provider_name, credentials)
    except Exception as exc:  # noqa: BLE001 - degrade clean on any auth/config error
        logger.warning("mail provider %s unavailable: %s", provider_name, exc)
        return None


def _garage_s3_config() -> dict[str, str]:
    cfg = _get_config()
    return {
        "endpoint_url": cfg.garage_s3_endpoint,
        "region": cfg.garage_s3_region,
        "access_key": cfg.garage_s3_access_key,
        "secret_key": cfg.garage_s3_secret_key,
    }


def _dataclass_to_dict(obj: Any) -> Any:
    if hasattr(obj, "__dataclass_fields__"):
        return asdict(obj)
    if isinstance(obj, list):
        return [_dataclass_to_dict(item) for item in obj]
    return obj


def _mail_message_to_dict(message: Any) -> dict[str, Any]:
    """Serialise a ThreadMessage, renaming ``sender`` -> ``from`` per the contract."""
    data = asdict(message)
    data["from"] = data.pop("sender", None)
    return data


def _decode_attachments(attachments: Any) -> list[dict[str, Any]]:
    """Decode base64 outbound-attachment inputs to provider-ready dicts
    ``{filename, mime_type, data(bytes)}``. Empty list when none."""
    out: list[dict[str, Any]] = []
    for att in (attachments or []):
        try:
            data = base64.b64decode(att.content_base64)
        except Exception:  # noqa: BLE001 - skip a corrupt part, never fail the send
            logger.warning("skipping un-decodable attachment %s", getattr(att, "filename", "?"))
            continue
        out.append({
            "filename": att.filename,
            "mime_type": att.mime_type or "application/octet-stream",
            "data": data,
        })
    return out


def _thread_triage_ids(provider_name: str, messages: list[Any], verb: str) -> list[str]:
    """Which of a thread's messages a triage verb (archive/trash/spam/inbox/read) touches.

    Drafts are NEVER touched — their lifecycle belongs to the drafts surface,
    not triage. Gmail triage verbs are LABEL edits (a SENT copy keeps its place
    in Sent), so the whole thread is safe; Microsoft archive/trash/spam/inbox
    are folder MOVES, so only received copies go — moving Sent Items out of the
    sent folder would corrupt the user's sent-mail record.
    """
    move_semantics = provider_name == "microsoft" and verb in ("archive", "trash", "spam", "inbox")
    ids: list[str] = []
    for message in messages:
        direction = getattr(message, "direction", "received")
        if direction == "draft":
            continue
        if move_semantics and direction != "received":
            continue
        ids.append(message.id)
    return ids


def _sse_event(event: str, data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def _build_llm_analyzer() -> LLMAnalyzer:
    cfg = _get_config()
    return LLMAnalyzer(
        model_name=cfg.litellm_model,
        max_tokens=cfg.max_tokens,
        temperature=cfg.temperature,
    )


def _ai_unavailable_analysis() -> dict[str, Any]:
    return {
        "ai_status": "ai_unavailable",
        "ai_categories": [],
        "recommendations": [],
    }


def _analyze_inbox(provider: Any, request_id: Any, progress_callback) -> dict[str, Any]:
    progress_callback(request_id, "fetch", 0, "Fetching messages...")

    all_messages: list[dict[str, Any]] = []
    page_token = None
    page = 0
    max_pages = 10

    while page < max_pages:
        messages, next_token = provider.list_messages(
            query="",
            max_results=100,
            page_token=page_token,
            folder="inbox",
        )
        for msg in messages:
            all_messages.append(_dataclass_to_dict(msg))

        page += 1
        progress_callback(request_id, "fetch", min(page * 10, 40), f"Fetched {len(all_messages)} messages...")

        if not next_token:
            break
        page_token = next_token

    progress_callback(request_id, "fetch", 40, f"Fetched {len(all_messages)} messages total")

    progress_callback(request_id, "metadata", 40, "Fetching message details...")
    detailed_messages: list[dict[str, Any]] = []
    for i, msg in enumerate(all_messages[:200]):
        try:
            full = provider.get_message(msg["id"], format="metadata")
            detailed_messages.append(_dataclass_to_dict(full))
        except Exception as e:
            logger.warning("Failed to fetch details for %s: %s", msg.get("id"), e)
            detailed_messages.append(msg)

        if (i + 1) % 20 == 0:
            pct = 40 + int((i / min(len(all_messages), 200)) * 20)
            progress_callback(request_id, "metadata", pct, f"Fetched details for {i + 1} messages...")

    progress_callback(request_id, "analyze", 60, "Analyzing patterns...")

    analyzer = InboxAnalyzer()
    analysis = analyzer.get_full_analysis(detailed_messages)

    cfg = _get_config()
    if not cfg.litellm_base_url:
        analysis.update(_ai_unavailable_analysis())
        progress_callback(request_id, "done", 100, "Analysis complete")
        return analysis

    progress_callback(request_id, "ai", 70, "Running AI categorization...")
    llm = _build_llm_analyzer()
    try:
        categories = llm.categorize_emails(detailed_messages[:50])
        analysis["ai_categories"] = categories
    except Exception as e:
        logger.warning("AI categorization failed (continuing without): %s", e)
        analysis["ai_categories"] = []

    progress_callback(request_id, "ai", 85, "Generating recommendations...")
    try:
        stats = provider.get_inbox_stats()
        recommendations = llm.generate_recommendations(
            _dataclass_to_dict(stats),
            detailed_messages[:50],
        )
        analysis["recommendations"] = recommendations
    except Exception as e:
        logger.warning("AI recommendations failed (continuing without): %s", e)
        analysis["recommendations"] = []

    # Report AI status honestly: the LLM is only "ready" if it actually produced
    # something. When every categorization batch fails to parse and no recommendation
    # comes back, the model effectively did not run — say so, rather than letting the
    # UI paint a green "AI ready" over an empty result.
    if analysis.get("ai_categories") or analysis.get("recommendations"):
        analysis["ai_status"] = "ai_ready"
    else:
        analysis["ai_status"] = "ai_unavailable"

    progress_callback(request_id, "done", 100, "Analysis complete")
    return analysis


def _sse_progress_collector(events: list[str]):
    def _progress(request_id: Any, stage: str, percent: int, message: str) -> None:
        events.append(_sse_event("progress", {
            "id": request_id,
            "stage": stage,
            "percent": int(percent),
            "message": message,
        }))

    return _progress


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=VERSION)


@app.post("/auth/oauth-url", response_model=OAuthUrlResponse, dependencies=[Depends(_require_engine_token)])
def auth_oauth_url(request: OAuthUrlRequest) -> OAuthUrlResponse:
    provider = provider_factory.create_provider(request.provider)
    return OAuthUrlResponse(url=provider.get_oauth_url(request.redirect_uri))


@app.post("/auth/exchange", dependencies=[Depends(_require_engine_token)])
def auth_exchange(request: ExchangeRequest) -> dict[str, Any]:
    provider = provider_factory.create_provider(request.provider)
    return _dataclass_to_dict(provider.exchange_code(request.code, request.redirect_uri))


@app.post("/accounts/profile", dependencies=[Depends(_require_engine_token)])
def accounts_profile(request: ProfileRequest) -> dict[str, Any]:
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
    return _dataclass_to_dict(provider.get_profile())


@app.post("/accounts/stats", dependencies=[Depends(_require_engine_token)])
def accounts_stats(request: StatsRequest) -> dict[str, Any]:
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
    return _dataclass_to_dict(provider.get_inbox_stats())


@app.post("/messages/list", dependencies=[Depends(_require_engine_token)])
def messages_list(request: ListMessagesRequest) -> dict[str, Any]:
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
    messages, next_token = provider.list_messages(
        query=request.query,
        max_results=request.max_results,
        page_token=request.page_token,
    )
    return {
        "messages": _dataclass_to_dict(messages),
        "next_token": next_token,
    }


@app.post("/messages/get", dependencies=[Depends(_require_engine_token)])
def messages_get(request: GetMessageRequest) -> dict[str, Any]:
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
    message = provider.get_message(request.message_id, format=request.format)
    return _dataclass_to_dict(message)


# Cleanup verbs MUTATE the mailbox, so — unlike the read-only /mail/* routes that
# degrade to an empty list — they must NOT swallow a provider failure into a 200
# ``count: 0`` (indistinguishable from "0 matched", which the backend would then
# record as a COMPLETED cleanup that silently did nothing). On any provider error we
# log and surface a clean 502 so the backend sees an explicit failure, marks the
# batch FAILED, and leaves the approval retryable.


def _cleanup_failed(verb: str, provider_name: str, exc: Exception) -> HTTPException:
    logger.warning("cleanup/%s failed for %s: %s", verb, provider_name, exc)
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"cleanup {verb} failed: {exc}",
    )


@app.post("/cleanup/trash", dependencies=[Depends(_require_engine_token)])
def cleanup_trash(request: MessageIdsRequest) -> CountResponse:
    try:
        provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
        count = provider.batch_trash(request.message_ids)
    except Exception as exc:  # noqa: BLE001 - surface as a clean 502, never a silent 0
        raise _cleanup_failed("trash", request.provider, exc) from exc
    return CountResponse(count=count)


@app.post("/cleanup/delete", dependencies=[Depends(_require_engine_token)])
def cleanup_delete(request: MessageIdsRequest) -> CountResponse:
    try:
        provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
        count = provider.batch_delete(request.message_ids)
    except Exception as exc:  # noqa: BLE001 - surface as a clean 502, never a silent 0
        raise _cleanup_failed("delete", request.provider, exc) from exc
    return CountResponse(count=count)


@app.post("/cleanup/organize", dependencies=[Depends(_require_engine_token)])
def cleanup_organize(request: OrganizeRequest) -> CountResponse:
    try:
        provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
        count = provider.batch_archive(request.message_ids, label=request.label)
    except Exception as exc:  # noqa: BLE001 - surface as a clean 502, never a silent 0
        raise _cleanup_failed("organize", request.provider, exc) from exc
    return CountResponse(count=count)


@app.post("/cleanup/unsubscribe", dependencies=[Depends(_require_engine_token)])
def cleanup_unsubscribe(request: UnsubscribeRequest) -> dict[str, Any]:
    """RFC 2369 / RFC 8058 unsubscribe for a sender group.

    Always returns a per-sender result list (unsubscribed / link_returned /
    unavailable / failed). Never a blanket success. Mutating (mailto send /
    one-click POST) — surface provider failures as 502 like the other cleanup verbs.
    """
    from cleanup.unsubscribe import unsubscribe_senders

    try:
        provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
        batch = unsubscribe_senders(provider, request.sender_group or [])
    except Exception as exc:  # noqa: BLE001 - surface as a clean 502
        raise _cleanup_failed("unsubscribe", request.provider, exc) from exc
    return batch.to_dict()


@app.post("/mail/threads", dependencies=[Depends(_require_engine_token)])
def mail_threads(request: MailThreadsRequest) -> dict[str, Any]:
    """List threads for a folder with optional search + opaque page token.

    Honest contract:
      - ``next_page_token`` is the provider's opaque cursor (or null).
      - ``has_more`` is true ONLY when next_page_token is present — never inferred
        from result length.
      - When a provider cannot honour the requested search, return empty threads
        with ``search_supported: false`` and a reason — NEVER the unfiltered inbox.
    """
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return {
            "threads": [],
            "next_page_token": None,
            "has_more": False,
            "search_supported": True,
            "reason": None,
        }
    try:
        listed = provider.list_threads(
            folder=request.folder,
            limit=request.limit,
            query=request.query or "",
            page_token=request.page_token,
        )
        # Providers return (threads, next_page_token). Tolerate a bare list from
        # older test fakes for a soft migration window.
        if isinstance(listed, tuple):
            threads, next_token = listed
        else:
            threads, next_token = listed, None
        return {
            "threads": [_dataclass_to_dict(t) for t in threads],
            "next_page_token": next_token,
            "has_more": bool(next_token),
            "search_supported": True,
            "reason": None,
        }
    except ValueError as exc:
        # Explicit unsupported search (e.g. Microsoft free-text) — honest empty.
        logger.info("mail/threads unsupported for %s: %s", request.provider, exc)
        return {
            "threads": [],
            "next_page_token": None,
            "has_more": False,
            "search_supported": False,
            "reason": str(exc),
        }
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/threads failed for %s: %s", request.provider, exc)
        return {
            "threads": [],
            "next_page_token": None,
            "has_more": False,
            "search_supported": True,
            "reason": None,
        }


@app.post("/mail/thread", dependencies=[Depends(_require_engine_token)])
def mail_thread(request: MailThreadRequest) -> dict[str, Any]:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return {"messages": []}
    try:
        messages = provider.get_thread(request.thread_id)
        return {"messages": [_mail_message_to_dict(m) for m in messages]}
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/thread failed for %s: %s", request.provider, exc)
        return {"messages": []}


@app.post("/mail/poll-inbound", dependencies=[Depends(_require_engine_token)])
def mail_poll_inbound(request: MailPollInboundRequest) -> dict[str, Any]:
    """Detect NEW mail arriving at an external (Gmail / M365) mailbox since a
    high-water cursor — external-mailbox parity with the sovereign James
    ``pollInbound`` the backend inbound watcher already drives.

    Degrade-clean like the other read-only /mail/* routes: an unusable provider
    or any provider error yields a null-ish result ({cursor: since_iso,
    new_messages: []}) so the watcher simply re-polls, never a 500.
    """
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return {"cursor": request.since_iso, "new_messages": []}
    try:
        return provider.poll_inbound(request.since_iso)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/poll-inbound failed for %s: %s", request.provider, exc)
        return {"cursor": request.since_iso, "new_messages": []}


@app.post("/mail/send", dependencies=[Depends(_require_engine_token)])
def mail_send(request: MailSendRequest) -> dict[str, Any]:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return {"accepted": False, "provider_message_id": None, "thread_id": None, "reason": "provider_unavailable"}
    try:
        result = provider.send_message(
            from_addr=request.from_,
            to_addr=request.to,
            subject=request.subject,
            body=request.body,
            in_reply_to_thread_id=request.in_reply_to_thread_id,
            cc=request.cc,
            bcc=request.bcc,
            body_html=request.body_html,
            attachments=_decode_attachments(request.attachments),
        )
        return _dataclass_to_dict(result)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/send failed for %s: %s", request.provider, exc)
        return {"accepted": False, "provider_message_id": None, "thread_id": None, "reason": "send_failed"}


# DRAFT verbs — create/delete a REAL draft in the provider's Drafts folder.
# A draft SENDS NOTHING: Email-Ops mirrors an agent-inbox draft here so the human
# reviews it in their own Outlook/Gmail before approving, and deletes the mirror
# once the approval has actually sent. Degrade-clean like the rest of /mail/*, but
# NEVER optimistic: a provider that cannot draft returns created:false + a reason
# so the backend does not claim a mirror that does not exist.


@app.post("/mail/draft", dependencies=[Depends(_require_engine_token)])
def mail_draft(request: MailDraftRequest) -> dict[str, Any]:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return {"created": False, "draft_id": None, "thread_id": None, "web_link": None, "reason": "provider_unavailable"}
    if not hasattr(provider, "create_draft"):
        # Honest, not silent: this provider has no draft lane yet.
        return {"created": False, "draft_id": None, "thread_id": None, "web_link": None, "reason": "drafts_unsupported_for_provider"}
    try:
        result = provider.create_draft(
            from_addr=request.from_,
            to_addr=request.to,
            subject=request.subject,
            body=request.body,
            in_reply_to_thread_id=request.in_reply_to_thread_id,
            cc=request.cc,
            bcc=request.bcc,
            body_html=request.body_html,
            attachments=_decode_attachments(request.attachments),
        )
        return _dataclass_to_dict(result)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/draft failed for %s: %s", request.provider, exc)
        return {"created": False, "draft_id": None, "thread_id": None, "web_link": None, "reason": "draft_failed"}


@app.post("/mail/draft/delete", dependencies=[Depends(_require_engine_token)])
def mail_draft_delete(request: MailDraftDeleteRequest) -> ThreadActionResponse:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None or not hasattr(provider, "delete_draft"):
        return ThreadActionResponse(ok=False, moved=0)
    try:
        ok = provider.delete_draft(request.draft_id)
        return ThreadActionResponse(ok=bool(ok), moved=1 if ok else 0)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/draft/delete failed for %s: %s", request.provider, exc)
        return ThreadActionResponse(ok=False, moved=0)


# Thread-level TRIAGE verbs (webmail parity for external accounts): resolve the
# thread's message ids via the provider, then apply the batch verb so the action
# is REAL in the Gmail/M365 mailbox, not just an app-side overlay. ``thread_id``
# uses the ``:path`` converter because Microsoft conversation ids are base64 and
# may contain ``/`` (which the ASGI server percent-DECODES before routing, so a
# plain segment param would 404 on them). Same degrade-clean contract as the
# other /mail/* routes: unusable provider / provider error -> ok:false + 200.


@app.post("/mail/threads/{thread_id:path}/archive", dependencies=[Depends(_require_engine_token)])
def mail_thread_archive(thread_id: str, request: ProfileRequest) -> ThreadActionResponse:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return ThreadActionResponse(ok=False, moved=0)
    try:
        ids = _thread_triage_ids(request.provider, provider.get_thread(thread_id), "archive")
        moved = provider.batch_archive(ids) if ids else 0
        return ThreadActionResponse(ok=True, moved=moved)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/threads/archive failed for %s: %s", request.provider, exc)
        return ThreadActionResponse(ok=False, moved=0)


@app.post("/mail/threads/{thread_id:path}/trash", dependencies=[Depends(_require_engine_token)])
def mail_thread_trash(thread_id: str, request: ProfileRequest) -> ThreadActionResponse:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return ThreadActionResponse(ok=False, moved=0)
    try:
        ids = _thread_triage_ids(request.provider, provider.get_thread(thread_id), "trash")
        moved = provider.batch_trash(ids) if ids else 0
        return ThreadActionResponse(ok=True, moved=moved)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/threads/trash failed for %s: %s", request.provider, exc)
        return ThreadActionResponse(ok=False, moved=0)


@app.post("/mail/threads/{thread_id:path}/read", dependencies=[Depends(_require_engine_token)])
def mail_thread_read(thread_id: str, request: MailReadRequest) -> ThreadActionResponse:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return ThreadActionResponse(ok=False, moved=0)
    try:
        ids = _thread_triage_ids(request.provider, provider.get_thread(thread_id), "read")
        moved = provider.batch_set_read(ids, request.read) if ids else 0
        return ThreadActionResponse(ok=True, moved=moved)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/threads/read failed for %s: %s", request.provider, exc)
        return ThreadActionResponse(ok=False, moved=0)


@app.post("/mail/attachment", dependencies=[Depends(_require_engine_token)])
def mail_attachment(request: MailAttachmentRequest) -> dict[str, Any]:
    """Fetch one attachment's BYTES for the reader (base64). The reader path —
    metadata comes with the thread; bytes are pulled only when the user opens
    the attachment. Degrade-clean: found=False (never a 500) when unreachable."""
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return {"found": False}
    try:
        att = provider.get_attachment(request.message_id, request.attachment_id)
        return {
            "found": True,
            "content_base64": base64.b64encode(att.data).decode("ascii"),
            "mime_type": att.mime_type or None,
            "filename": att.filename or None,
            "size": att.size_bytes,
        }
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/attachment failed for %s: %s", request.provider, exc)
        return {"found": False}


@app.post("/mail/threads/{thread_id:path}/flag", dependencies=[Depends(_require_engine_token)])
def mail_thread_flag(thread_id: str, request: MailFlagRequest) -> ThreadActionResponse:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return ThreadActionResponse(ok=False, moved=0)
    try:
        ids = _thread_triage_ids(request.provider, provider.get_thread(thread_id), "flag")
        moved = provider.batch_set_flagged(ids, request.flagged) if ids else 0
        return ThreadActionResponse(ok=True, moved=moved)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/threads/flag failed for %s: %s", request.provider, exc)
        return ThreadActionResponse(ok=False, moved=0)


@app.post("/mail/threads/{thread_id:path}/spam", dependencies=[Depends(_require_engine_token)])
def mail_thread_spam(thread_id: str, request: ProfileRequest) -> ThreadActionResponse:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return ThreadActionResponse(ok=False, moved=0)
    try:
        ids = _thread_triage_ids(request.provider, provider.get_thread(thread_id), "spam")
        moved = provider.batch_spam(ids) if ids else 0
        return ThreadActionResponse(ok=True, moved=moved)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/threads/spam failed for %s: %s", request.provider, exc)
        return ThreadActionResponse(ok=False, moved=0)


@app.post("/mail/threads/{thread_id:path}/inbox", dependencies=[Depends(_require_engine_token)])
def mail_thread_restore_inbox(thread_id: str, request: ProfileRequest) -> ThreadActionResponse:
    provider = _try_authenticated_provider(request.provider, request.credentials.model_dump())
    if provider is None:
        return ThreadActionResponse(ok=False, moved=0)
    try:
        ids = _thread_triage_ids(request.provider, provider.get_thread(thread_id), "inbox")
        moved = provider.batch_restore_inbox(ids) if ids else 0
        return ThreadActionResponse(ok=True, moved=moved)
    except Exception as exc:  # noqa: BLE001 - degrade clean
        logger.warning("mail/threads/inbox failed for %s: %s", request.provider, exc)
        return ThreadActionResponse(ok=False, moved=0)


@app.post("/archive/create", dependencies=[Depends(_require_engine_token)])
def archive_create(request: ArchiveCreateRequest) -> dict[str, Any]:
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
    metadata = {
        "provider": request.provider,
    }
    if request.workspace_id:
        metadata["workspace_id"] = request.workspace_id
    if request.expires_at:
        metadata["expires_at"] = request.expires_at
    manager = BackupManager()
    return manager.create_archive(
        provider=provider,
        message_ids=request.message_ids,
        bucket=request.garage.bucket,
        key=request.garage.key_prefix,
        s3_config=_garage_s3_config(),
        query=request.query,
        metadata=metadata,
    )


@app.post("/archive/verify", dependencies=[Depends(_require_engine_token)])
def archive_verify(request: ArchiveObjectRequest) -> dict[str, Any]:
    manager = BackupManager()
    return manager.verify_archive(request.bucket, request.key, _garage_s3_config())


@app.post("/archive/restore", dependencies=[Depends(_require_engine_token)])
def archive_restore(request: ArchiveRestoreRequest) -> dict[str, Any]:
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
    manager = BackupManager()
    return manager.restore_archive(provider, request.bucket, request.key, _garage_s3_config())


@app.post("/ai/analyze", dependencies=[Depends(_require_engine_token)])
def ai_analyze(request: AiAnalyzeRequest):
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())

    def generate():
        events: list[str] = []

        def progress_callback(request_id: Any, stage: str, percent: int, message: str) -> None:
            events.append(_sse_event("progress", {
                "id": request_id,
                "stage": stage,
                "percent": int(percent),
                "message": message,
            }))

        analysis = _analyze_inbox(provider, request_id=None, progress_callback=progress_callback)
        for event in events:
            yield event
        yield _sse_event("result", analysis)

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/ai/chat", dependencies=[Depends(_require_engine_token)], response_model=dict[str, str])
def ai_chat(request: AiChatRequest) -> dict[str, str]:
    cfg = _get_config()
    if not cfg.litellm_base_url:
        return {"response": "ai_unavailable: LITELLM_BASE_URL is not configured"}

    llm = _build_llm_analyzer()
    response = llm.chat(request.message, context=request.context)
    return {"response": response}


@app.post("/ai/chat/stream", dependencies=[Depends(_require_engine_token)])
def ai_chat_stream(request: AiChatRequest):
    """Streaming chat: SSE `token` frames for the prose reply, then one `actions`
    frame (proposed confirm-before-anything actions), then `done`."""
    cfg = _get_config()

    def generate():
        if not cfg.litellm_base_url:
            yield _sse_event("token", {"delta": "ai_unavailable: LITELLM_BASE_URL is not configured"})
            yield _sse_event("actions", {"actions": []})
            yield _sse_event("done", {})
            return

        llm = _build_llm_analyzer()
        try:
            for kind, payload in llm.chat_stream(request.message, context=request.context):
                if kind == "token":
                    yield _sse_event("token", {"delta": payload})
                elif kind == "actions":
                    yield _sse_event("actions", {"actions": payload})
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("ai_chat_stream failed")
            yield _sse_event("token", {"delta": f"\n\n_(The assistant hit an error: {exc})_"})
            yield _sse_event("actions", {"actions": []})
        yield _sse_event("done", {})

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/ai/models", dependencies=[Depends(_require_engine_token)], response_model=AiModelsResponse)
def ai_models() -> AiModelsResponse:
    llm = _build_llm_analyzer()
    return AiModelsResponse(models=llm.get_available_models())


@app.post("/backup/create", dependencies=[Depends(_require_engine_token)])
def backup_create(request: BackupCreateRequest) -> dict[str, Any]:
    provider = _create_authenticated_provider(request.provider, request.credentials.model_dump())
    manager = BackupManager()
    manifest = manager.create_backup(provider=provider, query=request.query, path=request.path)
    return manifest


@app.post("/backup/verify", dependencies=[Depends(_require_engine_token)])
def backup_verify(request: BackupVerifyRequest) -> dict[str, Any]:
    manager = BackupManager()
    return manager.verify_backup(request.path)
