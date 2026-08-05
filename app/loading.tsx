import Rev4aLoader from './components/Rev4aLoader';

export default function Loading() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: '100vh',
        background: 'radial-gradient(circle at center, rgba(167,139,250,0.10), transparent 34%), var(--bg)',
      }}
    >
      <Rev4aLoader label="LOADING SECTION" fullHeight />
    </div>
  );
}
