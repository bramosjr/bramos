/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: '#091A13',         // Verde-escuro profundo (Fundo)
        surface: '#132B22',        // Cartões em Verde-escuro
        surfaceHover: '#1B3E31',   // Hover em cartões
        borderSubtle: '#254E3E',   // Divisores e bordas
        textPrimary: '#F7F4EA',    // Marfim (Ivory)
        textSecondary: '#9CB0A3',  // Marfim/Sage suave
        yellowAccent: '#FACC15',   // Amarelo Destaque
        yellowDark: '#715D08',
        sageGreen: '#8CAE99',      // Verde-claro / Sage
        sandBeige: '#D4C5A9',      // Bege / Areia
        clayBrown: '#C88A58',      // Marrom-claro / Argila
        terracotta: '#E05D43',     // Coral / Terracota (Alertas)
        mintGreen: '#34D399'       // Verde-menta (Crescimento/Foco)
      }
    },
  },
  plugins: [],
};
