'use client';

import { GlobeIcon, MonitorIcon, ShieldIcon } from '../components/Icons';
import { Pill, TemplateOption } from '../components/ui';
import type { AccessPreset } from '@/lib/remote-access';

const ICONS = { local: MonitorIcon, direct: GlobeIcon, domain: ShieldIcon };

/** Shared visual option for the access page and the wizard's deferred choices. */
export function PresetOption({ preset, id, description, selected, current = false, disabled, disabledReason, onClick }: {
  preset: AccessPreset; id: string; description: string; selected: boolean; current?: boolean;
  disabled?: boolean; disabledReason?: string; onClick: () => void;
}) {
  const Icon = ICONS[preset];
  return <TemplateOption id={id} description={description} selected={selected}
    avatarVariant="icon" icon={<Icon size={20} aria-hidden="true" />} badge={current ? <Pill tone="accent">Current</Pill> : undefined}
    current={current} disabled={disabled || current} disabledReason={disabledReason} onClick={onClick} />;
}
