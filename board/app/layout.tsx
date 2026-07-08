import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'kodi board',
  description: 'kodi.dev board — local ticket board UI.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Dark mode follows the OS preference via daisyUI `--prefersdark`; no
  // client-side theme scripting is needed (design-system §5.1).
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
