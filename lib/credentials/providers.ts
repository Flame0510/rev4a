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
}

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
    deliveryMethod: 'gh auth login --with-token',
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
    deliveryMethod: 'writes ~/.config/trello/config.json',
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
    deliveryMethod: 'writes ~/.local/share/com.vercel.cli/auth.json',
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
    deliveryMethod: 'supabase login --token *** --no-browser',
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
    deliveryMethod: 'writes ~/.config/notion/config.json',
    docsUrl: 'https://www.notion.so/my-integrations',
  },
];

export function getProvider(id: string): CredentialProviderDef | undefined {
  return CREDENTIAL_PROVIDERS.find((p) => p.id === id);
}
