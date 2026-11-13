// Image generation with Cloudflare Workers AI (FLUX.1 schnell). The free plan includes 10,000 "neurons"
// a day, and one image here uses about 77 of them, so that's roughly 130 free images a day for the whole server.
// Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with "Workers AI" permission) to turn it on.
const BASE_URL = (process.env.CLOUDFLARE_AI_BASE_URL || "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
export const IMAGE_MODEL = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
export const IMAGE_DAILY_LIMIT = Number(process.env.IMAGE_DAILY_LIMIT || 10); // per person per day
const STEPS = Math.min(8, Math.max(1, Number(process.env.IMAGE_STEPS || 6))); // more steps = more detail, more neurons

const accountId = () => String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const apiToken = () => String(process.env.CLOUDFLARE_API_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
export const imagesAvailable = () => Boolean(accountId() && apiToken());

export class ImageError extends Error {
  constructor(message, { status = 0, quota = false } = {}) { super(message); this.status = status; this.quota = quota; }
}

const mimeOf = (buf) =>
  buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : buf[0] === 0x52 && buf[8] === 0x57 ? "image/webp" : "image/jpeg";

// A Cloudflare API token is one word of letters, digits, "-" and "_". Anything else (e.g. a pasted curl command)
// is a setup mistake - say so without ever echoing the value.
const tokenLooksValid = () => /^[A-Za-z0-9_-]{20,}$/.test(apiToken());
const accountLooksValid = () => /^[a-f0-9]{32}$/i.test(accountId());

export async function generateImage(prompt) {
  if (!imagesAvailable()) throw new ImageError("Image creation isn't set up on this server.");
  if (!tokenLooksValid() || !accountLooksValid()) {
    console.warn(`[images] setup problem: CLOUDFLARE_API_TOKEN ${tokenLooksValid() ? "ok" : "is not a plain token"}, CLOUDFLARE_ACCOUNT_ID ${accountLooksValid() ? "ok" : "is not a 32-character ID"}`);
    throw new ImageError("Image creation is set up incorrectly on the server (the Cloudflare settings need fixing by the site owner).");
  }
  const url = `${BASE_URL}/accounts/${accountId()}/ai/run/${IMAGE_MODEL}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: String(prompt).slice(0, 2048), steps: STEPS, seed: Math.floor(Math.random() * 2 ** 31) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.warn(`[images] request failed: ${err.name}${err.name === "TimeoutError" ? " (timeout)" : ""}`); // never log err.message: it can contain header values
    throw new ImageError(err.name === "TimeoutError" ? "The image service took too long. Try again." : "Couldn't reach the image service. Try again in a minute.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false || !data.result?.image) {
    const msg = (data.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    console.warn(`[images] Cloudflare returned ${res.status}: ${msg}`);
    const quota = res.status === 429 || /neuron|quota|limit|exceeded/i.test(msg);
    if (quota) throw new ImageError("The free image allowance for today is used up. It resets at midnight UTC.", { status: 429, quota: true });
    if (res.status === 401 || res.status === 403) throw new ImageError("The image service rejected Thinq's Cloudflare key.", { status: res.status });
    if (/nsfw|safety|flagged/i.test(msg)) throw new ImageError("The image service declined that prompt.", { status: 400 });
    throw new ImageError(`The image service had a problem: ${msg}`, { status: res.status });
  }
  const buffer = Buffer.from(data.result.image, "base64");
  return { buffer, mime: mimeOf(buffer) };
}
