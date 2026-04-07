import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import TopBar from "@/components/layout/TopBar";
import { QueryProvider } from "@/providers/QueryProvider";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Yoko CRM",
  description: "Yandex Dispatch API Testing Tool",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <QueryProvider>
          <div className="flex min-h-screen bg-background text-foreground">
            <Sidebar />
            <TopBar />
            <div className="flex w-full flex-col ml-0 lg:ml-[72px] pt-[64px] min-h-screen transition-all duration-300">
              {children}
            </div>
          </div>
        </QueryProvider>
        <Toaster />
      </body>
    </html>
  );
}
