export type AuditRecord =
  | {
      event: "tool_call";
      tool: string;
      target: string | null;
      ok: boolean;
      code: string;
      ms: number;
    }
  | { event: "auth_ok" }
  | { event: "auth_rejected" }
  | { event: "token_refresh"; ok: boolean; code: string }
  | { event: "reauth_required"; code: string }
  | { event: "killswitch_block" }
  | { event: "tool_backends_invalid" };

export function audit(record: AuditRecord): void {
  console.log(JSON.stringify(record));
}
