import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { ToastProvider } from '@/components/ToastProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Email-Ops',
  description: 'The privacy-first cleaner cockpit for connected mailboxes.',
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
