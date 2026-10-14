import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, createSession } from "@/lib/auth";

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 }); }
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Email o password errata" }, { status: 401 });
  }
  await createSession(user.id);
  return NextResponse.json({ ok: true });
}
