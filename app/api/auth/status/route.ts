import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GET /api/auth/status
 *
 * Returns { configured: true } if a password has been set on disk.
 * Reads ONLY from the .env file — never from process.env, because
 * Next.js inlines env vars at build time and they are not reliable
 * when the .env file is created at runtime by the setup wizard.
 *
 * No auth required.
 */
export function GET(): NextResponse {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/^OLYMPUS_PASSWORD=(.*)$/m);
      if (match && match[1].trim().length > 0) {
        return NextResponse.json({ configured: true });
      }
    }
  } catch {
    // .env unreadable → treat as not configured
  }
  return NextResponse.json({ configured: false });
}
