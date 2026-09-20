/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#ebebeb',
          800: '#333333',
          900: '#1a1a1a',
        },
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '20px',
      },
      boxShadow: {
        'card': '0px 1px 12px 2px rgba(36, 36, 36, 0.07)',
        'card-hover': '0px 2px 32px 6px rgba(36, 36, 36, 0.07)',
      },
    },
  },
  plugins: [],
};
