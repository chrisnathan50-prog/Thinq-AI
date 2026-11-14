// Read aloud, tried in this order:
//   1. ElevenLabs (natural voices) - set ELEVENLABS_API_KEY. Paid per character; the free plan is small.
//   2. Cloudflare Workers AI MeloTTS (free) - uses the same CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN as images.
//   3. The browser's built-in voice - handled in the app whenever the server can't make audio.
// Each request is capped at SPEECH_MAX_CHARS and counts toward the daily request limit.
import { cloudflareReady, cloudflareRunUrl, cloudflareToken } from "./images.js";

const BASE_URL = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1").replace(/\/$/, "");
// "George" - one of ElevenLabs' default voices. Pick another in their Voice Library and paste its ID.
export const VOICE_ID = String(process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb").trim();
// Flash is fast and uses about half the credits of the multilingual model.
export const SPEECH_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
export const SPEECH_MAX_CHARS = Math.max(100, Number(process.env.SPEECH_MAX_CHARS || 2500));
const FREE_VOICE_MODEL = process.env.CLOUDFLARE_SPEECH_MODEL || "@cf/myshell-ai/melotts";
const FREE_VOICE_LANG = process.env.CLOUDFLARE_SPEECH_LANG || "en";

const apiKey = () => String(process.env.ELEVENLABS_API_KEY || "").trim();
const elevenLabsOn = () => Boolean(apiKey()) && process.env.SPEECH_PROVIDER !== "cloudflare";
const freeVoiceOn = () => cloudflareReady() && process.env.SPEECH_FREE_VOICE !== "off";
export const speechAvailable = () => elevenLabsOn() || freeVoiceOn();

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

// After ElevenLabs runs out of credits (or its key is wrong), skip it for a while instead of failing every request.
let elevenLabsPausedUntil = 0;
const PAUSE_MS = { quota: 60 * 60_000, setup: 10 * 60_000 };

// Returns { voice, body } where body is MP3 audio: a web stream (ElevenLabs) or a Buffer (Cloudflare).
export async function synthesize(text) {
  if (!speechAvailable()) throw new SpeechError("Read aloud voices aren't set up on this server.");
  let firstError = null;
  if (elevenLabsOn() && Date.now() >= elevenLabsPausedUntil) {
    try {
      return { voice: "elevenlabs", body: (await elevenLabs(text)).body };
    } catch (err) {
      firstError = err;
      if (err.quota) elevenLabsPausedUntil = Date.now() + PAUSE_MS.quota;
      else if (err.status === 401 || err.status === 404) elevenLabsPausedUntil = Date.now() + PAUSE_MS.setup;
      if (freeVoiceOn()) console.warn(`[speech] using the free Cloudflare voice instead: ${err.message}`);
    }
  }
  if (freeVoiceOn()) {
    try {
      return { voice: "cloudflare", body: await cloudflareVoice(text) };
    } catch (err) {
      // Both failed: report "out of credits" only if both were out, otherwise the most useful message.
      throw firstError && !(firstError.quota && err.quota) ? firstError : err;
    }
  }
  throw firstError || new SpeechError("Read aloud voices aren't available right now.");
}

async function elevenLabs(text) {
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

// Free voice: Cloudflare Workers AI MeloTTS. It answers with MP3 bytes, or JSON holding base64 MP3.
async function cloudflareVoice(text) {
  let res;
  try {
    res = await fetch(cloudflareRunUrl(FREE_VOICE_MODEL), {
      method: "POST",
      headers: { Authorization: `Bearer ${cloudflareToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text, lang: FREE_VOICE_LANG }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.warn(`[speech] Cloudflare request failed: ${err.name}`); // never log err.message: it can contain header values
    throw new SpeechError("Couldn't reach the free voice service.");
  }
  const type = res.headers.get("content-type") || "";
  if (res.ok && /audio\//.test(type)) return Buffer.from(await res.arrayBuffer());
  const data = await res.json().catch(() => ({}));
  const audio = data.result?.audio ?? data.audio;
  if (res.ok && data.success !== false && typeof audio === "string" && audio.length > 100) return Buffer.from(audio, "base64");
  const msg = (data.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
  console.warn(`[speech] Cloudflare returned ${res.status}: ${msg}`);
  const quota = res.status === 429 || /neuron|quota|limit|exceeded/i.test(msg);
  if (quota) throw new SpeechError("The free voice allowance for today is used up. It resets at midnight UTC.", { status: 429, quota: true });
  throw new SpeechError(`The free voice service had a problem (${res.status}).`, { status: res.status });
}
