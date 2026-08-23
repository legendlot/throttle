import './globals.css';
import { AuthProvider } from '@throttle/auth';
import { ToastProvider } from '@throttle/ui';

export const metadata = { title: 'Odo · Consolidated Sales', manifest: '/manifest.json' };

// Mobile: real device width, notch-safe (viewport-fit) and a canvas-coloured browser chrome.
// Desktop reads none of this.
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#08090c' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" href="/favicon.png" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
        <AuthProvider workerUrl={process.env.NEXT_PUBLIC_WORKER_URL} pingAction="getMe">
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
