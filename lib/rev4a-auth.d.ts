import { NextResponse } from "next/server";
export function requireAuthJWT(request: Request): Promise<NextResponse | null>;
/** Operator setup code before configuration; cookie or bearer authentication afterwards. */
export function requireAuthIfConfigured(request: Request): Promise<NextResponse | null>;
export function getPassword(): string;
export function getJwtSecret(): string;
export function isConfigured(): boolean;
export function secretEquals(supplied: unknown, expected: unknown): boolean;
