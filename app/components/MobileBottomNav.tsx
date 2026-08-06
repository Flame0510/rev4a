'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  {
    label: 'Home',
    path: '/',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l6-7 6 7v6a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
        <polyline points="7,17 7,10 11,10 11,17"/>
      </svg>
    ),
  },
  {
    label: 'Agents',
    path: '/agents',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 2a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/>
        <path d="M5 16v-1.5A3.5 3.5 0 018.5 11h1A3.5 3.5 0 0113 14.5V16"/>
        <circle cx="5" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="13" cy="5" r="1" fill="currentColor" stroke="none"/>
      </svg>
    ),
  },
  {
    label: 'Workspace',
    path: '/workspace',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h2.3l1.2 1.5H14a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 14 14H4a1.5 1.5 0 0 1-1.5-1.5V5z"/>
        <path d="M2.5 6.5h13"/>
      </svg>
    ),
  },
  {
    label: 'Gateway',
    path: '/gateway',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 5.5H7M11 5.5h4.5M4.75 5.5a2 2 0 1 0 0 .01ZM13.25 5.5a2 2 0 1 0 0 .01ZM2.5 12.5H6M8 12.5h7.5M7 12.5a2 2 0 1 0 0 .01Z"/>
      </svg>
    ),
  },
  {
    label: 'Containers',
    path: '/containers',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="2" y="2" width="5.5" height="5.5" rx="1.5"/>
        <rect x="10.5" y="2" width="5.5" height="5.5" rx="1.5"/>
        <rect x="2" y="10.5" width="5.5" height="5.5" rx="1.5"/>
        <rect x="10.5" y="10.5" width="5.5" height="5.5" rx="1.5"/>
      </svg>
    ),
  },
];

export default function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="mobile-bottom-nav">
      <div className="mobile-bottom-nav__scroll">
        {navItems.map((item) => {
          const isActive = item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`mobile-bottom-nav__item ${isActive ? 'mobile-bottom-nav__item--active' : ''}`}
              prefetch={true}
            >
              <span className="mobile-bottom-nav__icon">{item.icon}</span>
              <span className="mobile-bottom-nav__label">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
