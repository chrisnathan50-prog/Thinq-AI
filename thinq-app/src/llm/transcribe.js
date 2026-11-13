// Voice notes -> text, using Groq's Whisper speech-to-text (free tier, works whichever AI_PROVIDER you use).
// The recording is sent to Groq once and never stored by Thinq.
import { GroqError } from "./groq.js";

const BASE_URL = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
export const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo";
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // about 15 minutes of compressed speech
export const voiceAvailable = () => Boolean(process.env.GROQ_API_KEY);

const extFor = (type) => (/mp4|m4a|aac/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : /wav/.test(type) ? "wav" : /mpeg|mp3/.test(type) ? "mp3" : "webm");

export async function transcribe(buffer, contentType = "audio/webm", { language } = {}) {
  if (!voiceAvailable()) throw new GroqError(0, "Voice notes need GROQ_API_KEY on the server.", "voice_not_configured");
  const type = String(contentType).split(";")[0] || "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), `voice-note.${extFor(type)}`);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (language) form.append("language", language);

  let res;
  try {
    res = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new GroqError(0, `Couldn't reach Groq: ${err.message}`, "connection_error");
  }
  if (!res.ok) {
    let message, code;
    try { const e = (await res.json()).error || {}; message = e.message; code = e.code; } catch {}
    throw new GroqError(res.status, message, code, Number(res.headers.get("retry-after")) || null);
  }
  const data = await res.json();
  return String(data.text || "").trim();
}
