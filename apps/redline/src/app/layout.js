import { AuthProvider } from '@throttle/auth';
import { ToastProvider } from '@throttle/ui';

export const metadata = { title: 'Redline' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ background: '#080808', color: '#eee', margin: 0, fontFamily: 'ui-monospace, Menlo, monospace' }}>
        <AuthProvider workerUrl={process.env.NEXT_PUBLIC_WORKER_URL} pingAction="ping">
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
