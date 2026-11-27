// The monthly and weekly Bitef programmes independently name the same two
// performances in different scripts. Each exception belongs to one pair of
// immutable source keys and one clock time. It is never a duplicate rule.
const reviewed = [
  {
    primaryKey: "instagram-occurrence-v2:919a8b6da7fc05bb828968136a4471c577c83ed12d115462421885969b45222d",
    weeklyKey: "instagram-occurrence-v2:d1178ee8fa94f5acec409fc06d65cd2015ccbfba2f9043db19e3f766568656fd",
    title: "Кретање", weeklyTitle: "Kretanje", date: "2026-11-24", time: "20:00",
  },
  {
    primaryKey: "instagram-occurrence-v2:abd88fc286dcb1f10e6d1dfebc70a4830eca9d66e57873579185265159d45f8d",
    weeklyKey: "instagram-occurrence-v2:bfa678bce4451eb3411ce0ce29d55ff8ceb821288734f1a8d45dd196b1520f2a",
    title: "Приватна прослава", weeklyTitle: "Privatna proslava", date: "2026-11-29", time: "18:30",
  },
] as const;

type Programme = { title: string; date: string; time?: string; venue: string; artists: string[] };

export function reviewedProgrammeOccurrenceMatches(
  primaryKey: string | undefined,
  snapshot: Programme,
  expected: Programme & { key: string },
): boolean {
  return snapshot.venue === "Bitef teatar" && expected.venue === snapshot.venue &&
    snapshot.artists.length === 0 && expected.artists.length === 0 &&
    reviewed.some((row) => row.primaryKey === primaryKey && row.weeklyKey === expected.key &&
      snapshot.title === row.title && expected.title === row.weeklyTitle &&
      snapshot.date === row.date && expected.date === row.date &&
      snapshot.time === row.time && expected.time === row.time);
}
