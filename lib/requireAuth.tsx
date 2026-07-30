import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { jwtVerify } from 'jose';
import * as fs from 'fs';
import { ENV_FILE } from './olympus-paths';

function getJwtSecret(): Uint8Array {
  const fromEnv = process.env.OLYMPUS_JWT_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return new TextEncoder().encode(fromEnv);
  }
  // Fallback: read from persistent .env
  try {
    if (fs.existsSync(ENV_FILE)) {
      const content = fs.readFileSync(ENV_FILE, 'utf-8');
      const match = content.match(/^OLYMPUS_JWT_SECRET=(.*)$/m);
      if (match && match[1].trim()) {
        return new TextEncoder().encode(match[1].trim());
      }
    }
  } catch { /* ignore */ }
  return new TextEncoder().encode('');
}

export async function requireAuth(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get('olympus_token')?.value;

  if (token) {
    try {
      await jwtVerify(token, getJwtSecret());
      return;
    } catch {
      // Invalid — redirect
    }
  }
  redirect('/login');
}
