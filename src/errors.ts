/** Consistent user-facing Pilot errors; safe to format again when forwarded by another UI. */
export function formatPilotError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Pilot says: ${message.replace(/^(?:Pilot says:\s*)+/, "")}`;
}

export class PilotError extends Error {
  constructor(message: string) {
    super(formatPilotError(message));
    this.name = "PilotError";
  }
}
