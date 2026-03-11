import { z } from "zod";
import {
  APPROVED_EVENTS_MASTER_REVIEW_SYSTEM_PROMPT,
  buildApprovedEventsMasterReviewUserPrompt,
} from "@/lib/ai/approved-events-master-review-prompt";
import {
  getStartOfLocalToday,
  parseNormalizedEventDate,
} from "@/lib/events/public-events";
import { getRequiredEnv } from "@/lib/utils/env";

const approvedEventsReviewModel = process.env.OPENAI_REVIEW_MODEL ?? "gpt-5.4-mini";
const APPROVED_EVENTS_REVIEW_TIMEOUT_MS = 60_000;
const APPROVED_EVENTS_REVIEW_MAX_ATTEMPTS = 2;

const SERBIAN_CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  ђ: "dj",
  е: "e",
  ж: "z",
  з: "z",
  и: "i",
  ј: "j",
  к: "k",
  л: "l",
  љ: "lj",
  м: "m",
  н: "n",
  њ: "nj",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  ћ: "c",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "c",
  џ: "dz",
  ш: "s",
};

const SERBIAN_LATIN_TO_ASCII: Record<string, string> = {
  đ: "dj",
  č: "c",
  ć: "c",
  ž: "z",
  š: "s",
};

const DUPLICATE_VENUE_STOP_WORDS = new Set([
  "beograd",
  "belgrade",
  "club",
  "klub",
  "dom",
  "kulture",
  "serbia",
  "srbija",
]);

const DUPLICATE_TEXT_STOP_WORDS = new Set([
  "belgrade",
  "beograd",
  "serbia",
  "srbija",
  "event",
  "party",
  "concert",
  "live",
  "music",
  "night",
  "official",
  "ulaz",
  "slobodan",
  "free",
  "entry",
]);

const approvedEventPatchSchema = z.object({
  title: z.string(),
  date: z.string(),
  time: z.string(),
  venue: z.string(),
  artists: z.array(z.string()).default([]),
  description: z.string(),
  ticketPrice: z.string(),
  eventType: z.string(),
  imageUrl: z.string(),
});

const approvedEventMasterReviewSchema = z.object({
  overview: z.string(),
  review_groups: z.array(
    z.object({
      group_id: z.string(),
      confidence: z.union([z.number(), z.string()]),
      reasoning: z.string(),
      recommended_action: z.union([
        z.literal("merge_delete"),
        z.literal("delete_only"),
      ]),
      primary_event_id: z.string(),
      duplicate_event_ids: z.array(z.string()).default([]),
      primary_patch: approvedEventPatchSchema,
    }),
  ),
});

export type ApprovedEventRecordForReview = {
  id: string;
  title: string;
  date: string;
  time: string | null;
  venue: string;
  artists: string[];
  description: string | null;
  imageUrl: string | null;
  instagramPostUrl: string | null;
  ticketPrice: string | null;
  eventType: string;
  sourceCaption: string | null;
  sourcePostedAt: string | null;
  normalizedFieldsJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ApprovedEventReviewCandidateGroup = {
  groupId: string;
  eventIds: string[];
  events: ApprovedEventRecordForReview[];
};

export type ApprovedEventMasterReviewGroup = {
  groupId: string;
  confidence: number | null;
  reasoning: string;
  recommendedAction: "merge_delete" | "delete_only";
  primaryEventId: string;
  duplicateEventIds: string[];
  primaryPatch: z.infer<typeof approvedEventPatchSchema>;
};

export type ApprovedEventMasterReviewResult = {
  overview: string;
  activeEventCount: number;
  candidateGroupCount: number;
  reviewGroups: ApprovedEventMasterReviewGroup[];
};

type DuplicateReviewDecoratedEvent = ApprovedEventRecordForReview & {
  normalizedFields: Record<string, unknown> | null;
  duplicateDateKey: string | null;
  duplicateVenueText: string;
  duplicateTitleText: string;
  duplicateArtistText: string;
  duplicateDescriptionText: string;
  titleUsedFallback: boolean;
  missingTime: boolean;
};

const approvedEventMasterReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    overview: { type: "string" },
    review_groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          group_id: { type: "string" },
          confidence: { type: ["number", "string"] },
          reasoning: { type: "string" },
          recommended_action: {
            type: "string",
            enum: ["merge_delete", "delete_only"],
          },
          primary_event_id: { type: "string" },
          duplicate_event_ids: {
            type: "array",
            items: { type: "string" },
          },
          primary_patch: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              date: { type: "string" },
              time: { type: "string" },
              venue: { type: "string" },
              artists: {
                type: "array",
                items: { type: "string" },
              },
              description: { type: "string" },
              ticketPrice: { type: "string" },
              eventType: { type: "string" },
              imageUrl: { type: "string" },
            },
            required: [
              "title",
              "date",
              "time",
              "venue",
              "artists",
              "description",
              "ticketPrice",
              "eventType",
              "imageUrl",
            ],
          },
        },
        required: [
          "group_id",
          "confidence",
          "reasoning",
          "recommended_action",
          "primary_event_id",
          "duplicate_event_ids",
          "primary_patch",
        ],
      },
    },
  },
  required: ["overview", "review_groups"],
} as const;

function normalizeConfidenceValue(value: number | string): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return null;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBooleanField(record: Record<string, unknown> | null, key: string): boolean {
  return record?.[key] === true;
}

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[đčćžš]/g, (character) => SERBIAN_LATIN_TO_ASCII[character] ?? character)
    .replace(/[\u0400-\u04ff]/g, (character) => {
      return SERBIAN_CYRILLIC_TO_LATIN[character] ?? character;
    })
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSimilarityRatio(left: string, right: string, stopWords: Set<string>): number {
  if (!left || !right) {
    return 0;
  }

  const leftTokens = [
    ...new Set(
      left.split(" ").filter((token) => token.length > 1 && !stopWords.has(token)),
    ),
  ];
  const rightTokens = [
    ...new Set(
      right.split(" ").filter((token) => token.length > 1 && !stopWords.has(token)),
    ),
  ];

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightTokenSet = new Set(rightTokens);
  let sharedCount = 0;
  for (const token of leftTokens) {
    if (rightTokenSet.has(token)) {
      sharedCount += 1;
    }
  }

  return sharedCount / Math.min(leftTokens.length, rightTokens.length);
}

function areSimilarVenues(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (left.includes(right) || right.includes(left)) {
    return true;
  }
  return getSimilarityRatio(left, right, DUPLICATE_VENUE_STOP_WORDS) >= 0.72;
}

function areSimilarDuplicateTexts(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength >= 24 && (left.includes(right) || right.includes(left))) {
    return true;
  }

  return getSimilarityRatio(left, right, DUPLICATE_TEXT_STOP_WORDS) >= 0.6;
}

function decorateEventForDuplicateReview(
  event: ApprovedEventRecordForReview,
): DuplicateReviewDecoratedEvent {
  const normalizedFields = parseJsonObject(event.normalizedFieldsJson);

  return {
    ...event,
    normalizedFields,
    duplicateDateKey: readStringField(normalizedFields, "normalizedDate") ?? event.date,
    duplicateVenueText: normalizeComparisonText(
      [
        event.venue,
        readStringField(normalizedFields, "normalizedVenue") ?? "",
        readStringField(normalizedFields, "locationName") ?? "",
      ].join(" "),
    ),
    duplicateTitleText: normalizeComparisonText(
      [event.title, event.artists.join(" ")].join(" "),
    ),
    duplicateArtistText: normalizeComparisonText(event.artists.join(" ")),
    duplicateDescriptionText: normalizeComparisonText(
      [event.description ?? "", event.sourceCaption ?? ""].join(" "),
    ),
    titleUsedFallback: readBooleanField(normalizedFields, "titleUsedFallback"),
    missingTime: !event.time,
  };
}

function areSuspectedDuplicateEvents(
  left: DuplicateReviewDecoratedEvent,
  right: DuplicateReviewDecoratedEvent,
): boolean {
  if (!left.duplicateDateKey || left.duplicateDateKey !== right.duplicateDateKey) {
    return false;
  }
  if (!areSimilarVenues(left.duplicateVenueText, right.duplicateVenueText)) {
    return false;
  }

  if (
    areSimilarDuplicateTexts(left.duplicateTitleText, right.duplicateTitleText) ||
    areSimilarDuplicateTexts(left.duplicateArtistText, right.duplicateArtistText) ||
    areSimilarDuplicateTexts(left.duplicateDescriptionText, right.duplicateDescriptionText)
  ) {
    return true;
  }

  return (
    (left.missingTime && right.missingTime) ||
    left.titleUsedFallback ||
    right.titleUsedFallback
  );
}

function buildDuplicateComponents(
  events: DuplicateReviewDecoratedEvent[],
): ApprovedEventReviewCandidateGroup[] {
  const adjacentIds = new Map<string, Set<string>>();
  const eventsById = new Map(events.map((event) => [event.id, event] as const));

  for (const event of events) {
    adjacentIds.set(event.id, new Set());
  }

  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
    const left = events[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
      const right = events[rightIndex];
      if (!areSuspectedDuplicateEvents(left, right)) {
        continue;
      }
      adjacentIds.get(left.id)?.add(right.id);
      adjacentIds.get(right.id)?.add(left.id);
    }
  }

  const visited = new Set<string>();
  const groups: ApprovedEventReviewCandidateGroup[] = [];

  for (const event of events) {
    if (visited.has(event.id)) {
      continue;
    }

    const stack = [event.id];
    const componentIds: string[] = [];

    while (stack.length > 0) {
      const currentId = stack.pop() as string;
      if (visited.has(currentId)) {
        continue;
      }
      visited.add(currentId);
      componentIds.push(currentId);
      for (const adjacentId of adjacentIds.get(currentId) ?? []) {
        if (!visited.has(adjacentId)) {
          stack.push(adjacentId);
        }
      }
    }

    if (componentIds.length < 2) {
      continue;
    }

    const componentEvents = componentIds
      .map((id) => eventsById.get(id))
      .filter((candidate): candidate is DuplicateReviewDecoratedEvent => Boolean(candidate))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        date: candidate.date,
        time: candidate.time,
        venue: candidate.venue,
        artists: candidate.artists,
        description: candidate.description,
        imageUrl: candidate.imageUrl,
        instagramPostUrl: candidate.instagramPostUrl,
        ticketPrice: candidate.ticketPrice,
        eventType: candidate.eventType,
        sourceCaption: candidate.sourceCaption,
        sourcePostedAt: candidate.sourcePostedAt,
        normalizedFieldsJson: candidate.normalizedFieldsJson,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      }));

    groups.push({
      groupId: `candidate_${groups.length + 1}`,
      eventIds: componentEvents.map((candidate) => candidate.id),
      events: componentEvents,
    });
  }

  return groups;
}

export function filterUpcomingApprovedEventsForReview(
  events: ApprovedEventRecordForReview[],
): ApprovedEventRecordForReview[] {
  const startOfToday = getStartOfLocalToday();
  return events
    .filter((event) => {
      const parsedDate = parseNormalizedEventDate(event.date);
      return Boolean(parsedDate && parsedDate >= startOfToday);
    })
    .sort((left, right) => left.date.localeCompare(right.date) || right.updatedAt - left.updatedAt);
}

export function buildApprovedEventReviewCandidateGroups(
  events: ApprovedEventRecordForReview[],
): ApprovedEventReviewCandidateGroup[] {
  return buildDuplicateComponents(events.map((event) => decorateEventForDuplicateReview(event)));
}

function sanitizePatch(
  patch: z.infer<typeof approvedEventPatchSchema>,
): z.infer<typeof approvedEventPatchSchema> {
  return {
    title: patch.title.trim(),
    date: patch.date.trim(),
    time: patch.time.trim(),
    venue: patch.venue.trim(),
    artists: [...new Set(patch.artists.map((artist) => artist.trim()).filter(Boolean))],
    description: patch.description.trim(),
    ticketPrice: patch.ticketPrice.trim(),
    eventType: patch.eventType.trim(),
    imageUrl: patch.imageUrl.trim(),
  };
}

export async function reviewApprovedEventsForMasterReview(options: {
  events: ApprovedEventRecordForReview[];
  candidateGroups: ApprovedEventReviewCandidateGroup[];
}): Promise<ApprovedEventMasterReviewResult> {
  if (options.candidateGroups.length === 0) {
    return {
      overview: "No strong duplicate candidate groups were found among active approved events.",
      activeEventCount: options.events.length,
      candidateGroupCount: 0,
      reviewGroups: [],
    };
  }

  const openAiApiKey = getRequiredEnv("OPENAI_API_KEY");
  const candidateGroupById = new Map(
    options.candidateGroups.map((group) => [group.groupId, group] as const),
  );
  const candidateGroupsForPrompt = options.candidateGroups.map((group) => ({
    group_id: group.groupId,
    event_ids: group.eventIds,
    events: group.events.map((event) => ({
      id: event.id,
      title: event.title,
      date: event.date,
      time: event.time,
      venue: event.venue,
      artists: event.artists,
      description: event.description,
      ticketPrice: event.ticketPrice,
      eventType: event.eventType,
      instagramPostUrl: event.instagramPostUrl,
      sourcePostedAt: event.sourcePostedAt,
      imageUrl: event.imageUrl,
    })),
  }));
  let lastError: unknown;

  for (let attempt = 1; attempt <= APPROVED_EVENTS_REVIEW_MAX_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), APPROVED_EVENTS_REVIEW_TIMEOUT_MS);

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: approvedEventsReviewModel,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: APPROVED_EVENTS_MASTER_REVIEW_SYSTEM_PROMPT,
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildApprovedEventsMasterReviewUserPrompt({
                    activeEventCount: options.events.length,
                    candidateGroupCount: options.candidateGroups.length,
                    candidateGroupsJson: JSON.stringify(candidateGroupsForPrompt, null, 2),
                  }),
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "approved_events_master_review",
              strict: true,
              schema: approvedEventMasterReviewJsonSchema,
            },
          },
        }),
        cache: "no-store",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI master review failed: ${response.status} ${response.statusText} - ${errorBody}`,
        );
      }

      const payload = (await response.json()) as {
        output_text?: string;
        output?: Array<{
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };

      const responseText =
        payload.output_text ??
        payload.output
          ?.flatMap((outputItem) => outputItem.content ?? [])
          .map((contentItem) => contentItem.text ?? "")
          .find((text) => text.trim().length > 0);

      if (!responseText) {
        throw new Error("OpenAI master review returned an empty response payload.");
      }

      const parsedJson = JSON.parse(responseText) as unknown;
      const parsed = approvedEventMasterReviewSchema.parse(parsedJson);
      const reviewGroups: ApprovedEventMasterReviewGroup[] = [];

      for (const group of parsed.review_groups) {
        const candidateGroup = candidateGroupById.get(group.group_id);
        if (!candidateGroup) {
          continue;
        }

        const candidateEventIds = new Set(candidateGroup.eventIds);
        const normalizedDuplicateIds = [
          ...new Set(group.duplicate_event_ids.filter((id) => candidateEventIds.has(id))),
        ];

        const preferredPrimaryId = candidateEventIds.has(group.primary_event_id)
          ? group.primary_event_id
          : candidateGroup.eventIds.find((id) => !normalizedDuplicateIds.includes(id)) ??
            candidateGroup.eventIds[0];

        const finalDuplicateIds = normalizedDuplicateIds.filter((id) => id !== preferredPrimaryId);
        if (!preferredPrimaryId || finalDuplicateIds.length === 0) {
          continue;
        }

        reviewGroups.push({
          groupId: candidateGroup.groupId,
          confidence: normalizeConfidenceValue(group.confidence),
          reasoning: group.reasoning.trim(),
          recommendedAction: group.recommended_action,
          primaryEventId: preferredPrimaryId,
          duplicateEventIds: finalDuplicateIds,
          primaryPatch: sanitizePatch(group.primary_patch),
        });
      }

      reviewGroups.sort(
        (left, right) => (right.confidence ?? Number.NEGATIVE_INFINITY) - (left.confidence ?? Number.NEGATIVE_INFINITY),
      );

      return {
        overview: parsed.overview.trim(),
        activeEventCount: options.events.length,
        candidateGroupCount: options.candidateGroups.length,
        reviewGroups,
      };
    } catch (error) {
      lastError = error;
      if (attempt < APPROVED_EVENTS_REVIEW_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 800));
      }
    }
  }

  const errorMessage =
    lastError instanceof Error ? lastError.message : "Unknown OpenAI master review error.";
  throw new Error(errorMessage);
}
