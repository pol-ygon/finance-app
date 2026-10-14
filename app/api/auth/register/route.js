import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSession, EMAIL_RE, MIN_PASSWORD } from "@/lib/auth";

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 }); }
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");

  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Email non valida" }, { status: 400 });
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json({ error: `La password deve avere almeno ${MIN_PASSWORD} caratteri` }, { status: 400 });
  }
  try {
    const user = await prisma.user.create({ data: { email, passwordHash: hashPassword(password) } });
    await createSession(user.id);
  } catch (e) {
    // violazione dell'unicità sull'email (anche per due registrazioni simultanee)
    if (e?.code === "P2002") return NextResponse.json({ error: "Esiste già un account con questa email" }, { status: 409 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}
