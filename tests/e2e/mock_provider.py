"""
A fake OpenAI-compatible provider (speech-to-text + chat) for end-to-end tests without real API keys.
Run: uvicorn tests.e2e.mock_provider:app --port 8099   then set GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:8099/v1
"""
import json
import re

from fastapi import FastAPI, Request

app = FastAPI()
# What the fake speech-to-text "hears", in turn (chosen so the summary has a decision and an action item).
LINES = ["We agreed to launch in Lagos first.", "I will send the price list by Friday.", "Good morning everyone."]
n = {"i": 0, "stt": 0}  # counters: next line to return, number of transcriptions


@app.post("/v1/audio/transcriptions")
async def stt(request: Request):
    """Fake Whisper: ignores the audio and returns the next line from LINES."""
    form = await request.form()
    n["stt"] += 1
    text = LINES[n["i"] % len(LINES)]
    n["i"] += 1
    return {"text": text}


@app.get("/v1/stats")
def stats():
    """How many chunks were transcribed (handy when debugging caption tests)."""
    return n


@app.post("/v1/chat/completions")
async def chat(request: Request):
    """Fake chat completions: recognises each Gather prompt by its system text and returns valid JSON.
    Translations are marked "[yo] ..." so tests can prove the right language reached the right person."""
    b = await request.json()
    system, user = b["messages"][0]["content"], b["messages"][1]["content"]
    if "translate live meeting captions" in system:
        codes = re.findall(r"(\w+) = ", user.split("Translate into:")[1].split("\n")[0])
        text = user.split("Text:", 1)[1].strip()
        out = {c: f"[{c}] {text}" for c in codes}
    elif "meeting outcomes" in system:
        out = {"summary": "The team agreed to launch in Lagos first and Tolu will send prices.",
               "decisions": ["Launch in Lagos first"], "action_items": [{"owner": "Tolu", "task": "Send the price list", "due": "Friday"}]}
    elif "Translate this meeting summary" in system:
        codes = re.findall(r"(\w+) = ", user.split("\n")[0])
        base = json.loads(user.split("JSON:\n", 1)[1])
        out = {c: {**base, "summary": f"[{c}] {base['summary']}"} for c in codes}
    else:
        out = {"answer": "You agreed to launch in Lagos first [M1].", "citations": ["M1"]}
    return {"choices": [{"message": {"content": json.dumps(out)}}]}
