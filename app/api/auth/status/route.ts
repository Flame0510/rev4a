import { NextResponse } from 'next/server';
import * as fs from 'fs';
import { ENV_FILE } from '@/lib/olympus-paths';

/**
 * GET /api/auth/status
 *
 * Returns { configured: true } if a password has been set (either
 * in the environment or in the .env file created by the setup wizard).
 * No auth required — used by the frontend to decide whether to show
 * the setup wizard or the login form.
 */
export function GET(): NextResponse {
  let password = process.env.OLYMPUS_PASSWORD;

  // Fallback: read .env from config dir if env var is empty (Next.js inlines at build)
  if (typeof password !== 'string' || password.length === 0) {
    try {
      if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf-8');
        const match = content.match(/^OLYMPUS_PASSWORD=(.*)$/m);
        if (match && match[1].trim()) {
          password = match[1].trim();
        }
      }
    } catch {
      // ignore
    }
  }

  const configured = typeof password === 'string' && password.length > 0;
  return NextResponse.json({ configured });
}
