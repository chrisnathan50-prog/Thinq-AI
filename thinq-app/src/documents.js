// Documents people attach in chat: we pull out the text (PDF, Word, plain text) and keep only that.
// The original file isn't stored. Long documents are split into parts the AI reads one at a time.
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_TEXT_CHARS = 400_000; // ~100k words kept per document
export const PART_CHARS = 6_000; // one "part" the AI reads at a time (~1,500 tokens)

const TEXT_TYPES = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "log"]);
export const ACCEPTED = ".pdf,.docx,.txt,.md,.csv,.tsv,.json,.html,.log";

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
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS);
  return { text, pages, truncated, chars: text.length, parts: partCount(text.length) };
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
