/**
 * Tailwind is compiled once (`npm run build:css`) and the output,
 * app/static/css/app.css, is committed. The running app never needs Node.
 *
 * Colours are RGB triplets that theme.css defaults and the server-inlined
 * theme override per operator, so a palette change applies without a rebuild.
 * Only classes that appear literally in the content files below are emitted -
 * a class built by string concatenation at runtime will not exist.
 */
module.exports = {
  content: [
    "./app/static/*.html",
    "./app/static/partials/*.html",
    "./app/static/js/*.js",
    "./app/static/js/settings/*.js",
    "./app/static/js/pages/*.js",
    "./app/static/js/player/*.js",
    "./app/pages.py",
  ],
  darkMode: "class",
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
        // The one focus ring colour (theme.css --ws-focus): outline-focus,
        // ring-focus, border-focus. At least 3:1 on the page and the frost.
        "focus": "rgb(var(--ws-focus) / <alpha-value>)",
        // The operator's status colours (Settings > Appearance), for dots,
        // rings, fills and borders.
        "status-ok": "rgb(var(--color-status-ok) / <alpha-value>)",
        "status-warn": "rgb(var(--color-status-warn) / <alpha-value>)",
        "status-err": "rgb(var(--color-status-err) / <alpha-value>)",
        // Status WORDS (R140): the status colour mixed with the text colour
        // (theme.css --ws-status-*-text), so they read on any background.
        // Only where the state is the point: status colour on deviation.
        "status-ok-text": "var(--ws-status-ok-text)",
        "status-warn-text": "var(--ws-status-warn-text)",
        "status-err-text": "var(--ws-status-err-text)",
        // Home's gauge rings: the accent, or with colourful gauges on (Settings >
        // Appearance) each gauge's own colour (theme.css --ws-gauge-*).
        "gauge-cpu": "rgb(var(--ws-gauge-cpu) / <alpha-value>)",
        "gauge-ram": "rgb(var(--ws-gauge-ram) / <alpha-value>)",
        "gauge-net": "rgb(var(--ws-gauge-net) / <alpha-value>)",
      },
      fontFamily: {
        "display": ["var(--font-display)", "sans-serif"],
      },
      // The design contract's type scale (UI design review, Part 5). Font
      // size alone, like the text-[Npx] literals they replace, so swapping a
      // literal for its step never changes a line height.
      fontSize: {
        "label": "13px",
        "body": "15px",
        "lead": "17px",
        "h3": "20px",
        "h2": "24px",
        "h1": "32px",
        "hero": "44px",
      },
      // The contract's radius scale: cards, the boxes inside them, buttons
      // and fields. Chips are rounded-full.
      borderRadius: {
        "card": "16px",
        "inner": "12px",
        "btn": "10px",
      },
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
