import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    hasPassword: !!process.env.REV4A_PASSWORD,
    hasJwtSecret: !!process.env.REV4A_JWT_SECRET,
    hasToken: !!process.env.REV4A_TOKEN,
  });
}
