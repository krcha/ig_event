# Agent Instructions

Read [INSTRUCTIONS.md](INSTRUCTIONS.md) before making changes.

Short version:

- Do not replace Convex, Clerk, OpenAI, or Apify unless explicitly asked.
- Preserve the existing ingestion and moderation behavior.
- Run `npm run qa:release` and `git diff --check` before handoff.
- `npm run qa:release` includes `npm run build`; treat build failures as release blockers.
- Never commit secrets or revert unrelated user work.
