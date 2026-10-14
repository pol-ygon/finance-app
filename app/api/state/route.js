import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

const STATE_KEY = "finanze-state-v1";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const row = await prisma.userState.findUnique({ where: { userId_key: { userId: user.id, key: STATE_KEY } }, select: { value: true } });
  return NextResponse.json({ key: STATE_KEY, value: row ? row.value : null });
}

export async function PUT(req) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 }); }
  if (typeof body?.value !== "string") return NextResponse.json({ error: "Valore non valido" }, { status: 400 });
  try { JSON.parse(body.value); } catch { return NextResponse.json({ error: "JSON non valido" }, { status: 400 }); }

  await prisma.userState.upsert({
    where: { userId_key: { userId: user.id, key: STATE_KEY } },
    create: { userId: user.id, key: STATE_KEY, value: body.value },
    update: { value: body.value, updatedAt: new Date() },
  });
  return NextResponse.json({ key: STATE_KEY, ok: true });
}
