import { z } from "zod";
import { chatComplete, type ChatModel, type ChatProvider, type ChatTrackingHeaders } from "./chat-client.js";
import { safeParseJson } from "./safe-parse-json.js";

const SentimentEnum = z.enum(["positive", "neutral", "negative"]);

export const ExtractionResultSchema = z.object({
  brandFound: z.boolean(),
  brandCount: z.number().int().nonnegative(),
  brandPosition: z.number().int().positive().nullable(),
  urlFound: z.boolean(),
  urlCount: z.number().int().nonnegative(),
  maxBrandsInResponse: z.number().int().nonnegative(),
  sentiment: SentimentEnum,
  sentimentScore: z.number().min(-1).max(1),
  citationUrls: z.array(z.string()),
  competitors: z.array(
    z.object({
      name: z.string().min(1),
      url: z.string().nullable(),
      position: z.number().int().nonnegative(),
      sentiment: SentimentEnum,
      sentimentScore: z.number().min(-1).max(1),
      citationUrl: z.string().nullable(),
    }),
  ),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

const SYSTEM_PROMPT = `You analyze an LLM response for brand visibility metrics.

Given the target brand name + domain and the LLM response, extract structured data and return STRICT JSON only matching this exact schema:

{
  "brandFound": boolean,
  "brandCount": number,
  "brandPosition": number | null,
  "urlFound": boolean,
  "urlCount": number,
  "maxBrandsInResponse": number,
  "sentiment": "positive" | "neutral" | "negative",
  "sentimentScore": number,
  "citationUrls": string[],
  "competitors": [
    { "name": string, "url": string | null, "position": number, "sentiment": "positive"|"neutral"|"negative", "sentimentScore": number, "citationUrl": string | null }
  ]
}

Rules:
- "brandFound" = true if the target brand is mentioned by name OR by its domain (treat both as the same brand).
- "brandCount" = number of mentions of the target brand in the response.
- "brandPosition" = ordinal in the list of brands mentioned in the response (1 = first brand mentioned). null if not found.
- "urlFound" = true if the target domain (or any URL on that domain) appears.
- "maxBrandsInResponse" = total distinct brands mentioned in the response (target + competitors).
- "sentiment" + "sentimentScore" = sentiment toward the TARGET brand only. Score in [-1, +1] (-1 strongly negative, 0 neutral, +1 strongly positive). Default to "neutral" with sentimentScore 0 if brand not mentioned.
- "citationUrls" = ALL URLs cited anywhere in the response (full URLs).
- "competitors" = all OTHER brands mentioned (exclude target). For each competitor: position is its ordinal in the brands list (same numbering as target).

Output JSON only — no preamble, no markdown fence.`;

export interface ExtractParams {
  responseText: string;
  brandName: string;
  domain: string;
  provider: ChatProvider;
  model: ChatModel;
  tracking: ChatTrackingHeaders;
}

export async function extractFromResponse(params: ExtractParams): Promise<ExtractionResult> {
  const message = `Target brand:
- name: ${params.brandName}
- domain: ${params.domain}

LLM response to analyze:
"""
${params.responseText}
"""`;

  const result = await chatComplete(
    {
      message,
      systemPrompt: SYSTEM_PROMPT,
      provider: params.provider,
      model: params.model,
      responseFormat: "json",
      temperature: 0,
    },
    params.tracking,
  );

  const raw = result.json ?? safeParseJson(result.content, "extractor");
  return ExtractionResultSchema.parse(raw);
}

