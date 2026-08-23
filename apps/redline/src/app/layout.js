import './globals.css';
import { AuthProvider } from '@throttle/auth';
import { ToastProvider } from '@throttle/ui';

export const metadata = { title: 'Redline', manifest: '/manifest.json' };

// Mobile: real device width, notch-safe (viewport-fit) and a canvas-coloured
// browser chrome. Desktop reads none of this.
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#1b1b1e' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Tomorrow:wght@400;500;600;700;900&display=swap"
        />
        <link rel="icon" href="/favicon.png" />
        <link rel="apple-touch-icon" href="/favicon.png" />
      </head>
      <body>
        <AuthProvider workerUrl={process.env.NEXT_PUBLIC_WORKER_URL} pingAction="ping">
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
