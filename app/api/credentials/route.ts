import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { listProfiles, createProfile } from '@/lib/credentials/vault';
import { CREDENTIAL_PROVIDERS, validateSecret } from '@/lib/credentials/providers';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // requireAuthJWT was imported for the POST below and never applied here,
  // leaving this the only unauthenticated route in the credentials feature.
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const profiles = listProfiles();
    return NextResponse.json({ profiles, providers: CREDENTIAL_PROVIDERS });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const body = await request.json() as { providerId?: string; label?: string; secret?: Record<string, string> };
    const { providerId, label, secret } = body;

    if (!providerId || !label || !secret) {
      return NextResponse.json({ error: 'providerId, label, and secret are required' }, { status: 400 });
    }

    const invalid = validateSecret(providerId, secret);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    const id = createProfile(providerId, label, secret);
    return NextResponse.json({ id }, { status: 201 });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
