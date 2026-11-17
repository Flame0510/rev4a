'use client';

import { Button, Page, PageHeader, Pill, Surface } from '../components/ui';
import { CurrentSetup } from './CurrentSetup';
import { PresetPicker } from './PresetPicker';
import { ConfirmPresetModal } from './ConfirmPresetModal';
import { AgentsToRecreate } from './AgentsToRecreate';
import { useRemoteAccess } from './useRemoteAccess';

export default function RemoteAccessPageClient() {
  const data = useRemoteAccess();
  return <Page maxWidth={900}>
    <PageHeader title="Remote access" description="Choose how you reach Rev4a and its agents." />
    {data.error && <Surface tone="danger" compact><p role="alert" className="ui-text-small">{data.error}</p></Surface>}
    {data.message && <Surface compact><p role="status" className="ui-text-small">{data.message}</p></Surface>}
    <CurrentSetup data={data} />
    {(data.restartNeeded || data.pending || data.restartFrom !== null) && <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Pill tone="warning">Restart pending</Pill>
      <Button type="button" disabled={!!data.busy} loading={data.busy === 'restart'} onClick={data.restart}>{data.busy === 'restart' ? 'Restarting…' : 'Restart now'}</Button>
    </div>}
    <PresetPicker data={data} />
    <AgentsToRecreate data={data} />
    <ConfirmPresetModal data={data} />
  </Page>;
}
