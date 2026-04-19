'use client';
import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { supabase, workerFetch } from '@throttle/db';

const AuthContext = createContext(null);

export function AuthProvider({ children, workerUrl, pingAction = 'ping' }) {
  const [session, setSession]       = useState(null);
  const [user, setUser]             = useState(null);
  const [role, setRole]             = useState(null);
  const [perms, setPerms]           = useState(null);
  const [brandUser, setBrandUser]   = useState(null);
  const brandUserRef = useRef(null);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, nextSession) => {
        // On token refresh, only skip re-render if identity is already loaded.
        // If brandUser is null we're still initialising — must proceed normally.
        if (event === 'TOKEN_REFRESHED' && brandUserRef.current) return;
        setSession(nextSession);
        if (nextSession) {
          await loadIdentity(nextSession);
        } else {
          setUser(null);
          setRole(null);
          setPerms(null);
          setBrandUser(null);
        }
        setLoading(false);
      }
    );
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadIdentity(currentSession) {
    try {
      const data = await workerFetch(pingAction, {}, currentSession, workerUrl);
      const resolvedRole     = data?.role ?? null;
      const resolvedFullName = data?.full_name ?? null;
      const resolvedPerms    = data?.permissions ?? null;
      setRole(resolvedRole);
      setPerms(resolvedPerms);
      setUser({
        id: data?.id ?? currentSession.user?.id ?? null,
        email: data?.email ?? currentSession.user?.email ?? null,
        full_name: resolvedFullName,
      });
      setBrandUser(data);
      brandUserRef.current = data;
    } catch (e) {
      console.error('[AuthProvider] loadIdentity failed:', e);
      setUser(null);
      setRole(null);
      setPerms(null);
      setBrandUser(null);
    }
  }

  async function signInWithGoogle() {
    return supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback/`,
        hd: 'legendoftoys.com',
      },
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
    setRole(null);
    setPerms(null);
    setBrandUser(null);
  }

  return (
    <AuthContext.Provider value={{ session, user, role, perms, loading, brandUser, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
