/** @type {import('next').NextConfig} */
const nextConfig = {
  // cartella di build alternativa (utile per lanciare un secondo server senza toccare .next)
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
