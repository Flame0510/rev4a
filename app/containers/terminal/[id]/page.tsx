import TerminalClient from './TerminalClient';

export default async function TerminalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TerminalClient containerId={id} />;
}
