import { z } from "zod";
import { getRequiredEnv } from "@/lib/utils/env";

const openAiVisionModel = process.env.OPENAI_VISION_MODEL ?? "gpt-5.4";
const OPENAI_REQUEST_TIMEOUT_MS = 40000;
const OPENAI_MAX_ATTEMPTS = 2;
const extractionFieldConfirmationSchema = z.object({
  confidence: z.union([z.number(), z.string()]),
  found_in: z.array(z.string()).default([]),
  notes: z.string(),
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
  imageDataUrl: string;
  caption?: string | null;
  instagramPostUrl: string;
  sourceImageUrl: string;
  instagramHandle: string;
  instagramPostTimestamp?: string | null;
};

const systemPrompt = `
You extract structured event data from Instagram nightlife captions and flyer/poster images.
Prioritize exact OCR-style text extraction over paraphrase.
Preserve artist names, venue names, and prices exactly as written when readable.
Never hallucinate unreadable or missing text.
Use the caption as primary context, then refine/fill from the image.
Return strict JSON with:
{
  "title": string,
  "date": string,
  "time": string,
  "venue": string,
  "city": string,
  "country": string,
  "price": string,
  "currency": string,
  "artists": string[],
  "category": string,
  "description": string,
  "confidence": number,
  "reasoning_notes": string,
  "source_caption": string,
  "source_url": string,
  "field_confirmation": {
    "title": { "confidence": number, "found_in": string[], "notes": string },
    "location": { "confidence": number, "found_in": string[], "notes": string },
    "location_name": { "confidence": number, "found_in": string[], "notes": string },
    "price": { "confidence": number, "found_in": string[], "notes": string },
    "start_time": { "confidence": number, "found_in": string[], "notes": string },
    "short_description": { "confidence": number, "found_in": string[], "notes": string },
    "artists": { "confidence": number, "found_in": string[], "notes": string }
  }
}
Rules:
- Use empty string for unknown scalar fields; use [] for unknown artists.
- Do not invent facts.
- Use the flyer/poster and caption together to identify the venue. The Instagram handle is strong identity context for the account and can help resolve abbreviations or partial venue references.
- If the handle clearly belongs to a venue or promoter, use that only as grounding context. Do not invent a venue that is unsupported by the poster, caption, location text, or obvious handle identity.
- Only return a non-empty "title" when an explicit event/program name is clearly written in the caption or flyer.
- If the source only indicates a genre, format, or generic session type (for example jam session, techno night, live music), return an empty string for "title".
- Do not use the venue name, Instagram handle, or a generic genre label as a fabricated event title unless that exact text is clearly the event/program name in the source.
- Do not create, paraphrase, beautify, or normalize event titles.
- Keep "description" short and factual, based only on details supported by the caption or flyer.
- If date is unclear, return empty string for date.
- If venue is unclear, return empty string for venue.
- If month/day is visible but year is missing, infer year from Instagram post timestamp only when confidence is high.
- If inferred date appears implausible relative to post timestamp, return empty date.
- For field_confirmation:
- "title" confirms the event title field.
- "location" confirms city/country style location details.
- "location_name" confirms the venue/location name field.
- "price" confirms ticket price details.
- "start_time" confirms the start time field.
- "short_description" confirms the description summary.
- "artists" confirms artist names.
- Each field_confirmation entry must explain confidence using the caption, image, handle context, or explicit inference notes.
- Never return markdown, only valid JSON.
`.trim();

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
    "field_confirmation",
  ],
} as const;

export async function extractEventDataFromPoster(
  options: ExtractEventDataOptions,
): Promise<ExtractedEventData> {
  const openAiApiKey = getRequiredEnv("OPENAI_API_KEY");
  let lastError: unknown;

  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);

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
              content: [{ type: "input_text", text: systemPrompt }],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: [
                    "Extract event data from this Instagram post.",
                    `Instagram handle: @${options.instagramHandle}`,
                    `Instagram post URL: ${options.instagramPostUrl}`,
                    `Instagram post timestamp: ${options.instagramPostTimestamp ?? "N/A"}`,
                    `Instagram caption: ${options.caption ?? "N/A"}`,
                    `Source image URL: ${options.sourceImageUrl}`,
                    "Use poster text + caption together. Use the Instagram handle as account identity context when resolving venue or organizer naming, but do not invent unsupported facts.",
                  ].join("\n"),
                },
                {
                  type: "input_image",
                  image_url: options.imageDataUrl,
                  detail: "high",
                },
              ],
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
