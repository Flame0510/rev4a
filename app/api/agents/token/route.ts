import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { NextResponse, type NextRequest } from 'next/server';
import { AGENTS_TOKEN_FILE } from '@/lib/rev4a-paths';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { agentBusyReason } from '@/lib/agent-busy';
import { redactedMessage } from '@/lib/redact-secret';
import { writeTokenToContainer, restartArgv } from '@/lib/agent-token';
import { acquireTokenLock } from '@/lib/agent-token-lock';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

interface TokenData {
  token: string;
  updated_at: number;
}

function readTokenFile(): TokenData {
  try {
    const raw = fs.readFileSync(AGENTS_TOKEN_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return {
      token: typeof data.token === 'string' ? data.token : '',
      updated_at: typeof data.updated_at === 'number' ? data.updated_at : 0,
    };
  } catch {
    return { token: '', updated_at: 0 };
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  return NextResponse.json(readTokenFile());
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthJWT(request);
  if (denied) return denied;
  let redactToken = '';
  // Held from writing the file to the end of the container loop (see lib/agent-token-lock.ts).
  let releaseLock: () => void = () => {};
  try {
    const body = await request.json();
    const token = typeof body?.token === 'string' ? body.token : null;
    redactToken = token ?? '';

    if (token === null) {
      return NextResponse.json(
        { success: false, error: 'Invalid token payload' },
        { status: 400 },
      );
    }

    const payload: TokenData = {
      token,
      updated_at: Date.now(),
    };

    releaseLock = await acquireTokenLock();
    fs.mkdirSync(require('path').dirname(AGENTS_TOKEN_FILE), { recursive: true });
    // An existing file keeps its mode on write: set it explicitly.
    fs.writeFileSync(AGENTS_TOKEN_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.chmodSync(AGENTS_TOKEN_FILE, 0o600);

    let containersUpdated = 0;
    /** Containers left alone because an operation is running on them. */
    const skipped: string[] = [];
    /** Containers that could not be updated, with the reason. */
    const failed: { container: string; error: string }[] = [];
    let containers: { name: string; agentId: string }[] = [];

    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '--filter', 'label=AGENT_ID', '--format', '{{.Names}} {{.Label "AGENT_ID"}}'],
        { encoding: 'utf-8', timeout: 5000 },
      );
      const raw = stdout.trim();
      containers = raw
        ? raw.split('\n').map((line) => {
          const [name, agentId] = line.trim().split(/\s+/);
          return { name: (name ?? '').trim(), agentId: (agentId ?? '').trim() };
        }).filter((c) => c.name)
        : [];
    } catch {
      return NextResponse.json(
        { success: false, error: 'Docker is not reachable: the token was saved, the agents were not updated.' },
        { status: 502 },
      );
    }

    for (const { name, agentId } of containers) {
      try {
        // Restarting an agent mid-update, mid-recreate, mid-restore or mid-edit would cut
        // the operation in half: leave it and say so.
        if (agentId && (await agentBusyReason(agentId))) {
          skipped.push(name);
          continue;
        }
        // Write token to /root/.agent-token (entrypoint reads this, overrides env var).
        // The token goes on stdin: never in argv, never in a shell string.
        await writeTokenToContainer(name, token);
        // Restart to pick up new token
        await execFileAsync('docker', restartArgv(name), { encoding: 'utf-8', timeout: 20000 });
        containersUpdated += 1;
      } catch (e) {
        // Report the failure instead of swallowing it: a token that reached only some
        // agents used to look like a full success.
        failed.push({ container: name, error: redactedMessage(e, token) });
      }
    }

    return NextResponse.json({
      success: failed.length === 0,
      ...(failed.length
        ? { error: `The token was saved but ${failed.length} agent(s) were not updated: ${failed.map((f) => f.container).join(', ')}.` }
        : {}),
      containersUpdated,
      ...(skipped.length ? { skipped } : {}),
      ...(failed.length ? { failed } : {}),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, error: redactedMessage(e, redactToken) || 'Unknown error' },
      { status: 500 },
    );
  } finally {
    releaseLock();
  }
}
