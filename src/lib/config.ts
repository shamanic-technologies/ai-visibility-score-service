import type { ChatModel, ChatProvider } from "./chat-client.js";
import { DEFAULT_WEIGHTS } from "./metrics.js";
import type { VisibilityWeights } from "../db/schema.js";

export interface JudgeConfig {
  provider: ChatProvider;
  model: ChatModel;
}

export interface VisibilityRunConfig {
  judges: JudgeConfig[];
  promptGenProvider: ChatProvider;
  promptGenModel: ChatModel;
  extractionProvider: ChatProvider;
  extractionModel: ChatModel;
  nPrompts: number;
  weights: VisibilityWeights;
}

export const VISIBILITY_RUN_CONFIG: VisibilityRunConfig = {
  judges: [
    { provider: "google", model: "flash" },
    { provider: "anthropic", model: "haiku" },
  ],
  promptGenProvider: "google",
  promptGenModel: "flash",
  extractionProvider: "google",
  extractionModel: "flash",
  nPrompts: 25,
  weights: DEFAULT_WEIGHTS,
};
