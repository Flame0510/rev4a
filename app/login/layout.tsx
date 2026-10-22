import type { Metadata } from 'next';

// The login page is a client component: its tab title comes from this layout.
export const metadata: Metadata = { title: 'Log in' };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
