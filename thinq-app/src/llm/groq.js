// Groq: free-tier access to open models (default: openai/gpt-oss-120b) through Groq's
// OpenAI-compatible Chat Completions API. Used when AI_PROVIDER=groq in .env.
// This file runs the tool loop by hand: ask the model, run the tools it asks for, send results back, repeat.
import * as z from "zod/v4";

export const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const BASE_URL = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const MAX_STEPS = 12;
// No single free AI tier is big enough on its own: Groq allows ~8,000 tokens a MINUTE per model, and one Thinq
// request is 3,000-4,000. So requests go down a chain of free models and services: when one is busy (rate limit),
// too small for the request, or down, the next one answers instead, and the busy one is skipped until its wait is over.
//   1. Groq: GROQ_MODEL, then GROQ_FALLBACK_MODELS (each Groq model has its own per-minute allowance)
//   2. Cloudflare Workers AI (uses the image settings CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN; ~200 free requests a day)
//   3. Mistral (MISTRAL_API_KEY) and OpenRouter (OPENROUTER_API_KEY), if set
// AI_FALLBACKS=off uses Groq's main model only.
const GROQ_FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS ?? process.env.GROQ_FALLBACK_MODEL ?? "openai/gpt-oss-20b,qwen/qwen3.8-27b")
  .split(",").map((m) => m.trim()).filter((m) => m && m !== "off");
const CF_CHAT_MODEL = process.env.CLOUDFLARE_CHAT_MODEL || "@cf/zai-org/glm-4.7-flash";

export class GroqError extends Error {
  constructor(status, message, code, retryAfter) {
    super(message || `AI request failed (${status})`);
    this.name = "GroqError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cooldown = new Map(); // provider id -> time it can be tried again

export function providers() {
  const list = [];
  const fallbacksOn = String(process.env.AI_FALLBACKS || "on").toLowerCase() !== "off";
  if (process.env.GROQ_API_KEY) {
    for (const model of [...new Set([GROQ_MODEL, ...(fallbacksOn ? GROQ_FALLBACK_MODELS : [])])]) {
      list.push({ id: `groq:${model}`, label: `Groq ${model}`, url: `${BASE_URL}/chat/completions`, key: process.env.GROQ_API_KEY, model, kind: "groq" });
    }
  }
  if (!fallbacksOn) return list;
  const cfAcct = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim(), cfToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  if (/^[a-f0-9]{32}$/i.test(cfAcct) && /^[\w-]{20,}$/.test(cfToken) && String(process.env.CLOUDFLARE_CHAT || "on") !== "off") {
    const cfBase = (process.env.CLOUDFLARE_AI_BASE_URL || "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
    list.push({ id: "cloudflare", label: `Cloudflare ${CF_CHAT_MODEL}`, url: `${cfBase}/accounts/${cfAcct}/ai/v1/chat/completions`, key: cfToken, model: CF_CHAT_MODEL, kind: "openai" });
  }
  if (process.env.MISTRAL_API_KEY) {
    list.push({ id: "mistral", label: "Mistral", url: "https://api.mistral.ai/v1/chat/completions", key: process.env.MISTRAL_API_KEY, model: process.env.MISTRAL_MODEL || "mistral-small-latest", kind: "openai" });
  }
  if (process.env.OPENROUTER_API_KEY) {
    list.push({ id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions", key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free", kind: "openai" });
  }
  return list;
}

function toFunctions(specs) {
  return specs.map((s) => {
    const { $schema, ...parameters } = z.toJSONSchema(s.inputSchema);
    return { type: "function", function: { name: s.name, description: s.description, parameters } };
  });
}

// Groq-style request body -> what a given provider accepts.
function bodyFor(p, body) {
  const b = { ...body, model: p.model };
  if (p.kind !== "groq") {
    if (b.max_completion_tokens) { b.max_tokens = Math.min(b.max_completion_tokens, 4096); delete b.max_completion_tokens; }
    b.messages = b.messages.map(({ reasoning, ...m }) => m);
  }
  return b;
}

async function callOne(p, body) {
  let res;
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...(p.id === "openrouter" ? { "X-Title": "Thinq" } : {}) },
      body: JSON.stringify(bodyFor(p, body)),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new GroqError(0, `Couldn't reach ${p.label}: ${err.message}`, "connection_error");
  }
  const retryAfter = Number(res.headers.get("retry-after")) || null;
  if (res.ok) {
    const data = await res.json();
    if (data?.choices?.length) return data;
    throw new GroqError(502, `${p.label} sent an empty answer`, "empty");
  }
  let message, code;
  try { const raw = await res.json(); const e = raw.error || raw.errors?.[0] || {}; message = e.message || raw.message; code = e.code; } catch {}
  throw Object.assign(new GroqError(res.status, message, code, retryAfter), { daily: /per day|\(TPD\)|\(RPD\)|daily|neurons/i.test(message || "") });
}

// One chat request, trying each provider in turn. Busy providers are skipped until their wait is over.
async function chat(body, { only } = {}) {
  const list = providers().filter((p) => !only || p.id === only);
  if (!list.length) throw new GroqError(401, "No AI service is set up (GROQ_API_KEY missing).", "not_configured");
  let lastErr, toolRetried = false;
  for (let round = 0; round < 2; round++) {
    for (const p of list) {
      if ((cooldown.get(p.id) || 0) > Date.now() && !only) continue;
      try {
        const data = await callOne(p, body);
        data.provider = p.id;
        return data;
      } catch (err) {
        lastErr = err;
        // Open models sometimes write a malformed tool call; the provider rejects it. Ask the same one again once.
        if (err.status === 400 && err.code === "tool_use_failed" && !toolRetried) { toolRetried = true; try { const d = await callOne(p, body); d.provider = p.id; return d; } catch (e) { lastErr = e; } }
        const tooBig = err.status === 413 || /request too large|context length|maximum context/i.test(err.message || "");
        const busy = err.status === 429;
        const down = err.status === 0 || err.status >= 500;
        if (!(tooBig || busy || down)) throw err; // a real error (bad key, bad request): don't hide it
        if (busy) cooldown.set(p.id, Date.now() + (err.daily ? 60 * 60_000 : Math.min(120, err.retryAfter ?? 20) * 1000));
        if (down) cooldown.set(p.id, Date.now() + 30_000);
        console.warn(`[ai] ${p.label} ${busy ? "is busy" : tooBig ? "can't take a request this big" : "is unavailable"} - trying the next one`);
      }
    }
    // Everyone is busy: if the soonest one frees up within ~25 seconds, wait for it once.
    const soonest = Math.min(...list.map((p) => cooldown.get(p.id) || 0));
    const wait = soonest - Date.now();
    if (round === 0 && wait > 0 && wait <= 25_000) { await sleep(wait + 250); continue; }
    break;
  }
  throw lastErr;
}

// Admin check: send a tiny tool-calling request to each provider and report what happened.
export async function checkProviders() {
  const out = [];
  for (const p of providers()) {
    const t = Date.now();
    try {
      const d = await chat({ model: p.model, messages: [{ role: "user", content: "What's the weather in Paris? Use the tool." }], max_completion_tokens: 200, temperature: 0,
        tools: [{ type: "function", function: { name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }], tool_choice: "auto" }, { only: p.id });
      const calls = d.choices[0]?.message?.tool_calls || [];
      out.push({ provider: p.label, ok: true, toolCalling: calls.some((c) => c.function?.name === "get_weather"), ms: Date.now() - t, coolingDown: (cooldown.get(p.id) || 0) > Date.now() });
    } catch (err) {
      out.push({ provider: p.label, ok: false, error: `${err.status || ""} ${String(err.message || "").slice(0, 160)}`.trim(), ms: Date.now() - t });
    }
  }
  return out;
}

async function runOne(call, byName) {
  const spec = byName[call.function?.name];
  if (!spec) return `Error: there is no tool called "${call.function?.name}".`;
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Error: the tool arguments were not valid JSON. Try again with valid JSON.";
  }
  // Open models don't always follow the schema, so check the input before running anything.
  const parsed = spec.inputSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: invalid arguments - ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  }
  try {
    return String(await spec.run(parsed.data));
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// One plain request and answer, no tools (used for meeting summaries).
export async function groqComplete({ system, prompt, maxTokens = 4000 }) {
  const data = await chat({
    model: GROQ_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    max_completion_tokens: maxTokens,
  });
  return String(data.choices?.[0]?.message?.content || "").trim();
}

/**
 * Yields { type: "tool", name } as tools run, then { type: "final", text }.
 */
export async function* runGroqTurn({ system, history, userText, specs }) {
  const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
  const tools = toFunctions(specs);
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: userText }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await chat({
      model: GROQ_MODEL,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
      max_completion_tokens: 8192,
    });
    const choice = data.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const calls = msg.tool_calls ?? [];

    if (!calls.length) {
      let text = (msg.content ?? "").trim();
      if (choice.finish_reason === "length") text += "\n\n(My reply was cut short. Ask me to continue.)";
      yield { type: "final", text };
      return;
    }

    // Echo the assistant's tool calls back (without any reasoning text), then one result per call.
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
    for (const call of calls) {
      yield { type: "tool", name: call.function?.name };
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function?.name, content: await runOne(call, byName) });
    }
  }
  yield { type: "final", text: "That took more steps than I'm allowed in one go. Try breaking the request into smaller parts." };
}
