'use client';

import { Button } from './Button';

type FilterOption = 'all' | 'running' | 'exited';

interface FilterBarProps {
  options: { value: FilterOption; label: string }[];
  active: FilterOption;
  onChange: (v: FilterOption) => void;
  counts?: Partial<Record<FilterOption, number>>;
}

export function FilterBar({ options, active, onChange, counts }: FilterBarProps) {
  return (
    <div className="ui-filter-bar">
      {options.map((opt) => {
        const count = counts?.[opt.value];
        const label = count !== undefined ? `${opt.label} (${count})` : opt.label;
        return (
          <Button
            key={opt.value}
            variant={active === opt.value ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => onChange(opt.value)}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}
