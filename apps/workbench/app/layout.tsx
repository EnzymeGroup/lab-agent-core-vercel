import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lab Agent · Workbench',
  description: 'Local agent sessions, task execution, and verified artifacts.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('lab-agent-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){}})()` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
