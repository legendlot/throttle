import { AuthProvider } from '@throttle/auth';
import './globals.css';

export const metadata = {
  title: 'Throttle',
  description: 'Brand Team Work OS — Legend of Toys',
};

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
