"""
AI email analysis using a LiteLLM gateway via the OpenAI-compatible API.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

from openai import OpenAI

logger = logging.getLogger(__name__)


class LLMAnalyzer:
    """Email analysis powered by a LiteLLM-backed chat-completions API."""

    def __init__(
        self,
        model_name: str = "local/qwen3.5-9b",
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> None:
        self.model_name = model_name or os.environ.get("LITELLM_MODEL", "local/qwen3.5-9b")
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.base_url = os.environ.get("LITELLM_BASE_URL", "").strip()
        self.api_key = os.environ.get("LITELLM_API_KEY", "").strip()
        self.frontier_model = os.environ.get("LITELLM_FRONTIER_MODEL", "").strip()
        self._client: Optional[OpenAI] = None
        self._available_models = self._build_available_models()

    def _build_available_models(self) -> list[str]:
        models = [self.model_name, self.frontier_model]
        return [model for model in dict.fromkeys(models) if model]

    def _get_client(self) -> OpenAI:
        if self._client is None:
            if not self.base_url:
                raise RuntimeError("AI unavailable: LITELLM_BASE_URL is not configured")
            self._client = OpenAI(
                base_url=self.base_url,
                api_key=self.api_key or "EMPTY",
            )
        return self._client

    @staticmethod
    def _force_frontier_requested(prompt: str) -> bool:
        lowered = prompt.lower()
        return '"force_frontier": true' in lowered or "'force_frontier': true" in lowered

    def _should_disable_thinking(self, model_name: str) -> bool:
        return bool(model_name) and model_name != self.frontier_model

    def _build_messages(
        self, prompt: str, system_prompt: str, model_name: str
    ) -> tuple[list[dict[str, str]], dict[str, Any] | None]:
        """Assemble the chat messages + extra_body (shared by buffered + streaming paths)."""
        messages: list[dict[str, str]] = []
        effective_system_prompt = system_prompt
        extra_body: dict[str, Any] | None = None

        if effective_system_prompt:
            if self._should_disable_thinking(model_name):
                effective_system_prompt = "/no_think\n" + effective_system_prompt
                extra_body = {"chat_template_kwargs": {"enable_thinking": False}}
            messages.append({"role": "system", "content": effective_system_prompt})
        elif self._should_disable_thinking(model_name):
            messages.append({"role": "system", "content": "/no_think"})
            extra_body = {"chat_template_kwargs": {"enable_thinking": False}}

        messages.append({"role": "user", "content": prompt})
        return messages, extra_body

    def _chat_completion(self, prompt: str, system_prompt: str, model_name: str) -> str:
        client = self._get_client()
        messages, extra_body = self._build_messages(prompt, system_prompt, model_name)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if extra_body is not None:
            kwargs["extra_body"] = extra_body

        response = client.chat.completions.create(**kwargs)
        content = response.choices[0].message.content or ""
        return content.strip()

    def _chat_completion_stream(self, prompt: str, system_prompt: str, model_name: str):
        """Yield content deltas from the gateway as they arrive (stream=True)."""
        client = self._get_client()
        messages, extra_body = self._build_messages(prompt, system_prompt, model_name)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": True,
        }
        if extra_body is not None:
            kwargs["extra_body"] = extra_body

        stream = client.chat.completions.create(**kwargs)
        for chunk in stream:
            try:
                delta = chunk.choices[0].delta.content
            except (IndexError, AttributeError):
                delta = None
            if delta:
                yield delta

    def _generate(self, prompt: str, system_prompt: str = "") -> str:
        """Generate a response from the configured LiteLLM gateway."""
        if not self.base_url:
            raise RuntimeError("AI unavailable: LITELLM_BASE_URL is not configured")

        force_frontier = self._force_frontier_requested(prompt)
        primary_model = self.frontier_model if force_frontier and self.frontier_model else self.model_name

        if force_frontier and self.frontier_model:
            logger.info("force_frontier requested; using frontier model %s", self.frontier_model)
        try:
            return self._chat_completion(prompt, system_prompt, primary_model)
        except Exception as exc:
            if self.frontier_model and primary_model != self.frontier_model:
                logger.warning(
                    "Primary model %s failed; falling back to frontier model %s: %s",
                    primary_model,
                    self.frontier_model,
                    exc,
                )
                return self._chat_completion(prompt, system_prompt, self.frontier_model)
            raise

    def _parse_json_response(self, response: str) -> Any:
        """Parse a JSON response from the model, tolerating markdown fences, prose
        around the JSON, and trailing commas. Raises json.JSONDecodeError if no
        valid JSON can be recovered."""
        text = response.strip()

        # Strip a leading ```json / ``` fence and its closing ```.
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.rstrip().endswith("```"):
                text = text.rstrip()[:-3]
            text = text.strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Recover the outermost JSON array/object emitted amid prose, dropping any
        # trailing comma a local model may slip in before a closing bracket.
        match = re.search(r"(\[.*\]|\{.*\})", text, re.S)
        if not match:
            raise json.JSONDecodeError("No JSON found in model response", text, 0)
        candidate = re.sub(r",(\s*[\]}])", r"\1", match.group(1))
        return json.loads(candidate)

    # Categorize at most this many emails per model call. Small batches keep each
    # response well under max_tokens (a local model silently truncates a long JSON
    # array, which then fails to parse) and bound a single parse failure to one chunk.
    _CATEGORIZE_BATCH = 15

    def categorize_emails(self, emails: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Categorize emails using the LLM, in small batches.

        Only metadata (id, sender, subject) is ever sent to the model — never the
        message body or snippet, honoring the "metadata only" promise. Emails whose
        batch fails to categorize are omitted from the result (a partial list), never
        back-filled with a fabricated "unknown" verdict: an empty result is what lets
        the caller honestly report that AI categorization did not run.

        Args:
            emails: List of email dicts with at least 'id', 'subject', 'sender'.

        Returns:
            List of dicts with 'id', 'category', 'confidence', 'reason' — one per
            successfully categorized email. May be shorter than the input (or empty).
        """
        from ai.prompts import CATEGORIZER_PROMPT

        results: list[dict[str, Any]] = []
        for start in range(0, len(emails), self._CATEGORIZE_BATCH):
            batch = emails[start:start + self._CATEGORIZE_BATCH]
            summaries = [
                {
                    "id": email.get("id", ""),
                    "from": email.get("sender", ""),
                    "subject": email.get("subject", ""),
                }
                for email in batch
            ]
            prompt = (
                "Categorize these emails:\n\n"
                + json.dumps(summaries, indent=2, ensure_ascii=False)
            )

            try:
                response = self._generate(prompt, system_prompt=CATEGORIZER_PROMPT)
                parsed = self._parse_json_response(response)
            except Exception as e:  # noqa: BLE001 — degrade clean: keep the other batches
                logger.warning(
                    "Categorization batch [%d:%d] failed (skipping, not back-filling): %s",
                    start, start + len(batch), e,
                )
                continue

            if isinstance(parsed, list):
                results.extend(item for item in parsed if isinstance(item, dict))
            else:
                logger.warning("Unexpected categorization response format: %s", type(parsed))

        return results

    def generate_recommendations(
        self, stats: dict[str, Any], emails: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Generate cleanup recommendations based on inbox analysis.

        Args:
            stats: Inbox statistics dict.
            emails: Sample of emails for context.

        Returns:
            List of recommendation dicts.
        """
        from ai.prompts import CLEANUP_ADVISOR_PROMPT

        email_summaries = []
        for email in emails[:50]:
            email_summaries.append({
                "from": email.get("sender", ""),
                "subject": email.get("subject", ""),
                "date": email.get("date", ""),
                "size": email.get("size_bytes", 0),
                "is_read": email.get("is_read", False),
                "labels": email.get("labels", []),
            })

        prompt = (
            "Inbox statistics:\n"
            + json.dumps(stats, indent=2, default=str)
            + "\n\nRecent emails sample:\n"
            + json.dumps(email_summaries, indent=2, ensure_ascii=False, default=str)
        )

        try:
            response = self._generate(prompt, system_prompt=CLEANUP_ADVISOR_PROMPT)
            results = self._parse_json_response(response)
            if isinstance(results, list):
                return results
            logger.warning("Unexpected recommendations response format: %s", type(results))
            return []
        except (json.JSONDecodeError, Exception) as e:
            logger.error("Failed to generate recommendations: %s", e)
            return []

    def chat(self, message: str, context: dict[str, Any] | None = None) -> str:
        """Answer a user question about their inbox.

        Args:
            message: The user's question.
            context: Optional dict with inbox stats, recent emails, etc.

        Returns:
            The assistant's response text.
        """
        from ai.prompts import CHAT_PROMPT

        prompt = message
        if context:
            context_text = json.dumps(context, indent=2, default=str)
            prompt = f"Inbox context:\n{context_text}\n\nUser question: {message}"

        try:
            return self._generate(prompt, system_prompt=CHAT_PROMPT)
        except Exception as e:
            logger.error("Chat generation failed: %s", e)
            return f"I'm sorry, I encountered an error processing your question: {e}"

    # The marker the model emits between its prose reply and the JSON action list.
    _ACTION_MARKER = "<<<ACTIONS>>>"

    def chat_stream(self, message: str, context: dict[str, Any] | None = None):
        """Stream a chat turn, then propose confirm-before-anything actions.

        Yields ``("token", str)`` for each prose delta as it arrives, then exactly one
        ``("actions", list[dict])`` at the end (possibly empty). The model is asked to
        append its structured actions after a ``<<<ACTIONS>>>`` marker; everything from
        the marker onward is withheld from the prose stream and parsed into JSON here,
        so the raw marker/JSON is never shown to the user.
        """
        from ai.prompts import CHAT_PROMPT, CHAT_ACTIONS_ADDENDUM

        prompt = message
        if context:
            context_text = json.dumps(context, indent=2, default=str)
            prompt = f"Inbox context:\n{context_text}\n\nUser question: {message}"

        system_prompt = CHAT_PROMPT + CHAT_ACTIONS_ADDENDUM
        marker = self._ACTION_MARKER
        keep = len(marker) - 1  # hold back enough to catch a marker split across deltas

        buf = ""            # unflushed prose (with lookback tail)
        action_raw = ""     # accumulated text after the marker
        in_actions = False

        try:
            for delta in self._chat_completion_stream(prompt, system_prompt, self.model_name):
                if in_actions:
                    action_raw += delta
                    continue
                buf += delta
                idx = buf.find(marker)
                if idx != -1:
                    pre = buf[:idx]
                    if pre:
                        yield ("token", pre)
                    action_raw = buf[idx + len(marker):]
                    in_actions = True
                    buf = ""
                    continue
                if len(buf) > keep:
                    flush, buf = buf[:-keep], buf[-keep:]
                    if flush:
                        yield ("token", flush)
            if not in_actions and buf:
                yield ("token", buf)
        except Exception as e:
            logger.error("Chat stream failed: %s", e)
            yield ("token", f"\n\n_(The assistant hit an error: {e})_")
            yield ("actions", [])
            return

        yield ("actions", self._parse_actions(action_raw) if in_actions else [])

    def _parse_actions(self, raw: str) -> list[dict[str, Any]]:
        """Best-effort parse of the model's post-marker JSON action list. Never raises."""
        text = (raw or "").strip()
        if not text:
            return []
        data: Any = None
        try:
            data = self._parse_json_response(text)
        except Exception:
            match = re.search(r"\[.*\]", text, re.S)
            if match:
                try:
                    data = json.loads(match.group(0))
                except Exception:
                    return []
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            return []
        return [a for a in data if isinstance(a, dict) and a.get("type")]

    def summarize_inbox(self, analysis: dict[str, Any]) -> str:
        """Generate a natural language summary of inbox analysis.

        Args:
            analysis: Full inbox analysis dict.

        Returns:
            Human-readable summary text.
        """
        from ai.prompts import SUMMARY_PROMPT

        prompt = "Analyze this inbox data:\n" + json.dumps(analysis, indent=2, default=str)

        try:
            return self._generate(prompt, system_prompt=SUMMARY_PROMPT)
        except Exception as e:
            logger.error("Summary generation failed: %s", e)
            return f"Unable to generate inbox summary: {e}"

    def get_available_models(self) -> list[str]:
        """List configured LiteLLM models."""
        return list(self._available_models)

    def set_model(self, model_name: str) -> bool:
        """Switch to a different model identifier."""
        logger.info("Switching model from %s to %s", self.model_name, model_name)
        self.model_name = model_name
        return True
