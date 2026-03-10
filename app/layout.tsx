import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { AppToolbar } from "@/components/navigation/app-toolbar";
import { ConvexClientProvider } from "@/components/providers/convex-client-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nightlife Event Aggregator",
  description: "Discover nightlife events aggregated from Instagram.",
};

const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

function AppDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">
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
