import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Un solo client per processo (in sviluppo sopravvive agli hot reload; su Vercel uno per istanza serverless).
const globalForPrisma = globalThis;

function createClient() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL non impostata");
  // poche connessioni per istanza: su serverless ogni istanza apre le sue
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 3 });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.__prisma ?? (globalForPrisma.__prisma = createClient());
