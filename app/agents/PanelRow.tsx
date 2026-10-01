/** One label/value row of an agent-panel section (COSTS and RESOURCES): the label dim on the left, the value right. */
export function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}
