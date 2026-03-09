import { z } from "zod";
import { getRequiredEnv } from "@/lib/utils/env";

const openAiVisionModel = process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini";
const OPENAI_REQUEST_TIMEOUT_MS = 40000;
const OPENAI_MAX_ATTEMPTS = 2;

const extractedEventSchema = z.object({
  eventName: z.string().min(1),
  date: z.string().min(1),
  time: z.string().nullable().optional(),
  venue: z.string().min(1),
  artists: z.array(z.string()).default([]),
  ticketPrice: z.string().nullable().optional(),
  eventType: z.enum(["club_night", "festival", "concert", "party"]),
  description: z.string().min(1),
});

export type ExtractedEventData = z.infer<typeof extractedEventSchema>;

type ExtractEventDataOptions = {
  imageDataUrl: string;
  caption?: string | null;
  instagramPostUrl: string;
  sourceImageUrl: string;
  instagramHandle: string;
};

const systemPrompt = `
Extract event information from nightlife posters and Instagram event images.
Return strict JSON with:
{
  "eventName": string,
  "date": ISO date string when possible (YYYY-MM-DD),
  "time": "HH:MM" or "HH:MM-HH:MM" or null,
  "venue": string,
  "artists": string[],
  "ticketPrice": string or null,
  "eventType": "club_night" | "festival" | "concert" | "party",
  "description": string
}
Rules:
- If there are multiple artists, return each artist as an array item.
- If date is ambiguous, infer best guess and include that ambiguity in description.
- If no ticket pricing is visible, return null for ticketPrice.
- Never return markdown, only valid JSON.
`.trim();

const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    eventName: { type: "string" },
    date: { type: "string" },
    time: { type: ["string", "null"] },
    venue: { type: "string" },
    artists: {
      type: "array",
      items: { type: "string" },
    },
    ticketPrice: { type: ["string", "null"] },
    eventType: {
      type: "string",
      enum: ["club_night", "festival", "concert", "party"],
    },
    description: { type: "string" },
  },
  required: [
    "eventName",
    "date",
    "time",
    "venue",
    "artists",
    "ticketPrice",
    "eventType",
    "description",
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
                    "Extract event data from this Instagram post image.",
                    `Instagram handle: @${options.instagramHandle}`,
                    `Instagram post URL: ${options.instagramPostUrl}`,
                    `Instagram caption: ${options.caption ?? "N/A"}`,
                    `Source image URL: ${options.sourceImageUrl}`,
                  ].join("\n"),
                },
                {
                  type: "input_image",
                  image_url: options.imageDataUrl,
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
      return extractedEventSchema.parse(parsedJson);
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
