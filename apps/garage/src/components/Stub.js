'use client';
import { RequireAuth } from '@throttle/auth';

export default function Stub({ title, route }) {
  return (
    <RequireAuth>
      <div style={{ padding: 24, fontFamily: 'ui-monospace, Menlo, monospace' }}>
        <h1 style={{ fontSize: 18, color: '#eee', margin: 0, marginBottom: 8 }}>{title}</h1>
        <code style={{ color: '#888', fontSize: 12 }}>{route}</code>
        <p style={{ color: '#666', marginTop: 16, fontSize: 13 }}>Coming soon</p>
      </div>
    </RequireAuth>
  );
}
