'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubTagsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState('');

  useEffect(() => {
    const token = getToken(); if (!token) return;
    fetch('/api/admin/tags', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setData);
  }, []);

  const fixTags = async () => {
    setFixing(true);
    const token = getToken(); if (!token) return;
    try {
      const r = await fetch('/api/skills/fix-tags', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      setFixResult(`Fixed ${j.fixed} skills`);
    } catch (e: any) { setFixResult('Error: ' + e.message); }
    setFixing(false);
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{t('admin.tags')}</h1>
      <p className="text-sm text-gray-500 mb-4">{t('admin.overview')}</p>

      <button onClick={fixTags} disabled={fixing} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 mb-4">
        {fixing ? 'Fixing...' : 'Fix All Tags (split commas, lowercase, deduplicate)'}
      </button>
      {fixResult && <p className="text-sm text-green-600 mb-4">{fixResult}</p>}

      <div className="bg-white border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Current Tags ({data?.tags?.length || 0})</h2>
        <div className="flex flex-wrap gap-2">
          {(data?.tags || []).map((tag: any) => (
            <span key={tag.name} className="px-3 py-1.5 bg-gray-50 border rounded-full text-sm">
              {tag.name}
              <span className="ml-1.5 text-xs text-gray-400">({tag.count})</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
