/**
 * GET /api/agents/build-logs
 *
 * Reads the current build log file. Supports:
 * - ?after=N  → returns lines after line N (for incremental polling)
 * - ?tail=200 → returns last 200 lines (default: all lines)
 *
 * The log path is provided by buildAgentImage module.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getBuildLogPath } from '@/lib/buildAgentImage';
import * as fs from 'fs';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const logPath = getBuildLogPath();
  const { searchParams } = request.nextUrl;
  const after = searchParams.get('after') ? parseInt(searchParams.get('after')!, 10) : null;
  const tail = searchParams.get('tail') ? parseInt(searchParams.get('tail')!, 10) : null;

  if (!logPath || !fs.existsSync(logPath)) {
    return NextResponse.json({ lines: [], count: 0, active: false });
  }

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n').filter(Boolean);

    let slice: string[];
    if (after !== null && after >= 0) {
      // Return lines after the given index
      slice = allLines.slice(after);
    } else if (tail !== null && tail > 0) {
      // Return last N lines
      slice = allLines.slice(-tail);
    } else {
      slice = allLines;
    }

    return NextResponse.json({
      lines: slice,
      count: allLines.length,
      after: after !== null ? after : 0,
      active: true,
    });
  } catch {
    return NextResponse.json({ lines: [], count: 0, active: false });
  }
}
