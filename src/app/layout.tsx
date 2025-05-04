import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { FirebaseProvider } from '@/context/firebase-context';
import { ChatProvider } from '@/context/chat-context';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});


export const metadata: Metadata = {
  title: 'NOTRACE - Anonymous Chat',
  description: 'Ephemeral anonymous chat rooms.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} antialiased bg-background text-foreground min-h-screen flex flex-col`}>
        <FirebaseProvider>
          <ChatProvider>
            <main className="flex-grow container mx-auto p-4 flex flex-col items-center justify-center">
              {children}
            </main>
            <Toaster />
          </ChatProvider>
        </FirebaseProvider>
      </body>
    </html>
  );
}
