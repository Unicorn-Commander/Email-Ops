import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { AppShell } from '@/components/AppShell';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { ToastProvider } from '@/components/ToastProvider';
import './globals.css';

// Self-hosted at build by next/font (no runtime request to Google → CSP-safe).
// Inter is the UI sans (body default); JetBrains Mono backs the machine-data
// voice (`.mono` class + `font-mono` utility). Each exposes a CSS variable the
// wiring in <head> below feeds into those rules — globals.css / tailwind.config
// reference the families by literal name, which next/font can't register, so we
// bridge the self-hosted family in through the variable.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: {
    default: 'Email-Ops',
    template: '%s · Email-Ops',
  },
  description: 'The privacy-first agent email command center for connected mailboxes.',
  applicationName: 'Email-Ops',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var pref=localStorage.getItem("theme")}catch(e){var pref=null}if(pref!=="light"&&pref!=="dark"&&pref!=="system")pref="dark";var resolved=pref;if(pref==="system"){resolved=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",resolved)})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem("eops:shell:nav-collapsed")==="1")document.documentElement.classList.add("eops-nav-collapsed")}catch(e){}})();`,
          }}
        />
        {/* Bridge the self-hosted next/font families into the literal-name font
            rules in globals.css / tailwind (which we don't own here). The extra
            `html` qualifier wins on specificity regardless of stylesheet order. */}
        <style
          dangerouslySetInnerHTML={{
            __html:
              'html body{font-family:var(--font-sans),ui-sans-serif,system-ui,sans-serif}' +
              'html .mono,html .font-mono{font-family:var(--font-mono),ui-monospace,SFMono-Regular,Menlo,monospace}',
          }}
        />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable}`}>
        <ConfirmProvider>
          <ToastProvider>
            <AppShell>{children}</AppShell>
          </ToastProvider>
        </ConfirmProvider>
      </body>
    </html>
  );
}
