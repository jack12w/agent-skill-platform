'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

export default function AnalyticsTracker() {
  const pathname = usePathname();

  useEffect(() => {
    try {
      fetch('/api/analytics/pageview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathname, referrer: document.referrer || null }),
        keepalive: true,
      }).catch(() => {}); // silent fail
    } catch {}
  }, [pathname]);

  return null;
}
