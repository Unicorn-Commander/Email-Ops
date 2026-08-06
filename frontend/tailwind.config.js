/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Geist Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        surface: {
          base: 'rgb(var(--surface-base) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          overlay: 'rgb(var(--surface-overlay) / <alpha-value>)',
          elevated: 'rgb(var(--surface-elevated) / <alpha-value>)',
        },
        primary: 'rgb(var(--text-primary) / <alpha-value>)',
        secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
        tertiary: 'rgb(var(--text-tertiary) / <alpha-value>)',
        muted: 'rgb(var(--text-muted) / <alpha-value>)',
        /* Border tones exposed as colors too, so hairline dividers can use
           `bg-border-subtle` / `bg-border-strong` (borderColor only feeds
           `border-*`, which left these dividers rendering transparent). */
        'border-subtle': 'rgb(var(--border-subtle) / <alpha-value>)',
        'border-strong': 'rgb(var(--border) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
          contrast: 'rgb(var(--accent-contrast) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          subtle: 'rgb(var(--success-subtle) / 0.12)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          subtle: 'rgb(var(--warning-subtle) / 0.12)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          subtle: 'rgb(var(--danger-subtle) / 0.12)',
        },
        info: {
          DEFAULT: 'rgb(var(--info) / <alpha-value>)',
          subtle: 'rgb(var(--info-subtle) / 0.12)',
        },
        keep: {
          DEFAULT: 'rgb(var(--keep) / <alpha-value>)',
          subtle: 'rgb(var(--keep-subtle) / 0.12)',
        },
        review: {
          DEFAULT: 'rgb(var(--review) / <alpha-value>)',
          subtle: 'rgb(var(--review-subtle) / 0.12)',
        },
        delete: {
          DEFAULT: 'rgb(var(--delete) / <alpha-value>)',
          subtle: 'rgb(var(--delete-subtle) / 0.12)',
        },
        protected: {
          DEFAULT: 'rgb(var(--protected) / <alpha-value>)',
          subtle: 'rgb(var(--protected-subtle) / 0.12)',
        },
      },
      borderColor: {
        subtle: 'rgb(var(--border-subtle) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
      },
      borderRadius: {
        token: 'var(--radius)',
        'token-lg': 'var(--radius-lg)',
      },
      boxShadow: {
        token: 'var(--shadow)',
        'token-lg': 'var(--shadow-lg)',
        pop: 'var(--shadow-pop)',
      },
      transitionDuration: {
        /* Bare `transition` / `transition-colors` (which otherwise fall back to
           150ms linear) now inherit the token timing, unifying hover feedback
           across the chrome and message area without touching each component. */
        DEFAULT: 'var(--dur-fast)',
        fast: 'var(--dur-fast)',
        token: 'var(--dur)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease)',
        token: 'var(--ease)',
      },
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [String(i), `${i / 100}`]),
      ),
    },
  },
  plugins: [],
};
