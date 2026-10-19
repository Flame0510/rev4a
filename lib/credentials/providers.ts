export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
  hint?: string;
  /**
   * Where this specific value is created. Rendered as a link next to the field
   * in the add/edit modal. The provider-level `docsUrl` sits on the card
   * outside the modal, so without this the form itself offers no way out to go
   * and fetch the value it is asking for.
   */
  docsUrl?: string;
  /** Link text, minus the trailing arrow the UI adds. Defaults to `docs`. */
  docsLabel?: string;
}

export interface CredentialProviderDef {
  id: string;
  label: string;
  category: 'vcs' | 'pm' | 'cloud' | 'db';
  description: string;
  authType: 'static-token' | 'api-key-pair';
  fields: CredentialField[];
  deliveryMethod: string;
  docsUrl?: string;
  /** A short note shown on the provider card (what the user must know before using it). */
  note?: string;
  /** A short note shown next to an agent's switch while this provider is being switched on. */
  switchOnNote?: string;
}

const MONGODB_READ_ONLY_NOTE =
  'Use a database user with the built-in read role: read-only depends on that role, not on Rev4a.';

export const CREDENTIAL_PROVIDERS: CredentialProviderDef[] = [
  {
    id: 'github-pat',
    label: 'GitHub',
    category: 'vcs',
    description: 'Personal Access Token for GitHub API and git operations',
    authType: 'static-token',
    fields: [
      {
        key: 'token',
        label: 'Personal Access Token',
        placeholder: 'ghp_...',
        type: 'password',
        hint: 'Requires repo, read:org scopes at minimum.',
        docsUrl: 'https://github.com/settings/tokens',
        docsLabel: 'Create token',
      },
    ],
    deliveryMethod: 'OpenClaw managed GitHub identity (the PAT) + github skill',
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'trello',
    label: 'Trello',
    category: 'pm',
    description: 'API Key and Token for Trello board access',
    authType: 'api-key-pair',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        placeholder: 'd3c4a0fee...',
        type: 'password',
        hint: 'Create a Power-Up, then copy its API key.',
        docsUrl: 'https://trello.com/power-ups/admin',
        docsLabel: 'Create API key',
      },
      {
        key: 'token',
        label: 'Token',
        placeholder: 'ATTA...',
        type: 'password',
        hint: 'Authorize Rev4a with the button below, then paste the token Trello returns.',
      },
    ],
    deliveryMethod: 'env TRELLO_API_KEY, TRELLO_TOKEN + trello skill',
    docsUrl: 'https://trello.com/power-ups/admin',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    category: 'cloud',
    description: 'Access Token for Vercel deployments and project management',
    authType: 'static-token',
    fields: [
      {
        key: 'token',
        label: 'Access Token',
        placeholder: 'vcp_...',
        type: 'password',
        hint: 'Create in Vercel Settings → Tokens.',
        docsUrl: 'https://vercel.com/account/tokens',
        docsLabel: 'Create token',
      },
    ],
    deliveryMethod: "the Vercel CLI's own auth.json and config.json",
    docsUrl: 'https://vercel.com/account/tokens',
  },
  {
    id: 'supabase',
    label: 'Supabase',
    category: 'db',
    description: 'Access token for Supabase CLI — grants access to all projects on your account',
    authType: 'static-token',
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        placeholder: 'sbp_...',
        type: 'password',
        hint: 'Grants access to every project on the account — migrations, edge functions, database management.',
        docsUrl: 'https://supabase.com/dashboard/account/tokens',
        docsLabel: 'Create token',
      },
    ],
    deliveryMethod: 'env SUPABASE_ACCESS_TOKEN',
    docsUrl: 'https://supabase.com/dashboard/account/tokens',
  },
  {
    id: 'notion',
    label: 'Notion',
    category: 'pm',
    description: 'API Token for Notion integration — enables the agent to read/write pages, databases, and blocks',
    authType: 'static-token',
    fields: [
      {
        key: 'token',
        label: 'API Token (Internal Integration)',
        placeholder: 'ntn_... or secret_...',
        type: 'password',
        hint: 'Grant Read + Insert + Update capabilities.',
        docsUrl: 'https://www.notion.so/my-integrations',
        docsLabel: 'Create integration',
      },
    ],
    deliveryMethod: 'env NOTION_API_TOKEN + notion skill',
    docsUrl: 'https://www.notion.so/my-integrations',
  },
  {
    id: 'mongodb',
    label: 'MongoDB',
    category: 'db',
    description: 'Connection string for a MongoDB database — the agent queries it through mongosh, and writes are refused when the database user only has the read role',
    authType: 'static-token',
    fields: [
      {
        key: 'uri',
        label: 'Connection string',
        placeholder: 'mongodb+srv://reader:…@cluster0.example.mongodb.net/mydb',
        type: 'password',
        hint: MONGODB_READ_ONLY_NOTE,
        docsUrl: 'https://www.mongodb.com/docs/manual/reference/connection-string/',
        docsLabel: 'Connection string format',
      },
    ],
    deliveryMethod: 'env REV4A_MONGODB_URI + rev4a-mongodb skill (mongosh)',
    docsUrl: 'https://www.mongodb.com/docs/manual/reference/connection-string/',
    note: MONGODB_READ_ONLY_NOTE,
    switchOnNote: 'The first switch-on installs mongosh (about 200 MB); it can take a few minutes.',
  },
];

/** Checks on a field's value, run when a credential is saved. Return an error text, or null when the value is fine. */
const FIELD_VALIDATORS: Record<string, Record<string, (value: string) => string | null>> = {
  mongodb: {
    uri: (v) => (/^mongodb(\+srv)?:\/\//.test(v) ? null : 'The connection string must start with mongodb:// or mongodb+srv://'),
  },
};

/**
 * The first problem with a secret about to be saved, or null. Values are checked trimmed (they
 * are delivered trimmed). `partial` is for an edit, where a blank field means "keep the stored
 * one" and is not checked; on a new credential a blank checked field is an error.
 */
export function validateSecret(providerId: string, secret: Record<string, string>, partial = false): string | null {
  const validators = FIELD_VALIDATORS[providerId];
  if (!validators) return null;
  const provider = getProvider(providerId);
  for (const [key, check] of Object.entries(validators)) {
    const raw: unknown = secret?.[key];
    // A number, object or null from a request body is a bad value, never a throw.
    if (raw !== undefined && typeof raw !== 'string') {
      if (raw === null && partial) continue;
      return check('') ?? 'Invalid value';
    }
    const value = (raw ?? '').trim();
    if (!value) {
      if (partial) continue;
      return `${provider?.fields.find((f) => f.key === key)?.label ?? key} is required`;
    }
    const problem = check(value);
    if (problem) return problem;
  }
  return null;
}

export function getProvider(id: string): CredentialProviderDef | undefined {
  return CREDENTIAL_PROVIDERS.find((p) => p.id === id);
}
