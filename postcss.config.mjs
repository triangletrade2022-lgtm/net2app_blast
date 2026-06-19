// postcss.config.mjs — required for Tailwind v4 + @tailwindcss/postcss
// to emit CSS in Next.js 16. Without this file, Next's PostCSS loader
// runs no plugins and the plugin is never invoked (symptom: zero CSS in
// the production bundle, fully unstyled UI). v4 auto-scans from the
// project root so no `tailwind.config.ts` is needed, but globals.css
// MUST contain `@import "tailwindcss";` — that's the load-bearing line.

export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
