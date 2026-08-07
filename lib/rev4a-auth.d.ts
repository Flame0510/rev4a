import { NextResponse } from "next/server";
export function requireAuth(request: Request): NextResponse | null;
export function requireAuthJWT(request: Request): Promise<NextResponse | null>;
