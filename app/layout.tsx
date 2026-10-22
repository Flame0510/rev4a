import type { Metadata, Viewport } from 'next';
import { Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import AppShell from './components/AppShell';
import UpdatingScreen from './components/UpdatingScreen';
import { ModelsProvider } from './lib/models-context';
import { ToastContainer } from './components/ui';

const jetBrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-serif',
});

export const viewport: Viewport = {
  themeColor: '#925BFC',
};

export const metadata: Metadata = {
  // Each page sets its own title ("Lineage · Rev4a"); pages without one show the default.
  title: { default: 'Rev4a — Revolution for Agents', template: '%s · Rev4a' },
  description: 'Dashboard and orchestrator for OpenClaw agents.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'REV4A' },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-64.png', sizes: '64x64', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { url: '/icon-192-maskable.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${jetBrainsMono.variable} ${instrumentSerif.variable}`}>
        <ModelsProvider><AppShell>{children}<ToastContainer /></AppShell><UpdatingScreen /></ModelsProvider>
      </body>
    </html>
  );
}
