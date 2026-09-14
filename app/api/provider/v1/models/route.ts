/**
 * Rev4a Provider Gateway — v1 Models List
 *
 * GET /api/provider/v1/models
 *
 * Returns the models available through the Rev4a Gateway, in OpenAI-compatible
 * format. This is the endpoint agent containers call to discover what they can
 * ask for, so it must agree with what `gateway/sync.ts` writes into their config.
 *
 * It did not. This route used to carry its own copy of the catalogue and its own
 * loader, and the two diverged in ways that mattered:
 *
 *  - **User toggles were ignored here.** Disabling a model from the Gateway page
 *    writes to `model-overrides.json`, which `loadModelsConfig()` applies. This
 *    route read `models.config.json` raw, so a model switched off in the UI was
 *    still advertised to agents.
 *  - **A read failure overwrote the catalogue.** If the file was missing or
 *    momentarily unparseable, the `catch` wrote a hardcoded 30-model default over
 *    it — replacing the real catalogue, user overrides included.
 *
 * Both are gone: the catalogue now comes from `lib/model-catalogue`, the single
 * loader shared with the create route, the provider page and the sync.
 */
import { NextResponse, NextRequest } from 'next/server';
import { isGatewayClient } from '@/app/api/provider/auth';
import { loadOfferedModels } from '@/lib/model-catalogue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (!isGatewayClient(request)) {
    // An empty list rather than a 401: this endpoint should not confirm the
    // catalogue to a caller that cannot use it. The cost is that a container
    // configured with the wrong key sees "no models" instead of an auth error.
    return NextResponse.json({
      object: 'list',
      total: 0,
      data: [],
    });
  }

  // Same set as gateway/sync.ts writes into the containers, so what an agent can
  // discover matches what it was actually given. This route used to skip the
  // provider-key half of that test and advertise models nobody could be billed for.
  const activeModels = loadOfferedModels();

  return NextResponse.json({
    object: 'list',
    total: activeModels.length,
    data: activeModels.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.provider,
      permission: [],
      root: m.id,
    })),
  });
}
