import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, currentSessionHash, hashPassword, verifyPassword, MIN_PASSWORD } from "@/lib/auth";

// limite per utente: 5 tentativi al minuto (protegge dal tentativo di indovinare la password attuale)
const hits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(userId, recent);
  return recent.length > 5;
}

const bad = (error, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req) {
  const user = await getCurrentUser();
  if (!user) return bad("Non autenticato", 401);
  if (rateLimited(user.id)) return bad("Troppi tentativi: aspetta un minuto e riprova.", 429);

  let body;
  try { body = await req.json(); } catch { return bad("Richiesta non valida"); }
  const current = String(body?.current || "");
  const next = String(body?.next || "");

  if (next.length < MIN_PASSWORD) return bad(`La nuova password deve avere almeno ${MIN_PASSWORD} caratteri`);
  if (next.length > 200) return bad("La nuova password è troppo lunga");

  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!row || !verifyPassword(current, row.passwordHash)) return bad("La password attuale non è corretta", 403);
  if (current === next) return bad("La nuova password deve essere diversa da quella attuale");

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(next) } });

  // chiude tutte le altre sessioni dell'utente (altri browser/dispositivi); quella attuale resta aperta
  const keep = await currentSessionHash();
  const closed = await prisma.session.deleteMany({ where: { userId: user.id, ...(keep ? { NOT: { tokenHash: keep } } : {}) } });
  return NextResponse.json({ ok: true, closedSessions: closed.count });
}
