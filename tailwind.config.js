/**
 * Build-time Tailwind config. The runtime CDN is gone; the committed output
 * is app/static/css/tailwind.css. Rebuild after adding new utility classes:
 * see docs/setup.md § "Rebuilding the stylesheet".
 */
module.exports = {
  darkMode: "class",
  content: ["./app/static/**/*.html", "./app/static/js/**/*.js"],
  safelist: [
    // Audit (2026-09-12) found no dynamically constructed Tailwind utility
    // class names that need safelisting. Every `+`/`${}` concatenation site
    // in app/static/*.html and app/static/js/*.js either:
    //   - builds from a small set of full literal class strings that already
    //     appear verbatim elsewhere in the same file (e.g. status/badge
    //     color branches in requests.html, index.html, issues.html,
    //     settings.html, news.html, auth.js), so the content scanner picks
    //     them up on its own; or
    //   - builds custom CSS classes defined directly in theme.css or a page's
    //     own <style> block (e.g. `badge-media-*` / `text-media-*` in
    //     requests.html, `rs-chip-*` in requests.html), which are not
    //     Tailwind-generated utilities at all; or
    //   - was a truly unbounded arbitrary-value class
    //     (`w-[${Math.round(progress)}%]` in index.html's Plex progress
    //     bar) and was refactored to an inline `style="width: ${...}%"`
    //     instead of a class, per this step's instructions; or
    //   - was dead code (`generateStatusBars()` in index.html, unreachable —
    //     zero call sites repo-wide) and was left alone since it never
    //     renders.
    // If a future change reintroduces a `prefix + variable` class pattern,
    // add its literal values here, one entry per line, commented with the
    // source file/line.
  ],
  theme: {
    extend: {
      colors: {
        "primary": "rgb(var(--color-primary) / <alpha-value>)",
        "baltic-blue": "rgb(var(--color-primary) / <alpha-value>)",
        "cornflower-ocean": "rgb(var(--color-secondary) / <alpha-value>)",
        "steel-blue": "rgb(var(--color-accent) / <alpha-value>)",
        "frosted-blue": "rgb(var(--color-text) / <alpha-value>)",
        "bright": "rgb(var(--color-text-secondary) / <alpha-value>)",
        "background-dark": "rgb(var(--color-background) / <alpha-value>)",
      },
      fontFamily: {
        "display": ["var(--font-display)", "sans-serif"],
      },
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
