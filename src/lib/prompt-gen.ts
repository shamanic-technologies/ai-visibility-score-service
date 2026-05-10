import { chatComplete, type ChatModel, type ChatTrackingHeaders } from "./chat-client.js";
import { safeParseJson } from "./safe-parse-json.js";

export interface BrandContext {
  industry?: string;
  target_audience?: string;
  offerings?: string;
  geography?: string;
}

const SYSTEM_PROMPT = `You generate plausible, user-style search queries for testing an LLM's brand visibility.

Return STRICT JSON shaped exactly as: {"prompts": ["query 1", "query 2", ...]}

Requirements for the queries:
- Short, natural, the way a real person would type into an LLM (e.g. "best CRM for early stage SaaS startups", "how do I run cold outreach for B2B").
- DO NOT name the target brand or any specific competitor by name.
- Vary intent across the set — mix comparative ("best X for Y"), problem-solving ("how to do Z"), and recommendation ("recommend a Z for W") queries.
- Each query must be a standalone search-style question or request, not a paragraph.
- No numbering, no bullets — only the JSON array of plain strings.`;

export async function generatePrompts(
  context: BrandContext,
  n: number,
  opts: {
    model: ChatModel;
    tracking: ChatTrackingHeaders;
  },
): Promise<string[]> {
  const message = `Generate ${n} short user-style search queries for someone in this brand's category.

Brand context:
- industry: ${context.industry ?? "(unknown)"}
- target audience: ${context.target_audience ?? "(unknown)"}
- offerings: ${context.offerings ?? "(unknown)"}
- geography: ${context.geography ?? "(unknown)"}

Return JSON with exactly ${n} prompts.`;

  const result = await chatComplete(
    {
      message,
      systemPrompt: SYSTEM_PROMPT,
      provider: "google",
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
  return cleaned.slice(0, n);
}

