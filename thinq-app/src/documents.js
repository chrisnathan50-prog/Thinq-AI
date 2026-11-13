// Documents people attach in chat: we pull out the text (PDF, Word, plain text) and keep only that.
// The original file isn't stored. Long documents are split into parts the AI reads one at a time.
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import JSZip from "jszip";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_TEXT_CHARS = 400_000; // ~100k words kept per document
export const PART_CHARS = 6_000; // one "part" the AI reads at a time (~1,500 tokens)

const TEXT_TYPES = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "log"]);
export const ACCEPTED = ".pdf,.docx,.txt,.md,.csv,.tsv,.json,.html,.log,.zip";

export class DocumentError extends Error {}

const ext = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";

export async function extractDocument(name, buffer) {
  if (!buffer?.length) throw new DocumentError("That file is empty.");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new DocumentError("That file is over 10 MB. Try a smaller one.");
  const kind = ext(name);
  let text = "", pages = null;

  if (kind === "pdf" || buffer.subarray(0, 5).toString() === "%PDF-") {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const out = await extractText(pdf, { mergePages: false });
      pages = out.totalPages;
      text = out.text.map((t, i) => `[Page ${i + 1}]\n${t.trim()}`).join("\n\n");
    } catch {
      throw new DocumentError("Couldn't read that PDF. It may be password-protected or damaged.");
    }
    if (text.replace(/\[Page \d+\]/g, "").trim().length < 20) {
      throw new DocumentError("That PDF has no readable text — it's probably a scan or photos. Try a PDF with selectable text.");
    }
  } else if (kind === "docx") {
    try {
      text = (await mammoth.extractRawText({ buffer })).value;
    } catch {
      throw new DocumentError("Couldn't read that Word file. Try saving it again as .docx or PDF.");
    }
  } else if (kind === "zip" || (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03)) {
    // WhatsApp's "Export chat" makes a .zip (chat text + media) - we only read the chat text.
    let zip;
    try { zip = await JSZip.loadAsync(buffer); } catch { throw new DocumentError("Couldn't open that zip file."); }
    const txt = Object.values(zip.files).filter((f) => !f.dir && /\.txt$/i.test(f.name) && !f.name.startsWith("__MACOSX"))
      .sort((a, b) => Number(/chat/i.test(b.name)) - Number(/chat/i.test(a.name)))[0];
    if (!txt) throw new DocumentError("Thinq can read zip files only when they're WhatsApp chat exports.");
    text = await txt.async("string");
    if (!parseWhatsApp(text)) throw new DocumentError("Thinq can read zip files only when they're WhatsApp chat exports.");
  } else if (kind === "doc") {
    throw new DocumentError("Old .doc files aren't supported. Save it as .docx or PDF and try again.");
  } else if (TEXT_TYPES.has(kind)) {
    text = buffer.toString("utf8");
    if (kind === "html" || kind === "htm") text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/[ \t]{2,}/g, " ");
  } else {
    throw new DocumentError("Thinq can read PDF, Word (.docx) and text files (.txt, .md, .csv).");
  }

  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new DocumentError("Couldn't find any text in that file.");
  let whatsapp = null;
  if (kind === "txt" || kind === "zip" || kind === "") {
    whatsapp = parseWhatsApp(text);
    if (whatsapp) text = whatsapp.text;
  }
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS);
  return { text, pages, truncated, chars: text.length, parts: partCount(text.length), whatsapp: whatsapp && { messages: whatsapp.count, people: whatsapp.people } };
}

export const partCount = (chars) => Math.max(1, Math.ceil(chars / PART_CHARS));

// Split on paragraph boundaries near PART_CHARS so parts don't cut sentences in half.
export function getPart(text, part) {
  const n = partCount(text.length);
  const p = Math.min(Math.max(1, part), n);
  let start = (p - 1) * PART_CHARS, end = Math.min(text.length, p * PART_CHARS);
  if (p > 1) { const nl = text.lastIndexOf("\n", start); if (nl > start - 800) start = nl + 1; }
  if (p < n) { const nl = text.lastIndexOf("\n", end); if (nl > end - 800) end = nl; }
  return { part: p, of: n, text: text.slice(start, end) };
}

// ---------- WhatsApp chat exports ----------
// WhatsApp's "Export chat" writes one line per message, in two styles:
//   iPhone:   [13/11/2026, 14:03:22] Sam Lee: See you at 5
//   Android:  13/11/2026, 14:03 - Sam Lee: See you at 5
// (date order and 12/24-hour clock follow the phone's settings). Lines that don't start a message continue the previous one.
const TIME = String.raw`\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[AaPp]\.?\s?[Mm]\.?)?`;
const DATE = String.raw`\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}`;
const IOS = new RegExp(String.raw`^\[(${DATE}),?\s(${TIME})\]\s([^:]{1,60}?):\s?(.*)$`);
const ANDROID = new RegExp(String.raw`^(${DATE}),?\s(${TIME})\s[-–]\s([^:]{1,60}?):\s?(.*)$`);
const SYSTEM = new RegExp(String.raw`^\[?(${DATE}),?\s(${TIME})\]?\s(?:[-–]\s)?(.*)$`);

export function parseWhatsApp(raw) {
  const lines = raw.replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\u202f/g, " ").split("\n");
  const head = lines.slice(0, 40).filter((l) => IOS.test(l) || ANDROID.test(l)).length;
  if (head < 2) return null;
  const msgs = [];
  for (const line of lines) {
    const m = line.match(IOS) || line.match(ANDROID);
    if (m) { msgs.push({ date: m[1], time: m[2].replace(/\s+/g, " "), who: m[3].trim(), text: m[4] }); continue; }
    if (SYSTEM.test(line)) continue; // "Messages are end-to-end encrypted", "Sam added Alex", ...
    if (msgs.length && line.trim()) msgs.at(-1).text += "\n" + line;
  }
  const NOTICE = /^(messages and calls are end-to-end encrypted|.{1,60} (created group|created this group|changed the subject|changed this group's (icon|description)|changed the group (description|name))\b|you were added|your security code with .* changed)/i;
  for (let i = msgs.length - 1; i >= 0; i--) if (NOTICE.test(msgs[i].text.trim()) && msgs[i].text.length < 160 && !msgs[i].text.includes("\n")) msgs.splice(i, 1);
  if (msgs.length < 2) return null;
  const media = (t) => t
    .replace(/<attached:\s*[^>]*?(PHOTO|IMG|jpe?g|png|webp)[^>]*>/gi, "[photo]")
    .replace(/<attached:\s*[^>]*?(AUDIO|opus|m4a|ogg)[^>]*>/gi, "[voice note]")
    .replace(/<attached:\s*[^>]*?(VIDEO|mp4|mov)[^>]*>/gi, "[video]")
    .replace(/<attached:\s*([^>]+)>/gi, "[file: $1]")
    .replace(/<Media omitted>|image omitted|audio omitted|video omitted|sticker omitted|GIF omitted|document omitted/gi, "[media]")
    .replace(/<This message was edited>/gi, "(edited)");
  const people = [...new Set(msgs.map((m) => m.who))];
  const header = `WhatsApp chat export - ${msgs.length} messages between ${msgs[0].date} and ${msgs.at(-1).date}. People: ${people.slice(0, 20).join(", ")}${people.length > 20 ? ` and ${people.length - 20} more` : ""}. Dates are as written by the phone (day/month order depends on its settings).`;
  const body = msgs.map((m) => `[${m.date} ${m.time}] ${m.who}: ${media(m.text)}`).join("\n");
  return { text: `${header}\n\n${body}`, count: msgs.length, people };
}
