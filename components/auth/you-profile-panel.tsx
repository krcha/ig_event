"use client";

import { SignInButton, SignUpButton, useClerk, useUser } from "@clerk/nextjs";
import { LogOut, Mail, Plus, Sparkles, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuthUser } from "@/components/providers/auth-user-provider";
import { useUserLibrary } from "@/components/providers/user-library-provider";
import { cn } from "@/lib/utils";

const DEFAULT_SCENES = ["Techno", "House", "Live jazz", "Free events"];
const SELECTED_SCENES_STORAGE_KEY = "events.you.selectedScenes.v1";
const CUSTOM_SCENES_STORAGE_KEY = "events.you.customScenes.v1";
const REMINDERS_STORAGE_KEY = "events.you.remindersEnabled.v1";

function parseStoredStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return [];
  }
}

function normalizeSceneName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 32);
}

function uniqueScenes(scenes: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const scene of scenes) {
    const normalized = normalizeSceneName(scene);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}

function ProfileLoadingCard() {
  return (
    <section className="mx-auto w-full max-w-xl rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[#13151D] px-4 py-5 sm:px-5">
      <div className="animate-pulse space-y-4">
        <div className="mx-auto h-[60px] w-[60px] rounded-[18px] bg-white/[0.08]" />
        <div className="mx-auto h-6 w-44 rounded-full bg-white/[0.08]" />
        <div className="mx-auto h-4 w-56 max-w-full rounded-full bg-white/[0.06]" />
      </div>
    </section>
  );
}

function SignInPromptCard() {
  return (
    <section className="hero-panel px-4 py-5 sm:px-6 sm:py-7">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.42fr)] lg:items-center">
        <div className="space-y-3">
          <span className="app-chip border-primary/25 bg-primary/[0.1] text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Your nights
          </span>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-[-0.045em] sm:text-4xl">
              Sign in when you want to save.
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Browsing stays open to everyone. Use your account for saved events, follows, and
              personal planning features.
            </p>
          </div>
        </div>

        <div className="rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[#13151D] p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-full bg-primary/[0.12] text-primary">
              <UserRound className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Create your event profile</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Save events, follow places, and keep your nights in one tab.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <SignInButton mode="modal">
              <button className="button-primary min-h-12 w-full px-4 py-0" type="button">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="button-secondary min-h-12 w-full px-4 py-0" type="button">
                Sign up
              </button>
            </SignUpButton>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[#13151D] px-4 py-4">
      <p
        className="text-4xl font-bold leading-none tracking-[-0.06em] text-[#8B86FB] sm:text-[2.6rem]"
        style={{ fontFamily: '"Space Grotesk", var(--font-sans)' }}
      >
        {value}
      </p>
      <p className="mt-2 text-xs font-medium text-muted-foreground">{label}</p>
    </div>
  );
}

export function YouProfilePanel() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();
  const authUser = useAuthUser();
  const { favoriteVenueIds, isLibraryLoaded, upcomingSavedEventCount } = useUserLibrary();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [selectedScenes, setSelectedScenes] = useState<string[]>([]);
  const [customScenes, setCustomScenes] = useState<string[]>([]);
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);

  useEffect(() => {
    setSelectedScenes(uniqueScenes(parseStoredStringArray(localStorage.getItem(SELECTED_SCENES_STORAGE_KEY))));
    setCustomScenes(uniqueScenes(parseStoredStringArray(localStorage.getItem(CUSTOM_SCENES_STORAGE_KEY))));

    const storedReminderValue = localStorage.getItem(REMINDERS_STORAGE_KEY);
    if (storedReminderValue !== null) {
      setRemindersEnabled(storedReminderValue === "true");
    }

    setHasLoadedPreferences(true);
  }, []);

  useEffect(() => {
    if (!hasLoadedPreferences) {
      return;
    }

    localStorage.setItem(SELECTED_SCENES_STORAGE_KEY, JSON.stringify(selectedScenes));
  }, [hasLoadedPreferences, selectedScenes]);

  useEffect(() => {
    if (!hasLoadedPreferences) {
      return;
    }

    localStorage.setItem(CUSTOM_SCENES_STORAGE_KEY, JSON.stringify(customScenes));
  }, [customScenes, hasLoadedPreferences]);

  useEffect(() => {
    if (!hasLoadedPreferences) {
      return;
    }

    localStorage.setItem(REMINDERS_STORAGE_KEY, String(remindersEnabled));
  }, [hasLoadedPreferences, remindersEnabled]);

  const scenes = useMemo(() => uniqueScenes([...DEFAULT_SCENES, ...customScenes]), [customScenes]);

  if (!isLoaded) {
    return <ProfileLoadingCard />;
  }

  if (!isSignedIn || !user) {
    return <SignInPromptCard />;
  }

  const email = user.primaryEmailAddress?.emailAddress ?? authUser.email ?? "No email on file";
  const displayName = user.fullName ?? authUser.name ?? user.username ?? email;
  const imageUrl = user.imageUrl || authUser.imageUrl || "";
  const savedEventsValue = isLibraryLoaded ? String(upcomingSavedEventCount) : "...";
  const favoritePlacesValue = isLibraryLoaded ? String(favoriteVenueIds.size) : "...";

  function toggleScene(scene: string) {
    setSelectedScenes((current) => {
      if (current.some((item) => item.toLowerCase() === scene.toLowerCase())) {
        return current.filter((item) => item.toLowerCase() !== scene.toLowerCase());
      }
      return uniqueScenes([...current, scene]);
    });
  }

  function addScene() {
    const nextScene = normalizeSceneName(window.prompt("Add a scene") ?? "");
    if (!nextScene) {
      return;
    }

    const existingScene = scenes.find((scene) => scene.toLowerCase() === nextScene.toLowerCase());
    const sceneToSelect = existingScene ?? nextScene;

    if (!existingScene) {
      setCustomScenes((current) => uniqueScenes([...current, nextScene]));
    }
    setSelectedScenes((current) => uniqueScenes([...current, sceneToSelect]));
  }

  async function signOut() {
    setIsSigningOut(true);
    await clerk.signOut({ redirectUrl: "/you" });
  }

  return (
    <section className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-3 pb-5 sm:gap-4">
      <div className="rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[#13151D] px-4 py-5 text-center sm:px-5">
        {/* Clerk avatars may come from multiple identity-provider domains. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt={displayName}
          className="mx-auto h-[60px] w-[60px] rounded-[18px] border border-white/[0.08] bg-white/[0.05] object-cover shadow-[0_18px_42px_-26px_rgba(139,134,251,0.9)]"
          src={imageUrl}
        />
        <h1 className="mt-4 truncate text-3xl font-bold leading-tight tracking-[-0.045em] sm:text-4xl">
          {displayName}
        </h1>
        <p className="mx-auto mt-2 flex max-w-full items-center justify-center gap-2 truncate text-sm text-muted-foreground">
          <Mail className="h-4 w-4 flex-none text-[#8B86FB]" />
          <span className="min-w-0 truncate">{email}</span>
        </p>
      </div>

      <div className="flex gap-3">
        <StatTile label="Saved events" value={savedEventsValue} />
        <StatTile label="Favourite places" value={favoritePlacesValue} />
      </div>

      <div className="rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[#13151D] px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-[-0.02em] text-foreground">Your scenes</h2>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {scenes.map((scene) => {
            const selected = selectedScenes.some((item) => item.toLowerCase() === scene.toLowerCase());

            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "inline-flex min-h-10 items-center rounded-full border px-3.5 text-sm font-semibold",
                  selected
                    ? "border-[#8B86FB]/50 bg-[#8B86FB]/18 text-[#DAD8FF]"
                    : "border-[rgba(255,255,255,0.07)] bg-white/[0.035] text-muted-foreground hover:border-[#8B86FB]/35 hover:text-foreground",
                )}
                key={scene}
                onClick={() => toggleScene(scene)}
                type="button"
              >
                {scene}
              </button>
            );
          })}
          <button
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-dashed border-[#8B86FB]/45 bg-[#8B86FB]/10 px-3.5 text-sm font-semibold text-[#BDBAFF] hover:bg-[#8B86FB]/16"
            onClick={addScene}
            type="button"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>
      </div>

      <div className="rounded-[18px] border border-[rgba(255,255,255,0.07)] bg-[#13151D] px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Remind me before saved events</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">A nudge two hours before doors</p>
          </div>
          <button
            aria-checked={remindersEnabled}
            aria-label="Remind me before saved events"
            className={cn(
              "relative h-8 w-14 flex-none rounded-full border p-1",
              remindersEnabled
                ? "border-[#8B86FB]/60 bg-[#8B86FB]"
                : "border-[rgba(255,255,255,0.07)] bg-white/[0.08]",
            )}
            onClick={() => setRemindersEnabled((current) => !current)}
            role="switch"
            type="button"
          >
            <span
              className={cn(
                "block h-6 w-6 rounded-full bg-white shadow-[0_8px_20px_-10px_rgba(0,0,0,0.9)] transition-transform",
                remindersEnabled ? "translate-x-6" : "translate-x-0",
              )}
            />
          </button>
        </div>
      </div>

      <button
        className="mt-auto inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-transparent px-4 text-sm font-semibold text-foreground hover:border-[#8B86FB]/55 hover:bg-[#8B86FB]/10 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isSigningOut}
        onClick={() => {
          void signOut();
        }}
        type="button"
      >
        <LogOut className="h-4 w-4" />
        {isSigningOut ? "Signing out..." : "Sign out"}
      </button>
    </section>
  );
}
