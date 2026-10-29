export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        jungle: {
          950: '#070f0a',
          900: '#0c1a12',
          850: '#112319',
          800: '#162c20',
          700: '#1f3c2c',
          600: '#2b533d',
          500: '#3c7255',
        },
        mango: {
          300: '#ffd073',
          400: '#ffb733',
          500: '#ff9e00',
          600: '#e08300',
          700: '#b86500',
        },
        papaya: {
          400: '#ff8652',
          500: '#ff6b35',
          600: '#e5531d',
          700: '#be3e0e',
        },
        tomato: {
          400: '#ff5c52',
          500: '#ff382e',
          600: '#e02218',
          700: '#b3150d',
        },
        lime: {
          300: '#bcf74a',
          400: '#9ef01a',
          500: '#70e000',
          600: '#52a800',
          700: '#387500',
        },
        cream: {
          50: '#fefefe',
          100: '#fbf8f2',
          200: '#f5eee1',
          300: '#ebd9c3',
        }
      },
      fontFamily: {
        sans: ['Space Grotesk', 'Outfit', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'glow-mango': '0 0 25px -3px rgba(255, 158, 0, 0.4)',
        'glow-tomato': '0 0 25px -3px rgba(255, 56, 46, 0.4)',
        'glow-lime': '0 0 25px -3px rgba(112, 224, 0, 0.4)',
        'glow-papaya': '0 0 25px -3px rgba(255, 107, 53, 0.4)',
      }
    },
  },
  plugins: [],
}
