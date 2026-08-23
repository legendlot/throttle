import { AuthProvider } from '@throttle/auth';
import './globals.css';

export const metadata = {
  title: 'Throttle',
  description: 'Brand Team Work OS — Legend of Toys',
  manifest: '/manifest.json',
};

// Mobile: real device width, notch-safe (viewport-fit) and a canvas-coloured
// browser chrome. Desktop reads none of this.
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#161318' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ background: 'var(--bg)', color: 'var(--text)' }}>
        <AuthProvider
          workerUrl={process.env.NEXT_PUBLIC_WORKER_URL}
          pingAction="getMe"
        >
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
