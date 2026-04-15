'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { workerFetch } from './worker';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession]     = useState(null);
  const [brandUser, setBrandUser] = useState(null);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    // onAuthStateChange fires with INITIAL_SESSION on subscribe — more reliable
    // than getSession() in static-export contexts where getSession() can hang.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        if (session) {
          await loadBrandUser(session);
        } else {
          setBrandUser(null);
        }
        setLoading(false);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  async function loadBrandUser(session) {
    // Call Worker's getMe instead of querying brand.users directly.
    // Direct client reads against brand schema hit RLS auth.uid() issues (406);
    // Worker uses service role which bypasses RLS.
    try {
      const data = await workerFetch('getMe', {}, session);
      setBrandUser(data);
    } catch (e) {
      console.error('loadBrandUser failed:', e);
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
    setBrandUser(null);
    setSession(null);
  }

  return (
    <AuthContext.Provider value={{ session, brandUser, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
