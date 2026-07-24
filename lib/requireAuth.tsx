import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { jwtVerify } from 'jose';
import { readJwtSecret } from '@/lib/env';

export async function requireAuth(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get('olympus_token')?.value;

  if (token) {
    try {
      const secret = readJwtSecret();
      if (secret) {
        const key = new TextEncoder().encode(secret);
        await jwtVerify(token, key);
        return;
      }
    } catch {
      // Invalid token — redirect
    }
  }
  redirect('/login');
}
