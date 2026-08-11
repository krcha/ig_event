import { z } from "zod";
import { getOpenAiModelEnv, getRequiredEnv } from "@/lib/utils/env";
import {
  buildEventExtractionUserPrompt,
  EVENT_EXTRACTION_SYSTEM_PROMPT,
} from "./event-extraction-prompt";


const OPENAI_REQUEST_TIMEOUT_MS = 40000;

export class OpenAiProviderBlockedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenAiProviderBlockedError";
    this.status = status;
  }
}

export function isOpenAiProviderBlockedError(
  error: unknown,
): error is OpenAiProviderBlockedError {
  return error instanceof OpenAiProviderBlockedError;
}

export class OpenAiPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiPermanentError";
  }
}

export function isOpenAiPermanentError(error: unknown): error is OpenAiPermanentError {
  return error instanceof OpenAiPermanentError;
}

export class OpenAiTransientError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenAiTransientError";
    this.status = status;
  }
}

export function classifyOpenAiHttpFailure(
  status: number,
  errorBody: string,
): "blocked" | "transient" | "permanent" {
  if (status === 401 || status === 403) return "blocked";
  if (status === 429) {
    const normalized = errorBody.toLocaleLowerCase();
    if (
      normalized.includes("insufficient_quota") ||
      normalized.includes("billing_hard_limit") ||
      normalized.includes("billing") ||
      normalized.includes("quota") ||
      normalized.includes("credit balance")
    ) {
      return "blocked";
    }
    return "transient";
  }
  if (status === 408 || status === 409 || status >= 500) return "transient";
  return "permanent";
}

function isTransientOpenAiFailure(error: unknown): boolean {
  return (
    error instanceof OpenAiTransientError ||
    (error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name))
  );
}

const extractionEvidenceSnippetSchema = z.object({
  source: z.union([
    z.literal("caption"),
    z.literal("poster"),
    z.literal("alt_text"),
    z.literal("location_tag"),
    z.literal("canonical_hint"),
    z.literal("handle_context"),
    z.literal("inference"),
  ]),
  text: z.string(),
});

const extractionFieldConfirmationSchema = z.object({
  confidence: z.union([z.number(), z.string()]),
  found_in: z.array(z.string()).default([]),
  evidence: z.string(),
  evidence_snippets: z.array(extractionEvidenceSnippetSchema).default([]),
  notes: z.string(),
});

const extractionEvidenceSourceSchema = z.enum([
  "caption",
  "poster",
  "alt_text",
  "unknown",
]);

const extractionDateEvidenceSchema = z.object({
  exact_text: z.string(),
  source: extractionEvidenceSourceSchema,
  is_relative: z.boolean(),
  resolved_date: z.string(),
});

const extractionTimeEvidenceSchema = z.object({
  status: z.enum([
    "start_time_stated",
    "not_stated",
    "unreadable",
    "doors_open_only",
  ]),
  exact_text: z.string(),
  source: extractionEvidenceSourceSchema,
});

const extractionSourceConflictSchema = z.object({
  field: z.enum(["date", "time", "venue", "title", "artists"]),
  poster_value: z.string(),
  caption_value: z.string(),
  reason: z.string(),
});

const extractionSharedContextSchema = z.object({
  applies_to_all: z.boolean(),
  value: z.string(),
  evidence: z.string(),
  source: extractionEvidenceSourceSchema,
});

const extractedScheduleEntrySchema = z.object({
  date: z.string(),
  time: z.string(),
  venue: z.string(),
  title: z.string(),
  artists: z.array(z.string()).default([]),
  description: z.string(),
  source_text: z.string(),
  date_evidence: extractionDateEvidenceSchema,
  time_evidence: extractionTimeEvidenceSchema,
});

const openAiUsageSchema = z.object({
  model: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

const extractedEventSchema = z
  .object({
    extraction_contract_version: z.literal("event_evidence_v2"),
    is_event: z.boolean(),
    non_event_reason: z.string(),
    title: z.string(),
    date: z.string(),
    time: z.string(),
    venue: z.string(),
    city: z.string(),
    country: z.string(),
    price: z.string(),
    currency: z.string(),
    artists: z.array(z.string()).default([]),
    category: z.string(),
    description: z.string(),
    confidence: z.union([z.number(), z.string()]),
    reasoning_notes: z.string(),
    source_caption: z.string(),
    source_url: z.string(),
    date_evidence: extractionDateEvidenceSchema,
    time_evidence: extractionTimeEvidenceSchema,
    source_conflicts: z.array(extractionSourceConflictSchema),
    shared_schedule_context: z.object({
      venue: extractionSharedContextSchema,
      time: extractionSharedContextSchema,
    }),
    schedule_entries: z.array(extractedScheduleEntrySchema).default([]),
    // Added by our transport wrapper after the provider's strict structured
    // output has been parsed. Keeping it in the durable parser preserves the
    // exact cached JSON used by the Convex approval attestation.
    _openaiUsage: openAiUsageSchema.optional(),
    field_confirmation: z.object({
      title: extractionFieldConfirmationSchema,
      location: extractionFieldConfirmationSchema,
      location_name: extractionFieldConfirmationSchema,
      price: extractionFieldConfirmationSchema,
      start_time: extractionFieldConfirmationSchema,
      short_description: extractionFieldConfirmationSchema,
      artists: extractionFieldConfirmationSchema,
    }),
  })
  .superRefine((value, context) => {
    const hasNonEventReason = value.non_event_reason.trim().length > 0;
    if (!value.is_event && !hasNonEventReason) {
      context.addIssue({
        code: "custom",
        path: ["non_event_reason"],
        message: "A non-event extraction must include a reason.",
      });
    }
    if (value.is_event && hasNonEventReason) {
      context.addIssue({
        code: "custom",
        path: ["non_event_reason"],
        message: "An event extraction must leave non_event_reason empty.",
      });
    }
  });

export type ExtractedEventData = z.infer<typeof extractedEventSchema>;

export function parseExtractedEventData(value: unknown): ExtractedEventData {
  return extractedEventSchema.parse(value);
}

type ExtractEventDataOptions = {
  imageDataUrl?: string | null;
  imageDataUrls?: string[];
  caption?: string | null;
  altText?: string | null;
  instagramPostUrl: string;
  sourceImageUrl?: string | null;
  instagramHandle: string;
  instagramPostTimestamp?: string | null;
  instagramLocationName?: string | null;
  canonicalVenueName?: string | null;
  extractionMode?: "poster" | "caption_only";
  beforeTransport?: () => Promise<void>;
  onTransportStarted?: () => void;
};

const extractionEvidenceSourceJsonSchema = {
  type: "string",
  enum: ["caption", "poster", "alt_text", "unknown"],
} as const;

const extractionDateEvidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    exact_text: { type: "string" },
    source: extractionEvidenceSourceJsonSchema,
    is_relative: { type: "boolean" },
    resolved_date: { type: "string" },
  },
  required: ["exact_text", "source", "is_relative", "resolved_date"],
} as const;

const extractionTimeEvidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: [
        "start_time_stated",
        "not_stated",
        "unreadable",
        "doors_open_only",
      ],
    },
    exact_text: { type: "string" },
    source: extractionEvidenceSourceJsonSchema,
  },
  required: ["status", "exact_text", "source"],
} as const;

const extractionSharedContextJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    applies_to_all: { type: "boolean" },
    value: { type: "string" },
    evidence: { type: "string" },
    source: extractionEvidenceSourceJsonSchema,
  },
  required: ["applies_to_all", "value", "evidence", "source"],
} as const;

const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    extraction_contract_version: {
      type: "string",
      enum: ["event_evidence_v2"],
    },
    is_event: { type: "boolean" },
    non_event_reason: { type: "string" },
    title: { type: "string" },
    date: { type: "string" },
    time: { type: "string" },
    venue: { type: "string" },
    city: { type: "string" },
    country: { type: "string" },
    price: { type: "string" },
    currency: { type: "string" },
    artists: {
      type: "array",
      items: { type: "string" },
    },
    category: { type: "string" },
    description: { type: "string" },
    confidence: { type: ["number", "string"] },
    reasoning_notes: { type: "string" },
    source_caption: { type: "string" },
    source_url: { type: "string" },
    date_evidence: extractionDateEvidenceJsonSchema,
    time_evidence: extractionTimeEvidenceJsonSchema,
    source_conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: {
            type: "string",
            enum: ["date", "time", "venue", "title", "artists"],
          },
          poster_value: { type: "string" },
          caption_value: { type: "string" },
          reason: { type: "string" },
        },
        required: ["field", "poster_value", "caption_value", "reason"],
      },
    },
    shared_schedule_context: {
      type: "object",
      additionalProperties: false,
      properties: {
        venue: extractionSharedContextJsonSchema,
        time: extractionSharedContextJsonSchema,
      },
      required: ["venue", "time"],
    },
    schedule_entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          date: { type: "string" },
          time: { type: "string" },
          venue: { type: "string" },
          title: { type: "string" },
          artists: {
            type: "array",
            items: { type: "string" },
          },
          description: { type: "string" },
          source_text: { type: "string" },
          date_evidence: extractionDateEvidenceJsonSchema,
          time_evidence: extractionTimeEvidenceJsonSchema,
        },
        required: [
          "date",
          "time",
          "venue",
          "title",
          "artists",
          "description",
          "source_text",
          "date_evidence",
          "time_evidence",
        ],
      },
    },
    field_confirmation: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
            evidence_snippets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: {
                    type: "string",
                    enum: [
                      "caption",
                      "poster",
                      "alt_text",
                      "location_tag",
                      "canonical_hint",
                      "handle_context",
                      "inference",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["source", "text"],
              },
            },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
        },
        location: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
            evidence_snippets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: {
                    type: "string",
                    enum: [
                      "caption",
                      "poster",
                      "alt_text",
                      "location_tag",
                      "canonical_hint",
                      "handle_context",
                      "inference",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["source", "text"],
              },
            },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
        },
        location_name: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
            evidence_snippets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: {
                    type: "string",
                    enum: [
                      "caption",
                      "poster",
                      "alt_text",
                      "location_tag",
                      "canonical_hint",
                      "handle_context",
                      "inference",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["source", "text"],
              },
            },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
        },
        price: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
            evidence_snippets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: {
                    type: "string",
                    enum: [
                      "caption",
                      "poster",
                      "alt_text",
                      "location_tag",
                      "canonical_hint",
                      "handle_context",
                      "inference",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["source", "text"],
              },
            },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
        },
        start_time: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
            evidence_snippets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: {
                    type: "string",
                    enum: [
                      "caption",
                      "poster",
                      "alt_text",
                      "location_tag",
                      "canonical_hint",
                      "handle_context",
                      "inference",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["source", "text"],
              },
            },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
        },
        short_description: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
            evidence_snippets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: {
                    type: "string",
                    enum: [
                      "caption",
                      "poster",
                      "alt_text",
                      "location_tag",
                      "canonical_hint",
                      "handle_context",
                      "inference",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["source", "text"],
              },
            },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
        },
        artists: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
            evidence_snippets: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: {
                    type: "string",
                    enum: [
                      "caption",
                      "poster",
                      "alt_text",
                      "location_tag",
                      "canonical_hint",
                      "handle_context",
                      "inference",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["source", "text"],
              },
            },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
        },
      },
      required: [
        "title",
        "location",
        "location_name",
        "price",
        "start_time",
        "short_description",
        "artists",
      ],
    },
  },
  required: [
    "extraction_contract_version",
    "is_event",
    "non_event_reason",
    "title",
    "date",
    "time",
    "venue",
    "city",
    "country",
    "price",
    "currency",
    "artists",
    "category",
    "description",
    "confidence",
    "reasoning_notes",
    "source_caption",
    "source_url",
    "date_evidence",
    "time_evidence",
    "source_conflicts",
    "shared_schedule_context",
    "schedule_entries",
    "field_confirmation",
  ],
} as const;

export async function extractEventDataFromInstagramPost(
  options: ExtractEventDataOptions,
): Promise<ExtractedEventData> {
  const openAiApiKey = getRequiredEnv("OPENAI_API_KEY");
  const openAiVisionModel = getOpenAiModelEnv("OPENAI_VISION_MODEL");
  let lastError: unknown;

  // A source revision owns exactly one paid transport. Cross-process retries
  // are driven by the durable analysis artifact; repeating an ambiguous
  // transport here would defeat that generation boundary.
  const maxAttempts = 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);
    try {
      const userContent: Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string; detail: "high" }
      > = [
        {
          type: "input_text",
          text: buildEventExtractionUserPrompt({
            instagramHandle: options.instagramHandle,
            instagramPostUrl: options.instagramPostUrl,
            instagramPostTimestamp: options.instagramPostTimestamp,
            instagramCaption: options.caption,
            instagramAltText: options.altText,
            instagramLocationName: options.instagramLocationName,
            canonicalVenueName: options.canonicalVenueName,
            sourceImageUrl: options.sourceImageUrl,
            extractionMode: options.extractionMode,
          }),
        },
      ];

      const imageDataUrls = [
        ...(options.imageDataUrls ?? []),
        options.imageDataUrl,
      ].filter((value): value is string => Boolean(value));
      for (const imageDataUrl of [...new Set(imageDataUrls)]) {
        userContent.push({
          type: "input_image",
          image_url: imageDataUrl,
          detail: "high",
        });
      }

      await options.beforeTransport?.();
      options.onTransportStarted?.();
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: openAiVisionModel,
          max_output_tokens: 4096,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: EVENT_EXTRACTION_SYSTEM_PROMPT }],
            },
            {
              role: "user",
              content: userContent,
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "nightlife_event_extraction",
              strict: true,
              schema: extractionJsonSchema,
            },
          },
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text();
        const message =
          `OpenAI extraction failed: ${response.status} ${response.statusText} - ${errorBody}`;
        const classification = classifyOpenAiHttpFailure(response.status, errorBody);
        if (classification === "blocked") {
          throw new OpenAiProviderBlockedError(response.status, message);
        }
        if (classification === "transient") {
          throw new OpenAiTransientError(response.status, message);
        }
        throw new OpenAiPermanentError(message);
      }

      const payload = (await response.json()) as {
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
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
        throw new Error("OpenAI extraction returned an empty response payload.");
      }

      const parsedJson = JSON.parse(responseText) as unknown;
      const parsed = parseExtractedEventData(parsedJson);
      return {
        ...parsed,
        source_caption: options.caption ?? "",
        source_url: options.instagramPostUrl,
        _openaiUsage: {
          model: payload.model ?? openAiVisionModel,
          inputTokens: payload.usage?.input_tokens,
          outputTokens: payload.usage?.output_tokens,
          totalTokens: payload.usage?.total_tokens,
        },
      };
    } catch (error) {
      lastError = error;
      if (isOpenAiProviderBlockedError(error)) {
        break;
      }
      if (!isTransientOpenAiFailure(error)) {
        lastError = isOpenAiPermanentError(error)
          ? error
          : new OpenAiPermanentError(
              error instanceof Error ? error.message : "Permanent OpenAI response/schema failure.",
            );
        break;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (isOpenAiProviderBlockedError(lastError)) {
    throw lastError;
  }
  if (isOpenAiPermanentError(lastError)) {
    throw lastError;
  }
  const errorMessage =
    lastError instanceof Error ? lastError.message : "Unknown OpenAI extraction error.";
  throw new Error(errorMessage);
}

export async function extractEventDataFromPoster(
  options: ExtractEventDataOptions & { imageDataUrl: string },
): Promise<ExtractedEventData> {
  return extractEventDataFromInstagramPost({
    ...options,
    extractionMode: options.extractionMode ?? "poster",
  });
}
