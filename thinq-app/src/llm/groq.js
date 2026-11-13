// Groq: free-tier access to open models (default: openai/gpt-oss-120b) through Groq's
// OpenAI-compatible Chat Completions API. Used when AI_PROVIDER=groq in .env.
// This file runs the tool loop by hand: ask the model, run the tools it asks for, send results back, repeat.
import * as z from "zod/v4";

export const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const BASE_URL = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const MAX_STEPS = 12;

export class GroqError extends Error {
  constructor(status, message, code, retryAfter) {
    super(message || `Groq request failed (${status})`);
    this.name = "GroqError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toFunctions(specs) {
  return specs.map((s) => {
    const { $schema, ...parameters } = z.toJSONSchema(s.inputSchema);
    return { type: "function", function: { name: s.name, description: s.description, parameters } };
  });
}

async function chat(body, tries = { wait: 0, toolRetry: 0 }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new GroqError(0, `Couldn't reach Groq: ${err.message}`, "connection_error");
  }
  const retryAfter = Number(res.headers.get("retry-after")) || null;
  if (res.ok) return res.json();

  let message, code;
  try { const e = (await res.json()).error || {}; message = e.message; code = e.code; } catch {}
  // Short waits on the free tier: wait and try again (at most twice).
  if ((res.status === 429 || res.status >= 500) && tries.wait < 2 && (retryAfter ?? 2) <= 15) {
    await sleep((retryAfter ?? 2) * 1000);
    return chat(body, { ...tries, wait: tries.wait + 1 });
  }
  // Open models sometimes write a malformed tool call; Groq rejects it with tool_use_failed. Ask again once.
  if (res.status === 400 && code === "tool_use_failed" && tries.toolRetry < 1) return chat(body, { ...tries, toolRetry: tries.toolRetry + 1 });
  throw new GroqError(res.status, message, code, retryAfter);
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
