import type {
  AdvanceCursorInput,
  ClaimProcessingInput,
  ConsumerCursor,
  JournalPage,
  MarkProcessingInput,
  ObservationId,
  ProcessingState,
  SanitizedObservationInput,
} from './types.ts'

export interface RawEventJournal {
  append(observation: SanitizedObservationInput): Promise<ObservationId>
  readAfter(accountId: string, cursor: bigint, limit: number): Promise<JournalPage>
  claimProcessing(input: ClaimProcessingInput): Promise<ProcessingState>
  markProcessingState(input: MarkProcessingInput): Promise<ProcessingState>
  getProcessingState(
    accountId: string,
    observationId: ObservationId,
    parserVersion: string,
  ): Promise<ProcessingState | null>
  advanceCursor(input: AdvanceCursorInput): Promise<ConsumerCursor>
  getCursor(consumerId: string, accountId: string, parserVersion: string): Promise<ConsumerCursor | null>
}
