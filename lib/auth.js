import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "./prisma";

export const SESSION_COOKIE = "finanze_session";
const SESSION_DAYS = 30;

// ---------- Password (scrypt) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- Sessioni ----------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt: BigInt(expires) } });
  // pulizia delle sessioni scadute (in background, senza bloccare il login)
  prisma.session.deleteMany({ where: { expiresAt: { lt: BigInt(Date.now()) } } }).catch(() => {});
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SECURE_COOKIES === "1",
    path: "/",
    expires: new Date(expires),
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

// hash della sessione attuale (dal cookie): serve per chiudere "le altre" sessioni senza disconnettere questa
export async function currentSessionHash() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? sha256(token) : null;
}

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = await prisma.session.findUnique({ where: { tokenHash }, include: { user: { select: { id: true, email: true } } } });
  if (!row) return null;
  if (Number(row.expiresAt) < Date.now()) {
    await prisma.session.deleteMany({ where: { tokenHash } });
    return null;
  }
  return { id: row.user.id, email: row.user.email };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;
