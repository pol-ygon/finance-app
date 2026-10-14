// Copia il worker di pdf.js in public/ (stessa versione della libreria installata)
import fs from "node:fs";
import path from "node:path";

const src = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs");
const dst = path.join(process.cwd(), "public", "pdf.worker.min.mjs");
fs.mkdirSync(path.dirname(dst), { recursive: true });
if (fs.existsSync(src)) fs.copyFileSync(src, dst);
