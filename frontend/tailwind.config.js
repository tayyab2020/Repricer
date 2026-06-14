/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // CSS custom property colors — updated at runtime for theme switching.
        // The `rgb(... / <alpha-value>)` syntax enables Tailwind opacity variants
        // (bg-surface/10, text-accent/60, etc.) to work correctly with CSS vars.
        background: "rgb(var(--col-bg)      / <alpha-value>)",
        surface:    "rgb(var(--col-surface)  / <alpha-value>)",
        panel:      "rgb(var(--col-panel)    / <alpha-value>)",
        accent:     "rgb(var(--col-accent)   / <alpha-value>)",
        foreground: "rgb(var(--col-fg)       / <alpha-value>)",
        muted:      "rgb(var(--col-muted)    / <alpha-value>)",
        separator:  "rgb(var(--col-sep)      / <alpha-value>)",
        danger:     "rgb(var(--col-danger)   / <alpha-value>)",
        subdued:    "rgb(var(--col-subdued)  / <alpha-value>)",
        amber:      "rgb(var(--col-amber)    / <alpha-value>)",
        info:       "rgb(var(--col-info)     / <alpha-value>)",
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      borderRadius: {
        DEFAULT: "0.5rem",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
    },
  },
  plugins: [],
};
