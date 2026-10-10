/**
 * PUT /api/gateway/agent
 *
 * Update the model configuration for an agent container.
 * Uses base64-safe write — no heredoc shell escaping issues.
 *
 * Body:
 *   { "containerName": "openclaw-atlas", "model": "rev4a/deepseek-flash", "fallbacks": ["rev4a/deepseek-v4-pro"] }
 *
 * A reference marked `subscription:openai/<id>` is a ChatGPT subscription model, stored as the
 * bare `openai/<id>`; the route answers 409 when the agent has no ChatGPT sign-in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { agentBusyReason } from '@/lib/agent-busy';
import { execSync } from 'child_process';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { readFastStatus, statusReadFailedMessage, UNSUPPORTED_AGENT_MESSAGE } from '@/lib/subscriptions';
import { keepStoredRef } from '@/lib/subscriptions-parse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function execInContainer(container: string, cmd: string, timeout = 15000): string {
  try {
    return execSync(
      `docker exec ${container} sh -c ${JSON.stringify(cmd)}`,
      { timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8' },
    ).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr || err.message || `Failed to exec in ${container}`);
  }
}

/**
 * A ChatGPT subscription model is stored as a bare `openai/<id>` (lib/subscriptions.ts), while the
 * Rev4a catalogue also has ids that start with `openai/` and are stored as `rev4a/openai/<id>`. The
 * model panel marks a subscription reference with this prefix so the two cannot be confused.
 */
const SUBSCRIPTION_MARK = 'subscription:';

/** A marked subscription reference is accepted only in the exact shape of a ChatGPT model id. */
const SUBSCRIPTION_REF = /^subscription:openai\/[A-Za-z0-9._-]+$/;

function ensureRev4aPrefix(id: string): string {
  if (id.startsWith(SUBSCRIPTION_MARK)) return id.slice(SUBSCRIPTION_MARK.length);
  return id.startsWith('rev4a/') ? id : `rev4a/${id}`;
}

function ensureRev4aPrefixes(ids: string[]): string[] {
  return ids.map(ensureRev4aPrefix);
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Write content to a file inside a container. */
function writeFileToContainer(container: string, remotePath: string, content: string): void {
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  execSync(
    `docker exec ${container} sh -c "echo '${b64}' | base64 -d > ${remotePath}"`,
    { timeout: 15000, maxBuffer: 128 * 1024 },
  );
}

/** Read file content from container (stderr goes to /dev/null). */
function readFileFromContainer(container: string, remotePath: string): string {
  try {
    return execInContainer(container, `cat ${remotePath} 2>/dev/null`);
  } catch {
    return '';
  }
}

/**
 * Fallbacks already on a model entry, for a request that did not send any.
 *
 * `fallbacks` omitted and `fallbacks: []` are different requests. The first means
 * "leave them alone", the second "clear them". This route used to treat both as
 * `[]`, so any caller that sent only `model` silently erased the list.
 */
function existingFallbacks(model: unknown): string[] {
  if (model && typeof model === 'object') {
    const f = (model as { fallbacks?: unknown }).fallbacks;
    // Stored refs: a bare `openai/<id>` is a subscription model and must not gain the `rev4a/` prefix.
    if (Array.isArray(f)) return f.filter((x): x is string => typeof x === 'string').map(keepStoredRef);
  }
  return [];
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const body: { containerName?: string; model?: string; fallbacks?: string[] } = await request.json();
    const { containerName } = body;

    if (!containerName) {
      return NextResponse.json({ status: 'error', error: 'containerName is required' }, { status: 400 });
    }

    const safeContainer = containerName.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (safeContainer !== containerName) {
      return NextResponse.json({ status: 'error', error: 'Invalid container name' }, { status: 400 });
    }

    if (!body.model) {
      return NextResponse.json({ status: 'error', error: 'model is required' }, { status: 400 });
    }
    const refs = [body.model, ...(Array.isArray(body.fallbacks) ? body.fallbacks : [])];
    if (refs.some((r) => typeof r === 'string' && r.startsWith(SUBSCRIPTION_MARK) && !SUBSCRIPTION_REF.test(r))) {
      return NextResponse.json({ status: 'error', error: 'Invalid subscription model reference' }, { status: 400 });
    }

    // Refuse while a long operation is running on this agent: the write would race the
    // recreate/migration that is replacing the container underneath it.
    try {
      const agentId = execSync(
        `docker inspect --format '{{index .Config.Labels "AGENT_ID"}}' ${safeContainer}`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (agentId) {
        const busy = await agentBusyReason(agentId);
        if (busy) return NextResponse.json({ status: 'error', error: busy }, { status: 409 });
      }
    } catch { /* no container or no label: the rest of the route reports it */ }

    // A subscription model needs a ChatGPT sign-in on this agent: without one the next turn fails.
    if (refs.some((r) => typeof r === 'string' && r.startsWith(SUBSCRIPTION_MARK))) {
      const read = await readFastStatus(safeContainer);
      if (read.status === 'failed') {
        return NextResponse.json({ status: 'error', error: statusReadFailedMessage(read.reason) }, { status: 503 });
      }
      if (read.status === 'unsupported') {
        return NextResponse.json({ status: 'error', error: UNSUPPORTED_AGENT_MESSAGE }, { status: 409 });
      }
      if (read.state.profiles.length === 0) {
        return NextResponse.json({ status: 'error', error: 'This agent is not connected to a ChatGPT subscription.' }, { status: 409 });
      }
    }

    // Read current config
    const raw = readFileFromContainer(safeContainer, '/root/.openclaw/openclaw.json');
    if (!raw) {
      return NextResponse.json({ status: 'error', error: 'Failed to read config from container (empty)' }, { status: 500 });
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw);
    } catch (e) {
      return NextResponse.json({
        status: 'error',
        error: 'Failed to parse config from container',
        detail: raw.slice(0, 200),
      }, { status: 500 });
    }

    // Update model config
    const agents = (config.agents || {}) as Record<string, unknown>;
    const list = (agents.list || []) as Record<string, unknown>[];

    const mainAgent = list.find((a) => a.id === 'main');
    if (mainAgent) {
      const primary = ensureRev4aPrefix(body.model);
      let fallbacks = dedupe(body.fallbacks ? ensureRev4aPrefixes(body.fallbacks) : existingFallbacks(mainAgent.model));
      // The primary never doubles as its own fallback.
      fallbacks = fallbacks.filter((fb) => fb !== primary);
      mainAgent.model = {
        primary,
        fallbacks,
      };
    }

    const defaults = (agents.defaults || {}) as Record<string, unknown>;
    {
      const primary = ensureRev4aPrefix(body.model);
      let fallbacks = dedupe(body.fallbacks ? ensureRev4aPrefixes(body.fallbacks) : existingFallbacks(defaults.model));
      fallbacks = fallbacks.filter((fb) => fb !== primary);
      defaults.model = {
        primary,
        fallbacks,
      };
    }

    // Write back
    const newConfig = JSON.stringify(config, null, 2);
    execSync(
      `docker exec -i ${safeContainer} sh -c 'cat > /root/.openclaw/openclaw.json'`,
      { timeout: 15000, maxBuffer: 1024 * 1024, input: newConfig },
    );

    // No gateway restart: the Gateway watches openclaw.json and hot-applies this.
    // Confirmed against a live agent by writing the file exactly the way this
    // route does — the container logged:
    //   [reload] config change detected; evaluating reload (agents.defaults.model.primary)
    //   [reload] config hot reload applied (agents.defaults.model.primary)
    // OpenClaw's docs put `agents` in the no-restart column, and gateway.reload
    // defaults to `hybrid`, which restarts on its own for the sections that do
    // need it. The restart here cost ~7.5s of fully blocked event loop.

    // Verify
    const verifyRaw = readFileFromContainer(safeContainer, '/root/.openclaw/openclaw.json');
    const verifyOk = verifyRaw.includes('"primary"');
    const verifyBytes = verifyRaw.length;

    return NextResponse.json({
      status: 'ok',
      agent: safeContainer,
      model: {
        // Report what was written, not what was asked: both prefixed, and the
        // fallbacks as preserved or replaced.
        primary: (defaults.model as { primary: string }).primary,
        fallbacks: (defaults.model as { fallbacks: string[] }).fallbacks,
      },
      verify: { ok: verifyOk, bytes: verifyBytes },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: 'error', error: message }, { status: 500 });
  }
}
