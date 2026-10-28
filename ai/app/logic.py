"""
Caption translation, meeting summaries and "ask your meetings" answers.
Each function has an AI path and a plain fallback, so meetings still end with something useful without keys.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

from . import llm

# Language codes used across Gather → names given to the LLM in prompts.
LANG_NAMES = {
    "en": "English", "yo": "Yoruba", "ha": "Hausa", "ig": "Igbo",
    "pcm": "Nigerian Pidgin", "sw": "Swahili", "fr": "French",
}
# Whisper understands these directly; Igbo and Pidgin are auto-detected instead.
WHISPER_CODES = {"en": "en", "yo": "yo", "ha": "ha", "sw": "sw", "fr": "fr"}

# Longest transcript sent in one summary request.
MAX_TRANSCRIPT_CHARS = 24_000  # keeps one request inside free-tier limits


def whisper_language(lang: str) -> str | None:
    """Gather language → Whisper language hint (None = let Whisper detect it)."""
    return WHISPER_CODES.get(lang)


# ------------------------------------------------------------------------------------------------
# Translation (live captions)
# ------------------------------------------------------------------------------------------------

@lru_cache(maxsize=2048)
def _translate_cached(text: str, source: str, targets: tuple[str, ...]) -> tuple[tuple[str, str], ...]:
    """One LLM call translates a caption into all target languages at once.
    Cached because the same short phrases repeat a lot ("Can you hear me?")."""
    names = {t: LANG_NAMES.get(t, t) for t in targets}
    system = (
        "You translate live meeting captions. Keep meaning, names and numbers exactly. Be natural and short. "
        "Return only JSON: an object whose keys are the language codes requested and values the translation."
    )
    user = (
        f"Source language: {LANG_NAMES.get(source, source)} ({source}).\n"
        f"Translate into: {', '.join(f'{c} = {n}' for c, n in names.items())}.\n"
        f"Text: {text}"
    )
    data, _ = llm.chat_json(system, user, max_tokens=600)
    return tuple((t, str(data.get(t) or text).strip()) for t in targets)


def translate(text: str, source: str, targets: list[str]) -> dict[str, str]:
    """Translate one caption line into every language someone in the room follows.
    Without AI (or if it fails) everyone gets the original text, so captions never break."""
    targets = sorted({t for t in targets if t != source})
    if not targets or not text.strip():
        return {}
    if not llm.providers():
        return {t: text for t in targets}  # no AI: show the original
    try:
        return dict(_translate_cached(text.strip(), source, tuple(targets)))
    except llm.LLMError:
        return {t: text for t in targets}


# ------------------------------------------------------------------------------------------------
# Summaries
# ------------------------------------------------------------------------------------------------

# Phrases that usually mark an action item or a decision (used by the no-AI summary).
ACTION_RE = re.compile(
    r"\b(i will|i'll|we will|we'll|let's|action|todo|to do|please|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|end of))\b",
    re.I,
)
DECISION_RE = re.compile(r"\b(we agreed|agreed|decided|decision|we will go with|approved|final(ly)?)\b", re.I)


def _lines_text(items: list[dict]) -> str:
    """Format lines as "Speaker: text" for prompts."""
    return "\n".join(f"{i['speaker']}: {i['text']}" for i in items)


def _clip(text: str, limit: int = MAX_TRANSCRIPT_CHARS) -> str:
    """Keep the start and the end (where decisions usually are) when a meeting is very long."""
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + "\n[... middle of the meeting omitted ...]\n" + text[-half:]


def extractive_summary(title: str, transcript: list[dict], chat: list[dict]) -> dict:
    """No-AI fallback: who spoke, the first points, and lines that sound like actions or decisions."""
    items = transcript + chat
    if not items:
        return {"summary": f'"{title}" took place. No captions or chat were captured, so there is no summary.',
                "decisions": [], "action_items": []}
    speakers = sorted({i["speaker"] for i in items})
    first = " ".join(i["text"] for i in transcript[:3])[:300]
    actions = [{"owner": i["speaker"], "task": i["text"][:160], "due": None} for i in items if ACTION_RE.search(i["text"])][:8]
    decisions = [i["text"][:160] for i in items if DECISION_RE.search(i["text"])][:6]
    summary = f'{len(speakers)} people spoke in "{title}" ({", ".join(speakers[:6])}).'
    if first:
        summary += f" It opened with: {first}"
    return {"summary": summary, "decisions": decisions, "action_items": actions}


def _normalise(d: dict) -> dict:
    """Clean an LLM summary into the exact shape the server expects (models sometimes return strings for items)."""
    items = []
    for a in d.get("action_items") or []:
        if isinstance(a, dict) and a.get("task"):
            items.append({"owner": str(a.get("owner") or "Team"), "task": str(a["task"]), "due": a.get("due") or None})
        elif isinstance(a, str):
            items.append({"owner": "Team", "task": a, "due": None})
    return {
        "summary": str(d.get("summary") or "").strip(),
        "decisions": [str(x) for x in (d.get("decisions") or []) if str(x).strip()],
        "action_items": items,
    }


def summarize(title: str, transcript: list[dict], chat: list[dict], languages: list[str]) -> dict:
    """Summary, decisions and action items (in English), then the same translated into each attendee's language.
    Returns {summary, decisions, action_items, by_language: {lang: {...}}, engine}."""
    languages = list(dict.fromkeys(["en", *languages]))
    engine = "extractive"
    base = extractive_summary(title, transcript, chat)
    if llm.providers() and (transcript or chat):
        system = (
            "You write meeting outcomes for busy people reading on a phone. Use only what was said; never invent. "
            "Return JSON: {\"summary\": 2-4 plain sentences, \"decisions\": [short strings], "
            "\"action_items\": [{\"owner\": name, \"task\": what, \"due\": date or null}]}."
        )
        user = f"Meeting: {title}\n\nTranscript (captions):\n{_clip(_lines_text(transcript))}\n\nChat:\n{_clip(_lines_text(chat), 4000)}"
        try:
            data, engine = llm.chat_json(system, user, max_tokens=1200)
            base = _normalise(data) if data.get("summary") else base
        except llm.LLMError:
            engine = "extractive"

    # Translate the whole summary in one call (cheaper than one call per language).
    by_language = {"en": base}
    others = [l for l in languages if l != "en"]
    if others and engine != "extractive":
        system = (
            "Translate this meeting summary JSON into each requested language. Keep names, dates and numbers. "
            "Return JSON whose keys are the language codes; each value has the same shape as the input."
        )
        user = f"Languages: {', '.join(f'{l} = {LANG_NAMES.get(l, l)}' for l in others)}\nJSON:\n{json.dumps(base, ensure_ascii=False)}"
        try:
            data, _ = llm.chat_json(system, user, max_tokens=3000)
            for l in others:
                if isinstance(data.get(l), dict):
                    by_language[l] = _normalise(data[l]) if data[l].get("summary") else base
        except llm.LLMError:
            pass
    for l in others:
        by_language.setdefault(l, base)
    return {**base, "by_language": by_language, "engine": engine}


# ------------------------------------------------------------------------------------------------
# Ask your meetings
# ------------------------------------------------------------------------------------------------

def answer(question: str, passages: list[dict]) -> dict:
    """ "Ask your meetings": answer from the matching transcript/chat excerpts only, citing them as [M1]...
    Without AI, return the closest excerpts instead."""
    if not passages:
        return {"answer": "Nothing in your meetings matches that yet.", "citations": [], "engine": "none"}
    if llm.providers():
        system = (
            "Answer the question using only the meeting excerpts. Cite excerpts like [M1]. "
            "If the excerpts don't answer it, say so. Return JSON: {\"answer\": string, \"citations\": [\"M1\", ...]}."
        )
        ctx = "\n".join(f"[{p['id']}] {p['meeting']} ({p['date']}) {p['speaker']}: {p['text']}" for p in passages)
        try:
            data, engine = llm.chat_json(system, f"Question: {question}\n\nExcerpts:\n{ctx}", max_tokens=600)
            cites = [c for c in data.get("citations") or [] if any(p["id"] == c for p in passages)]
            return {"answer": str(data.get("answer") or ""), "citations": cites, "engine": engine}
        except llm.LLMError:
            pass
    top = passages[:3]
    text = "Closest matches:\n" + "\n".join(f"[{p['id']}] {p['speaker']} in {p['meeting']}: {p['text']}" for p in top)
    return {"answer": text, "citations": [p["id"] for p in top], "engine": "extractive"}
