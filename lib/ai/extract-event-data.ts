import { z } from "zod";
import { getOpenAiModelEnv, getRequiredEnv } from "@/lib/utils/env";
import {
  buildEventExtractionUserPrompt,
  CAROUSEL_EVENT_EXTRACTION_SYSTEM_PROMPT,
  EVENT_EXTRACTION_SYSTEM_PROMPT,
} from "./event-extraction-prompt";
import type { OpenAiDefinitiveOutputFailureKind } from "./openai-analysis-protocol";
import {
  CAROUSEL_EXTRACTION_CONTRACT_VERSION,
  carouselMediaBindingSchema,
  MAX_CAROUSEL_EXTRACTION_IMAGES,
  parseCarouselMediaBinding,
  type CarouselImageBinding,
} from "./carousel-media-contract";

// GPT-5 mini structured vision responses can legitimately take longer than
// 40 seconds on production poster inputs. Keep this comfortably inside the
// 300-second executor request and receipt lease while avoiding false
// transport ambiguity caused by aborting a healthy provider response.
export const OPENAI_REQUEST_TIMEOUT_MS = 120_000;
// The evidence-v2 schema includes per-row evidence for multi-event posters.
// Production multi-event posters reached both the former 4,096- and
// 8,192-token caps and were returned as definitive `incomplete` responses, so
// reserve enough output for the bounded schedule schema without relaxing any
// parsing or approval rules.
export const OPENAI_EXTRACTION_MAX_OUTPUT_TOKENS = 16_384;
export const EVENT_EXTRACTION_POLICY_VERSION = "event_quality_v1";

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

type OpenAiOutputFailureMetadata = {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export class OpenAiDefinitiveOutputError extends OpenAiPermanentError {
  readonly kind: OpenAiDefinitiveOutputFailureKind;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;

  constructor(
    kind: OpenAiDefinitiveOutputFailureKind,
    message: string,
    metadata: OpenAiOutputFailureMetadata,
  ) {
    super(message);
    this.name = "OpenAiDefinitiveOutputError";
    this.kind = kind;
    this.model = metadata.model;
    this.inputTokens = metadata.inputTokens;
    this.outputTokens = metadata.outputTokens;
    this.reasoningTokens = metadata.reasoningTokens;
    this.totalTokens = metadata.totalTokens;
  }
}

export function isOpenAiDefinitiveOutputError(
  error: unknown,
): error is OpenAiDefinitiveOutputError {
  return error instanceof OpenAiDefinitiveOutputError;
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
  slide_index: z.number().int().min(0).max(19).nullable().optional(),
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
  slide_index: z.number().int().min(0).max(19).nullable().optional(),
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
  slide_index: z.number().int().min(0).max(19).nullable().optional(),
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
  source_slide_indexes: z.array(z.number().int().min(0).max(19)).max(20).optional(),
  poster_evidence: z.array(z.object({
    slide_index: z.number().int().min(0).max(19),
    text: z.string().min(1).max(200),
  })).max(24).optional(),
  text_evidence: z.array(z.object({
    source: z.enum(["caption", "alt_text"]),
    text: z.string().min(1).max(200),
  })).max(8).optional(),
  source_conflicts: z.array(extractionSourceConflictSchema).optional(),
  category: z.string().optional(),
  price: z.string().optional(),
  currency: z.string().optional(),
});

const openAiUsageSchema = z.object({
  model: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

const imageCoverageSchema = z.object({
  version: z.literal(1),
  knownSlideCount: z.number().int().nonnegative(),
  analyzedSlideIndexes: z.array(z.number().int().nonnegative()),
  unanalyzedSlideIndexes: z.array(z.number().int().nonnegative()),
  videoSlideIndexes: z.array(z.number().int().nonnegative()).optional(),
  complete: z.boolean(),
  manifestKnown: z.boolean(),
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
    // Wrapper-owned policy marker. Its absence preserves cached v2 semantics.
    _extractionPolicyVersion: z.literal(EVENT_EXTRACTION_POLICY_VERSION).optional(),
    _imageCoverage: imageCoverageSchema.optional(),
    _carouselContractVersion: z.literal(CAROUSEL_EXTRACTION_CONTRACT_VERSION).optional(),
    _carouselMedia: carouselMediaBindingSchema.optional(),
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
    if (Boolean(value._carouselContractVersion) !== Boolean(value._carouselMedia)) {
      context.addIssue({ code: "custom", path: ["_carouselMedia"],
        message: "Carousel evidence requires the exact caller-owned media binding." });
    }
    if (!value._carouselContractVersion || !value._carouselMedia) return;
    if (value._extractionPolicyVersion !== EVENT_EXTRACTION_POLICY_VERSION) {
      context.addIssue({ code: "custom", path: ["_extractionPolicyVersion"],
        message: "Carousel evidence must use the current source-validation policy." });
    }
    if (value.is_event !== (value.schedule_entries.length > 0)) {
      context.addIssue({ code: "custom", path: ["schedule_entries"],
        message: "Carousel event analyses require occurrence rows; non-events must have none." });
    }
    const boundIndexes = new Set(value._carouselMedia.images.map((image) => image.slideIndex));
    for (const [field, evidence] of [["date_evidence", value.date_evidence],
      ["time_evidence", value.time_evidence],
      ["shared_schedule_context.venue", value.shared_schedule_context.venue],
      ["shared_schedule_context.time", value.shared_schedule_context.time]] as const) {
      if (evidence.slide_index === undefined || (evidence.source === "poster"
        ? evidence.slide_index === null || !boundIndexes.has(evidence.slide_index)
        : evidence.slide_index !== null)) {
        context.addIssue({ code: "custom", path: [field, "slide_index"],
          message: "Poster context must identify a submitted slide; other sources use null." });
      }
    }
    if (value.source_conflicts.length > 0) {
      context.addIssue({ code: "custom", path: ["source_conflicts"],
        message: "Carousel conflicts must be scoped to the affected occurrence." });
    }
    for (const [rowIndex, row] of value.schedule_entries.entries()) {
      const path = ["schedule_entries", rowIndex];
      if (!row.source_slide_indexes || !row.poster_evidence || !row.text_evidence || !row.source_conflicts ||
        row.category === undefined || row.price === undefined || row.currency === undefined) {
        context.addIssue({ code: "custom", path,
          message: "Carousel rows require independently scoped fields and evidence." });
        continue;
      }
      const rowIndexes = new Set(row.source_slide_indexes);
      if (rowIndexes.size !== row.source_slide_indexes.length ||
        row.source_slide_indexes.some((index) => !boundIndexes.has(index))) {
        context.addIssue({ code: "custom", path: [...path, "source_slide_indexes"],
          message: "Every row slide must have been retained and submitted." });
      }
      for (const [field, evidence] of [["date_evidence", row.date_evidence],
        ["time_evidence", row.time_evidence]] as const) {
        if (evidence.slide_index === undefined ||
          (evidence.source === "poster"
            ? evidence.slide_index === null || !rowIndexes.has(evidence.slide_index)
            : evidence.slide_index !== null)) {
          context.addIssue({ code: "custom", path: [...path, field, "slide_index"],
            message: "Poster field evidence must identify its submitted row slide; other sources use null." });
        }
      }
      for (const [evidenceIndex, evidence] of row.poster_evidence.entries()) {
        if (!rowIndexes.has(evidence.slide_index)) {
          context.addIssue({ code: "custom", path: [...path, "poster_evidence", evidenceIndex],
            message: "Poster snippets must belong to this occurrence's submitted slides." });
        }
      }
    }
  });

export type ExtractedEventData = z.infer<typeof extractedEventSchema>;

export function parseExtractedEventData(value: unknown): ExtractedEventData {
  return extractedEventSchema.parse(value);
}

type ExtractEventDataOptions = {
  imageDataUrl?: string | null;
  imageDataUrls?: string[];
  carouselImages?: CarouselImageBinding[];
  carouselKnownSlideCount?: number;
  imageCoverage?: {
    version: 1;
    knownSlideCount: number;
    analyzedSlideIndexes: number[];
    unanalyzedSlideIndexes: number[];
    videoSlideIndexes?: number[];
    complete: boolean;
    manifestKnown: boolean;
  };
  caption?: string | null;
  altText?: string | null;
  instagramPostUrl: string;
  sourceImageUrl?: string | null;
  instagramHandle: string;
  instagramPostTimestamp?: string | null;
  instagramLocationName?: string | null;
  canonicalVenueName?: string | null;
  instagramSourceRole?: "venue" | "promoter" | "unknown";
  instagramSourceName?: string | null;
  extractionMode?: "poster" | "caption_only";
  beforeTransport?: () => Promise<void>;
  onTransportStarted?: () => void;
};

const extractionEvidenceSourceJsonSchema = {
  type: "string",
  enum: ["caption", "poster", "alt_text", "unknown"],
} as const;

// Structured Outputs supports string patterns for base GPT-5 models. Use
// anchored all-character patterns instead of unsupported maxLength keywords;
// exact evidence remains byte-for-byte unchanged after the provider returns.
const emptyStringJsonSchema = {
  type: "string",
  pattern: "^$",
} as const;
const compact80StringJsonSchema = {
  type: "string",
  pattern: "^[\\s\\S]{0,80}$",
} as const;
const compact120StringJsonSchema = {
  type: "string",
  pattern: "^[\\s\\S]{0,120}$",
} as const;
const compact160StringJsonSchema = {
  type: "string",
  pattern: "^[\\s\\S]{0,160}$",
} as const;
const compact200StringJsonSchema = {
  type: "string",
  pattern: "^[\\s\\S]{0,200}$",
} as const;
const compact240StringJsonSchema = {
  type: "string",
  pattern: "^[\\s\\S]{0,240}$",
} as const;

const extractionDateEvidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    exact_text: compact200StringJsonSchema,
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
    exact_text: compact200StringJsonSchema,
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
    evidence: compact200StringJsonSchema,
    source: extractionEvidenceSourceJsonSchema,
  },
  required: ["applies_to_all", "value", "evidence", "source"],
} as const;

const extractionFieldConfirmationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    confidence: { type: ["number", "string"] },
    found_in: {
      type: "array",
      maxItems: 2,
      items: { type: "string" },
    },
    evidence: compact160StringJsonSchema,
    evidence_snippets: {
      type: "array",
      maxItems: 1,
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
          text: compact160StringJsonSchema,
        },
        required: ["source", "text"],
      },
    },
    notes: compact80StringJsonSchema,
  },
  required: ["confidence", "found_in", "evidence", "evidence_snippets", "notes"],
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
    non_event_reason: compact160StringJsonSchema,
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
      maxItems: 64,
      items: { type: "string" },
    },
    category: { type: "string" },
    description: compact240StringJsonSchema,
    confidence: { type: ["number", "string"] },
    reasoning_notes: compact160StringJsonSchema,
    source_caption: emptyStringJsonSchema,
    source_url: emptyStringJsonSchema,
    date_evidence: extractionDateEvidenceJsonSchema,
    time_evidence: extractionTimeEvidenceJsonSchema,
    source_conflicts: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: {
            type: "string",
            enum: ["date", "time", "venue", "title", "artists"],
          },
          poster_value: compact200StringJsonSchema,
          caption_value: compact200StringJsonSchema,
          reason: compact120StringJsonSchema,
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
      maxItems: 64,
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
            maxItems: 64,
            items: { type: "string" },
          },
          description: compact240StringJsonSchema,
          source_text: compact200StringJsonSchema,
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
        title: extractionFieldConfirmationJsonSchema,
        location: extractionFieldConfirmationJsonSchema,
        location_name: extractionFieldConfirmationJsonSchema,
        price: extractionFieldConfirmationJsonSchema,
        start_time: extractionFieldConfirmationJsonSchema,
        short_description: extractionFieldConfirmationJsonSchema,
        artists: extractionFieldConfirmationJsonSchema,
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

const nullableSlideIndexJsonSchema = {
  type: ["integer", "null"], minimum: 0, maximum: MAX_CAROUSEL_EXTRACTION_IMAGES - 1,
} as const;
const carouselDateEvidenceJsonSchema = {
  ...extractionDateEvidenceJsonSchema,
  properties: { ...extractionDateEvidenceJsonSchema.properties, slide_index: nullableSlideIndexJsonSchema },
  required: [...extractionDateEvidenceJsonSchema.required, "slide_index"],
} as const;
const carouselTimeEvidenceJsonSchema = {
  ...extractionTimeEvidenceJsonSchema,
  properties: { ...extractionTimeEvidenceJsonSchema.properties, slide_index: nullableSlideIndexJsonSchema },
  required: [...extractionTimeEvidenceJsonSchema.required, "slide_index"],
} as const;
const carouselSharedContextJsonSchema = {
  ...extractionSharedContextJsonSchema,
  properties: { ...extractionSharedContextJsonSchema.properties, slide_index: nullableSlideIndexJsonSchema },
  required: [...extractionSharedContextJsonSchema.required, "slide_index"],
} as const;
const carouselExtractionJsonSchema = {
  ...extractionJsonSchema,
  properties: {
    ...extractionJsonSchema.properties,
    source_conflicts: { ...extractionJsonSchema.properties.source_conflicts, maxItems: 0 },
    date_evidence: carouselDateEvidenceJsonSchema,
    time_evidence: carouselTimeEvidenceJsonSchema,
    shared_schedule_context: {
      ...extractionJsonSchema.properties.shared_schedule_context,
      properties: { venue: carouselSharedContextJsonSchema, time: carouselSharedContextJsonSchema },
    },
    schedule_entries: {
      ...extractionJsonSchema.properties.schedule_entries,
      items: {
        ...extractionJsonSchema.properties.schedule_entries.items,
        properties: {
          ...extractionJsonSchema.properties.schedule_entries.items.properties,
          date_evidence: carouselDateEvidenceJsonSchema,
          time_evidence: carouselTimeEvidenceJsonSchema,
          source_slide_indexes: { type: "array", maxItems: 20,
            items: { type: "integer", minimum: 0, maximum: 19 } },
          poster_evidence: { type: "array", maxItems: 24, items: {
            type: "object", additionalProperties: false,
            properties: { slide_index: { type: "integer", minimum: 0, maximum: 19 },
              text: compact200StringJsonSchema }, required: ["slide_index", "text"],
          } },
          text_evidence: { type: "array", maxItems: 8, items: {
            type: "object", additionalProperties: false,
            properties: { source: { type: "string", enum: ["caption", "alt_text"] },
              text: compact200StringJsonSchema }, required: ["source", "text"],
          } },
          source_conflicts: extractionJsonSchema.properties.source_conflicts,
          category: extractionJsonSchema.properties.category,
          price: extractionJsonSchema.properties.price,
          currency: extractionJsonSchema.properties.currency,
        },
        required: [...extractionJsonSchema.properties.schedule_entries.items.required,
          "source_slide_indexes", "poster_evidence", "text_evidence", "source_conflicts", "category", "price", "currency"],
      },
    },
  },
} as const;

export async function extractEventDataFromInstagramPost(
  options: ExtractEventDataOptions,
): Promise<ExtractedEventData> {
  const carouselMedia = options.carouselImages === undefined ? undefined : parseCarouselMediaBinding({
    version: 1, knownSlideCount: options.carouselKnownSlideCount, images: options.carouselImages,
  });
  if (carouselMedia && options.imageDataUrls?.length !== carouselMedia.images.length) {
    throw new OpenAiPermanentError("Each retained carousel image requires exactly one ordered transport image.");
  }
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
            instagramSourceRole: options.instagramSourceRole,
            instagramSourceName: options.instagramSourceName,
            sourceImageUrl: options.sourceImageUrl,
            extractionMode: options.extractionMode,
            carouselSlideIndexes: carouselMedia?.images.map((image) => image.slideIndex),
            carouselKnownSlideCount: carouselMedia?.knownSlideCount,
          }),
        },
      ];

      const imageDataUrls = carouselMedia ? options.imageDataUrls! : [
        ...(options.imageDataUrls ?? []),
        options.imageDataUrl,
      ].filter((value): value is string => Boolean(value));
      const submittedImageDataUrls = carouselMedia ? imageDataUrls : [...new Set(imageDataUrls)];
      for (const [index, imageDataUrl] of submittedImageDataUrls.entries()) {
        if (carouselMedia && !imageDataUrl.startsWith("data:image/")) {
          throw new OpenAiPermanentError("Extraction requires decoded image data for every submitted slide.");
        }
        if (carouselMedia) userContent.push({ type: "input_text",
          text: `SLIDE ${carouselMedia.images[index].slideIndex} (zero-based original carousel index). The next image is this slide only.` });
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
          max_output_tokens: OPENAI_EXTRACTION_MAX_OUTPUT_TOKENS,
          reasoning: { effort: "medium" },
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: carouselMedia
                ? `${EVENT_EXTRACTION_SYSTEM_PROMPT}\n\n${CAROUSEL_EVENT_EXTRACTION_SYSTEM_PROMPT}`
                : EVENT_EXTRACTION_SYSTEM_PROMPT }],
            },
            {
              role: "user",
              content: userContent,
            },
          ],
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: "nightlife_event_extraction",
              strict: true,
              schema: carouselMedia ? carouselExtractionJsonSchema : extractionJsonSchema,
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

      const responseBody = await response.text();
      let payload: {
        status?: string;
        incomplete_details?: { reason?: string } | null;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          output_tokens_details?: { reasoning_tokens?: number };
          total_tokens?: number;
        };
        output_text?: string;
        output?: Array<{
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };
      try {
        payload = JSON.parse(responseBody) as typeof payload;
      } catch {
        throw new OpenAiDefinitiveOutputError(
          "invalid_json",
          "OpenAI extraction returned an invalid JSON response envelope.",
          { model: openAiVisionModel },
        );
      }

      const responseMetadata: OpenAiOutputFailureMetadata = {
        model: payload.model ?? openAiVisionModel,
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
        reasoningTokens: payload.usage?.output_tokens_details?.reasoning_tokens,
        totalTokens: payload.usage?.total_tokens,
      };
      if (
        payload.status === "incomplete" &&
        payload.incomplete_details?.reason === "max_output_tokens"
      ) {
        throw new OpenAiDefinitiveOutputError(
          "incomplete_max_output_tokens",
          `OpenAI extraction reached the ${OPENAI_EXTRACTION_MAX_OUTPUT_TOKENS}-token output cap.`,
          responseMetadata,
        );
      }
      if (payload.status === "incomplete") {
        throw new OpenAiPermanentError(
          `OpenAI extraction was incomplete (${payload.incomplete_details?.reason ?? "unknown_reason"}).`,
        );
      }
      if (payload.status === "failed") {
        throw new OpenAiPermanentError("OpenAI extraction response reported a failed status.");
      }

      const responseText =
        payload.output_text ??
        payload.output
          ?.flatMap((outputItem) => outputItem.content ?? [])
          .map((contentItem) => contentItem.text ?? "")
          .find((text) => text.trim().length > 0);

      if (!responseText) {
        throw new OpenAiDefinitiveOutputError(
          "empty_output",
          "OpenAI extraction returned an empty output payload.",
          responseMetadata,
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(responseText) as unknown;
      } catch {
        throw new OpenAiDefinitiveOutputError(
          "invalid_json",
          "OpenAI extraction output was not valid JSON.",
          responseMetadata,
        );
      }
      let parsed: ExtractedEventData;
      try {
        parsed = parseExtractedEventData(carouselMedia && parsedJson && typeof parsedJson === "object"
          ? { ...parsedJson, _extractionPolicyVersion: EVENT_EXTRACTION_POLICY_VERSION,
              _carouselContractVersion: CAROUSEL_EXTRACTION_CONTRACT_VERSION,
              _carouselMedia: carouselMedia }
          : parsedJson);
      } catch {
        throw new OpenAiDefinitiveOutputError(
          "invalid_schema",
          "OpenAI extraction output did not satisfy the event-evidence schema.",
          responseMetadata,
        );
      }
      return {
        ...parsed,
        _extractionPolicyVersion: EVENT_EXTRACTION_POLICY_VERSION,
        ...(options.imageCoverage ? { _imageCoverage: options.imageCoverage } : {}),
        source_caption: options.caption ?? "",
        source_url: options.instagramPostUrl,
        _openaiUsage: {
          model: responseMetadata.model,
          inputTokens: responseMetadata.inputTokens,
          outputTokens: responseMetadata.outputTokens,
          reasoningTokens: responseMetadata.reasoningTokens,
          totalTokens: responseMetadata.totalTokens,
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
