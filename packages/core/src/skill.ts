import type { PermissionMode } from "./config";

export type DumplSkillModelConfig = {
  reasoning: "low" | "medium" | "high";
};

export type DumplSkillIntegrationProvider = "openai" | "anthropic";

export type DumplSkillIntegrationConfig = {
  provider: DumplSkillIntegrationProvider;
  purpose: string;
};

export type DumplSkill = {
  id: string;
  promptPrelude: string;
  toolAllowlist: string[];
  bashCommandPrefixAllowlist: string[];
  permissionMode: PermissionMode;
  model: DumplSkillModelConfig;
  integrations: DumplSkillIntegrationConfig[];
};
