// Reading text from pictures: photos (receipts, whiteboards, screenshots, letters) and scanned PDFs.
//
//   - With Claude (AI_PROVIDER=anthropic): images and whole PDFs go straight to Claude, which reads scans itself.
//   - With Groq: a Groq model that can see images reads each one. Groq retires models now and then, so a list is
//     tried in order (GROQ_VISION_MODELS, comma-separated) and one that no longer exists is skipped from then on. For a scanned
//     PDF we take out the page images ourselves (unpdf), shrink them, and read them one page at a time.
//
// Only the text that comes back is kept, like any other document - the picture itself isn't stored.
// VISION=off turns this off (then scans and photos are refused as before).
import zlib from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { extractImages, getDocumentProxy } from "unpdf";

const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase() === "groq" ? "groq" : "anthropic";
const GROQ_VISION_MODELS = (process.env.GROQ_VISION_MODELS || process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b,meta-llama/llama-4-scout-17b-16e-instruct,meta-llama/llama-4-maverick-17b-128e-instruct")
  .split(",").map((m) => m.trim()).filter(Boolean);
const goneModels = new Set(); // models Groq said don't exist (retired)
const GROQ_URL = `${(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "")}/chat/completions`;
const CLAUDE_MODEL = process.env.THINQ_MODEL || "claude-opus-5-5";
export const MAX_SCAN_PAGES = Number(process.env.MAX_SCAN_PAGES || 15); // pages read from one scanned PDF (Groq)
const MAX_SIDE = 1600; // px: page images are shrunk to this before they're sent

export const visionAvailable = () =>
  String(process.env.VISION || "on").toLowerCase() !== "off" &&
  (PROVIDER === "groq" ? Boolean(process.env.GROQ_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN));

export class VisionError extends Error {}

const PROMPT = `Transcribe all the text in this image exactly as written, keeping its layout where it helps (lines, lists, tables as rows with " | " between cells, totals on receipts). Don't fix or summarize the text. If part is unreadable, write [unreadable]. Then, if the image has things text alone doesn't capture (a diagram, a chart, a drawing on a whiteboard, a photo with no text), add a line "Picture:" and describe them briefly. If there's no text at all, only write the "Picture:" description. Output only the transcription.`;
const PDF_PROMPT = `This PDF is a scan. Transcribe all its text exactly as written, page by page. Start each page with a line "[Page N]". Keep layout where it helps (lists, tables as rows with " | " between cells). Don't fix or summarize. Write [unreadable] for parts you can't read, and briefly describe diagrams or pictures in a line starting "Picture:". Output only the transcription.`;

let claude;
async function askClaude(content, maxTokens = 8000) {
  claude ??= new Anthropic();
  const msg = await claude.messages.create({ model: CLAUDE_MODEL, max_tokens: maxTokens, output_config: { effort: "low" }, messages: [{ role: "user", content }] });
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

async function askGroq(dataUrl) {
  let lastError = "no vision model is available on this Groq account";
  for (const model of GROQ_VISION_MODELS.filter((m) => !goneModels.has(m))) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_completion_tokens: 4000, ...(/qwen/.test(model) ? { reasoning_effort: "none" } : {}),
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }] }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return String(data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const msg = data?.error?.message || `error ${res.status}`;
    if (res.status === 404 || data?.error?.code === "model_not_found" || /does not exist|decommissioned|not support.*image|image.*not supported/i.test(msg)) {
      console.warn(`[vision] ${model} can't read images here (${msg}) - trying the next model`);
      goneModels.add(model); lastError = msg; continue;
    }
    if (res.status === 429) {
      // Free tier's per-minute limit: wait (up to 25s, twice) and try again before giving up.
      if ((askGroq.waits = (askGroq.waits || 0) + 1) <= 2) {
        const wait = Math.min(25, Number(res.headers.get("retry-after")) || 10);
        await new Promise((r) => setTimeout(r, wait * 1000));
        try { return await askGroq(dataUrl); } finally { askGroq.waits = 0; }
      }
      askGroq.waits = 0;
      throw new VisionError("The free AI is busy reading other pictures. Try again in a minute.");
    }
    throw new VisionError(`Couldn't read the picture: ${msg}`);
  }
  throw new VisionError(`Couldn't read the picture: ${lastError}. Set GROQ_VISION_MODELS to a Groq model that accepts images.`);
}

const IMAGE_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
export const IMAGE_EXTS = Object.keys(IMAGE_MIME);
export function imageMime(name, buffer) {
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (b.subarray(0, 3).toString() === "GIF") return "image/gif";
  return IMAGE_MIME[(String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1]] || null;
}

// A photo or screenshot -> its text.
export async function readImage(buffer, mime) {
  if (!visionAvailable()) throw new VisionError("Reading photos isn't turned on on this server.");
  // Claude takes images up to 5 MB, Groq data URLs up to 4 MB. The app shrinks photos before uploading.
  if (buffer.length > 3.8 * 1024 * 1024) throw new VisionError("That picture is too big to read (over 4 MB). Try a smaller photo or a screenshot.");
  const b64 = buffer.toString("base64");
  const text = PROVIDER === "groq"
    ? await askGroq(`data:${mime};base64,${b64}`)
    : await askClaude([{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }, { type: "text", text: PROMPT }], 4000);
  if (!text) throw new VisionError("Couldn't find anything to read in that picture.");
  return text;
}

// A scanned PDF (no text layer) -> its text, page by page. Returns { text, pagesRead, totalPages }.
export async function readScannedPdf(buffer) {
  if (!visionAvailable()) throw new VisionError("Reading scanned PDFs isn't turned on on this server.");
  if (PROVIDER === "anthropic") {
    const text = await askClaude([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } }, { type: "text", text: PDF_PROMPT }], 16000);
    return { text, pagesRead: null };
  }
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const total = pdf.numPages, pages = Math.min(total, MAX_SCAN_PAGES);
  const out = [];
  for (let n = 1; n <= pages; n++) {
    let imgs = [];
    try { imgs = await extractImages(pdf, n); } catch { /* a page we can't take apart */ }
    const big = imgs.filter((i) => i.width * i.height > 200 * 200).sort((a, b) => b.width * b.height - a.width * a.height);
    if (!big.length) { out.push(`[Page ${n}]\n[no picture found on this page]`); continue; }
    const png = toPng(big[0]);
    out.push(`[Page ${n}]\n${await askGroq(`data:image/png;base64,${png.toString("base64")}`)}`);
  }
  if (total > pages) out.push(`[Only the first ${pages} of ${total} pages were read.]`);
  return { text: out.join("\n\n"), pagesRead: pages, totalPages: total };
}

// ---------- raw page pixels -> a small PNG (no image library needed) ----------
function toPng({ data, width, height, channels }) {
  channels = channels || Math.round(data.length / (width * height)) || 1; // unpdf doesn't always say: work it out from the size
  // Shrink with a box filter so the long side is at most MAX_SIDE, and turn colour into grey (text reads fine, files are 3x smaller).
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
  const w = Math.floor(width / scale), h = Math.floor(height / scale);
  const grey = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < scale; dy++) {
        const row = (y * scale + dy) * width;
        for (let dx = 0; dx < scale; dx++) {
          const i = (row + x * scale + dx) * channels;
          const v = channels >= 3 ? (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 : data[i];
          // Transparent pixels (alpha channel: 4 = RGBA, 2 = grey + alpha) are laid on white paper, not black.
          const alpha = channels === 4 ? data[i + 3] / 255 : channels === 2 ? data[i + 1] / 255 : 1;
          sum += v * alpha + 255 * (1 - alpha);
        }
      }
      grey[y * w + x] = Math.round(sum / (scale * scale));
    }
  }
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; grey.copy(raw, y * (w + 1) + 1, y * w, y * w + w); }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export { toPng as _toPng };
