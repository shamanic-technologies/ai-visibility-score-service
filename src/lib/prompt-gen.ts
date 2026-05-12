import { chatComplete, type ChatModel, type ChatProvider, type ChatTrackingHeaders } from "./chat-client.js";
import { safeParseJson } from "./safe-parse-json.js";

export interface BrandContext {
  category?: string;
  specific_offerings?: string;
  target_audience?: string;
  primary_geography?: string;
  positioning?: string;
}

export const SYSTEM_PROMPT = `You generate user-style search queries to measure a brand's visibility in LLM answers.

OUTPUT
Return STRICT JSON: {"prompts": ["query 1", "query 2", ...]}
No numbering, no bullets, no commentary outside the JSON.

CORE RULE — VENDOR-CITABLE QUERIES ONLY
Every query MUST be one where a typical LLM answer would name specific firms, vendors, products, or service providers — not just concepts, country lists, regulatory steps, or generic how-to walkthroughs. Skip purely educational, definitional, or tutorial queries unless they implicitly ask "who can do this for me".

NICHE GROUNDING
Queries must sit inside the brand's NARROW category and reference its SPECIFIC OFFERINGS by name (or close paraphrase). Do NOT drift to the parent industry, adjacent geographies, or sibling product categories.

NEUTRALITY — NO NAMED ENTITIES
Never name the target brand. Never name a competitor firm, product, or provider. Never name any specific company at all. Queries must be open-ended so the LLM is free to enumerate the market on its own. Naming any vendor in the query biases the answer set and corrupts the measurement.

INTENT MIX (enforced across the N queries)
- ~40% recommendation / best-of  ("best X for Y", "top X firms in {market} {year}")
- ~25% comparison / open enumeration  ("compare top X firms", "X firms compared", "leading X providers")
- ~20% procurement / discriminator  ("who offers X", "which firm provides X", "independent X advisor", "licensed X provider in {market}")
- ~15% problem-solving with vendor implication  ("I need X done, who can help", "best firm to handle X for Y")
0% pure tutorial / definitional / step-by-step. 0% generic country, program, or category comparison without a vendor angle.

COMPARISON BUCKET — OPEN ENUMERATION ONLY
Comparison queries must trigger an open market list. No named entity in the query.
- Allowed shapes: "compare top X firms for Y", "best X providers compared", "leading X firms in {market}", "X firms ranked".
- Forbidden shapes: any query naming a specific vendor, brand, product, or company (including "{brand} vs {other}", "alternatives to {brand}", "{brand} competitors", "is {brand} the best").

STYLE
- Short, natural, 30–100 characters.
- The way a real prospect would type into ChatGPT / Perplexity / Gemini.
- Each query is a standalone search-style request.
- Vary surface form: questions, imperative requests, fragment queries.
- Match the language of the brand's primary market.

DO NOT
- Do not name the target brand.
- Do not name any competitor, vendor, product, or company of any kind.
- Do not invent offerings the brand does not provide.
- Do not generate concept-only or definitional queries ("how does X work", "history of X", "tax implications of X").
- Do not output duplicates or near-duplicates.`;

export interface GeneratePromptsResult {
  prompts: string[];
  systemPrompt: string;
  userMessage: string;
}

export function buildUserMessage(context: BrandContext, n: number): string {
  return `Generate ${n} vendor-citable search queries for this brand's specific market.

Brand context:
- category: ${context.category ?? "(unknown)"}
- specific offerings: ${context.specific_offerings ?? "(unknown)"}
- target audience: ${context.target_audience ?? "(unknown)"}
- primary geography: ${context.primary_geography ?? "(unknown)"}
- positioning: ${context.positioning ?? "(unknown)"}

Constraints:
- Stay strictly inside the named category and offerings — do not drift to the parent industry or adjacent geographies.
- Apply the intent mix from the system prompt (~40% recommendation, ~25% open-enumeration comparison, ~20% procurement, ~15% problem-solving).
- Never name any vendor, brand, product, or company in any query.
- Return exactly ${n} prompts in the JSON array.`;
}

export async function generatePrompts(
  context: BrandContext,
  n: number,
  opts: {
    provider: ChatProvider;
    model: ChatModel;
    tracking: ChatTrackingHeaders;
  },
): Promise<GeneratePromptsResult> {
  const message = buildUserMessage(context, n);

  const result = await chatComplete(
    {
      message,
      systemPrompt: SYSTEM_PROMPT,
      provider: opts.provider,
      model: opts.model,
      responseFormat: "json",
      temperature: 0.7,
    },
    opts.tracking,
  );

  const json = result.json ?? safeParseJson(result.content, "prompt-gen");
  const prompts = (json as { prompts?: unknown }).prompts;
  if (!Array.isArray(prompts)) {
    throw new Error(`[prompt-gen] expected JSON { prompts: string[] }, got: ${result.content.slice(0, 200)}`);
  }
  const cleaned = prompts.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  if (cleaned.length < n) {
    throw new Error(`[prompt-gen] requested ${n} prompts, model returned ${cleaned.length}`);
  }
  return { prompts: cleaned.slice(0, n), systemPrompt: SYSTEM_PROMPT, userMessage: message };
}
