/**
 * Browser access to one agent's Control UI.
 *
 *   GET     pending approvals and approved browsers
 *   POST    { action: "approve" | "reject", requestId }
 *   PATCH   { deviceId, name }            rename an approved browser
 *   DELETE  ?deviceId=<id>                revoke: the browser needs approval again
 *
 * All operations run the OpenClaw CLI inside the container asynchronously; see
 * `lib/agent-devices.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import {
  approveBrowser,
  cleanDeviceName,
  findAgentContainer,
  isDeviceId,
  isRequestId,
  listBrowserAccess,
  rejectBrowser,
  removeBrowser,
  renameBrowser,
  type AgentContainer,
} from '@/lib/agent-devices';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** The agent's container, or the response that explains why there is none to act on. */
async function resolveAgent(id: string): Promise<AgentContainer | NextResponse> {
  let agent: AgentContainer | null;
  try {
    agent = await findAgentContainer(id);
  } catch (e) {
    return NextResponse.json({ error: `Docker is unreachable: ${(e as Error).message}` }, { status: 503 });
  }
  if (!agent) return NextResponse.json({ error: `No agent '${id}'` }, { status: 404 });
  return agent;
}

const failed = (e: unknown) => NextResponse.json({ error: (e as Error).message || 'OpenClaw command failed' }, { status: 502 });

export async function GET(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  const agent = await resolveAgent(id);
  if (agent instanceof NextResponse) return agent;
  if (!agent.running) return NextResponse.json({ running: false, requiresApproval: null, pending: [], approved: [] });
  try {
    return NextResponse.json({ running: true, ...(await listBrowserAccess(agent.name)) });
  } catch (e) {
    return failed(e);
  }
}

async function runningAgent(id: string): Promise<AgentContainer | NextResponse> {
  const agent = await resolveAgent(id);
  if (agent instanceof NextResponse) return agent;
  if (!agent.running) return NextResponse.json({ error: 'The agent is not running' }, { status: 409 });
  return agent;
}

async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  const body = await readBody(request);
  if (!body || (body.action !== 'approve' && body.action !== 'reject')) {
    return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
  }
  if (!isRequestId(body.requestId)) return NextResponse.json({ error: 'A valid requestId is required' }, { status: 400 });

  const agent = await runningAgent(id);
  if (agent instanceof NextResponse) return agent;
  try {
    if (body.action === 'approve') await approveBrowser(agent.name, body.requestId);
    else await rejectBrowser(agent.name, body.requestId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  const body = await readBody(request);
  if (!body || !isDeviceId(body.deviceId)) return NextResponse.json({ error: 'A valid deviceId is required' }, { status: 400 });
  const name = cleanDeviceName(body.name);
  if (!name) return NextResponse.json({ error: 'name must be 1-64 printable characters' }, { status: 400 });

  const agent = await runningAgent(id);
  if (agent instanceof NextResponse) return agent;
  try {
    await renameBrowser(agent.name, body.deviceId, name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = await requireAuthJWT(request); if (denied) return denied as NextResponse;
  const { id } = await params;
  const deviceId = request.nextUrl.searchParams.get('deviceId');
  if (!isDeviceId(deviceId)) return NextResponse.json({ error: 'A valid deviceId query parameter is required' }, { status: 400 });

  const agent = await runningAgent(id);
  if (agent instanceof NextResponse) return agent;
  try {
    await removeBrowser(agent.name, deviceId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}
