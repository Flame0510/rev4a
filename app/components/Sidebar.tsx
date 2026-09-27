'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import MobileBottomNav from './MobileBottomNav';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  {
    href: '/',
    label: 'Dashboard',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },

  {
    href: '/lineage?active=1&cron=0&period=1d',
    label: 'Lineage',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.7 5.2 7.1 10M10.3 5.2 8.9 10M6 4h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/agents',
    label: 'Agents',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/containers',
    label: 'Containers',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    href: '/costs',
    label: 'Costs',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10 5.8C9.6 5.3 8.9 5 8 5c-1.2 0-2 .6-2 1.5S6.8 7.8 8 8s2 .6 2 1.5S9.2 11 8 11c-.9 0-1.6-.3-2-.8M8 3.8V5M8 11v1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/system',
    label: 'System',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="2.5" width="13" height="11" stroke="currentColor" strokeWidth="1.3" />
        <path d="M4 10.5l2.5-3 2 2 3.5-4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/workspace',
    label: 'Workspace',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M1.75 4.5a1.75 1.75 0 0 1 1.75-1.75h2.35l1.2 1.5h5.45a1.75 1.75 0 0 1 1.75 1.75v5.5a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75v-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
        <path d="M1.75 6h12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    href: '/gateway',
    label: 'Gateway',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 4.5h4.5M8.5 4.5H13M5.25 4.5a1.75 1.75 0 1 0 0 .01ZM10.75 4.5a1.75 1.75 0 1 0 0 .01ZM3 11.5h2.5M5.5 11.5H13M7.25 11.5a1.75 1.75 0 1 0 0 .01Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    href: '/crons',
    label: 'Crons',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.5V8l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/config',
    label: 'Config',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/plugins',
    label: 'Plugins',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M6.2 1.8v3.1H3.1a1.2 1.2 0 0 0 0 2.4h3.1v3.1a1.2 1.2 0 0 0 2.4 0V7.3h3.1a1.2 1.2 0 0 0 0-2.4H8.6V1.8a1.2 1.2 0 1 0-2.4 0Z" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
  },
  {
    href: '/skills',
    label: 'Skills',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 2.5h7.5a2 2 0 0 1 2 2V13l-3-1.5L6.5 13V4.5a2 2 0 0 0-2-2Z" stroke="currentColor" strokeWidth="1.2"/>
        <path d="M3 2.5h7.5" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
  },
  {
    href: '/credentials',
    label: 'Credentials',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="6" width="13" height="8.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 6V4.5a3 3 0 0 1 6 0V6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="8" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M8 11.5v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: '/tools',
    label: 'Tools',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10.5 2a3.5 3.5 0 0 1 0 7 3.5 3.5 0 0 1-3.36-2.5H2v-1h5.14A3.5 3.5 0 0 1 10.5 2Zm0 1.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" fill="currentColor"/>
        <path d="M2 10.5h5.14a3.5 3.5 0 1 0 0-1H2v1Z" fill="none" stroke="currentColor" strokeWidth="1.2"/>
        <circle cx="10.5" cy="5.5" r="2" stroke="currentColor" strokeWidth="1.2" fill="none"/>
        <path d="M2 10.5h4.5M2 13h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <circle cx="11" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
        <path d="M11 10.5v1.5l1 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    href: '/memory',
    label: 'Memory / Context',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v11.5a.5.5 0 0 1-.8.4L9.5 12 6.8 13.9a.5.5 0 0 1-.8-.4V4.5A1.5 1.5 0 0 0 4.5 3H13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M4.5 2C3.67 2 3 2.67 3 3.5S3.67 5 4.5 5H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <path d="M8 5.5h3M8 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    href: '/wizard',
    label: 'Wizard',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z" />
      </svg>
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ocVersion, setOcVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/version')
      .then((r) => r.json())
      .then((d) => setOcVersion(d.version))
      .catch(() => {});
  }, []);

  const isActive = (href: string) => {
    const targetPath = href.split('?')[0] || '/';
    return targetPath === '/' ? pathname === '/' : pathname.startsWith(targetPath);
  };

  const handleLogout = async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) {
        router.push('/login');
      }
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  const navItems = (
    <nav className="sidebar__nav">
      {NAV.map(({ href, label, icon }) => (
        <Link
          key={href}
          href={href}
          className={`sidebar__item${isActive(href) ? ' sidebar__item--active' : ''}`}
          onClick={() => setMobileOpen(false)}
          onMouseEnter={() => router.prefetch(href)}
          prefetch={true}
        >
          <span className="sidebar__icon">{icon}</span>
          <span className="sidebar__label">{label}</span>
        </Link>
      ))}
    </nav>
  );

  const EyeLogo = () => (
    <img src="/rev4a-logo.svg" alt="Rev4a" width="20" height="20" style={{ display: 'block', objectFit: 'contain' }} />
  );

  return (
    <>
      {/* Mobile top bar */}
      <header className={`mobile-topbar${mobileOpen ? ' mobile-topbar--open' : ''}`}>
        <div className="mobile-topbar__row">
          <div className="mobile-topbar__brand">
            <EyeLogo />
            <span>REV4A</span>
          </div>
          <button
            className="mobile-topbar__menu"
            aria-label={mobileOpen ? 'Close menu' : 'Menu'}
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M3 5h14M3 10h14M3 15h14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
        {/* Drawer — grows below the top bar row */}
        <div className="mobile-drawer__wrapper" aria-hidden={!mobileOpen}>
          <nav className="mobile-drawer">
            {navItems}
          </nav>
        </div>
      </header>

      {/* Backdrop */}
      {mobileOpen && (
        <div className="mobile-drawer__backdrop" onClick={() => setMobileOpen(false)} />
      )}

      <aside className="sidebar sidebar--desktop">
        <div className="sidebar__logo">
          <EyeLogo />
          <span className="sidebar__title">REV4A</span>
        </div>
        {navItems}
        <div className="sidebar__bottom">
          <button
            onClick={handleLogout}
            className="sidebar__item sidebar__item--logout"
          >
            <span className="sidebar__icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 3h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2M6 12l-4-4 4-4M2 8h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            <span className="sidebar__label">Logout</span>
          </button>
          <div className="sidebar__footer">
            {ocVersion || ''}
          </div>
        </div>
      </aside>

      <MobileBottomNav />
    </>
  );
}
