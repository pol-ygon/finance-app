# Le mie finanze (Next.js)

```bash
npm install
npm run dev      # http://localhost:3000
npm run build && npm start
```

- DB SQLite locale: `data/finanze.db` (creato in automatico, ignorato da git).
- Utenti con password hash (scrypt) e sessioni via cookie httpOnly (30 giorni).
- Lo stato dell'app (movimenti, investimenti, budget, categorie…) è salvato per utente come JSON in `user_state`.
- `SECURE_COOKIES=1` per forzare il flag Secure dietro HTTPS.

## Consulente AI (Gemini)
Copia `.env.example` in `.env.local` e imposta `GEMINI_API_KEY` (la chiave resta solo sul server, non arriva mai al browser).
Facoltativo: `GEMINI_MODEL` (default `gemini-3.8-flash`). Dopo aver creato/modificato `.env.local`, riavvia `npm run dev`.
# finance-app
