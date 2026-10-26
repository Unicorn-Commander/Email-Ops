import type { Metadata } from 'next';
import { ApiTokensCard } from '@/components/connect/ApiTokensCard';
import { ConnectYourAiPanel } from '@/components/connect/ConnectYourAiPanel';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'Connect your AI to Email-Ops and manage API tokens.',
};

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <header>
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-primary">Settings</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">
          Connect an assistant to this Email-Ops site. It receives your permissions and nothing
          more. Tokens are created here and shown once.
        </p>
      </header>
      <ConnectYourAiPanel />
      <ApiTokensCard />
    </div>
  );
}
