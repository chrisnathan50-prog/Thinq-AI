// Voice notes -> text, using Groq's Whisper speech-to-text (free tier, works whichever AI_PROVIDER you use).
// The recording is sent to Groq once and never stored by Thinq.
import { GroqError } from "./groq.js";

const BASE_URL = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
export const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo";
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // about 15 minutes of compressed speech
export const voiceAvailable = () => Boolean(process.env.GROQ_API_KEY);

const extFor = (type) => (/mp4|m4a|aac/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : /wav/.test(type) ? "wav" : /mpeg|mp3/.test(type) ? "mp3" : "webm");

// How long Groq asks us to wait: the Retry-After header, or "try again in 7m30.5s" / "12s" / "900ms" in its message.
export function retryAfterSeconds(header, message) {
  if (Number(header) > 0) return Number(header);
  const m = String(message || "").match(/try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?/i);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + (m[3] ? Number(m[3]) / (m[4].toLowerCase() === "ms" ? 1000 : 1) : 0);
}

// With timestamps: true it returns { text, segments: [{ start, end, text, noSpeech, logprob }] } (seconds from the
// start of this audio; noSpeech and logprob are Whisper's own confidence that a stretch is really speech).
// Whisper's sentence times swallow any silence before them (speech at 18s comes back as "0 to 21s"), but its word
// times are accurate. So each sentence is timed from its own words. wordSeconds is the average length of a word:
// words Whisper invents in silence are stretched over seconds, real ones last a fraction of a second.
export function timedSegments(segments = [], words = []) {
  return segments.map((s) => {
    const start = Number(s.start) || 0, end = Number(s.end) || 0;
    const own = words.filter((w) => w.start >= start - 0.01 && w.start < end);
    return {
      start: own.length ? own[0].start : start, end: own.length ? own.at(-1).end : end, text: String(s.text || "").trim(),
      noSpeech: Number(s.no_speech_prob) || 0, logprob: Number(s.avg_logprob) || 0,
      wordCount: own.length, wordSeconds: own.length ? own.reduce((n, w) => n + (w.end - w.start), 0) / own.length : 0,
    };
  }).filter((s) => s.text);
}

export async function transcribe(buffer, contentType = "audio/webm", { language, timestamps = false } = {}) {
  if (!voiceAvailable()) throw new GroqError(0, "Voice notes need GROQ_API_KEY on the server.", "voice_not_configured");
  const type = String(contentType).split(";")[0] || "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), `voice-note.${extFor(type)}`);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", timestamps ? "verbose_json" : "json");
  form.append("temperature", "0");
  if (timestamps) { form.append("timestamp_granularities[]", "word"); form.append("timestamp_granularities[]", "segment"); }
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
    throw new GroqError(res.status, message, code, retryAfterSeconds(res.headers.get("retry-after"), message));
  }
  const data = await res.json();
  if (timestamps) {
    return { text: String(data.text || "").trim(), segments: timedSegments(data.segments, data.words) };
  }
  return String(data.text || "").trim();
}
