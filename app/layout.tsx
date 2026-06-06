import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { AppToolbar } from "@/components/navigation/app-toolbar";
import { ConvexClientProvider } from "@/components/providers/convex-client-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Belgrade Events — Nightlife calendar",
  description: "A dark, mobile-first calendar for Belgrade nightlife, concerts, club nights, and culture.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050609",
};

const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

function AppDocument({ children }: { children: React.ReactNode }) {
  return (
    <html className="dark" lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ConvexClientProvider>
          <div className="min-h-screen">
            <AppToolbar />
            {children}
          </div>
        </ConvexClientProvider>
      </body>
    </html>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  if (!clerkPublishableKey) {
    return <AppDocument>{children}</AppDocument>;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <AppDocument>{children}</AppDocument>
    </ClerkProvider>
  );
}
