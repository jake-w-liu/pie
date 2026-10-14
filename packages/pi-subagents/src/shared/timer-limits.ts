/**
 * Largest delay a Node.js timer accepts: 2^31 - 1 ms, about 24.8 days. setTimeout clamps
 * anything larger to 1 ms (with a TimeoutOverflowWarning), so a deadline above this bound
 * would expire almost immediately while still reporting the long duration. Every
 * user-supplied timeout that reaches a timer must be validated against it.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
