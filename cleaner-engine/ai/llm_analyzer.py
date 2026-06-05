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

    def _chat_completion(self, prompt: str, system_prompt: str, model_name: str) -> str:
        client = self._get_client()

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
        """Parse a JSON response from the model, handling markdown code blocks."""
        text = response.strip()

        if text.startswith("```"):
            lines = text.split("\n")
            lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines)

        return json.loads(text)

    def categorize_emails(self, emails: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Categorize a batch of emails using the LLM.

        Args:
            emails: List of email dicts with at least 'id', 'subject', 'sender', 'snippet'.

        Returns:
            List of dicts with 'id', 'category', 'confidence', 'reason'.
        """
        from ai.prompts import CATEGORIZER_PROMPT

        summaries = []
        for email in emails:
            summaries.append({
                "id": email.get("id", ""),
                "from": email.get("sender", ""),
                "subject": email.get("subject", ""),
                "snippet": email.get("snippet", "")[:200],
            })

        prompt = (
            "Categorize these emails:\n\n"
            + json.dumps(summaries, indent=2, ensure_ascii=False)
        )

        try:
            response = self._generate(prompt, system_prompt=CATEGORIZER_PROMPT)
            results = self._parse_json_response(response)
            if isinstance(results, list):
                return results
            logger.warning("Unexpected categorization response format: %s", type(results))
            return []
        except (json.JSONDecodeError, Exception) as e:
            logger.error("Failed to categorize emails: %s", e)
            return [
                {"id": email.get("id", ""), "category": "unknown", "confidence": 0.0, "reason": "categorization failed"}
                for email in emails
            ]

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
