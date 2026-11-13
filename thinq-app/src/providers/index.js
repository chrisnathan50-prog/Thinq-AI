// Picks each user's real Google connection when they've connected one, otherwise their own demo inbox and calendar.
import * as store from "../store.js";
import { createDemo } from "./demo.js";
import { createGoogleProvider } from "./google.js";

const demos = new Map(); // per-user sample data, kept in memory (resets when the server restarts)

export async function providerFor(user) {
  if (await store.getGoogle(user.id)) return createGoogleProvider(user.id, user);
  if (!demos.has(user.id)) demos.set(user.id, createDemo(user));
  return demos.get(user.id);
}
