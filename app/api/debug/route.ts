import { type NextRequest } from "next/server";
import { NextResponse } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export async function GET(request: NextRequest) {
  return NextResponse.json({
    hasPassword: !!process.env.REV4A_PASSWORD,
    hasJwtSecret: !!process.env.REV4A_JWT_SECRET,
    hasToken: !!process.env.REV4A_TOKEN,
  });
}
