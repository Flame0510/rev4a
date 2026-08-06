import { NextResponse } from "next/server";
import { jwtVerify } from "jose";

function getExpectedToken() {
  const token = process.env.REV4A_TOKEN || process.env.NEXT_PUBLIC_REV4A_TOKEN || '';
  if (!token) console.warn('REV4A_TOKEN is not set — auth will reject all requests');
  return token;
}

export function requireAuth(request) {
  const auth = request.headers.get("authorization");
  if (!auth || auth !== `Bearer ${getExpectedToken()}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

const JWT_SECRET = new TextEncoder().encode(
  process.env.REV4A_JWT_SECRET || ''
);

export async function requireAuthJWT(request) {
  const cookieToken = request.cookies?.get?.("rev4a_token")?.value;
  if (cookieToken) {
    try {
      await jwtVerify(cookieToken, JWT_SECRET);
      return null;
    } catch {}
  }

  const auth = request.headers.get("authorization");
  const expectedToken = process.env.REV4A_TOKEN || process.env.NEXT_PUBLIC_REV4A_TOKEN || '';
  if (auth === `Bearer ${expectedToken}`) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
