import { z } from "zod";
import { getRequiredEnv } from "@/lib/utils/env";
import {
  buildEventExtractionUserPrompt,
  EVENT_EXTRACTION_SYSTEM_PROMPT,
} from "./event-extraction-prompt";

const openAiVisionModel = process.env.OPENAI_VISION_MODEL ?? "gpt-5.4";
const OPENAI_REQUEST_TIMEOUT_MS = 40000;
const OPENAI_MAX_ATTEMPTS = 2;
const extractionFieldConfirmationSchema = z.object({
  confidence: z.union([z.number(), z.string()]),
  found_in: z.array(z.string()).default([]),
  notes: z.string(),
});

const extractedScheduleEntrySchema = z.object({
  date: z.string(),
  time: z.string(),
  title: z.string(),
  artists: z.array(z.string()).default([]),
  description: z.string(),
  source_text: z.string(),
});

const extractedEventSchema = z.object({
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
  schedule_entries: z.array(extractedScheduleEntrySchema).default([]),
  field_confirmation: z.object({
    title: extractionFieldConfirmationSchema,
    location: extractionFieldConfirmationSchema,
    location_name: extractionFieldConfirmationSchema,
    price: extractionFieldConfirmationSchema,
    start_time: extractionFieldConfirmationSchema,
    short_description: extractionFieldConfirmationSchema,
    artists: extractionFieldConfirmationSchema,
  }),
});

export type ExtractedEventData = z.infer<typeof extractedEventSchema>;

type ExtractEventDataOptions = {
  imageDataUrl?: string | null;
  caption?: string | null;
  altText?: string | null;
  instagramPostUrl: string;
  sourceImageUrl?: string | null;
  instagramHandle: string;
  instagramPostTimestamp?: string | null;
  instagramLocationName?: string | null;
  canonicalVenueName?: string | null;
  extractionMode?: "poster" | "caption_only";
};

const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
    schedule_entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          date: { type: "string" },
          time: { type: "string" },
          title: { type: "string" },
          artists: {
            type: "array",
            items: { type: "string" },
          },
          description: { type: "string" },
          source_text: { type: "string" },
        },
        required: ["date", "time", "title", "artists", "description", "source_text"],
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
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "notes"],
        },
        location: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "notes"],
        },
        location_name: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "notes"],
        },
        price: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "notes"],
        },
        start_time: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "notes"],
        },
        short_description: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "notes"],
        },
        artists: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: ["number", "string"] },
            found_in: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
          required: ["confidence", "found_in", "notes"],
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
    "schedule_entries",
    "field_confirmation",
  ],
} as const;

export async function extractEventDataFromInstagramPost(
  options: ExtractEventDataOptions,
): Promise<ExtractedEventData> {
  const openAiApiKey = getRequiredEnv("OPENAI_API_KEY");
  let lastError: unknown;

  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);

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

      if (options.imageDataUrl) {
        userContent.push({
          type: "input_image",
          image_url: options.imageDataUrl,
          detail: "high",
        });
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: openAiVisionModel,
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

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI extraction failed: ${response.status} ${response.statusText} - ${errorBody}`,
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
        throw new Error("OpenAI extraction returned an empty response payload.");
      }

      const parsedJson = JSON.parse(responseText) as unknown;
      const parsed = extractedEventSchema.parse(parsedJson);
      return {
        ...parsed,
        source_caption: options.caption ?? "",
        source_url: options.instagramPostUrl,
      };
    } catch (error) {
      lastError = error;
      if (attempt < OPENAI_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }
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
