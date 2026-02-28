export type PermissionMode = "strict" | "balanced" | "permissive";

export type DumplServerConfig = {
  host: string;
  port: number;
};

export type DumplSttConfig = {
  provider: "openai";
  model: string;
  language: string;
  promptBias: string;
};

export type DumplUiConfig = {
  displayDriver: string;
  fallbackDisplayDriver: string;
  audioCaptureCmd: string;
  pttWavPath: string;
};

export type DumplRuntimeConfig = {
  defaultWorkspace: string;
  defaultSkill: string;
  permissionMode: PermissionMode;
  maxRunSeconds: number;
};

export type DumplSandboxConfig = {
  enabled: boolean;
  backend: "bwrap";
};

export type DumplSchedulerConfig = {
  enabled: boolean;
  store: "file" | "sqlite";
};

export type DumplLoggingConfig = {
  level: "debug" | "info" | "warn" | "error";
};

export type DumplConfig = {
  server: DumplServerConfig;
  stt: DumplSttConfig;
  ui: DumplUiConfig;
  runtime: DumplRuntimeConfig;
  sandbox: DumplSandboxConfig;
  scheduler: DumplSchedulerConfig;
  logging: DumplLoggingConfig;
};
