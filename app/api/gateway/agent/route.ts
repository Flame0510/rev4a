/**
 * PUT /api/gateway/agent
 *
 * Update the model configuration for an agent container.
 * Uses base64-safe write — no heredoc shell escaping issues.
 *
 * Body:
 *   { "containerName": "openclaw-atlas", "model": "rev4a/deepseek-flash", "fallbacks": ["rev4a/deepseek-v4-pro"] }
 *
 * A reference marked `subscription:openai/<id>` is a ChatGPT subscription model and one marked
 * `subscription:anthropic/<id>` is a Claude subscription model; both are stored as the bare
 * `<provider>/<id>`. The route answers 409 when the agent has no sign-in for the provider named.
 * `onlyIfUnset: true` sets a first model without replacing a primary selected by another writer.
 */
import { NextRequest, NextResponse } from 'next/server';
import { agentBusyReason } from '@/lib/agent-busy';
import { execSync } from 'child_process';
import { withAgentConfigLock } from '@/lib/agent-config-lock';
import { requireAuthJWT } from '@/lib/rev4a-auth';
import { readFastStatus, statusReadFailedMessage, SubscriptionError, UNSUPPORTED_AGENT_MESSAGE } from '@/lib/subscriptions';
import { readClaudeAgent } from '@/lib/subscription-claude';
import { normalizeModel, type AgentModelRef } from '@/lib/subscriptions-parse';

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
 * A subscription model is stored as a bare `<provider>/<id>` (lib/subscriptions.ts), while the
 * Rev4a catalogue also has ids that start with `openai/` or `anthropic/` and are stored as
 * `rev4a/<provider>/<id>`. The model panel marks a subscription reference with this prefix so
 * the two cannot be confused.
 */
const SUBSCRIPTION_MARK = 'subscription:';

/**
 * A marked subscription reference is accepted only in the exact shape of a ChatGPT or Claude model
 * id: it starts with a letter, digit, underscore or hyphen (so `.`, `..` and `.x` are refused) and
 * then continues with those plus `.` and `-`.
 */
const SUBSCRIPTION_REF = /^subscription:(?:openai|anthropic)\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Keep a stored reference as it is when it is already a bare subscription model or a Rev4a id;
 * anything else belongs to the Rev4a catalogue and gets the prefix. This mirrors keepStoredRef
 * in lib/subscriptions-parse.js and adds the bare `anthropic/<id>` case.
 */
function keepStoredSubscriptionRef(id: string): string {
  if (id.startsWith('openai/') || id.startsWith('anthropic/') || id.startsWith('rev4a/')) return id;
  return `rev4a/${id}`;
}

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
    // Stored refs: a bare `openai/<id>` or `anthropic/<id>` is a subscription model and must not
    // gain the `rev4a/` prefix.
    if (Array.isArray(f)) return f.filter((x): x is string => typeof x === 'string').map(keepStoredSubscriptionRef);
  }
  return [];
}

async function subscriptionSignInError(refs: string[], safeContainer: string, agentId: string): Promise<NextResponse | undefined> {
  // A ChatGPT subscription model needs a ChatGPT sign-in on this agent: without one the next turn fails.
  if (refs.some((r) => typeof r === 'string' && r.startsWith('subscription:openai/'))) {
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

  // A Claude subscription model needs Claude Code signed in with a Claude plan on this agent.
  if (refs.some((r) => typeof r === 'string' && r.startsWith('subscription:anthropic/'))) {
    const notConnected = NextResponse.json({ status: 'error', error: 'This agent is not connected to a Claude subscription.' }, { status: 409 });
    if (!agentId) return notConnected;
    try {
      const claude = await readClaudeAgent(agentId);
      // `readClaudeAgent` reports a failed read as a row carrying `error`, not as an exception.
      if (claude.error === UNSUPPORTED_AGENT_MESSAGE) {
        return NextResponse.json({ status: 'error', error: UNSUPPORTED_AGENT_MESSAGE }, { status: 409 });
      }
      // Any other error (an unreadable status or configuration, an API account) is not "not connected".
      if (claude.error) return NextResponse.json({ status: 'error', error: claude.error }, { status: 503 });
      if (claude.claude.state !== 'connected') return notConnected;
    } catch (e) {
      // It still throws for an invalid or unknown agent (a SubscriptionError 503 is passed on).
      if (e instanceof SubscriptionError && e.status === 503) {
        return NextResponse.json({ status: 'error', error: e.message }, { status: 503 });
      }
      // No usable Claude sign-in to store a model for.
      return notConnected;
    }
  }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuthJWT(request); if (denied) return denied as any;
  try {
    const body: { containerName?: string; model?: string; fallbacks?: string[]; onlyIfUnset?: boolean } = await request.json();
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
    let agentId = '';
    try {
      agentId = execSync(
        `docker inspect --format '{{index .Config.Labels "AGENT_ID"}}' ${safeContainer}`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (agentId) {
        const busy = await agentBusyReason(agentId);
        if (busy) return NextResponse.json({ status: 'error', error: busy }, { status: 409 });
      }
    } catch { /* no container or no label: the rest of the route reports it */ }

    const onlyIfUnset = body.onlyIfUnset === true;
    // Read sign-in outside the config lock. In setup, an existing primary takes precedence.
    const signInError = await subscriptionSignInError(refs, safeContainer, agentId);
    if (!onlyIfUnset && signInError) return signInError;

    const requestedModel = body.model; // narrowed above; the closure below would lose that
    // Read, change and write openclaw.json under the agent's config lock: a patch or
    // another rewrite landing between the read and the write would be lost, or tear the file.
    const locked = await withAgentConfigLock(safeContainer, async () => {
      // Read current config
      const raw = readFileFromContainer(safeContainer, '/root/.openclaw/openclaw.json');
      if (!raw) {
        return signInError ?? NextResponse.json({ status: 'error', error: 'Failed to read config from container (empty)' }, { status: 500 });
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

      // Check and write under the same lock so a concurrent save cannot be overwritten.
      const agents = (config.agents || {}) as Record<string, unknown>;
      const defaults = (agents.defaults || {}) as Record<string, unknown>;
      if (onlyIfUnset && normalizeModel(defaults.model as AgentModelRef).primary) {
        return NextResponse.json({
          status: 'error',
          code: 'model-already-set',
          error: 'This agent already has a model.',
        }, { status: 409 });
      }

      if (signInError) return signInError;

      // Update model config
      const list = (agents.list || []) as Record<string, unknown>[];

      const mainAgent = list.find((a) => a.id === 'main');
      if (mainAgent) {
        const primary = ensureRev4aPrefix(requestedModel);
        let fallbacks = dedupe(body.fallbacks ? ensureRev4aPrefixes(body.fallbacks) : existingFallbacks(mainAgent.model));
        // The primary never doubles as its own fallback.
        fallbacks = fallbacks.filter((fb) => fb !== primary);
        mainAgent.model = {
          primary,
          fallbacks,
        };
      }

      {
        const primary = ensureRev4aPrefix(requestedModel);
        let fallbacks = dedupe(body.fallbacks ? ensureRev4aPrefixes(body.fallbacks) : existingFallbacks(defaults.model));
        fallbacks = fallbacks.filter((fb) => fb !== primary);
        defaults.model = {
          primary,
          fallbacks,
        };
      }
      agents.defaults = defaults;
      config.agents = agents;

      // Write back
      const newConfig = JSON.stringify(config, null, 2);
      execSync(
        `docker exec -i ${safeContainer} sh -c 'cat > /root/.openclaw/openclaw.json'`,
        { timeout: 15000, maxBuffer: 1024 * 1024, input: newConfig },
      );

      return { defaults };
    });
    if (locked instanceof NextResponse) return locked;
    const { defaults } = locked;
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
