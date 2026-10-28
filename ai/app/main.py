"""
Gather AI service: speech-to-text for live captions, caption translation, meeting summaries,
and answers for "Ask your meetings". Called only by the Gather server (never by browsers).
Run: uvicorn app.main:app --port 8001
"""
from __future__ import annotations

import os
from pathlib import Path

import hmac

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import llm, logic


def _load_env() -> None:
    """Read ../.env (repo root) without overriding real environment variables."""
    for f in (Path(__file__).resolve().parents[2] / ".env", Path(__file__).resolve().parents[1] / ".env"):
        if not f.exists() or os.getenv("GATHER_SKIP_DOTENV"):
            continue
        for line in f.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))


_load_env()
# The FastAPI app (only the Gather server calls it; it is not exposed to browsers).
app = FastAPI(title="Gather AI", version="1.0")


@app.middleware("http")
async def require_token(request: Request, call_next):
    """If AI_TOKEN is set, only callers that send it (the Gather server, header x-ai-token) may use the AI.
    Without it the service is open, which is fine on a private network (Docker Compose) but not on the internet."""
    token = os.getenv("AI_TOKEN", "")
    if token and request.url.path != "/health" and not hmac.compare_digest(request.headers.get("x-ai-token", ""), token):
        return JSONResponse({"detail": "Not allowed"}, status_code=401)
    return await call_next(request)


@app.get("/health")
def health():
    """Which AI features are available (the server hides captions when stt is false)."""
    ps = llm.providers()
    return {"ok": True, "stt": llm.stt_available(), "llm": ps[0].name if ps else None, "fallback": ps[1].name if len(ps) > 1 else None}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form("en")):
    """Speech-to-text for one caption chunk (≤ 2 MB) in the speaker's language."""
    data = await audio.read()
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(413, "chunk too large")
    try:
        text = llm.transcribe(data, audio.filename or "chunk.webm", audio.content_type or "audio/webm", logic.whisper_language(language))
    except llm.LLMError as e:
        raise HTTPException(502, str(e))
    return {"text": text, "language": language}


class TranslateIn(BaseModel):
    """One caption line and the languages to translate it into."""
    text: str = Field(max_length=2000)
    source: str
    targets: list[str] = Field(max_length=10)


@app.post("/translate")
def translate(b: TranslateIn):
    """Translate a caption into several languages at once."""
    return {"translations": logic.translate(b.text, b.source, b.targets)}


class Line(BaseModel):
    """One transcript or chat line."""
    speaker: str
    text: str


class SummarizeIn(BaseModel):
    """Everything said in a meeting (captions + chat) and the attendees' languages."""
    title: str
    transcript: list[Line] = []
    chat: list[Line] = []
    languages: list[str] = ["en"]


@app.post("/summarize")
def summarize(b: SummarizeIn):
    """Meeting summary + decisions + action items, in every attendee language."""
    return logic.summarize(b.title, [l.model_dump() for l in b.transcript], [l.model_dump() for l in b.chat], b.languages)


class Passage(BaseModel):
    """One search hit from past meetings, labelled M1, M2... for citations."""
    id: str
    meeting: str
    date: str
    speaker: str
    text: str


class AnswerIn(BaseModel):
    """A question and the matching excerpts found by the server's full-text search."""
    question: str = Field(max_length=300)
    passages: list[Passage] = Field(max_length=20)


@app.post("/answer")
def answer(b: AnswerIn):
    """Answer a question about past meetings, with citations."""
    return logic.answer(b.question, [p.model_dump() for p in b.passages])
