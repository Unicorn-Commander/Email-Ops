import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Email-Ops',
  description:
    'The mailbox / thread surface (Stalwart-fronted) + agent-inbox of the Unicorn Commander suite.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
