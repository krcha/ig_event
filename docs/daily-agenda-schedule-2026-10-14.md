# Daily posting time: 16:30 Belgrade

The daily n8n workflow `EzekaDailyIg001` now uses cron `30 16 * * *` and timezone
`Europe/Belgrade`, following the user's request for 4:30 pm posting.

The trigger is named `Daily at 16:30 Belgrade`; its ID remains `daily-schedule`.
Its outgoing connection key and node static-data key were renamed with it.
The publisher code and complete global publication state were preserved.
The social API and poster release did not require redeployment.

The 14 October post had already been published at the previous time. The
one-post-per-day guard remains in place: the 14 October 16:30 run will skip,
and the first new post at this time is due on 15 October 2026, covering
16 through 18 October.

The current published and active version is
`cddfd23d-b0ea-438a-bde1-05390b6cce24`. Its publisher is unchanged from the
successful 14 October execution, which published post `18079091330387866`.
The actual execution and latest global publication receipt remain in the live
n8n SQLite database.

The user's subsequent production-only cleanup removed filesystem backups,
temporary workflow exports and private preview receipts. Current production
sources, Compose files, dependencies and operational data were retained; the
previous v7 and superseded web containers were removed. Future schedule changes
must preserve the latest live publication state and remove temporary exports
after verification.

`npm run qa:release` and `git diff --check` passed. Activation checks compare
the published history with the live definition, verify the new cron and
timezone, and confirm the unchanged publisher, publication receipts and other
active workflows. The n8n scheduler is reloaded only with no in-flight execution.
