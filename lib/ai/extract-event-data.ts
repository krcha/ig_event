import { z } from "zod";
import { getRequiredEnv } from "@/lib/utils/env";

const openAiVisionModel = process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini";

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
  imageUrl: string;
  caption?: string | null;
  instagramPostUrl: string;
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

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: openAiVisionModel,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "nightlife_event_extraction",
          strict: true,
          schema: extractionJsonSchema,
        },
      },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Extract event data from this Instagram post image.",
                `Instagram post URL: ${options.instagramPostUrl}`,
                `Instagram caption: ${options.caption ?? "N/A"}`,
              ].join("\n"),
            },
            {
              type: "image_url",
              image_url: { url: options.imageUrl },
            },
          ],
        },
      ],
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OpenAI extraction failed: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI extraction returned an empty response payload.");
  }

  const parsedJson = JSON.parse(content) as unknown;
  return extractedEventSchema.parse(parsedJson);
}
