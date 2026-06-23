# Agent Instructions

Read [INSTRUCTIONS.md](INSTRUCTIONS.md) before making changes.

Short version:

- Do not replace Convex APIs/data model, Clerk, OpenAI, or Apify unless
  explicitly asked. Convex may run hosted or via the self-hosted Compose overlay.
- Preserve the existing ingestion and moderation behavior.
- Run `npm run qa:release` and `git diff --check` before handoff.
- `npm run qa:release` includes `npm run build`; treat build failures as release blockers.
- Never commit secrets or revert unrelated user work.
