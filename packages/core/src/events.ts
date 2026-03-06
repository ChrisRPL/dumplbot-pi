export type DumplEventType =
  | "status"
  | "stt"
  | "token"
  | "tool"
  | "done"
  | "error";

export type DumplStatusEvent = {
  type: "status";
  message: string;
  phase?: string;
};

export type DumplSttEvent = {
  type: "stt";
  text: string;
  confidence?: number;
};

export type DumplTokenEvent = {
  type: "token";
  text: string;
};

export type DumplToolEvent = {
  type: "tool";
  name: string;
  detail?: string;
};

export type DumplDoneEvent = {
  type: "done";
  summary?: string;
};

export type DumplErrorEvent = {
  type: "error";
  message: string;
  code?: string;
};

export type DumplEvent =
  | DumplStatusEvent
  | DumplSttEvent
  | DumplTokenEvent
  | DumplToolEvent
  | DumplDoneEvent
  | DumplErrorEvent;
