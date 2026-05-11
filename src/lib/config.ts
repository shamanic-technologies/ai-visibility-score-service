import type { ChatModel, ChatProvider } from "./chat-client.js";
import { DEFAULT_WEIGHTS } from "./metrics.js";
import type { VisibilityWeights } from "../db/schema.js";

export interface VisibilityRunConfig {
  provider: ChatProvider;
  promptModel: ChatModel;
  promptGenProvider: ChatProvider;
  promptGenModel: ChatModel;
  extractionProvider: ChatProvider;
  extractionModel: ChatModel;
  nPrompts: number;
  weights: VisibilityWeights;
}

export const VISIBILITY_RUN_CONFIG: VisibilityRunConfig = {
  provider: "google",
  promptModel: "pro",
  promptGenProvider: "google",
  promptGenModel: "flash",
  extractionProvider: "anthropic",
  extractionModel: "haiku",
  nPrompts: 25,
  weights: DEFAULT_WEIGHTS,
};
