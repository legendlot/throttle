'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && session) router.replace('/');
  }, [session, loading, router]);

  return (
    <div className="login">
      <div className="login-card">
        <img className="login-lot" src="/lot-logo.png" alt="Legend of Toys" />
        <img className="login-mark" src="/favicon.svg" alt="" />
        <div className="login-word">DOCKET</div>
        <div className="login-sub">Org Task Manager</div>
        <div className="login-rule" />
        <button className="login-btn" onClick={signInWithGoogle}>Sign in with Google</button>
        <div className="login-foot">@legendoftoys.com</div>
      </div>
    </div>
  );
}
