import './globals.css';
import { AuthProvider } from '@throttle/auth';
import { ToastProvider } from '@throttle/ui';

export const metadata = { title: 'Pitstop · Customer Support' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Tomorrow:wght@400;500;600;700&display=swap"
        />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" href="/favicon.png" sizes="any" />
        <link rel="apple-touch-icon" href="/favicon.png" />
      </head>
      <body>
        <AuthProvider workerUrl={process.env.NEXT_PUBLIC_WORKER_URL} pingAction="getMe">
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
