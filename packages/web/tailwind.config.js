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
        accent: {
          50:  '#ECFEFF',
          100: '#CFFAFE',
          200: '#A5F3FC',
          300: '#67E8F9',
          400: '#22D3EE',
          500: '#06B6D4',
          600: '#0891B2',
          700: '#0E7490',
          800: '#155E75',
          900: '#164E63',
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
        danger: {
          50:  '#FFF1F2',
          500: '#F43F5E',
          600: '#E11D48',
          700: '#BE123C',
        },
        success: {
          50:  '#ECFDF5',
          500: '#10B981',
          600: '#059669',
          700: '#047857',
        },
        warning: {
          50:  '#FFFBEB',
          500: '#F59E0B',
          600: '#D97706',
          700: '#B45309',
        },
      },
      boxShadow: {
        'xs':    '0 1px 2px rgba(0,0,0,0.04)',
        'brand': '0 4px 14px rgba(124,58,237,0.25)',
        'glass': '0 8px 32px rgba(0,0,0,0.06)',
        'card':  '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
      },
      borderRadius: {
        '2xl': '1.25rem',
      },
      backdropBlur: {
        'glass': '16px',
      },
      keyframes: {
        aurora: {
          '0%, 100%': { transform: 'scale(1) translate(0, 0)', opacity: '1' },
          '25%': { transform: 'scale(1.08) translate(-1%, 1%)', opacity: '0.9' },
          '50%': { transform: 'scale(1.04) translate(1%, -2%)', opacity: '0.85' },
          '75%': { transform: 'scale(1.1) translate(-0.5%, 0.5%)', opacity: '0.9' },
        },
      },
      animation: {
        aurora: 'aurora 18s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [],
}
