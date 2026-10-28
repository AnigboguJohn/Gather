"""
Unit tests for the AI service. They run with NO API keys (keys are removed below), so they check the
fallback behaviour plus the provider-ordering and fallback logic with a faked HTTP call.
Run: .venv/bin/python -m pytest -q tests
"""
import os

import pytest

# Never read the real .env in tests, and make sure no real keys are used.
os.environ["GATHER_SKIP_DOTENV"] = "1"
for k in ("GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
    os.environ.pop(k, None)

from app import llm, logic  # noqa: E402


def test_parse_json_handles_fences_and_chatter():
    """LLM replies wrapped in ``` fences or extra words still parse."""
    assert llm.parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm.parse_json('Sure! {"en": "hi"} hope that helps') == {"en": "hi"}


def test_translate_without_ai_returns_original():
    """No AI: captions are shown in the original language instead of failing; the source language is skipped."""
    assert logic.translate("Good morning", "en", ["yo", "en"]) == {"yo": "Good morning"}
    assert logic.translate("", "en", ["yo"]) == {}


def test_whisper_language_mapping():
    """Languages Whisper knows get a hint; Pidgin and Igbo are auto-detected."""
    assert logic.whisper_language("yo") == "yo"
    assert logic.whisper_language("pcm") is None  # auto-detect
    assert logic.whisper_language("ig") is None


def test_extractive_summary_finds_actions_and_decisions():
    """No-AI summary still picks out action items ("I will...") and decisions ("We agreed...") for every language."""
    t = [
        {"speaker": "Ada", "text": "Welcome everyone to the sales review."},
        {"speaker": "Tolu", "text": "I will send the price list by Friday."},
        {"speaker": "Ada", "text": "We agreed to launch in Lagos first."},
    ]
    out = logic.summarize("Sales review", t, [], ["en", "yo"])
    assert out["engine"] == "extractive"
    assert any("price list" in a["task"] for a in out["action_items"])
    assert any("Lagos" in d for d in out["decisions"])
    assert set(out["by_language"]) == {"en", "yo"}


def test_empty_meeting_summary():
    """A meeting with no captions or chat gets an honest 'no summary' message."""
    out = logic.summarize("Quiet call", [], [], ["en"])
    assert "No captions" in out["summary"]


def test_clip_keeps_start_and_end():
    """Very long transcripts keep the beginning and the end (where decisions usually are)."""
    text = "A" * 30000 + "END"
    c = logic._clip(text, 1000)
    assert c.startswith("A") and c.endswith("END") and "omitted" in c


def test_answer_without_ai_lists_matches():
    """'Ask your meetings' without AI returns the closest excerpts with citations."""
    p = [{"id": "M1", "meeting": "Standup", "date": "2026-10-01", "speaker": "Ada", "text": "Budget is 2 million naira"}]
    out = logic.answer("what is the budget", p)
    assert out["citations"] == ["M1"] and "2 million" in out["answer"]


def test_llm_fallback_order(monkeypatch):
    """Groq is tried first, Gemini second; LLM_ORDER=gemini swaps them."""
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("GEMINI_API_KEY", "m")
    assert [p.name for p in llm.providers()] == ["groq", "gemini"]
    monkeypatch.setenv("LLM_ORDER", "gemini")
    assert [p.name for p in llm.providers()] == ["gemini", "groq"]


def test_chat_json_falls_back_to_second_provider(monkeypatch):
    """If Groq fails (e.g. bad key), the same request goes to Gemini automatically."""
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("GEMINI_API_KEY", "m")
    calls = []

    class R:
        def __init__(self, code, body):
            self.status_code, self._b, self.text, self.headers = code, body, str(body), {}

        def json(self):
            return self._b

    # Fake HTTP: Groq answers 401, Gemini answers with a translation.
    def fake_post(p, path, timeout, **kw):
        calls.append(p.name)
        if p.name == "groq":
            return R(401, {"error": "bad key"})
        return R(200, {"choices": [{"message": {"content": '{"yo": "E kaaro"}'}}]})

    monkeypatch.setattr(llm, "_post", fake_post)
    data, name = llm.chat_json("s", "u")
    assert name == "gemini" and data == {"yo": "E kaaro"} and calls == ["groq", "gemini"]
