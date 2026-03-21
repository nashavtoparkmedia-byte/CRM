/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        neu: {
          base: "#353941",
          dark: "#26292f",
          light: "#444953",
          accent: "#00f0ff", /* Neon Cyan */
          secondary: "#ff3366", /* Neon Pink/Orange */
        }
      },
      boxShadow: {
        'neu': '6px 6px 12px #26292f, -6px -6px 12px #444953',
        'neu-sm': '3px 3px 6px #26292f, -3px -3px 6px #444953',
        'neu-inner': 'inset 6px 6px 12px #26292f, inset -6px -6px 12px #444953',
        'neu-inner-sm': 'inset 3px 3px 6px #26292f, inset -3px -3px 6px #444953',
        'neu-glow': '0 0 10px rgba(0, 240, 255, 0.5), 0 0 20px rgba(0, 240, 255, 0.3)',
      }
    },
  },
  plugins: [],
};
