import type { ReactNode } from 'react';

export type View = 'landing' | 'trade' | 'desk';

export const viewFromHash = (): View => (location.hash === '#trade' ? 'trade' : location.hash === '#desk' ? 'desk' : 'landing');

/** "{ bracket }" with blinking braces. */
export function Wordmark({ href = '#', className = '' }: { href?: string; className?: string }) {
  return (
    <a className={`wordmark ${className}`} href={href} aria-label="Bracket home">
      <span className="brace" aria-hidden="true">{'{'}</span>
      <span className="name">bracket</span>
      <span className="brace" aria-hidden="true">{'}'}</span>
    </a>
  );
}

export function TopNav({ active, right }: { active: View; right?: ReactNode }) {
  return (
    <header className="top">
      <Wordmark />
      <nav className="nav" aria-label="Sections">
        <a className={active === 'trade' ? 'on' : ''} href="#trade">Trade</a>
        <a className={active === 'desk' ? 'on' : ''} href="#desk" title="The house's book, shadow hedges and hedge-cost research">Desk</a>
      </nav>
      <div className="right">{right}</div>
    </header>
  );
}
