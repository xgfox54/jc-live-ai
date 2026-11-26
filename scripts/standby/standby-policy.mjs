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
// The desktop is checked every 60 seconds while it answers or its status is unknown. After an unanswered check, and while
// the laptop transcribes (its lease lasts 25 seconds), the check runs every 15 seconds, so the 60-second silence rule still
// rests on checks 15 seconds apart. Checking every 15 seconds all day made 5,760 Worker requests a day (2026-11-25).
export const checkInterval = (active, desktopReady) => active || desktopReady === false ? 15000 : 60000;
