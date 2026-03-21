import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrustCore Mission Control',
  description: 'Real-time dashboard for the TrustCore agent engine',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
