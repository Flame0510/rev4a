import TerminalClient from './TerminalClient';

export default async function TerminalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ name?: string | string[] }>;
}) {
  const { id } = await params;
  const { name } = await searchParams;
  // The agent's display name, passed by the containers list; only a label, never used to address the container.
  const displayName = (Array.isArray(name) ? name[0] : name)?.trim().slice(0, 80) || null;
  return <TerminalClient containerId={id} displayName={displayName} />;
}
