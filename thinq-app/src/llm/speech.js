// Read aloud with natural voices from ElevenLabs text-to-speech. Optional: set ELEVENLABS_API_KEY to turn it on.
// Without it (or if ElevenLabs fails or runs out of credits), the app falls back to the browser's built-in voice.
// ElevenLabs bills per character, so each request is capped at SPEECH_MAX_CHARS and counts toward the daily limit.
const BASE_URL = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1").replace(/\/$/, "");
// "George" - one of ElevenLabs' default voices. Pick another in their Voice Library and paste its ID.
export const VOICE_ID = String(process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb").trim();
// Flash is fast and uses about half the credits of the multilingual model.
export const SPEECH_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
export const SPEECH_MAX_CHARS = Math.max(100, Number(process.env.SPEECH_MAX_CHARS || 2500));

const apiKey = () => String(process.env.ELEVENLABS_API_KEY || "").trim();
export const speechAvailable = () => Boolean(apiKey());

export class SpeechError extends Error {
  constructor(message, { status = 0, quota = false } = {}) { super(message); this.status = status; this.quota = quota; }
}

// Cut long text at a sentence end near the limit so the voice doesn't stop mid-word.
export function trimForSpeech(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= SPEECH_MAX_CHARS) return t;
  const cut = t.slice(0, SPEECH_MAX_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > SPEECH_MAX_CHARS * 0.6 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

// Returns a fetch Response whose body is MP3 audio, so the server can stream it straight to the browser.
export async function synthesize(text) {
  if (!speechAvailable()) throw new SpeechError("Natural voices aren't set up on this server.");
  // Real ElevenLabs keys start with "sk_". Anything else (often the key's ID, copied from the list of keys)
  // is a setup mistake - say so without calling ElevenLabs or echoing the value.
  if (!apiKey().startsWith("sk_")) {
    console.warn("[speech] setup problem: ELEVENLABS_API_KEY doesn't start with sk_ (it may be the key's ID instead of the key)");
    throw new SpeechError("ELEVENLABS_API_KEY isn't a valid ElevenLabs key. Real keys start with \"sk_\" and are shown only once, when the key is created.", { status: 401 });
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}/text-to-speech/${encodeURIComponent(VOICE_ID)}/stream?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: SPEECH_MODEL }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new SpeechError(`Couldn't reach ElevenLabs: ${err.message}`);
  }
  if (res.ok) return res;

  // Log the reason (never the key) so the site owner can fix setup problems.
  let detail = {};
  try { const d = (await res.json()).detail; detail = typeof d === "object" && d ? d : { message: String(d || "") }; } catch {}
  const status = String(detail.status || detail.code || "");
  console.warn(`[speech] ElevenLabs ${res.status} ${status}: ${detail.message || ""}`);
  const quota = res.status === 402 || /quota|credit|limit/i.test(status);
  if (quota) throw new SpeechError("The natural voice has run out of credits for now.", { status: res.status, quota: true });
  if (res.status === 401 || /invalid_api_key|unauthorized/i.test(status)) throw new SpeechError("The server's ElevenLabs key was rejected.", { status: 401 });
  if (res.status === 404 || /voice_not_found/i.test(status)) throw new SpeechError("The ElevenLabs voice isn't available (check ELEVENLABS_VOICE_ID).", { status: 404 });
  if (res.status === 429) throw new SpeechError("The natural voice is busy. Try again in a moment.", { status: 429 });
  // Include ElevenLabs' short reason code (never the key) so the site owner can see what to fix.
  const reason = [status, String(detail.message || "").slice(0, 160)].filter(Boolean).join(": ");
  throw new SpeechError(`ElevenLabs returned an error (${res.status}${reason ? ` - ${reason}` : ""}).`, { status: res.status });
}
