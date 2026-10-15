import './globals.css';
import { ToastProvider } from '@throttle/ui/Toast.js';

export const metadata = { title: 'Outpost', description: 'Vendor packing floor' };
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
