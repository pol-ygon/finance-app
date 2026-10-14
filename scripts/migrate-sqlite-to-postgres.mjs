// Migra utenti, sessioni e stato dell'app dal vecchio SQLite (data/finanze.db) a Postgres.
//  - SQLite è aperto SOLO in lettura: nessun dato locale viene modificato o cancellato.
//  - Idempotente: si può rieseguire (es. subito prima del passaggio definitivo) senza creare doppioni.
//    Lo stato di un utente viene sovrascritto solo se quello su SQLite è più recente di quello su Postgres.
//  - Alla fine verifica che tutto coincida esattamente (stesso testo, stessi conteggi).
// Uso:  node scripts/migrate-sqlite-to-postgres.mjs [--dry] [percorso/finanze.db]
import path from "node:path";
import { createRequire } from "node:module";
import dotenv from "dotenv";
import pg from "pg";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
dotenv.config({ path: ".env.local" });
dotenv.config();

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const sqlitePath = args.find((a) => !a.startsWith("--")) || path.join("data", "finanze.db");
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL mancante"); process.exit(1); }

const toDate = (s) => new Date(String(s).replace(" ", "T") + "Z"); // SQLite salva UTC come 'YYYY-MM-DD HH:MM:SS'

const lite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const users = lite.prepare("SELECT id, email, password_hash, created_at FROM users ORDER BY id").all();
const sessions = lite.prepare("SELECT token_hash, user_id, expires_at FROM sessions").all();
const states = lite.prepare("SELECT user_id, key, value, updated_at FROM user_state").all();
console.log(`SQLite (${sqlitePath}): ${users.length} utenti, ${sessions.length} sessioni, ${states.length} stati`);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const report = { users: 0, sessions: 0, statesInserted: 0, statesUpdated: 0, statesKept: 0 };
try {
  await client.query("BEGIN");
  for (const u of users) {
    const r = await client.query(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [u.id, String(u.email).toLowerCase(), u.password_hash, toDate(u.created_at)]
    );
    report.users += r.rowCount;
  }
  for (const s of sessions) {
    const r = await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO NOTHING`,
      [s.token_hash, s.user_id, s.expires_at]
    );
    report.sessions += r.rowCount;
  }
  for (const st of states) {
    const cur = await client.query(`SELECT updated_at FROM user_state WHERE user_id=$1 AND key=$2`, [st.user_id, st.key]);
    const ts = toDate(st.updated_at);
    if (cur.rowCount === 0) {
      await client.query(`INSERT INTO user_state (user_id, key, value, updated_at) VALUES ($1,$2,$3,$4)`, [st.user_id, st.key, st.value, ts]);
      report.statesInserted++;
    } else if (cur.rows[0].updated_at < ts) {
      await client.query(`UPDATE user_state SET value=$3, updated_at=$4 WHERE user_id=$1 AND key=$2`, [st.user_id, st.key, st.value, ts]);
      report.statesUpdated++;
    } else {
      report.statesKept++; // su Postgres c'è già una versione uguale o più recente
    }
  }
  // la sequenza degli id riparte dopo il massimo id migrato
  await client.query(`SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))`);

  if (dry) { await client.query("ROLLBACK"); console.log("DRY RUN (nessuna modifica salvata):", report); process.exit(0); }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("ERRORE, tutto annullato:", e.message);
  process.exit(1);
}
console.log("Migrazione completata:", report);

// ---------- verifica ----------
let problems = 0;
const bad = (m) => { problems++; console.error("  ✗", m); };
for (const u of users) {
  const r = (await client.query(`SELECT email, password_hash FROM users WHERE id=$1`, [u.id])).rows[0];
  if (!r) bad(`utente ${u.id} mancante`);
  else if (r.email !== String(u.email).toLowerCase() || r.password_hash !== u.password_hash) bad(`utente ${u.id} diverso`);
}
for (const s of sessions) {
  const r = (await client.query(`SELECT user_id, expires_at FROM sessions WHERE token_hash=$1`, [s.token_hash])).rows[0];
  if (!r || r.user_id !== s.user_id || Number(r.expires_at) !== Number(s.expires_at)) bad("sessione mancante o diversa");
}
for (const st of states) {
  const r = (await client.query(`SELECT value FROM user_state WHERE user_id=$1 AND key=$2`, [st.user_id, st.key])).rows[0];
  if (!r) { bad(`stato utente ${st.user_id} mancante`); continue; }
  if (r.value !== st.value) {
    // se Postgres è più recente va bene che sia diverso; altrimenti è un errore
    const pgTs = (await client.query(`SELECT updated_at FROM user_state WHERE user_id=$1 AND key=$2`, [st.user_id, st.key])).rows[0].updated_at;
    if (pgTs <= toDate(st.updated_at)) bad(`stato utente ${st.user_id} NON identico`);
    else console.log(`  = stato utente ${st.user_id}: su Postgres c'è una versione più recente (ok)`);
  } else {
    const j = JSON.parse(st.value);
    console.log(`  ✓ stato utente ${st.user_id}: identico (${st.value.length} caratteri; ${j.transactions?.length ?? 0} movimenti, ${j.accounts?.length ?? 0} conti, ${j.investments?.length ?? 0} investimenti, ${j.rules?.length ?? 0} regole, ${j.trash?.length ?? 0} nel cestino)`);
  }
}
const cnt = async (t) => Number((await client.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n);
console.log(`Postgres ora: ${await cnt("users")} utenti, ${await cnt("sessions")} sessioni, ${await cnt("user_state")} stati`);
await client.end();
if (problems) { console.error(`VERIFICA FALLITA: ${problems} problemi`); process.exit(2); }
console.log("VERIFICA OK: tutti i dati coincidono con SQLite.");
