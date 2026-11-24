// WhatsApp chat sync: Thinq reads a person's own WhatsApp chats so the assistant can search and summarize them,
// the way it reads Gmail and Calendar.
//
// WhatsApp has no official API for reading someone's personal chats, so this links Thinq to the person's
// account as a "linked device" (like WhatsApp Web), using the unofficial Baileys library. The person scans a
// QR code (or types a pairing code) in WhatsApp → Linked devices. Thinq reads their chats, and sends a text
// message only when the person taps Send on a draft (see sendToChat). It never reacts, marks as read or shows
// "online" from their account.
//
// Unofficial means: it isn't allowed by WhatsApp's Terms, WhatsApp can restrict or ban numbers that use it,
// and a WhatsApp update can break it. The app tells people this before they link.
//
// Stored per person: the linked-device keys (encrypted, in wa_sync_auth) and the text of their messages
// (wa_messages / wa_chats, last WA_SYNC_KEEP_DAYS days). Disconnecting logs the device out and deletes all of it.
//
// Settings: WHATSAPP_SYNC=off turns the feature off. WA_SYNC_KEEP_DAYS (default 90).
import QRCode from "qrcode";
import makeWASocket, {
  Browsers, BufferJSON, DisconnectReason, initAuthCreds, makeCacheableSignalKeyStore, proto, fetchLatestBaileysVersion, fetchLatestWaWebVersion,
  normalizeMessageContent, getContentType, jidNormalizedUser, isJidGroup, isJidBroadcast, isJidNewsletter, isLidUser,
} from "@whiskeysockets/baileys";
import { query, one } from "./db.js";
import { encrypt, decrypt } from "./secrets.js";
import * as store from "./store.js";

export const syncAvailable = () => String(process.env.WHATSAPP_SYNC || "on").toLowerCase() !== "off";
const KEEP_DAYS = Math.max(7, Number(process.env.WA_SYNC_KEEP_DAYS) || 90);
const QR_WAIT_MS = 5 * 60_000; // stop showing new QR codes after this long without a scan
const CODE_LIFE_MS = 160_000; // WhatsApp hangs up on an unused link after ~164 seconds; a phone code dies with it

// Baileys logs a lot; keep only real errors.
const logger = {
  level: "error",
  child() { return logger; },
  trace() {}, debug() {}, info() {}, warn() {},
  error(obj, msg) {
    const why = obj?.err?.message || obj?.error?.message || (obj instanceof Error ? obj.message : "");
    console.warn("[wa-sync]", typeof obj === "string" ? obj : msg || obj?.msg || "error", why ? `(${why})` : "");
  },
};

// ---------- linked-device keys, stored encrypted in the database ----------
async function dbAuthState(userId) {
  const read = async (key) => {
    const row = await one(`select value_enc from wa_sync_auth where user_id = $1 and key = $2`, [userId, key]);
    return row ? JSON.parse(JSON.stringify(decrypt(row.value_enc)), BufferJSON.reviver) : null;
  };
  const write = (key, value) => query(
    `insert into wa_sync_auth (user_id, key, value_enc) values ($1, $2, $3)
     on conflict (user_id, key) do update set value_enc = excluded.value_enc`,
    [userId, key, encrypt(JSON.parse(JSON.stringify(value, BufferJSON.replacer)))]);
  const remove = (key) => query(`delete from wa_sync_auth where user_id = $1 and key = $2`, [userId, key]);

  const creds = (await read("creds")) || initAuthCreds();
  let saving = Promise.resolve();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(`${type}-${id}`);
            if (type === "app-state-sync-key" && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const type in data) for (const id in data[type]) {
            const v = data[type][id];
            tasks.push(v ? write(`${type}-${id}`, v) : remove(`${type}-${id}`));
          }
          await Promise.all(tasks);
        },
      },
    },
    // One save at a time, in order: an older copy of the keys must never overwrite a newer one.
    saveCreds: () => (saving = saving.catch(() => {}).then(() => write("creds", creds))),
    settled: () => saving.catch(() => {}),
  };
}

// ---------- turning WhatsApp messages into plain text ----------
function messageText(m) {
  const c = normalizeMessageContent(m.message);
  if (!c) return null;
  const type = getContentType(c);
  const v = c[type];
  switch (type) {
    case "conversation": return c.conversation;
    case "extendedTextMessage": return v.text;
    case "imageMessage": return `[photo]${v.caption ? ` ${v.caption}` : ""}`;
    case "videoMessage": return `[${v.gifPlayback ? "GIF" : "video"}]${v.caption ? ` ${v.caption}` : ""}`;
    case "audioMessage": return v.ptt ? "[voice note]" : "[audio]";
    case "documentMessage": return `[document: ${v.fileName || "file"}]${v.caption ? ` ${v.caption}` : ""}`;
    case "documentWithCaptionMessage": return messageText({ message: v.message });
    case "stickerMessage": return "[sticker]";
    case "locationMessage": case "liveLocationMessage": return `[location${v.name ? `: ${v.name}` : ""}${v.address ? `, ${v.address}` : ""}]`;
    case "contactMessage": return `[contact: ${v.displayName || "contact"}]`;
    case "contactsArrayMessage": return `[contacts: ${(v.contacts || []).map((x) => x.displayName).join(", ")}]`;
    case "pollCreationMessage": case "pollCreationMessageV2": case "pollCreationMessageV3":
      return `[poll] ${v.name} (${(v.options || []).map((o) => o.optionName).join(" / ")})`;
    case "eventMessage": return `[event] ${v.name || ""}${v.startTime ? ` at ${new Date(Number(v.startTime) * 1000).toISOString()}` : ""}`;
    case "buttonsResponseMessage": return v.selectedDisplayText;
    case "listResponseMessage": return v.title;
    case "templateButtonReplyMessage": return v.selectedDisplayText;
    default: return null; // reactions, edits, deletes, protocol and system messages
  }
}

// Chats can be addressed by phone number or by WhatsApp's newer "LID" ids; prefer the phone-number form.
const chatJid = (key) => jidNormalizedUser(isLidUser(key.remoteJid) && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid);
const skipJid = (jid) => !jid || isJidBroadcast(jid) || isJidNewsletter(jid) || jid === "status@broadcast";
const tsOf = (t) => new Date(Number(t?.low ?? t ?? 0) * 1000);

// ---------- saving ----------
export async function saveMessages(userId, msgs, names) {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const rows = [];
  for (const m of msgs) {
    if (!m?.key?.id || !m.message) continue;
    const jid = chatJid(m.key);
    if (skipJid(jid)) continue;
    const at = tsOf(m.messageTimestamp);
    if (!at.getTime() || at.getTime() < cutoff) continue;
    const text = messageText(m);
    if (!text?.trim()) continue;
    const fromMe = Boolean(m.key.fromMe);
    const senderJid = fromMe ? null : jidNormalizedUser(isJidGroup(jid) ? (m.key.participantAlt || m.key.participant) : jid) || null;
    const sender = fromMe ? "You" : (m.pushName || names.get(senderJid) || (senderJid ? `+${senderJid.split("@")[0]}` : "Someone"));
    if (!fromMe && m.pushName && senderJid && !isJidGroup(senderJid)) names.set(senderJid, m.pushName);
    rows.push({ jid, id: m.key.id, fromMe, sender: sender.slice(0, 120), senderJid, text: text.slice(0, 4000), at: at.toISOString() });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const b = rows.slice(i, i + 500);
    await query(
      `insert into wa_messages (user_id, jid, msg_id, from_me, sender, sender_jid, text, at)
       select $1, * from unnest($2::text[], $3::text[], $4::boolean[], $5::text[], $6::text[], $7::text[], $8::timestamptz[])
       on conflict (user_id, jid, msg_id) do update set text = excluded.text`,
      [userId, b.map((r) => r.jid), b.map((r) => r.id), b.map((r) => r.fromMe), b.map((r) => r.sender), b.map((r) => r.senderJid), b.map((r) => r.text), b.map((r) => r.at)]);
  }
  // Keep each chat's "last message" time current, and give 1:1 chats a name when we learn one.
  const latest = new Map();
  for (const r of rows) if (!latest.has(r.jid) || latest.get(r.jid).at < r.at) latest.set(r.jid, r);
  for (const [jid, r] of latest) {
    const name = isJidGroup(jid) ? null : names.get(jid) || null;
    await query(
      `insert into wa_chats (user_id, jid, name, is_group, last_at) values ($1, $2, $3, $4, $5)
       on conflict (user_id, jid) do update set last_at = greatest(wa_chats.last_at, excluded.last_at), name = coalesce(wa_chats.name, excluded.name)`,
      [userId, jid, name, Boolean(isJidGroup(jid)), r.at]);
  }
  return rows.length;
}

export async function saveChatNames(userId, list) {
  for (const { jid, name } of list) {
    if (skipJid(jid) || !name) continue;
    await query(
      `insert into wa_chats (user_id, jid, name, is_group) values ($1, $2, $3, $4)
       on conflict (user_id, jid) do update set name = excluded.name`,
      [userId, jid, String(name).slice(0, 200), Boolean(isJidGroup(jid))]);
  }
}

// ---------- one live connection per person ----------
const sentCache = new Map(); // message id -> content of messages Thinq sent (for WhatsApp's resend requests)
const live = new Map(); // userId -> { sock, status, qr, pairingCode, phone, stopped, retries, names, startedAt }

async function setSession(userId, fields) {
  const cols = Object.keys(fields);
  await query(
    `insert into wa_sync_sessions (user_id, ${cols.join(", ")}, updated_at) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}, now())
     on conflict (user_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = now()`,
    [userId, ...cols.map((c) => fields[c])]);
}

// Linked = the phone accepted this device. (Baileys' creds.registered is only ever set by phone codes, never by QR.)
const isLinked = (creds) => Boolean(creds?.me?.id && (creds.account || creds.signalIdentities?.length || creds.platform));

let waVersion;
const linkVersion = { v: undefined, at: 0 };
// WhatsApp can refuse NEW devices that announce an old WhatsApp Web version, so linking asks for today's.
async function versionFor(linked) {
  waVersion ??= await fetchLatestBaileysVersion().then((r) => r.version).catch(() => undefined);
  if (linked) return waVersion;
  if (Date.now() - linkVersion.at > 6 * 3600e3) {
    linkVersion.v = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(8000) }).then((r) => (r.error ? undefined : r.version)).catch(() => undefined);
    linkVersion.at = Date.now();
  }
  return linkVersion.v || waVersion;
}

async function connect(userId, { pairPhone, link = false } = {}) {
  const prev = live.get(userId);
  const entry = prev && !prev.stopped ? prev : { status: "starting", retries: 0, linkErrors: 0, names: new Map(), startedAt: Date.now() };
  if (pairPhone) entry.pairPhone = pairPhone;
  if (link) entry.linking = true;
  live.set(userId, entry);

  // Keep the same keys in memory across reconnects: re-reading them from the database right after a scan could
  // miss the ones WhatsApp just gave us, and the scan would be forgotten.
  entry.auth ??= await dbAuthState(userId);
  await entry.auth.settled();
  const { state, saveCreds } = entry.auth;
  const linked = isLinked(state.creds);
  if (!linked && !entry.linking) { // nothing to reconnect with: say so instead of quietly making QR codes
    stop(userId, "logged_out");
    await setSession(userId, { status: "logged_out" });
    return;
  }
  const version = await versionFor(linked);
  if (live.get(userId) !== entry || entry.stopped) return; // cancelled meanwhile
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.macOS("Chrome"), // phone codes are refused ("Couldn't link device") unless this is a real browser
    markOnlineOnConnect: false, // so the person still gets notifications on their phone
    syncFullHistory: false, // recent history only; new messages arrive live
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    // WhatsApp asks for a sent message again if a recipient's phone couldn't decrypt it.
    getMessage: async (key) => sentCache.get(key.id),
  });
  entry.sock = sock;

  sock.ev.on("creds.update", () => saveCreds().catch((e) => console.warn("[wa-sync] saving keys failed:", e.message)));

  sock.ev.on("connection.update", async (u) => {
    if (live.get(userId) !== entry || entry.sock !== sock) return;
    if (u.isNewLogin) { entry.finishing = true; entry.qr = null; entry.pairingCode = null; entry.status = "starting"; } // accepted on the phone
    if (u.qr && !entry.finishing) {
      if (Date.now() - entry.startedAt > QR_WAIT_MS) { stop(userId, "expired"); return; }
      if (entry.pairPhone) {
        if (!entry.codeAsked) {
          entry.codeAsked = true;
          const code = await sock.requestPairingCode(entry.pairPhone).catch((e) => { console.warn("[wa-sync] pairing code failed:", e.message); return null; });
          if (entry.stopped || live.get(userId) !== entry) return;
          if (!code) { fail(userId, "WhatsApp didn't give a code for that number. Check the number and try again, or use the QR code."); return; }
          entry.pairingCode = code; entry.codeUntil = Date.now() + CODE_LIFE_MS;
        }
      } else {
        // Large, with the full white border scanners need (the app shows it smaller).
        entry.qr = await QRCode.toDataURL(u.qr, { margin: 4, scale: 10, errorCorrectionLevel: "L" }).catch(() => null);
      }
      entry.status = "waiting";
    }
    if (u.connection === "open") {
      entry.status = "connected"; entry.qr = null; entry.pairingCode = null; entry.pairPhone = null; entry.retries = 0; entry.linking = false; entry.finishing = false; failures.delete(userId);
      const phone = jidNormalizedUser(sock.user?.id || "").split("@")[0] || null;
      entry.phone = phone;
      await setSession(userId, { status: "connected", phone, name: sock.user?.name || null, linked_at: new Date().toISOString() });
      store.logAction(userId, "whatsapp_sync_connected", {});
      // Group names.
      sock.groupFetchAllParticipating()
        .then((groups) => saveChatNames(userId, Object.values(groups).map((g) => ({ jid: g.id, name: g.subject }))))
        .catch(() => {});
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (entry.stopped) return;
      if (!isLinked(state.creds)) { // still waiting for the phone
        console.warn(`[wa-sync] link attempt closed (code ${code ?? "?"}, ${entry.pairPhone ? "phone code" : "QR"}, after ${Math.round((Date.now() - entry.startedAt) / 1000)}s)`);
        if (entry.pairPhone && entry.codeAsked) {
          // A phone code can't survive its connection. Say what happened instead of logging in with half-made keys.
          fail(userId, code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden
            ? "WhatsApp didn't accept the code. Check that the number is the one WhatsApp uses on your phone, then get a new code or use the QR code."
            : "That code expired before it was used. Get a new one and enter it within 2 minutes.");
          await query(`delete from wa_sync_auth where user_id = $1`, [userId]);
          return;
        }
        if (code === 405) { linkVersion.v = undefined; } // WhatsApp refused that version: use the library's own
        if (Date.now() - entry.startedAt > QR_WAIT_MS) { stop(userId, "expired"); return; }
        if (code !== DisconnectReason.timedOut && ++entry.linkErrors > 6) { fail(userId, "Couldn't reach WhatsApp to make a code. Wait a minute and try again."); return; }
        entry.auth = null; entry.qr = null; entry.status = "starting";
        await query(`delete from wa_sync_auth where user_id = $1`, [userId]);
        entry.timer = setTimeout(() => { entry.timer = null; if (live.get(userId) === entry && !entry.stopped) connect(userId).catch((e) => console.warn("[wa-sync] link retry failed:", e.message)); }, code === DisconnectReason.timedOut ? 200 : 2000);
        return;
      }
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        // Unlinked from the phone (or blocked): forget the keys, keep nothing half-working.
        await entry.auth?.settled();
        await wipe(userId, { keepMessages: true });
        await setSession(userId, { status: code === DisconnectReason.forbidden ? "blocked" : "logged_out" });
        if (entry.finishing) failures.set(userId, "WhatsApp unlinked Thinq straight after linking. Try again.");
        entry.stopped = true; entry.status = "logged_out"; live.delete(userId);
        return;
      }
      // Restart required right after pairing, or a dropped connection: reconnect quickly (1s, 2s, 4s, 8s, then every 15s).
      // 440 = another copy of Thinq took over this WhatsApp link (happens for a few seconds during a deploy): give it
      // room instead of fighting it - the copy that's shutting down stops for good (see stopAllSyncs).
      const delay = code === DisconnectReason.restartRequired ? 0
        : code === DisconnectReason.connectionReplaced ? 20_000
        : Math.min(15_000, 1000 * 2 ** entry.retries++);
      console.warn(`[wa-sync] connection closed (code ${code ?? "?"}); reconnecting in ${Math.round(delay / 1000)}s`);
      entry.status = entry.finishing ? "starting" : "reconnecting";
      clearTimeout(entry.timer);
      entry.nextAt = Date.now() + delay;
      entry.timer = setTimeout(() => { entry.timer = null; if (live.get(userId) === entry && !entry.stopped) connect(userId).catch((e) => console.warn("[wa-sync] reconnect failed:", e.message)); }, delay);
    }
  });

  sock.ev.on("contacts.upsert", (cs) => { for (const c of cs) { const n = c.name || c.notify || c.verifiedName; if (n) entry.names.set(jidNormalizedUser(c.phoneNumber || c.id), n); } });
  sock.ev.on("contacts.update", (cs) => { for (const c of cs) { const n = c.name || c.notify; if (n && c.id) entry.names.set(jidNormalizedUser(c.phoneNumber || c.id), n); } });
  sock.ev.on("chats.upsert", (chats) => saveChatNames(userId, chats.map((c) => ({ jid: jidNormalizedUser(c.id), name: c.name }))).catch(() => {}));
  sock.ev.on("groups.update", (gs) => saveChatNames(userId, gs.filter((g) => g.subject).map((g) => ({ jid: g.id, name: g.subject }))).catch(() => {}));

  sock.ev.on("messaging-history.set", async ({ chats, contacts, messages }) => {
    try {
      for (const c of contacts || []) { const n = c.name || c.notify || c.verifiedName; if (n) entry.names.set(jidNormalizedUser(c.phoneNumber || c.id), n); }
      await saveChatNames(userId, (chats || []).map((c) => ({ jid: jidNormalizedUser(c.id), name: c.name })));
      await saveMessages(userId, messages || [], entry.names);
      await nameUnnamedChats(userId, entry.names);
    } catch (e) { console.warn("[wa-sync] history save failed:", e.message); }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try { await saveMessages(userId, messages, entry.names); } catch (e) { console.warn("[wa-sync] message save failed:", e.message); }
  });
}

async function nameUnnamedChats(userId, names) {
  const rows = await query(`select jid from wa_chats where user_id = $1 and name is null and not is_group`, [userId]);
  await saveChatNames(userId, rows.map((r) => ({ jid: r.jid, name: names.get(r.jid) })).filter((r) => r.name));
}

const failures = new Map(); // userId -> why the last link attempt failed, in plain words
function fail(userId, why) { failures.set(userId, why); stop(userId, "failed"); }

function stop(userId, status) {
  const entry = live.get(userId);
  if (!entry) return;
  entry.stopped = true; entry.status = status || "idle"; clearTimeout(entry.timer);
  if (status === "expired") failures.set(userId, "The QR code wasn't scanned in time.");
  try { entry.sock?.end(undefined); } catch { /* already closed */ }
  live.delete(userId);
}

async function wipe(userId, { keepMessages = false } = {}) {
  await query(`delete from wa_sync_auth where user_id = $1`, [userId]);
  if (!keepMessages) {
    await query(`delete from wa_messages where user_id = $1`, [userId]);
    await query(`delete from wa_chats where user_id = $1`, [userId]);
    await query(`delete from wa_sync_sessions where user_id = $1`, [userId]);
  }
}

// ---------- what the server calls ----------
// "+44 (0)7700 900123", "0044 7700...", "+234 0803..." -> digits WhatsApp understands: country code, no extra zeros.
const TRUNK_ZERO = ["20", "27", "30", "31", "32", "33", "40", "41", "43", "44", "46", "49", "60", "61", "62", "63", "64", "66", "81", "82", "84", "90", "91", "92", "94", "212", "213", "233", "234", "250", "251", "254", "255", "256", "260", "263", "351", "353", "358", "380", "880", "966", "971", "972"];
export function cleanPhone(raw) {
  let d = String(raw || "").replace(/\(0\)/g, "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  const cc = TRUNK_ZERO.find((c) => d.startsWith(`${c}0`));
  return cc ? cc + d.slice(cc.length + 1) : d;
}

export async function startSync(userId, { phone } = {}) {
  if (!syncAvailable()) throw new Error("WhatsApp chat sync is turned off on this server.");
  const p = cleanPhone(phone);
  if (phone && p.startsWith("0")) throw new Error("Start with your country code instead of 0, like +44 7700 900123 or +234 803 123 4567.");
  if (phone && (p.length < 9 || p.length > 15)) throw new Error("Enter your full WhatsApp number with the country code, like +44 7700 900123.");
  const cur = live.get(userId);
  if (cur?.status === "connected") return syncState(userId);
  if (cur) stop(userId);
  // A fresh link always starts from fresh keys.
  await query(`delete from wa_sync_auth where user_id = $1`, [userId]);
  await query(`update wa_sync_sessions set status = 'off' where user_id = $1`, [userId]);
  failures.delete(userId);
  await connect(userId, { pairPhone: p || null, link: true });
  if (p && live.get(userId)) live.get(userId).phoneShown = `+${p}`;
  return syncState(userId);
}

export async function cancelSync(userId) {
  const cur = live.get(userId);
  failures.delete(userId);
  if (cur && cur.status !== "connected" && !isLinked(cur.auth?.state.creds)) { stop(userId); await query(`delete from wa_sync_auth where user_id = $1`, [userId]); }
}

export async function disconnectSync(userId) {
  const cur = live.get(userId);
  if (cur?.sock && cur.status === "connected") { cur.stopped = true; await cur.sock.logout().catch(() => {}); }
  stop(userId);
  await wipe(userId);
}

// Someone is looking at Thinq while their WhatsApp is reconnecting: try right away instead of waiting out the delay.
// Also covers a link that never came back after a restart (nothing was scheduled to retry it).
const nudged = new Map(); // userId -> last nudge time
function nudge(userId, entry) {
  if (shuttingDown || Date.now() - (nudged.get(userId) || 0) < 10_000) return;
  if (entry && (entry.status !== "reconnecting" || !entry.timer || entry.nextAt - Date.now() < 3000)) return;
  nudged.set(userId, Date.now());
  if (entry) { clearTimeout(entry.timer); entry.timer = null; }
  connect(userId).catch((e) => console.warn("[wa-sync] reconnect failed:", e.message));
}

// Server is shutting down (deploy/restart): close every WhatsApp link without logging out, and don't reconnect,
// so the new copy of the server can take over cleanly.
let shuttingDown = false;
export function stopAllSyncs() {
  shuttingDown = true;
  for (const entry of live.values()) {
    entry.stopped = true;
    clearTimeout(entry.timer);
    try { entry.sock?.end(undefined); } catch { /* already closed */ }
  }
}

export async function syncState(userId) {
  if (!syncAvailable()) return { available: false };
  const entry = live.get(userId);
  const session = await one(`select * from wa_sync_sessions where user_id = $1`, [userId]);
  if (session?.status === "connected" && (!entry || entry.status === "reconnecting")) nudge(userId, entry);
  const counts = await one(`select count(*)::int as messages, count(distinct jid)::int as chats, max(at) as last from wa_messages where user_id = $1`, [userId]);
  const status = entry?.status || (session?.status === "connected" ? "reconnecting" : session?.status) || "off";
  const masked = (p) => p && `+${p.slice(0, -4).replace(/\d/g, "•")}${p.slice(-4)}`;
  return {
    available: true,
    status, // off | starting | waiting | connected | reconnecting | logged_out | blocked | expired
    qr: status === "waiting" ? entry?.qr || null : null,
    pairingCode: status === "waiting" ? entry?.pairingCode || null : null,
    pairingFor: status === "waiting" ? entry?.phoneShown || null : null,
    codeSeconds: status === "waiting" && entry?.codeUntil ? Math.max(0, Math.round((entry.codeUntil - Date.now()) / 1000)) : null,
    finishing: Boolean(entry?.finishing),
    problem: entry ? null : failures.get(userId) || null,
    phone: masked(entry?.phone || session?.phone),
    since: session?.linked_at || null,
    chats: counts.chats, messages: counts.messages, lastMessageAt: counts.last,
    keepDays: KEEP_DAYS,
  };
}

export const hasSyncedChats = async (userId) =>
  Boolean(await one(`select 1 from wa_messages where user_id = $1 limit 1`, [userId]));

// Reconnect everyone who was linked when the server last ran, and trim old messages once a day.
export async function resumeAllSyncs() {
  if (!syncAvailable()) return;
  const rows = await query(`select user_id from wa_sync_sessions where status = 'connected'`);
  for (const { user_id } of rows) connect(user_id).catch((e) => console.warn("[wa-sync] resume failed:", e.message));
  const trim = () => query(`delete from wa_messages where at < now() - ($1 || ' days')::interval`, [String(KEEP_DAYS)]).catch(() => {});
  trim(); setInterval(trim, 864e5).unref();
  return rows.length;
}

// ---------- reading, for the assistant's tools ----------
const chatOut = (r) => ({ chat: r.name || (r.is_group ? "(unnamed group)" : `+${r.jid.split("@")[0]}`), group: r.is_group, chat_id: r.jid });

export async function recentChats(userId, { limit = 15, sinceDays } = {}) {
  const rows = await query(
    `select c.jid, c.name, c.is_group, c.last_at,
       (select count(*)::int from wa_messages m where m.user_id = c.user_id and m.jid = c.jid and m.at > now() - interval '1 day') as today,
       (select json_build_object('sender', m.sender, 'text', left(m.text, 160), 'at', m.at) from wa_messages m
          where m.user_id = c.user_id and m.jid = c.jid order by m.at desc limit 1) as last
     from wa_chats c
     where c.user_id = $1 and c.last_at is not null ${sinceDays ? `and c.last_at > now() - ($3 || ' days')::interval` : ""}
     order by c.last_at desc limit $2`,
    sinceDays ? [userId, limit, String(sinceDays)] : [userId, limit]);
  return rows.map((r) => ({ ...chatOut(r), last_message_at: r.last_at, messages_last_24h: r.today, last_message: r.last }));
}

async function findChats(userId, chat) {
  const exact = await query(`select * from wa_chats where user_id = $1 and jid = $2`, [userId, chat]);
  if (exact.length) return exact;
  const digits = cleanPhone(chat);
  return query(
    `select * from wa_chats where user_id = $1 and (name ilike $2 ${digits.length >= 5 ? "or jid like $3" : ""})
     order by last_at desc nulls last limit 5`,
    digits.length >= 5 ? [userId, `%${chat}%`, `%${digits}%`] : [userId, `%${chat}%`]);
}

export async function searchMessages(userId, { text, chat, sinceDays, limit = 30 }) {
  const params = [userId], where = ["m.user_id = $1"];
  if (text) {
    for (const word of String(text).split(/\s+/).filter(Boolean).slice(0, 6)) { params.push(`%${word}%`); where.push(`m.text ilike $${params.length}`); }
  }
  if (chat) {
    const chats = await findChats(userId, chat);
    if (!chats.length) return { error: `No WhatsApp chat matches "${chat}".` };
    params.push(chats.map((c) => c.jid)); where.push(`m.jid = any($${params.length}::text[])`);
  }
  if (sinceDays) { params.push(String(sinceDays)); where.push(`m.at > now() - ($${params.length} || ' days')::interval`); }
  params.push(Math.min(limit, 50));
  const rows = await query(
    `select m.jid, m.sender, m.from_me, m.text, m.at, c.name, c.is_group from wa_messages m
     left join wa_chats c on c.user_id = m.user_id and c.jid = m.jid
     where ${where.join(" and ")} order by m.at desc limit $${params.length}`, params);
  return { messages: rows.map((r) => ({ ...chatOut(r), sender: r.sender, at: r.at, text: r.text })) };
}

// One chat from a name, part of a name, phone number or chat id - or an error to show the assistant.
export async function resolveChat(userId, chat) {
  const chats = await findChats(userId, chat);
  if (!chats.length) return { error: `No WhatsApp chat matches "${chat}". Use whatsapp_recent_chats to see chat names.` };
  const exact = chats.find((x) => (x.name || "").toLowerCase() === String(chat).toLowerCase() || x.jid === chat);
  if (chats.length > 1 && !exact) {
    return { error: `Several chats match "${chat}": ${chats.map((c) => chatOut(c).chat).join("; ")}. Ask the user which one, or use its exact name.` };
  }
  const c = exact || chats[0];
  return { jid: c.jid, ...chatOut(c) };
}

export async function readChat(userId, { chat, sinceDays, limit = 80 }) {
  const r = await resolveChat(userId, chat);
  if (r.error) return r;
  const c = { jid: r.jid, name: r.chat, is_group: r.group };
  const params = [userId, c.jid, Math.min(limit, 200)];
  if (sinceDays) params.push(String(sinceDays));
  const rows = await query(
    `select * from (select sender, text, at from wa_messages where user_id = $1 and jid = $2
       ${sinceDays ? "and at > now() - ($4 || ' days')::interval" : ""} order by at desc limit $3) t order by at`, params);
  return { chat: chatOut(c), messages: rows };
}

// ---------- sending (only after the person taps Send on a draft, or a routine they turned on) ----------
class SyncError extends Error { userFacing = true; }

export async function sendToChat(userId, jid, text) {
  const entry = live.get(userId);
  if (!entry?.sock || entry.status !== "connected") {
    throw new SyncError("Your WhatsApp isn't connected to Thinq right now. Check the WhatsApp chats card in the sidebar, then try again.");
  }
  const known = await one(`select 1 from wa_chats where user_id = $1 and jid = $2`, [userId, jid]);
  if (!known) throw new SyncError("That WhatsApp chat isn't in your synced chats any more.");
  const sent = await entry.sock.sendMessage(jid, { text: String(text).slice(0, 4000) });
  if (sent?.key?.id) {
    sentCache.set(sent.key.id, sent.message);
    if (sentCache.size > 200) sentCache.delete(sentCache.keys().next().value);
    await saveMessages(userId, [sent], entry.names).catch(() => {});
  }
  return { id: sent?.key?.id || null, note: "Sent on WhatsApp." };
}
