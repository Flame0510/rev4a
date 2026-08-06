import { Skeleton, TreeSkeleton, CodeSkeleton } from '../components/Skeleton';

export default function WorkspaceLoading() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ fontFamily: 'var(--font-serif-stack)', fontSize: 20, letterSpacing: '4px', color: 'var(--violet)' }}>WORKSPACE</div>
        <Skeleton width={160} height={24} accent variant="block" />
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Sidebar tree skeleton */}
        <div style={{ width: 280, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <TreeSkeleton rows={16} />
        </div>

        {/* Resize handle */}
        <div style={{ width: 4, flexShrink: 0 }} />

        {/* Editor skeleton */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* File meta bar */}
          <div style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, background: 'var(--bg2)' }}>
            <Skeleton width="50%" height={12} accent />
            <Skeleton width={32} height={12} />
            <Skeleton width={40} height={12} />
            <Skeleton width={60} height={12} />
          </div>
          <CodeSkeleton lines={18} />
        </div>
      </div>
    </div>
  );
}
