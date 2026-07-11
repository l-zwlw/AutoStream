import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const authFile = path.join(process.cwd(), "data/auth.json");
const sessions = new Map<string, number>();
const attempts = new Map<string, { count: number; blockedUntil: number }>();
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

type StoredAuth = {
  salt: string;
  hash: string;
};

function readStoredAuth(): StoredAuth | undefined {
  if (!fs.existsSync(authFile)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (typeof value.salt === "string" && typeof value.hash === "string") {
      return value;
    }
  } catch (error) {
    console.error("Could not read dashboard authentication settings:", error);
  }
  return undefined;
}

function derive(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function isPasswordConfigured() {
  return Boolean(process.env.AUTOSTREAM_ADMIN_PASSWORD || readStoredAuth());
}

export function setPassword(password: string) {
  if (password.length < 10) {
    throw new Error("Use at least 10 characters");
  }
  const salt = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(
    authFile,
    JSON.stringify({ salt, hash: derive(password, salt) }, null, 2),
    { mode: 0o600 }
  );
  sessions.clear();
}

export function verifyPassword(password: string) {
  const environmentPassword = process.env.AUTOSTREAM_ADMIN_PASSWORD;
  if (environmentPassword) {
    const supplied = Buffer.from(password);
    const expected = Buffer.from(environmentPassword);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  const stored = readStoredAuth();
  if (!stored) return false;
  const supplied = Buffer.from(derive(password, stored.salt), "hex");
  const expected = Buffer.from(stored.hash, "hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function createSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + sessionLifetimeMs);
  return token;
}

export function destroySession(token?: string) {
  if (token) sessions.delete(token);
}

export function isValidSession(token?: string) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function parseSessionCookie(cookieHeader?: string) {
  const match = cookieHeader?.match(/(?:^|;\s*)autostream_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

export function registerFailedAttempt(client: string) {
  const current = attempts.get(client) || { count: 0, blockedUntil: 0 };
  current.count += 1;
  if (current.count >= 5) {
    current.blockedUntil = Date.now() + Math.min(60_000, current.count * 5_000);
  }
  attempts.set(client, current);
}

export function clearFailedAttempts(client: string) {
  attempts.delete(client);
}

export function retryAfterSeconds(client: string) {
  const blockedUntil = attempts.get(client)?.blockedUntil || 0;
  return Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
}

export const sessionCookieMaxAgeSeconds = sessionLifetimeMs / 1000;
