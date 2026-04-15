'use client';
import { useState } from 'react';
import Layout from '@/components/Layout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';

const ROLES = ['admin', 'lead', 'member', 'requester'];
const DISCIPLINES = ['designer', '3d', 'copywriter', 'photo_video', 'lead'];

export default function SettingsPage() {
  const { session, brandUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  async function loadUsers() {
    const { data } = await supabase.from('users').select('*').order('name');
    setUsers(data || []);
    setLoaded(true);
  }

  async function updateUser(userId, field, value) {
    setSaving(userId);
    setError(null);
    try {
      await workerFetch('updateUserRole', { user_id: userId, [field]: value }, session?.access_token);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, [field]: value } : u));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(null);
    }
  }

  if (brandUser?.role !== 'admin') {
    return (
      <Layout>
        <div className="max-w-lg mx-auto py-20 text-center">
          <p className="text-zinc-600 text-sm">Admin access required.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-1">Settings</h1>
        <p className="text-zinc-500 text-sm mb-6">Manage team roles and disciplines</p>

        {!loaded ? (
          <button
            onClick={loadUsers}
            className="bg-white text-black font-semibold px-4 py-2 rounded-lg text-sm hover:bg-zinc-100 transition-colors"
          >
            Load Team
          </button>
        ) : (
          <div>
            {error && (
              <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3 mb-4">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="text-left text-xs text-zinc-500 font-medium px-4 py-3">Name</th>
                    <th className="text-left text-xs text-zinc-500 font-medium px-4 py-3">Email</th>
                    <th className="text-left text-xs text-zinc-500 font-medium px-4 py-3">Role</th>
                    <th className="text-left text-xs text-zinc-500 font-medium px-4 py-3">Discipline</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user, i) => (
                    <tr key={user.id} className={`border-t border-zinc-800 ${i % 2 === 0 ? '' : 'bg-zinc-900/50'}`}>
                      <td className="px-4 py-3 text-sm text-zinc-200">{user.name}</td>
                      <td className="px-4 py-3 text-xs text-zinc-500">{user.email}</td>
                      <td className="px-4 py-3">
                        <select
                          value={user.role}
                          disabled={user.id === brandUser.id || saving === user.id}
                          onChange={e => updateUser(user.id, 'role', e.target.value)}
                          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none disabled:opacity-40"
                        >
                          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={user.discipline || ''}
                          disabled={saving === user.id}
                          onChange={e => updateUser(user.id, 'discipline', e.target.value || null)}
                          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none disabled:opacity-40"
                        >
                          <option value="">— none —</option>
                          {DISCIPLINES.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
