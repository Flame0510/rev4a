import { NextResponse } from 'next/server';

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete({ name: 'rev4a_token', path: '/' });
  return response;
}
