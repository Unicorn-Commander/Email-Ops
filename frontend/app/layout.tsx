import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { ToastProvider } from '@/components/ToastProvider';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://email-ops.unicorncommander.ai'),
  title: {
    default: 'Email-Ops',
    template: '%s · Email-Ops',
  },
  description: 'The privacy-first agent email command center for connected mailboxes.',
  applicationName: 'Email-Ops',
  openGraph: {
    url: '/',
    siteName: 'Email-Ops',
    title: 'Email-Ops',
    description: 'The privacy-first agent email command center for connected mailboxes.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="canonical" href="https://email-ops.unicorncommander.ai/" />
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
        {/* Keep the shell self-contained in offline builds. The token stack in
            globals.css falls back to system sans/mono when optional web fonts
            are not bundled. */}
        <style
          dangerouslySetInnerHTML={{
            __html:
              'html body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
              'html .mono,html .font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}',
          }}
        />
      </head>
      <body>
        <ConfirmProvider>
          <ToastProvider>
            <AppShell>{children}</AppShell>
          </ToastProvider>
        </ConfirmProvider>
      </body>
    </html>
  );
}
