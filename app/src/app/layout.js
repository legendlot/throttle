import { AuthProvider } from '@/lib/auth';
import './globals.css';

export const metadata = {
  title: 'Throttle',
  description: 'Brand Team Work OS — Legend of Toys',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
