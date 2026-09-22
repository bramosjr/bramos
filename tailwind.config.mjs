/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: '#37211B',         // Argila Escura (Fundo, terracota dessaturada)
        surface: '#1A1A1A',        // Carvão Intenso (Cartões)
        surfaceHover: '#332822',   // Carvão aquecido (Hover em cartões)
        borderSubtle: '#4A332B',   // Divisores e bordas
        textPrimary: '#FFFCE4',    // Off-White Puro
        textSecondary: '#D8CFC0',  // Off-White dessaturado (texto de apoio)
        accent: '#E68770',         // Terracota Luz (Destaque/CTA)
        success: '#34D399',        // Verde-menta (status positivo/crescimento)
        danger: '#FCA5A5'          // Vermelho de alerta (status de risco, distinto da marca)
      }
    },
  },
  plugins: [],
};
