// Desktop transcription has priority: the laptop becomes active only after the desktop has been confirmed
// unreachable for 60 seconds. An unknown status (null) never counts as desktop silence.
export const SILENCE_MS = 60000;
export class StandbyPolicy {
  constructor() { this.silentSince = null; }
  observe(desktopReady, now) {
    if (desktopReady !== false) { this.silentSince = null; return false; }
    this.silentSince ??= now;
    return now - this.silentSince >= SILENCE_MS;
  }
}
