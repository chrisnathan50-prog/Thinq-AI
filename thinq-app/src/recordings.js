// Recorded meetings: the person presses "Record meeting" in the Thinq app, and the browser records their
// microphone (and, on desktop Chrome/Edge, the audio of a meeting tab such as Google Meet). The browser sends
// the audio in pieces of a few minutes, saving each piece to the server every 15 seconds while it records. Each
// finished piece is turned into text with Groq's Whisper (free tier), and its audio is deleted only once that worked:
// when Groq is busy the audio waits, for as long as Groq asks, up to a day. Pieces overlap by two seconds so no word
// is lost at a join. When the recording stops, Thinq joins the
// pieces into one transcript and writes the same notes as for the notetaker (summary, decisions, action items).
//
// Recordings are rows in the meetings table (source = 'recording') with their pieces in meeting_segments.
//
// Speaker names: when a meeting tab is recorded too, the browser records the microphone ("me" track - the person
// recording) and the tab's sound ("others" track - everyone else on the call) as two separate files. Each is
// transcribed with timestamps and the lines are merged back in time order, labelled with the person's name or
// "Others in the call". Whisper can't tell different voices apart within one track, so the people on the call
// share one label. A microphone-only recording (one room, one track) has no speaker labels.
// If the browser tab closes mid-meeting, whatever was already sent is still turned into notes (see finishStale).
import { query, one } from "./db.js";
import { id } from "./secrets.js";
import * as store from "./store.js";
import { transcribe, voiceAvailable, MAX_AUDIO_BYTES } from "./llm/transcribe.js";
import { summarize } from "./meetings.js";

export const recordingAvailable = () => voiceAvailable();
export const MAX_SEGMENT_BYTES = MAX_AUDIO_BYTES;
const MAX_SEGMENTS = 200; // piece numbers per recording (a dropped recorder restarts with a new piece)
const MAX_RECORDING_MS = 4 * 3600e3;
const GIVE_UP_MS = 24 * 3600e3; // audio Groq still hasn't taken after a day is dropped
let groqPausedUntil = 0; // Groq said to wait: nothing is sent until then
const MAX_RECORDINGS_PER_DAY = Number(process.env.RECORDINGS_PER_DAY ?? 10);

class RecordingError extends Error { userFacing = true; }

export const OTHERS_LABEL = "Others in the call";
const TRACKS = ["mixed", "me", "others"];
const trackN = (track, n) => (track === "others" ? 1000 + n : n); // both tracks' pieces share one table

export async function startRecording(userId, { title, withTab, separate = false }) {
  if (!recordingAvailable()) throw new RecordingError("Recording meetings needs GROQ_API_KEY on the server.");
  const today = (await one(`select count(*)::int as n from meetings where user_id = $1 and source = 'recording' and created_at >= current_date`, [userId])).n;
  if (MAX_RECORDINGS_PER_DAY && today >= MAX_RECORDINGS_PER_DAY) throw new RecordingError(`You've recorded ${today} meetings today, the daily limit. It resets tomorrow.`);
  // Only one recording at a time per person: close any that were left open.
  const open = await query(`select id from meetings where user_id = $1 and source = 'recording' and status = 'recording'`, [userId]);
  for (const r of open) finishRecording(userId, r.id).catch(() => {});
  const meetingId = id("rec");
  const name = String(title || "").trim().slice(0, 200) || `Meeting ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  await query(
    `insert into meetings (id, user_id, source, platform, title, join_at, started_at, status) values ($1, $2, 'recording', $3, $4, now(), now(), 'recording')`,
    [meetingId, userId, withTab ? (separate ? "Recorded (you + meeting tab)" : "Recorded (tab + mic)") : "Recorded (mic)", name]);
  await store.logAction(userId, "recording_started", { meetingId, withTab: Boolean(withTab) });
  return { id: meetingId, title: name };
}

const owned = (userId, meetingId) => one(`select * from meetings where id = $1 and user_id = $2 and source = 'recording'`, [meetingId, userId]);

// A piece arrives in numbered parts (seq 0, 1, 2...) and `final` marks the last one. Parts are appended in order and
// a repeated part (a retry after a lost response) is ignored. Without seq, the body is one whole piece.
export async function addSegment(userId, meetingId, { n, offsetMs, mime, audio, track = "mixed", seq = null, final = true, overlapMs = 0 }) {
  if (!TRACKS.includes(track)) throw new RecordingError("Unknown audio track.");
  const m = await owned(userId, meetingId);
  if (!m) throw new RecordingError("That recording wasn't found.");
  if (!["recording", "transcribing"].includes(m.status)) throw new RecordingError("That recording has already finished.");
  if (!Number.isInteger(n) || n < 0 || n >= MAX_SEGMENTS || offsetMs > MAX_RECORDING_MS) throw new RecordingError("That recording is too long (4 hours at most).");
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.alloc(0);
  if (bytes.length > MAX_SEGMENT_BYTES) throw new RecordingError("That piece of audio is too big.");
  const dbN = trackN(track, n), overlap = Math.min(5000, Math.max(0, overlapMs | 0));
  if (seq == null || seq === 0) {
    if (!bytes.length) throw new RecordingError("That piece of audio is empty.");
    await query(
      `insert into meeting_segments (meeting_id, n, offset_ms, mime, audio, track, status, chunks, overlap_ms) values ($1, $2, $3, $4, $5, $6, $7, 1, $8)
       on conflict (meeting_id, n) do nothing`,
      [meetingId, dbN, Math.max(0, offsetMs | 0), String(mime || "audio/webm").slice(0, 80), bytes, track, final ? "pending" : "receiving", overlap]);
  } else {
    const added = await one(
      `update meeting_segments set audio = audio || $3::bytea, chunks = chunks + 1, overlap_ms = greatest(overlap_ms, $6::int),
         status = case when $4::boolean then 'pending' else 'receiving' end
       where meeting_id = $1 and n = $2 and chunks = $5::int and status = 'receiving' and octet_length(audio) + $7::int <= $8::int returning n`,
      [meetingId, dbN, bytes, Boolean(final), seq, overlap, bytes.length, MAX_SEGMENT_BYTES]);
    if (!added) {
      const row = await one(`select chunks from meeting_segments where meeting_id = $1 and n = $2`, [meetingId, dbN]);
      if (!row || row.chunks < seq) throw new RecordingError("Part of the recording arrived out of order.");
    }
  }
  await query(`update meetings set updated_at = now() where id = $1`, [meetingId]);
  if (final) transcribeSegment(meetingId, dbN).catch(() => {}); // in the background; the browser doesn't wait
  return { ok: true };
}

// ---------- turning pieces into text ----------
const working = new Set();
async function transcribeSegment(meetingId, n) {
  const key = `${meetingId}:${n}`;
  if (working.has(key) || Date.now() < groqPausedUntil) return;
  working.add(key);
  try {
    const s = await one(`select * from meeting_segments where meeting_id = $1 and n = $2 and status = 'pending'`, [meetingId, n]);
    if (!s?.audio) return;
    try {
      // Timed sentences, so overlapping pieces and separate tracks can be joined in order.
      const out = await transcribe(Buffer.from(s.audio), s.mime || "audio/webm", { timestamps: true });
      const lines = cleanLines(out.segments.length ? out.segments : [{ start: 0, end: 0, text: out.text }], s.offset_ms);
      await query(`update meeting_segments set text = $3, lines = $4, status = 'done', audio = null, next_try_at = null where meeting_id = $1 and n = $2`,
        [meetingId, n, lines.map((l) => l.text).join(" "), JSON.stringify(lines)]);
    } catch (err) {
      const tries = s.tries + 1;
      // Only audio the service can never read is dropped. Busy, down or a wrong key: keep it and try again later.
      const unreadable = [400, 413, 415, 422].includes(err.status);
      const giveUp = unreadable || Date.now() - new Date(s.created_at).getTime() > GIVE_UP_MS;
      const waitSec = Math.max(5, err.retryAfter ?? Math.min(900, 60 * tries));
      if (err.status === 429) groqPausedUntil = Date.now() + waitSec * 1000;
      await query(`update meeting_segments set tries = $3, status = $4, next_try_at = now() + make_interval(secs => $5),
          audio = case when $4 = 'failed' then null else audio end where meeting_id = $1 and n = $2`,
        [meetingId, n, tries, giveUp ? "failed" : "pending", waitSec]);
      console.warn(`[recordings] piece ${n} of ${meetingId} ${giveUp ? "failed" : `will retry in ${Math.round(waitSec)}s`}: ${err.message}`);
    }
    await maybeComplete(meetingId);
  } finally {
    working.delete(key);
  }
}

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)); // rounded down, so jumping to a line never skips its first word
  const h = Math.floor(s / 3600), mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// Whisper's sentences -> what we keep. It "hears" punctuation or stock phrases in silence, so those are dropped.
const PHANTOM = /^(thank(s| you)( (so much|very much))?( for watching| for listening)?|you|bye|okay|subtitles by .*)[.!]?$/i;
export function cleanLines(segments, offsetMs = 0) {
  return (segments || []).filter((g) => {
    const text = String(g.text || "").trim(), noSpeech = g.noSpeech || 0, logprob = g.logprob || 0;
    if (!/[\p{L}\p{N}]/u.test(text)) return false;
    if (noSpeech >= 0.8 || (noSpeech > 0.6 && logprob < -0.7)) return false;
    if (g.wordCount && g.wordCount <= 5 && g.wordSeconds > 1) return false; // words stretched over seconds: invented in silence
    return !(PHANTOM.test(text) && noSpeech > 0.25);
  }).map((g) => ({ at: offsetMs + Math.round(g.start * 1000), end: offsetMs + Math.round(g.end * 1000), text: String(g.text).trim() }));
}

// Each track's pieces in order, cutting the overlap at its midpoint so a sentence appears once.
export function stitchLines(parts) {
  const out = [];
  for (const track of new Set(parts.map((p) => p.track || "mixed"))) {
    const list = parts.filter((p) => (p.track || "mixed") === track).sort((a, b) => a.offset_ms - b.offset_ms);
    list.forEach((s, i) => {
      const before = list[i - 1], after = list[i + 1];
      const from = before ? s.offset_ms + (before.overlap_ms || 0) / 2 : -Infinity;
      const to = after ? after.offset_ms + (s.overlap_ms || 0) / 2 : Infinity;
      const lines = (typeof s.lines === "string" ? JSON.parse(s.lines) : s.lines) || [{ at: s.offset_ms, end: s.offset_ms, text: s.text }];
      for (const l of lines) if (l.text?.trim() && l.at >= from && l.at < to) out.push({ at: l.at, end: l.end ?? l.at, track, text: l.text.trim() });
    });
  }
  return out.sort((a, b) => a.at - b.at);
}
// One voice: readable paragraphs, each with its time.
function plainTranscript(lines) {
  const paras = [];
  for (const l of lines) {
    const last = paras.at(-1);
    if (last && l.at - last.end < 8000 && last.text.length < 600) { last.text += ` ${l.text}`; last.end = l.end; }
    else paras.push({ ...l });
  }
  return paras.map((p) => `[${clock(p.at)}] ${p.text}`).join("\n\n");
}

// Once the recording has stopped and every piece is transcribed, build the transcript and write the notes.
async function maybeComplete(meetingId) {
  const m = await one(`select * from meetings where id = $1`, [meetingId]);
  if (m?.status !== "transcribing") return;
  const segs = await query(`select n, offset_ms, overlap_ms, text, lines, track, status from meeting_segments where meeting_id = $1 order by offset_ms, n`, [meetingId]);
  if (segs.some((s) => s.status === "pending")) return;
  const parts = segs.filter((s) => s.status === "done" && s.text?.trim());
  const failed = segs.filter((s) => s.status === "failed").length;
  const separate = parts.some((s) => s.track === "me" || s.track === "others");
  const transcript = separate
    ? speakerTranscript(parts, (await one(`select name from users where id = $1`, [m.user_id]))?.name)
    : plainTranscript(stitchLines(parts));
  const claimed = await one(`update meetings set status = 'summarizing', transcript = $2, updated_at = now() where id = $1 and status = 'transcribing' returning id`, [meetingId, transcript || null]);
  if (!claimed) return;
  if (!transcript) {
    await query(`update meetings set status = 'no_notes', error = $2 where id = $1`, [meetingId,
      segs.length ? "No speech was heard in the recording." : "Nothing was recorded. Check that your microphone (or the tab's audio) was shared."]);
    return;
  }
  await summarize(meetingId);
  if (failed) await query(`update meetings set error = $2 where id = $1`, [meetingId, `${failed} part${failed > 1 ? "s" : ""} of the recording couldn't be transcribed, so the notes may have gaps.`]);
  await store.logAction(m.user_id, "recording_finished", { meetingId, pieces: segs.length, failed });
}

// Two tracks -> one transcript in time order, each line labelled with who spoke:
//   [02:14] Alex: Can we move the launch to March?
//   [02:19] Others in the call: March works if design is done by the 20th.
const wordsOf = (t) => String(t).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
// The same run of words: most of this line's word pairs also appear, in order, in the other track's line.
function repeats(line, other) {
  const a = wordsOf(line), b = wordsOf(other);
  if (a.length < 3 || b.length < 2) return false;
  const pairs = new Set(b.slice(1).map((w, i) => `${b[i]} ${w}`));
  const shared = a.slice(1).filter((w, i) => pairs.has(`${a[i]} ${w}`)).length;
  return shared / (a.length - 1) >= 0.7;
}
export function speakerTranscript(parts, userName) {
  const me = String(userName || "").split(/\s+/)[0] || "You";
  const lines = stitchLines(parts).map((l) => ({ ...l, who: l.track === "me" ? me : l.track === "others" ? OTHERS_LABEL : "Someone" }));
  // On speakers (no headphones) the microphone also picks up the call. Drop "me" lines that just repeat what the
  // tab said at the same moment.
  const others = lines.filter((l) => l.who === OTHERS_LABEL);
  const echo = (l) => l.track === "me" && others.some((o) => o.at - 2000 <= l.end && l.at <= o.end + 2000 && repeats(l.text, o.text));
  const kept = lines.filter((l) => !echo(l));
  // Join consecutive lines from the same speaker so it reads like a conversation.
  const turns = [];
  for (const l of kept) {
    const last = turns.at(-1);
    if (last && last.who === l.who && l.at - last.end < 8000) { last.text += ` ${l.text}`; last.end = l.end; }
    else turns.push({ ...l });
  }
  return turns.map((t) => `[${clock(t.at)}] ${t.who}: ${t.text}`).join("\n");
}

export async function finishRecording(userId, meetingId) {
  const m = await owned(userId, meetingId);
  if (!m) throw new RecordingError("That recording wasn't found.");
  if (m.status === "recording") {
    await query(`update meetings set status = 'transcribing', ended_at = now(), updated_at = now() where id = $1`, [meetingId]);
  }
  // Pieces the browser never finished sending (tab closed, phone died): use what arrived.
  await query(`update meeting_segments set status = 'pending' where meeting_id = $1 and status = 'receiving' and octet_length(audio) >= 2000`, [meetingId]);
  await query(`delete from meeting_segments where meeting_id = $1 and status = 'receiving'`, [meetingId]);
  const pending = await query(`select n from meeting_segments where meeting_id = $1 and status = 'pending'`, [meetingId]);
  for (const s of pending) transcribeSegment(meetingId, s.n).catch(() => {});
  await maybeComplete(meetingId);
  return { ok: true };
}

export async function cancelRecording(userId, meetingId) {
  const m = await owned(userId, meetingId);
  if (!m) return false;
  await query(`delete from meetings where id = $1`, [meetingId]); // pieces are deleted with it
  await store.logAction(userId, "recording_cancelled", { meetingId });
  return true;
}

// ---------- background: retries, and recordings whose tab was closed ----------
async function tick() {
  // Retry pieces that failed for a temporary reason (e.g. Groq's limits), oldest first, once their wait is over.
  const retry = Date.now() < groqPausedUntil ? [] : await query(`select meeting_id, n from meeting_segments
    where status = 'pending' and coalesce(next_try_at, created_at + interval '1 minute') <= now() order by created_at limit 5`);
  for (const s of retry) await transcribeSegment(s.meeting_id, s.n).catch(() => {});
  // A recording that hasn't sent anything for 12 minutes was probably closed: finish it with what arrived.
  const stale = await query(`select id, user_id from meetings where source = 'recording' and status = 'recording' and updated_at < now() - interval '12 minutes'`);
  for (const r of stale) await finishRecording(r.user_id, r.id).catch(() => {});
  // Any finished recording still waiting (e.g. after a restart).
  const waiting = await query(`select id from meetings where source = 'recording' and status = 'transcribing' and updated_at < now() - interval '2 minutes'`);
  for (const r of waiting) await maybeComplete(r.id).catch(() => {});
  // Notes that were being written when the server restarted.
  const stuck = await query(`select id from meetings where source = 'recording' and status = 'summarizing' and updated_at < now() - interval '5 minutes'`);
  for (const r of stuck) await summarize(r.id).catch(() => {});
}

let started = false;
export function startRecordingWorker() {
  if (started || !recordingAvailable()) return;
  started = true;
  setInterval(() => tick().catch((e) => console.warn("[recordings]", e.message)), 60_000).unref();
  setTimeout(() => tick().catch(() => {}), 10_000).unref();
}
export const _tick = tick;
export const _resetGroqPause = () => { groqPausedUntil = 0; };
