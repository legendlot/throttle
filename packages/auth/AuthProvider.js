'use client';
import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { supabase, workerFetch } from '@throttle/db';

const BRAND_USER_CACHE_KEY = 'throttle-brand-user';
function readCache(userId) {
  try {
    const raw = sessionStorage.getItem(BRAND_USER_CACHE_KEY);
    if (!raw) return null;
    const { userId: cachedId, data } = JSON.parse(raw);
    return cachedId === userId ? data : null;
  } catch { return null; }
}
function writeCache(userId, data) {
  try { sessionStorage.setItem(BRAND_USER_CACHE_KEY, JSON.stringify({ userId, data })); } catch {}
}
function clearCache() {
  try { sessionStorage.removeItem(BRAND_USER_CACHE_KEY); } catch {}
}

const AuthContext = createContext(null);

export function AuthProvider({ children, workerUrl, pingAction = 'ping' }) {
  const [session, setSession]       = useState(null);
  const [user, setUser]             = useState(null);
  const [role, setRole]             = useState(null);
  const [perms, setPerms]           = useState(null);
  const [brandUser, setBrandUser]   = useState(null);
  const [loading, setLoading]       = useState(true);
  const identityCacheRef   = useRef(null);  // { userId, data }
  const loadingIdentityRef = useRef(false); // in-flight guard for loadIdentity

  useEffect(() => {
    let cancelled = false;

    // Primary: load session immediately on mount. onAuthStateChange is unreliable
    // in a Next.js static export on GitHub Pages — it fires inconsistently on
    // hard refresh, tab switch, and back navigation, which leaves the app stuck
    // on LOADING. getSession() resolves synchronously from storage.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (cancelled) return;
      setSession(session);
      if (session) {
        // Apply cached identity immediately so app loads without waiting for Worker
        const cached = readCache(session.user?.id);
        if (cached) {
          setBrandUser(cached);
          setRole(cached?.role ?? null);
          setUser({ id: cached?.id ?? session.user?.id, email: cached?.email ?? session.user?.email, full_name: cached?.full_name ?? null });
          setLoading(false);
          // Revalidate in background — don't await
          loadIdentity(session);
        } else {
          await loadIdentity(session);
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    });

    // Secondary: handle subsequent auth changes (sign in, sign out, token refresh).
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, nextSession) => {
        if (cancelled) return;
        setSession(nextSession);
        if (nextSession) {
          await loadIdentity(nextSession);
        } else {
          setUser(null);
          setRole(null);
          setPerms(null);
          setBrandUser(null);
          setLoading(false);
        }
      }
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadIdentity(currentSession) {
    // In-flight guard. Both the getSession primary path and onAuthStateChange
    // (which itself can fire INITIAL_SESSION → SIGNED_IN → TOKEN_REFRESHED in
    // quick succession) can call this concurrently. Without the guard, all
    // concurrent calls bypass identityCacheRef (cache populates only after the
    // first call returns) and fire parallel getMe requests with a not-yet-
    // settled token, producing cascading 401s.
    if (loadingIdentityRef.current) return;
    loadingIdentityRef.current = true;
    try {
      // Wait for Supabase to finish hydrating the session from storage before
      // calling the Worker. On mobile browsers, onAuthStateChange can fire
      // with a session object before the access_token is ready, which causes
      // getMe to 401 and the app to hang on LOADING. getSession() resolves
      // only once the in-memory session is settled.
      const { data: { session: liveSession } } = await supabase.auth.getSession();
      const activeSession = liveSession || currentSession;
      if (!activeSession?.access_token) return;

      const incomingUserId = activeSession.user?.id;

      // If we already have identity data for this exact user, reuse it.
      // This prevents a Worker round-trip (and the resulting re-render flash)
      // on every token refresh / tab focus event.
      if (identityCacheRef.current?.userId === incomingUserId && identityCacheRef.current?.data) {
        const data = identityCacheRef.current.data;
        setBrandUser(data);
        setRole(data?.role ?? null);
        setPerms(data?.permissions ?? null);
        setUser({
          id: data?.id ?? incomingUserId ?? null,
          email: data?.email ?? activeSession.user?.email ?? null,
          full_name: data?.full_name ?? null,
        });
        return;
      }

      const data = await workerFetch(pingAction, {}, activeSession, workerUrl);
      identityCacheRef.current = { userId: incomingUserId, data };
      const resolvedRole     = data?.role ?? null;
      const resolvedFullName = data?.full_name ?? null;
      const resolvedPerms    = data?.permissions ?? null;
      setRole(resolvedRole);
      setPerms(resolvedPerms);
      setUser({
        id: data?.id ?? activeSession.user?.id ?? null,
        email: data?.email ?? activeSession.user?.email ?? null,
        full_name: resolvedFullName,
      });
      setBrandUser(data);
      writeCache(incomingUserId, data);
    } catch (e) {
      console.error('[AuthProvider] loadIdentity failed:', e);
      // Only clear state if we have nothing — don't wipe a valid session on a transient Worker error
      if (!identityCacheRef.current?.data) {
        setUser(null);
        setRole(null);
        setPerms(null);
        setBrandUser(null);
      }
    } finally {
      loadingIdentityRef.current = false;
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
    clearCache();
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
