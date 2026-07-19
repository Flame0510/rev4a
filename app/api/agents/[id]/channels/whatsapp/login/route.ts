import { NextResponse, type NextRequest } from 'next/server';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LOGIN_STATE_DIR = '/tmp/olympus-wa-login';

function statePath(agentId: string): string {
  return join(LOGIN_STATE_DIR, `${agentId}.json`);
}

function logPath(agentId: string): string {
  return join(LOGIN_STATE_DIR, `${agentId}.log`);
}

function findContainer(agentId: string): string | null {
  try {
    const out = execSync(
      `docker ps --filter "label=AGENT_ID=${agentId}" --format "{{.Names}}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

interface LoginState {
  status: 'idle' | 'running' | 'linked' | 'error' | 'expired';
  qr: string | null;           // raw ANSI QR code output
  startedAt: number | null;    // unix ms
  error: string | null;
  pid: number | null;
}

function readState(agentId: string): LoginState {
  try {
    const raw = readFileSync(statePath(agentId), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { status: 'idle', qr: null, startedAt: null, error: null, pid: null };
  }
}

function writeState(agentId: string, state: LoginState): void {
  writeFileSync(statePath(agentId), JSON.stringify(state), 'utf-8');
}

function escapeShell(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * POST /api/agents/[id]/channels/whatsapp/login
 * Start WhatsApp QR login in the agent container.
 * Returns the QR code output immediately.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const container = findContainer(id);

  if (!container) {
    return NextResponse.json({ error: 'Agent container not found' }, { status: 404 });
  }

  const current = readState(id);
  if (current.status === 'running') {
    // Already running — return current QR
    return NextResponse.json({ qr: current.qr, status: 'running' });
  }

  // Ensure state directory exists
  try { execSync(`mkdir -p ${escapeShell(LOGIN_STATE_DIR)}`); } catch { /* */ }

  // Start login in background via a shell script that writes output to a log file
  const logFile = logPath(id);
  const cmd = `docker exec ${escapeShell(container)} sh -c "openclaw channels login --channel whatsapp" > ${escapeShell(logFile)} 2>&1`;
  
  const child = spawn('docker', ['exec', container, 'sh', '-c', 'openclaw channels login --channel whatsapp'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Capture output to log file
  let logContent = '';
  child.stdout.on('data', (chunk: Buffer) => { logContent += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { logContent += chunk.toString(); });
  child.unref();

  // Write initial state
  writeState(id, {
    status: 'running',
    qr: null,
    startedAt: Date.now(),
    error: null,
    pid: child.pid ?? null,
  });

  // Wait a moment for QR to appear, then read captured output
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Write captured output to log file for GET polling
  try {
    writeFileSync(logFile, logContent, 'utf-8');
  } catch { /* */ }

  // Update state with QR
  const qr = logContent.trim() || null;
  writeState(id, {
    status: 'running',
    qr,
    startedAt: Date.now(),
    error: null,
    pid: child.pid ?? null,
  });

  return NextResponse.json({ qr, status: 'running' });
}

/**
 * GET /api/agents/[id]/channels/whatsapp/login
 * Check WhatsApp login status.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const state = readState(id);

  if (state.status === 'idle') {
    return NextResponse.json({ status: 'idle', qr: null });
  }

  // Check if the process is still running
  const logFile = logPath(id);
  let logContent = '';
  try {
    logContent = readFileSync(logFile, 'utf-8');
  } catch { /* */ }

  // Check for success indicators in the log
  const linked = logContent.includes('Linked') || logContent.includes('successfully linked');

  // Check for error indicators
  const hasError = logContent.includes('Error') || logContent.includes('failed') || logContent.includes('timeout');

  // Check if the log hasn't changed in a while (expired)
  const age = state.startedAt ? Date.now() - state.startedAt : 0;
  const expired = age > 120_000; // 2 minute timeout

  if (linked) {
    writeState(id, { ...state, status: 'linked' });
    return NextResponse.json({ status: 'linked', qr: null });
  }

  if (hasError) {
    writeState(id, { ...state, status: 'error', error: logContent });
    return NextResponse.json({ status: 'error', error: logContent, qr: state.qr });
  }

  if (expired) {
    writeState(id, { ...state, status: 'expired' });
    return NextResponse.json({ status: 'expired', qr: null });
  }

  return NextResponse.json({ status: 'running', qr: state.qr });
}

/**
 * DELETE /api/agents/[id]/channels/whatsapp/login
 * Cancel an in-progress login.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const state = readState(id);

  if (state.pid) {
    try { process.kill(state.pid); } catch { /* */ }
  }

  // Clean up state files
  try { unlinkSync(statePath(id)); } catch { /* */ }
  try { unlinkSync(logPath(id)); } catch { /* */ }

  return NextResponse.json({ success: true });
}
