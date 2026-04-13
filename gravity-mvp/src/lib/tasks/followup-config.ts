/**
 * Mandatory follow-up enforcement thresholds.
 * Adjustable without schema changes.
 */
export const FOLLOWUP_THRESHOLDS = {
    /** Minutes from enforcement until mandatory follow-up is due */
    followupDeadlineMinutes: 60,
    /** The nextActionId value set by enforcement */
    mandatoryActionId: 'mandatory_followup',
}
