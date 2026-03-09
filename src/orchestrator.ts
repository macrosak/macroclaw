export type OrchestratorRequest =
  | { type: "user"; message: string; files?: string[] }
  | { type: "cron"; name: string; prompt: string; model?: string }
  | { type: "background"; name: string; result: string }
  | { type: "timeout"; originalMessage: string }
  | { type: "bg-task"; name: string; prompt: string; model?: string };
