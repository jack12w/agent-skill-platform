/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Noto Sans SC"',
          'sans-serif',
        ],
      },
      colors: {
        brand: {
          50:  '#EFF4FF',
          100: '#DCE7FF',
          200: '#B7CCFF',
          300: '#8DACFF',
          400: '#5C85FF',
          500: '#3366FF',
          600: '#2952E3',
          700: '#1F3EB8',
          800: '#162D8C',
          900: '#0E1D61',
        },
        accent: {
          50:  '#F8F6FF',
          100: '#EDE9FE',
          200: '#DDD6FE',
          300: '#C4B5FD',
          400: '#A78BFA',
          500: '#8B5CF6',
          600: '#7C3AED',
          700: '#6D28D9',
          800: '#5B21B6',
          900: '#4C1D95',
        },
        neutral: {
          50:  '#FAFAFA',
          100: '#F4F4F5',
          200: '#E4E4E7',
          300: '#D4D4D8',
          400: '#A1A1AA',
          500: '#71717A',
          600: '#52525B',
          700: '#3F3F46',
          800: '#27272A',
          900: '#18181B',
        },
        surface: {
          page:    '#FAFAFA',
          card:    '#FFFFFF',
          hover:   '#F4F4F5',
          overlay: 'rgba(0, 0, 0, 0.4)',
        },
      },
      boxShadow: {
        'xs':    '0 1px 2px rgba(0,0,0,0.04)',
        'brand': '0 4px 14px rgba(41,82,227,0.25)',
        'glass': '0 8px 32px rgba(0,0,0,0.06)',
        'card':  '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
      },
      borderRadius: {
        '2xl': '1.25rem',
      },
      backdropBlur: {
        'glass': '16px',
      },
    },
  },
  plugins: [],
}
