export type ChatProvider = "google" | "anthropic";
export type ChatModel = "flash" | "flash-lite" | "pro" | "sonnet" | "haiku" | "opus";

export interface ChatCompleteParams {
  message: string;
  systemPrompt: string;
  provider: ChatProvider;
  model: ChatModel;
  responseFormat?: "json";
  temperature?: number;
  maxTokens?: number;
  /**
   * Opt-in native web search. When true, chat-service attaches the provider's
   * native web-search tool (Gemini → Google Search grounding; Anthropic →
   * server-side web_search). Default (omitted) = no grounding, byte-identical
   * to the legacy call. Only the visibility panel (judge) calls set this true —
   * prompt-gen and extraction stay ungrounded.
   */
  webSearch?: boolean;
}

export interface ChatCompleteResult {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

export interface ChatTrackingHeaders {
  orgId: string;
  userId?: string;
  /** Outbound x-run-id — this service's own runId (NOT the inbound parent). */
  runId: string;
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  brandId?: string;
  workflowSlug?: string;
}

function baseUrl(): string {
  const url = process.env.CHAT_SERVICE_URL;
  if (!url) throw new Error("[ai-visibility-score-service] CHAT_SERVICE_URL is required");
  return url;
}

function buildHeaders(tracking: ChatTrackingHeaders): Record<string, string> {
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[ai-visibility-score-service] CHAT_SERVICE_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": tracking.orgId,
    "x-run-id": tracking.runId,
  };
  if (tracking.userId) headers["x-user-id"] = tracking.userId;
  if (tracking.campaignId) headers["x-campaign-id"] = tracking.campaignId;
  if (tracking.audienceId) headers["x-audience-id"] = tracking.audienceId;
  if (tracking.featureSlug) headers["x-feature-slug"] = tracking.featureSlug;
  if (tracking.brandId) headers["x-brand-id"] = tracking.brandId;
  if (tracking.workflowSlug) headers["x-workflow-slug"] = tracking.workflowSlug;
  return headers;
}

export async function chatComplete(
  params: ChatCompleteParams,
  tracking: ChatTrackingHeaders,
): Promise<ChatCompleteResult> {
  const body = {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
    ...(params.responseFormat && { responseFormat: params.responseFormat }),
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
    ...(params.webSearch !== undefined && { webSearch: params.webSearch }),
  };

  const res = await fetch(`${baseUrl()}/complete`, {
    method: "POST",
    headers: buildHeaders(tracking),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[chat-client] POST /complete returned ${res.status}: ${text}`);
  }

  return (await res.json()) as ChatCompleteResult;
}
