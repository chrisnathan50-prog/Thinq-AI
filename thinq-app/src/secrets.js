// Encrypts stored Google tokens (AES-256-GCM) and makes random IDs and session tokens.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// TOKEN_ENCRYPTION_KEY: any long random string. In production it must be set (Render generates one).
// Locally, if it's missing, we create one in data/.local-key so tokens still get encrypted.
function loadKey() {
  let secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("TOKEN_ENCRYPTION_KEY must be set in production.");
    const file = path.resolve(here, "..", "data", ".local-key");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
    secret = fs.readFileSync(file, "utf8").trim();
  }
  return crypto.createHash("sha256").update(secret).digest(); // 32-byte key from any string
}
const KEY = loadKey();

export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob) {
  const [iv, tag, data] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}

export const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
