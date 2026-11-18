// Database: Postgres in production (set DATABASE_URL, e.g. a free Neon database),
// and PGlite - a full Postgres that runs inside Node - for local development (stored in ./data/pglite).
// Both speak the same SQL, so the rest of the app doesn't care which one it's using.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let db;

export async function initDb() {
  if (db) return db;
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    db = { kind: "postgres", query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql) };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = process.env.PGLITE_DIR || path.resolve(here, "..", "data", "pglite");
    const lite = new PGlite(dir);
    await lite.waitReady;
    db = { kind: "pglite", query: (sql, params) => lite.query(sql, params), exec: (sql) => lite.exec(sql) };
  }
  await migrate();
  return db;
}

export async function query(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows;
}
export const one = async (sql, params) => (await query(sql, params))[0] ?? null;
export const dbKind = () => db?.kind;

async function migrate() {
  await db.exec(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      name text,
      picture text,
      google_sub text unique,
      created_at timestamptz not null default now(),
      last_login_at timestamptz
    );
    create table if not exists sessions (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
    create table if not exists google_connections (
      user_id text primary key references users(id) on delete cascade,
      email text,
      tokens_enc text not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists conversations (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      title text not null default 'New conversation',
      created_at timestamptz not null default now()
    );
    create table if not exists messages (
      id bigserial primary key,
      conversation_id text not null references conversations(id) on delete cascade,
      role text not null,
      text text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists approvals (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      conversation_id text,
      kind text not null,
      payload jsonb not null,
      summary text,
      status text not null default 'pending',
      result jsonb,
      error text,
      mode text,
      created_at timestamptz not null default now(),
      updated_at timestamptz
    );
    create table if not exists notes (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      text text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists action_log (
      id bigserial primary key,
      user_id text references users(id) on delete cascade,
      kind text not null,
      detail jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists usage_daily (
      user_id text not null references users(id) on delete cascade,
      day date not null,
      requests integer not null default 0,
      primary key (user_id, day)
    );
    create table if not exists documents (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      conversation_id text references conversations(id) on delete set null,
      name text not null,
      size_bytes integer,
      pages integer,
      chars integer not null,
      text text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists images (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      conversation_id text references conversations(id) on delete set null,
      prompt text not null,
      mime text not null,
      data bytea not null,
      created_at timestamptz not null default now()
    );
    create index if not exists images_user on images(user_id, created_at desc);
    create table if not exists whatsapp_links (
      wa_id text primary key,
      user_id text not null unique references users(id) on delete cascade,
      name text,
      conversation_id text references conversations(id) on delete set null,
      time_zone text,
      linked_at timestamptz not null default now()
    );
    create table if not exists whatsapp_codes (
      code_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      time_zone text,
      expires_at timestamptz not null
    );
    create table if not exists whatsapp_seen (
      message_id text primary key,
      at timestamptz not null default now()
    );
    create table if not exists testers (
      id text primary key,
      email text not null unique,
      name text,
      use_case text,
      status text not null default 'pending',
      created_at timestamptz not null default now(),
      decided_at timestamptz,
      decided_by text
    );
    create table if not exists wa_sync_sessions (
      user_id text primary key references users(id) on delete cascade,
      status text not null default 'off',
      phone text,
      name text,
      linked_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table if not exists wa_sync_auth (
      user_id text not null references users(id) on delete cascade,
      key text not null,
      value_enc text not null,
      primary key (user_id, key)
    );
    create table if not exists wa_chats (
      user_id text not null references users(id) on delete cascade,
      jid text not null,
      name text,
      is_group boolean not null default false,
      last_at timestamptz,
      primary key (user_id, jid)
    );
    create table if not exists wa_messages (
      user_id text not null references users(id) on delete cascade,
      jid text not null,
      msg_id text not null,
      from_me boolean not null default false,
      sender text,
      sender_jid text,
      text text not null,
      at timestamptz not null,
      primary key (user_id, jid, msg_id)
    );
    create index if not exists wa_messages_user_at on wa_messages(user_id, at desc);
    create index if not exists wa_messages_chat_at on wa_messages(user_id, jid, at desc);
    create index if not exists wa_chats_user_last on wa_chats(user_id, last_at desc);
    create table if not exists meetings (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      bot_id text unique,
      meeting_url text not null,
      platform text,
      title text,
      calendar_event_id text,
      join_at timestamptz,
      status text not null,
      bot_state text,
      error text,
      transcript text,
      summary text,
      started_at timestamptz,
      ended_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (user_id, calendar_event_id)
    );
    alter table meetings alter column meeting_url drop not null;
    alter table meetings add column if not exists source text not null default 'bot';
    create table if not exists meeting_segments (
      meeting_id text not null references meetings(id) on delete cascade,
      n integer not null,
      offset_ms integer not null default 0,
      mime text,
      audio bytea,
      text text,
      status text not null default 'pending',
      tries integer not null default 0,
      created_at timestamptz not null default now(),
      primary key (meeting_id, n)
    );
    create index if not exists meetings_user on meetings(user_id, join_at desc);
    create index if not exists meetings_status on meetings(status);
    create table if not exists meeting_prefs (
      user_id text primary key references users(id) on delete cascade,
      auto_join boolean not null default false,
      updated_at timestamptz not null default now()
    );
    create table if not exists app_secrets (
      name text primary key,
      value text not null
    );
    create table if not exists push_subscriptions (
      endpoint text primary key,
      user_id text not null references users(id) on delete cascade,
      keys jsonb not null,
      device text,
      failures int not null default 0,
      last_ok_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists push_subscriptions_user on push_subscriptions(user_id);
    create table if not exists notify_prefs (
      user_id text primary key references users(id) on delete cascade,
      calendar boolean not null default true,
      calendar_minutes int not null default 10,
      meetings boolean not null default true,
      whatsapp boolean not null default false,
      updated_at timestamptz not null default now()
    );
    create table if not exists reminders (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      kind text not null,
      text text not null,
      due_at timestamptz,
      watch_from text,
      watch_subject text,
      watch_since timestamptz,
      expires_at timestamptz,
      checked_at timestamptz,
      status text not null default 'active',
      result text,
      conversation_id text,
      created_at timestamptz not null default now(),
      fired_at timestamptz
    );
    create index if not exists reminders_user on reminders(user_id, status);
    create index if not exists reminders_due on reminders(status, kind, due_at);
    create table if not exists notify_sent (
      user_id text not null references users(id) on delete cascade,
      key text not null,
      sent_at timestamptz not null default now(),
      primary key (user_id, key)
    );
    create table if not exists group_bots (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      name text not null,
      purpose text,
      knowledge text,
      time_zone text not null default 'UTC',
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists bot_reminders (
      id text primary key,
      bot_id text not null references group_bots(id) on delete cascade,
      message text not null,
      repeat text not null,
      time_of_day text not null,
      on_date text,
      weekdays text,
      day_of_month integer,
      next_run_at timestamptz,
      last_run_at timestamptz,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create index if not exists bot_reminders_due on bot_reminders(next_run_at) where active;
    create table if not exists bot_groups (
      chat_id text primary key,
      bot_id text not null references group_bots(id) on delete cascade,
      platform text not null default 'telegram',
      title text,
      paused boolean not null default false,
      linked_at timestamptz not null default now()
    );
    create table if not exists bot_link_codes (
      code_hash text primary key,
      bot_id text not null references group_bots(id) on delete cascade,
      expires_at timestamptz not null
    );
    alter table messages add column if not exists attachments jsonb;
    alter table conversations add column if not exists unread boolean not null default false;
    alter table users add column if not exists tour_done_at timestamptz;
    create index if not exists documents_conv on documents(conversation_id);
    create index if not exists conversations_user on conversations(user_id, created_at desc);
    create index if not exists messages_conv on messages(conversation_id, id);
    create index if not exists approvals_user on approvals(user_id, created_at desc);
  `);
}
