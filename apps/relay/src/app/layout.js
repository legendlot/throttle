import './globals.css';
import './redesign.css';
import { AuthProvider } from '@throttle/auth';
import { ToastProvider } from '@throttle/ui';

export const metadata = { title: 'Relay · Comms' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
        />
        {/* Relay brand pack (Orchestration Hub) — wiring per public/brand/relay/README.md.
            Root /favicon.png + /favicon.svg mirror the new mark for legacy consumers
            (the cross-system AppLauncher loads {app}/favicon.png). */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" href="/brand/relay/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/brand/relay/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/brand/relay/favicon-16.png" />
        <link rel="apple-touch-icon" href="/brand/relay/apple-touch-icon.png" />
        <link rel="mask-icon" href="/brand/relay/relay-mark-ink.svg" color="#F2CD1A" />
        <link rel="manifest" href="/brand/relay/site.webmanifest" />
        <meta name="theme-color" content="#0d0e10" />
      </head>
      <body>
        <AuthProvider workerUrl={process.env.NEXT_PUBLIC_WORKER_URL} pingAction="getMe">
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
