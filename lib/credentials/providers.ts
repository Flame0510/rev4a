export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
  hint?: string;
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
        hint: 'Requires repo, read:org scopes at minimum',
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
      { key: 'apiKey', label: 'API Key', placeholder: 'd3c4a0fee...', type: 'password' },
      { key: 'token', label: 'Token', placeholder: 'ATTA...', type: 'password', hint: 'Click "Generate Trello Token" below to authorize' },
    ],
    deliveryMethod: 'writes ~/.trello-cli/default/config.json',
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
        hint: 'Create in Vercel Settings → Tokens',
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
        hint: 'Supabase CLI personal access token. Create at supabase.com/dashboard/account/tokens. Grants access to all your projects for migrations, edge functions, and database management.',
      },
    ],
    deliveryMethod: 'supabase login --token *** --no-browser',
    docsUrl: 'https://supabase.com/dashboard/account/tokens',
  },
];

export function getProvider(id: string): CredentialProviderDef | undefined {
  return CREDENTIAL_PROVIDERS.find((p) => p.id === id);
}
