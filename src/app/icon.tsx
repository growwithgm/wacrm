import { readFile } from "fs/promises";
import { join } from "path";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Serves public/favicon.png via the Next.js metadata image route so
// Next.js auto-injects the correct <link rel="icon"> into <head>.
// layout.tsx also declares icons: { icon: '/favicon.png' } as a belt-and-
// suspenders fallback for static export and CDN edge caches.
export default async function Icon() {
  const buffer = await readFile(join(process.cwd(), "public/favicon.png"));
  return new Response(buffer, {
    headers: { "Content-Type": "image/png" },
  });
}
