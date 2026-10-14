export const metadata = {
  title: "Le mie finanze",
};

// Variabili di colore del tema (scuro/chiaro) e del colore principale. Entrate/uscite (--pos/--neg) e avviso (--warn)
// dipendono solo dal tema chiaro/scuro, mai dal colore principale.
const THEME_CSS = `
:root {
  color-scheme: dark;
  --bg: #0F1720; --surface: #16212C; --surface-muted: #141C25; --surface-2: #1B2732; --surface-3: #1E2933; --line-faint: #1B252F;
  --border: #26333F; --border-2: #2A3743; --border-3: #3A4552;
  --text: #E8E6DF; --text-strong: #F2F0EA; --text-soft: #C7CDD4; --text-soft-2: #B8BFC8; --text-muted: #8B94A0; --text-dim: #5C6773;
  --pos: #4A9B7F; --neg: #C15B4A; --warn: #C9A227;
  --chart-3: #B77BAF; --chart-4: #5FA8C9;
  --accent: #C9A227; --secondary: #7B8CDE; --accent-contrast: #0F1720;
  --check-stroke: %230F1720;
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #F5F2EA; --surface: #FFFFFF; --surface-muted: #FAF8F3; --surface-2: #F0EDE4; --surface-3: #E9E5DA; --line-faint: #EEEAE0;
  --border: #DDD7C8; --border-2: #D0C9B8; --border-3: #BDB5A0;
  --text: #1F2933; --text-strong: #0F1720; --text-soft: #38434E; --text-soft-2: #4E5A66; --text-muted: #5B6672; --text-dim: #8A94A0;
  --pos: #2F8A6C; --neg: #B94A3A; --warn: #A8841A;
  --chart-3: #9A5A94; --chart-4: #2F85A8;
  --accent: #9A7B14; --secondary: #4F62C0; --accent-contrast: #FFFFFF;
}
:root[data-accent="blu"] { --accent: #5B8DEF; --secondary: #E0A458; }
:root[data-accent="turchese"] { --accent: #3FB6C9; --secondary: #C98BD9; }
:root[data-accent="viola"] { --accent: #A78BFA; --secondary: #E8B04A; }
:root[data-accent="arancio"] { --accent: #E8884A; --secondary: #6FA8DC; }
:root[data-accent="rosa"] { --accent: #E07BA8; --secondary: #8FB4E8; }
:root[data-theme="light"][data-accent="blu"] { --accent: #2F62C8; --secondary: #B87A1E; }
:root[data-theme="light"][data-accent="turchese"] { --accent: #17808F; --secondary: #8E4FA0; }
:root[data-theme="light"][data-accent="viola"] { --accent: #6D4FD1; --secondary: #B07A12; }
:root[data-theme="light"][data-accent="arancio"] { --accent: #C25A1B; --secondary: #2F6FA8; }
:root[data-theme="light"][data-accent="rosa"] { --accent: #B8457A; --secondary: #3E69B0; }
html, body { background: var(--bg); }
`;

// imposta tema e colore prima del primo disegno (preferenze salvate nel browser), così non c'è nessun "lampo"
const THEME_SCRIPT = `try{var p=JSON.parse(localStorage.getItem('fx-prefs')||'{}');var d=document.documentElement;d.dataset.theme=p.theme||'dark';d.dataset.accent=p.accent||'oro';}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body style={{ margin: 0, padding: 0, background: "var(--bg)", fontFamily: "'Inter', sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
