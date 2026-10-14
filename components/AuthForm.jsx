"use client";

import { useState } from "react";
import Link from "next/link";

export default function AuthForm({ mode }) {
  const isRegister = mode === "register";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (isRegister && password !== confirm) { setError("Le password non coincidono"); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${isRegister ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || "Errore imprevisto"); setBusy(false); return; }
      window.location.href = "/";
    } catch {
      setError("Impossibile contattare il server");
      setBusy(false);
    }
  };

  return (
    <div style={styles.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        input { font-family: 'Inter', sans-serif; }
        ::selection { background: color-mix(in srgb, var(--accent) 33%, transparent); }
      `}</style>
      <div style={styles.box}>
        <div style={styles.eyebrow}>REGISTRO PERSONALE</div>
        <h1 style={styles.title}>Le mie finanze</h1>

        <form onSubmit={submit} style={styles.card}>
          <div style={styles.cardTitle}>{isRegister ? "Crea il tuo account" : "Accedi"}</div>

          <div style={styles.field}>
            <label style={styles.fieldLabel}>Email</label>
            <input
              style={styles.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div style={styles.field}>
            <label style={styles.fieldLabel}>Password</label>
            <input
              style={styles.input}
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={isRegister ? 8 : undefined}
              required
            />
          </div>
          {isRegister && (
            <div style={styles.field}>
              <label style={styles.fieldLabel}>Conferma password</label>
              <input
                style={styles.input}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
              <div style={styles.hint}>Almeno 8 caratteri</div>
            </div>
          )}

          {error && <div style={styles.fieldError}>{error}</div>}

          <button type="submit" disabled={busy} style={{ ...styles.primaryBtnFull, opacity: busy ? 0.7 : 1 }}>
            {isRegister ? "Registrati" : "Accedi"}
          </button>

          <div style={styles.switchRow}>
            {isRegister ? "Hai già un account?" : "Non hai un account?"}{" "}
            <Link href={isRegister ? "/login" : "/register"} style={styles.link}>
              {isRegister ? "Accedi" : "Registrati"}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}

const styles = {
  app: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--text)",
    fontFamily: "'Inter', sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  box: { width: 380, maxWidth: "100%" },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: 2,
    color: "var(--accent)",
    marginBottom: 4,
  },
  title: {
    fontFamily: "'Fraunces', serif",
    fontSize: 34,
    fontWeight: 600,
    margin: "0 0 24px",
    color: "var(--text-strong)",
  },
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: 20,
  },
  cardTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: 18,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 16,
  },
  field: { marginBottom: 14 },
  fieldLabel: { display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 },
  input: {
    width: "100%",
    background: "var(--bg)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 14,
    padding: "9px 11px",
  },
  hint: { marginTop: 6, fontSize: 12, color: "var(--text-dim)" },
  fieldError: { marginBottom: 10, fontSize: 12, color: "var(--neg)" },
  primaryBtnFull: {
    width: "100%",
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    border: "none",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 6,
  },
  switchRow: { marginTop: 16, fontSize: 13, color: "var(--text-muted)", textAlign: "center" },
  link: { color: "var(--accent)", textDecoration: "underline" },
};
