import { createHash } from "crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { visibilityScorePromptCache } from "../db/schema.js";

export const CACHE_TTL_DAYS = 30;

export function computeSystemPromptHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

export interface CacheLookupKey {
  brandId: string;
  nPrompts: number;
  promptGenProvider: string;
  promptGenModel: string;
  systemPromptHash: string;
}

export interface CachedPromptSet {
  prompts: string[];
  systemPrompt: string;
  userMessage: string;
}

export async function cacheLookup(key: CacheLookupKey): Promise<CachedPromptSet | null> {
  const now = new Date();
  const rows = await db
    .select({
      prompts: visibilityScorePromptCache.prompts,
      systemPrompt: visibilityScorePromptCache.systemPrompt,
      userMessage: visibilityScorePromptCache.userMessage,
    })
    .from(visibilityScorePromptCache)
    .where(
      and(
        eq(visibilityScorePromptCache.brandId, key.brandId),
        eq(visibilityScorePromptCache.nPrompts, key.nPrompts),
        eq(visibilityScorePromptCache.promptGenProvider, key.promptGenProvider),
        eq(visibilityScorePromptCache.promptGenModel, key.promptGenModel),
        eq(visibilityScorePromptCache.systemPromptHash, key.systemPromptHash),
        gt(visibilityScorePromptCache.expiresAt, now),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  return {
    prompts: rows[0].prompts,
    systemPrompt: rows[0].systemPrompt,
    userMessage: rows[0].userMessage,
  };
}

export interface CacheWriteInput extends CacheLookupKey {
  systemPrompt: string;
  userMessage: string;
  prompts: string[];
}

export async function cacheWrite(input: CacheWriteInput): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(visibilityScorePromptCache).values({
    brandId: input.brandId,
    nPrompts: input.nPrompts,
    promptGenProvider: input.promptGenProvider,
    promptGenModel: input.promptGenModel,
    systemPromptHash: input.systemPromptHash,
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    prompts: input.prompts,
    expiresAt,
  });
}
