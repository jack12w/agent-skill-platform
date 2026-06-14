'use client';

import { useEffect, useState, useCallback } from 'react';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

export default function HubFeedbacksPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const r = await fetch(`/api/admin/feedbacks?page=${page}&size=20`, { headers: { Authorization: `Bearer ${token}` } });
    setData(await r.json());
    setLoading(false);
  }, [page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const deleteFeedback = async (id: string) => {
    if (!confirm('Delete this feedback?')) return;
    const token = getToken(); if (!token) return;
    await fetch(`/api/admin/feedbacks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchData();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">反馈建议</h1>
      <p className="text-xs text-gray-500 mb-4">用户提交的反馈和建议列表</p>

      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left hidden md:table-cell">Email</th>
              <th className="px-4 py-3 text-left">Content</th>
              <th className="px-4 py-3 text-left hidden sm:table-cell">Date</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data?.items || []).map((f: any) => (
              <tr key={f.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{f.name}</td>
                <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{f.email || '-'}</td>
                <td className="px-4 py-3 text-gray-600 max-w-sm truncate">{f.content}</td>
                <td className="px-4 py-3 text-gray-400 text-xs hidden sm:table-cell whitespace-nowrap">{new Date(f.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => deleteFeedback(f.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
            {(!data || data.items.length === 0) && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400 text-sm">暂无反馈</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > 20 && (
        <div className="flex justify-between mt-4 text-sm text-gray-500">
          <span>{(page-1)*20+1}-{Math.min(page*20, data.total)} of {data.total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1} className="px-3 py-1 border rounded disabled:opacity-30">Prev</button>
            <button onClick={() => setPage(p => p+1)} disabled={page*20 >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
