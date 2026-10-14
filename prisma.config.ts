import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Next.js usa .env.local: lo leggo anche per i comandi della CLI di Prisma
config({ path: ".env.local" });
config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // per "prisma generate" l'URL non serve; per migrate/deploy deve essere impostato
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/postgres" },
});
