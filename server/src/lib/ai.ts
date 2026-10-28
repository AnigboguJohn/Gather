/**
 * Client for the Python AI service (ai/ folder, FastAPI on AI_URL).
 * The server never calls Groq/Gemini directly: it sends audio and text here and the AI service picks
 * the provider (Groq first, Gemini as backup) or falls back to non-AI behaviour when no keys are set.
 */
import { config } from "../config.js";
import { log } from "../log.js";

/** The shared secret for the AI service, when one is set (AI_TOKEN). */
const tokenHeader = (): Record<string, string> => (config.aiToken ? { "x-ai-token": config.aiToken } : {});

/** POST JSON to the AI service with a timeout; throws with the status and a short body on errors. */
async function post<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const r = await fetch(`${config.aiUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...tokenHeader() }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`AI ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

/** Speech-to-text for one short caption chunk (multipart upload). `language` is the speaker's caption language. */
export async function transcribe(audio: Buffer, mime: string, language: string): Promise<{ text: string; english?: string }> {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(audio)], { type: mime }), mime.includes("ogg") ? "chunk.ogg" : "chunk.webm");
  form.append("language", language);
  const r = await fetch(`${config.aiUrl}/transcribe`, { method: "POST", headers: tokenHeader(), body: form, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`AI /transcribe ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { text: string };
}

/** Translate one caption into every target language at once: returns { translations: { yo: "...", ... } }. */
export const translate = (text: string, source: string, targets: string[]) =>
  post<{ translations: Record<string, string> }>("/translate", { text, source, targets }, 20_000);

/** Shape of a meeting summary: English fields plus a copy per attendee language in `by_language`. */
export interface SummaryOut {
  summary: string;
  decisions: string[];
  action_items: { owner: string; task: string; due?: string | null }[];
  by_language: Record<string, { summary: string; decisions: string[]; action_items: { owner: string; task: string; due?: string | null }[] }>;
  engine: string;
}
/** Summarise a finished meeting (captions + chat). Long timeout: big meetings take a while. */
export const summarize = (body: {
  title: string; transcript: { speaker: string; text: string }[]; chat: { speaker: string; text: string }[]; languages: string[];
}) => post<SummaryOut>("/summarize", body, 180_000);

/** "Ask your meetings": answer a question from matching transcript passages, with [M1]-style citations. */
export const answer = (question: string, passages: { id: string; meeting: string; date: string; speaker: string; text: string }[]) =>
  post<{ answer: string; citations: string[]; engine: string }>("/answer", { question, passages }, 60_000);

/** Is the AI service up, and are speech-to-text and an LLM configured? Never throws (used by /api/health and the join page). */
export async function aiHealth(): Promise<{ ok: boolean; stt: boolean; llm: string | null }> {
  try {
    const r = await fetch(`${config.aiUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()) as any;
  } catch (e: any) {
    log.debug({ err: e?.message }, "ai health failed");
    return { ok: false, stt: false, llm: null };
  }
}
