import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    REV4A_PASSWORD: process.env.REV4A_PASSWORD || '(not set)',
    REV4A_TOKEN: process.env.REV4A_TOKEN || '(not set)',
    REV4A_JWT_SECRET: process.env.REV4A_JWT_SECRET?.substring(0,10) + '...' || '(not set)',
    NODE_ENV: process.env.NODE_ENV,
  });
}
