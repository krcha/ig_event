import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { AppToolbar } from "@/components/navigation/app-toolbar";
import { ConvexClientProvider } from "@/components/providers/convex-client-provider";
import { isViewerAdmin } from "@/lib/auth/admin";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nightlife Event Aggregator",
  description: "Discover nightlife events aggregated from Instagram.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#eef7fb",
};

const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

async function AppDocument({ children }: { children: React.ReactNode }) {
  const showAdminNavigation = await isViewerAdmin();

  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ConvexClientProvider>
          <div className="min-h-screen">
            <AppToolbar showAdminNavigation={showAdminNavigation} />
            {children}
          </div>
        </ConvexClientProvider>
      </body>
    </html>
  );
}

export default async function RootLayout({
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
