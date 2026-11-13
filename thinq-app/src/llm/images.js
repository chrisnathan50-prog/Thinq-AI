// Image generation with Cloudflare Workers AI (FLUX.1 schnell). The free plan includes 10,000 "neurons"
// a day, and one image here uses about 77 of them, so that's roughly 130 free images a day for the whole server.
// Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with "Workers AI" permission) to turn it on.
const BASE_URL = (process.env.CLOUDFLARE_AI_BASE_URL || "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
export const IMAGE_MODEL = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
export const IMAGE_DAILY_LIMIT = Number(process.env.IMAGE_DAILY_LIMIT || 10); // per person per day
const STEPS = Math.min(8, Math.max(1, Number(process.env.IMAGE_STEPS || 6))); // more steps = more detail, more neurons

export const imagesAvailable = () => Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

export class ImageError extends Error {
  constructor(message, { status = 0, quota = false } = {}) { super(message); this.status = status; this.quota = quota; }
}

const mimeOf = (buf) =>
  buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : buf[0] === 0x52 && buf[8] === 0x57 ? "image/webp" : "image/jpeg";

export async function generateImage(prompt) {
  if (!imagesAvailable()) throw new ImageError("Image creation isn't set up on this server.");
  const url = `${BASE_URL}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${IMAGE_MODEL}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: String(prompt).slice(0, 2048), steps: STEPS, seed: Math.floor(Math.random() * 2 ** 31) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new ImageError(`Couldn't reach the image service (${err.name === "TimeoutError" ? "it took too long" : err.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false || !data.result?.image) {
    const msg = (data.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    const quota = res.status === 429 || /neuron|quota|limit|exceeded/i.test(msg);
    if (quota) throw new ImageError("The free image allowance for today is used up. It resets at midnight UTC.", { status: 429, quota: true });
    if (res.status === 401 || res.status === 403) throw new ImageError("The image service rejected Thinq's Cloudflare key.", { status: res.status });
    if (/nsfw|safety|flagged/i.test(msg)) throw new ImageError("The image service declined that prompt.", { status: 400 });
    throw new ImageError(`The image service had a problem: ${msg}`, { status: res.status });
  }
  const buffer = Buffer.from(data.result.image, "base64");
  return { buffer, mime: mimeOf(buffer) };
}
