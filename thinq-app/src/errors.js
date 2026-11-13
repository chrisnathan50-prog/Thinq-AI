// Turns errors from the AI services and Google into plain-language messages people can act on.
import Anthropic from "@anthropic-ai/sdk";
import { GroqError } from "./llm/groq.js";
import { MODEL } from "./agent.js";

export function friendlyError(err) {
  if (err instanceof GroqError) {
    if (err.status === 401) return "The server's Groq API key was rejected. The site owner needs to check GROQ_API_KEY.";
    if (err.status === 429) return "Thinq's AI is busy (free-tier limit reached). Wait a minute and try again.";
    if (err.status === 404 || err.code === "model_not_found" || err.code === "model_decommissioned") return `The AI model "${MODEL}" isn't available any more. The site owner needs to set GROQ_MODEL.`;
    if (err.status === 413 || err.code === "context_length_exceeded") return "This conversation got too long. Start a new conversation and try again.";
    if (err.status === 400 && err.code === "tool_use_failed") return "The AI got confused while using a tool. Try rephrasing your request.";
    if (err.status === 0) return "Couldn't reach the AI service. Try again in a moment.";
    return `The AI service returned an error (${err.status}). Try again in a moment.`;
  }
  if (err instanceof Anthropic.AuthenticationError) return "The server's Anthropic API key was rejected. The site owner needs to check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The server's API key doesn't have access to the model.";
  if (err instanceof Anthropic.RateLimitError) return "Thinq is getting too many requests right now. Wait a minute and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI service. Try again in a moment.";
  if (err instanceof Anthropic.APIError) return `The AI service returned an error (${err.status}). Try again in a moment.`;
  if (/invalid_grant|Google is not connected/i.test(String(err?.message))) return "Your Google connection has expired. Click “Connect Gmail & Calendar” in the sidebar to reconnect.";
  return "Something went wrong. Try again in a moment.";
}
