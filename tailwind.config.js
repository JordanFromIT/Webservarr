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
