import './globals.css';
import { ToastProvider } from '@throttle/ui/Toast.js';

// manifest: a LOT phone adds Outpost to its home screen and opens it full screen, portrait, like the floor Scanner app.
export const metadata = { title: 'Outpost', description: 'Vendor packing floor', manifest: '/manifest.webmanifest' };
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#161519' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
