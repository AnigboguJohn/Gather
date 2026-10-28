// Tailwind CSS config: which files to scan for class names, plus Gather's colours and font.
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Gather palette: brand = green (trust, "go"), clay = warm accent, ink = dark call background, ocean/flame = dashboard tiles.
      colors: {
        brand: { 50: "#ecfdf5", 100: "#d1fae5", 200: "#a7f3d0", 400: "#34d399", 500: "#10b981", 600: "#059669", 700: "#047857", 800: "#065f46", 900: "#064e3b" },
        clay: { 400: "#f6a35c", 500: "#ef8a3c", 600: "#d9711f" },
        ink: { 900: "#0d1512", 800: "#141f1b", 700: "#1c2a25", 600: "#26372f", 500: "#3a4d44" },
        // Dashboard ("/home") tiles: orange for New meeting, blue for everything else.
        ocean: { 400: "#3d93fb", 500: "#0e78f9", 600: "#0b66d6" },
        flame: { 400: "#ff9257", 500: "#ff7a2f", 600: "#f0661a" },
      },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "sans-serif"] },
    },
  },
  plugins: [],
};
