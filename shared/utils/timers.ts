// Shared timer constants — used by the server (cap enforcement on start) and
// the client (disabling "Add a timer" before the request is worth making).

/**
 * How many timers one user may run at once (ticktimer/Tick#37). A guardrail,
 * not an invariant: the number exists so a stuck client or a misfiring play
 * button can't fill the table with running rows, and so the running list stays
 * a list a person can read.
 */
export const MAX_RUNNING_TIMERS = 10
