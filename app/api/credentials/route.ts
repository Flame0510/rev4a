import { NextResponse } from 'next/server';
import { listProfiles, createProfile } from '@/lib/credentials/vault';
import { CREDENTIAL_PROVIDERS } from '@/lib/credentials/providers';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const profiles = listProfiles();
    return NextResponse.json({ profiles, providers: CREDENTIAL_PROVIDERS });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = await req.json() as { providerId?: string; label?: string; secret?: Record<string, string> };
    const { providerId, label, secret } = body;

    if (!providerId || !label || !secret) {
      return NextResponse.json({ error: 'providerId, label, and secret are required' }, { status: 400 });
    }

    const id = createProfile(providerId, label, secret);
    return NextResponse.json({ id }, { status: 201 });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
