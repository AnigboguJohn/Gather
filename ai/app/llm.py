"""
LLM and speech-to-text providers (free tiers first).

- Speech-to-text: Groq Whisper (whisper-large-v3-turbo). Needs GROQ_API_KEY.
- Text (translation, summaries, answers): Groq Llama first, Gemini second (both OpenAI-compatible).
  If the first provider fails or hits its rate limit, the second is tried automatically.
Nothing here is required: without keys the service falls back to simple non-AI behaviour.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass

import httpx


@dataclass
class Provider:
    """One OpenAI-compatible API (Groq or Gemini): where to call, with which key and model."""
    name: str
    base_url: str
    api_key: str
    model: str


def _env(*names: str) -> str:
    """First non-empty environment variable among `names` (empty counts as not set)."""
    for n in names:
        v = os.getenv(n, "").strip()
        if v:
            return v
    return ""


def providers() -> list[Provider]:
    """Text providers in the order to try: Groq then Gemini (LLM_ORDER=gemini swaps them).
    *_BASE_URL variables let tests point at a fake provider."""
    out: list[Provider] = []
    groq = _env("GROQ_API_KEY")
    gemini = _env("GEMINI_API_KEY", "GOOGLE_API_KEY")
    if groq:
        out.append(Provider("groq", _env("GROQ_BASE_URL") or "https://api.groq.com/openai/v1", groq, _env("GROQ_LLM_MODEL") or "openai/gpt-oss-120b"))
    if gemini:
        out.append(Provider("gemini", _env("GEMINI_BASE_URL") or "https://generativelanguage.googleapis.com/v1beta/openai", gemini, _env("GEMINI_MODEL") or "gemini-3.8-flash"))
    if os.getenv("LLM_ORDER", "").lower().startswith("gemini"):
        out.reverse()
    return out


def stt_available() -> bool:
    """Live captions need Groq (it hosts the Whisper speech-to-text model)."""
    return bool(_env("GROQ_API_KEY"))


class LLMError(RuntimeError):
    """Every provider failed (or none is configured); callers fall back to non-AI behaviour."""
    pass


def _post(p: Provider, path: str, timeout: float, **kw) -> httpx.Response:
    """POST with one retry on 429/5xx (honouring Retry-After up to 8 s)."""
    for attempt in range(2):
        r = httpx.post(f"{p.base_url}{path}", headers={"Authorization": f"Bearer {p.api_key}"}, timeout=timeout, **kw)
        if r.status_code in (429, 500, 502, 503) and attempt == 0:
            wait = min(float(r.headers.get("retry-after", "2") or 2), 8.0)
            time.sleep(wait)
            continue
        return r
    return r


def chat_json(system: str, user: str, max_tokens: int = 1500) -> tuple[dict, str]:
    """Ask for a JSON object; tries each provider in order. Returns (data, provider_name).
    JSON mode makes answers machine-readable; low temperature keeps translations and summaries faithful."""
    errors = []
    for p in providers():
        try:
            r = _post(p, "/chat/completions", 60, json={
                "model": p.model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "temperature": 0.2,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
            })
            if r.status_code != 200:
                raise LLMError(f"{p.name} {r.status_code}: {r.text[:200]}")
            content = r.json()["choices"][0]["message"]["content"] or ""
            return parse_json(content), p.name
        except Exception as e:  # try the next provider
            errors.append(str(e))
    raise LLMError("; ".join(errors) or "no LLM configured")


def parse_json(text: str) -> dict:
    """Models sometimes wrap JSON in ``` fences or add a sentence; take the outermost object."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, flags=re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def transcribe(audio: bytes, filename: str, mime: str, language: str | None) -> str:
    """Speech-to-text for one short audio chunk via Groq Whisper.
    `language` is a Whisper code ("yo", "ha"...) or None to auto-detect (Igbo, Pidgin).
    Returns "" when no Groq key is set, so captions simply stay empty."""
    key = _env("GROQ_API_KEY")
    if not key:
        return ""
    p = Provider("groq", _env("GROQ_BASE_URL") or "https://api.groq.com/openai/v1", key, _env("GROQ_STT_MODEL") or "whisper-large-v3-turbo")
    data = {"model": p.model, "response_format": "json", "temperature": "0"}
    if language:
        data["language"] = language
    r = _post(p, "/audio/transcriptions", 30, data=data, files={"file": (filename, audio, mime)})
    if r.status_code != 200:
        raise LLMError(f"stt {r.status_code}: {r.text[:200]}")
    return (r.json().get("text") or "").strip()
