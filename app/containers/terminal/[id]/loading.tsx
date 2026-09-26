import { Skeleton } from '../../../components/Skeleton';

/**
 * The terminal while the route loads: its own full-screen frame (the `terminal-page`
 * bar and dark screen), not the Containers list's rows — the page is a terminal, and it
 * already shows "Connecting…" itself once it renders.
 */
export default function TerminalLoading() {
  return (
    <div className="terminal-page" aria-busy="true">
      <div className="terminal-page__bar">
        <div className="terminal-page__title">
          <span className="ui-kicker ui-kicker--accent">Terminal</span>
          <Skeleton width={120} height={12} />
        </div>
      </div>
      <div className="terminal-page__screen" />
    </div>
  );
}
