// Recorded meetings: the person presses "Record meeting" in the Thinq app, and the browser records their
// microphone (and, on desktop Chrome/Edge, the audio of a meeting tab such as Google Meet). The browser sends
// the audio in pieces of a few minutes; each piece is turned into text with Groq's Whisper (free tier) as soon as
// it arrives, and the audio is deleted once it has been transcribed. When the recording stops, Thinq joins the
// pieces into one transcript and writes the same notes as for the notetaker (summary, decisions, action items).
//
// Recordings are rows in the meetings table (source = 'recording') with their pieces in meeting_segments.
// If the browser tab closes mid-meeting, whatever was already sent is still turned into notes (see finishStale).
import { query, one } from "./db.js";
import { id } from "./secrets.js";
import * as store from "./store.js";
import { transcribe, voiceAvailable, MAX_AUDIO_BYTES } from "./llm/transcribe.js";
import { summarize } from "./meetings.js";

export const recordingAvailable = () => voiceAvailable();
export const MAX_SEGMENT_BYTES = MAX_AUDIO_BYTES;
const MAX_SEGMENTS = 48; // 4 hours at 5-minute pieces
const MAX_RECORDINGS_PER_DAY = Number(process.env.RECORDINGS_PER_DAY ?? 10);

class RecordingError extends Error { userFacing = true; }

export async function startRecording(userId, { title, withTab }) {
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
    [meetingId, userId, withTab ? "Recorded (tab + mic)" : "Recorded (mic)", name]);
  await store.logAction(userId, "recording_started", { meetingId, withTab: Boolean(withTab) });
  return { id: meetingId, title: name };
}

const owned = (userId, meetingId) => one(`select * from meetings where id = $1 and user_id = $2 and source = 'recording'`, [meetingId, userId]);

export async function addSegment(userId, meetingId, { n, offsetMs, mime, audio }) {
  const m = await owned(userId, meetingId);
  if (!m) throw new RecordingError("That recording wasn't found.");
  if (!["recording", "transcribing"].includes(m.status)) throw new RecordingError("That recording has already finished.");
  if (!Number.isInteger(n) || n < 0 || n >= MAX_SEGMENTS) throw new RecordingError("That recording is too long (4 hours at most).");
  if (!audio?.length || audio.length > MAX_SEGMENT_BYTES) throw new RecordingError("That piece of audio is empty or too big.");
  await query(
    `insert into meeting_segments (meeting_id, n, offset_ms, mime, audio) values ($1, $2, $3, $4, $5)
     on conflict (meeting_id, n) do nothing`,
    [meetingId, n, Math.max(0, offsetMs | 0), String(mime || "audio/webm").slice(0, 80), audio]);
  await query(`update meetings set updated_at = now() where id = $1`, [meetingId]);
  transcribeSegment(meetingId, n).catch(() => {}); // in the background; the browser doesn't wait
  return { ok: true };
}

// ---------- turning pieces into text ----------
const working = new Set();
async function transcribeSegment(meetingId, n) {
  const key = `${meetingId}:${n}`;
  if (working.has(key)) return;
  working.add(key);
  try {
    const s = await one(`select * from meeting_segments where meeting_id = $1 and n = $2 and status = 'pending'`, [meetingId, n]);
    if (!s?.audio) return;
    try {
      const text = await transcribe(Buffer.from(s.audio), s.mime || "audio/webm");
      await query(`update meeting_segments set text = $3, status = 'done', audio = null where meeting_id = $1 and n = $2`, [meetingId, n, text]);
    } catch (err) {
      const tries = s.tries + 1;
      const giveUp = tries >= 6 || (err.status && err.status >= 400 && err.status < 500 && err.status !== 429);
      await query(`update meeting_segments set tries = $3, status = $4, audio = case when $4 = 'failed' then null else audio end where meeting_id = $1 and n = $2`,
        [meetingId, n, tries, giveUp ? "failed" : "pending"]);
      console.warn(`[recordings] piece ${n} of ${meetingId} ${giveUp ? "failed" : "will retry"}: ${err.message}`);
    }
    await maybeComplete(meetingId);
  } finally {
    working.delete(key);
  }
}

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// Once the recording has stopped and every piece is transcribed, build the transcript and write the notes.
async function maybeComplete(meetingId) {
  const m = await one(`select * from meetings where id = $1`, [meetingId]);
  if (m?.status !== "transcribing") return;
  const segs = await query(`select n, offset_ms, text, status from meeting_segments where meeting_id = $1 order by n`, [meetingId]);
  if (segs.some((s) => s.status === "pending")) return;
  const parts = segs.filter((s) => s.status === "done" && s.text?.trim());
  const failed = segs.filter((s) => s.status === "failed").length;
  const transcript = parts.map((s) => `[${clock(s.offset_ms)}] ${s.text.trim()}`).join("\n\n");
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

export async function finishRecording(userId, meetingId) {
  const m = await owned(userId, meetingId);
  if (!m) throw new RecordingError("That recording wasn't found.");
  if (m.status === "recording") {
    await query(`update meetings set status = 'transcribing', ended_at = now(), updated_at = now() where id = $1`, [meetingId]);
  }
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
  // Retry pieces that failed for a temporary reason (e.g. Groq's per-minute limit), oldest first.
  const retry = await query(`select meeting_id, n from meeting_segments where status = 'pending' and created_at < now() - interval '1 minute' order by created_at limit 5`);
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
