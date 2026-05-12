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

export const SYSTEM_PROMPT = `You analyze an LLM response for brand visibility metrics.

Given a target brand (name + domain) and an LLM response, return STRICT JSON matching:

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

For each field, answer the plain question:
- brandFound: Is the target brand mentioned in the response? Use your judgment — a brand mention means the brand itself, not coincidental occurrences of common words that happen to be part of the brand name.
- brandCount: How many times is the target brand mentioned?
- brandPosition: Among the brands mentioned, what is the target brand's ordinal rank (1 = first)? null if not mentioned.
- urlFound: Does any URL pointing to the target's domain appear in the response?
- urlCount: How many such URLs?
- maxBrandsInResponse: Total distinct brands mentioned (target + competitors).
- sentiment / sentimentScore: Sentiment toward the target brand. Score in [-1, +1]. Neutral / 0 if not mentioned.
- citationUrls: All URLs cited in the response.
- competitors: All other brands mentioned.

Output JSON only — no preamble, no markdown fence.`;

export interface ExtractParams {
  responseText: string;
  brandName: string;
  domain: string;
  provider: ChatProvider;
  model: ChatModel;
  tracking: ChatTrackingHeaders;
}

export interface ExtractFromResponseResult {
  extraction: ExtractionResult;
  systemPrompt: string;
  userMessage: string;
}

export async function extractFromResponse(params: ExtractParams): Promise<ExtractFromResponseResult> {
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
  const extraction = ExtractionResultSchema.parse(raw);
  return { extraction, systemPrompt: SYSTEM_PROMPT, userMessage: message };
}

