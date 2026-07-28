import type {
  OutboundShadowPlan,
  ShadowCommandRecord,
  ShadowPlanDraft,
  ShadowPlanRepository,
  ShadowReservationRecord,
} from '../../src/shadow/types.ts'

export class FakeShadowPlanRepository implements ShadowPlanRepository {
  readonly #commands = new Map<string, ShadowCommandRecord>()
  readonly #reservations = new Map<string, ShadowReservationRecord>()
  readonly #dispatchStates = new Map<string, string>()
  readonly #plansByCommand = new Map<string, OutboundShadowPlan>()
  readonly #plansByIdempotency = new Map<string, OutboundShadowPlan>()
  physicalAdapterCalls = 0
  deliveryStateMutations = 0

  seedCommand(command: ShadowCommandRecord): void { this.#commands.set(command.commandId, Object.freeze({ ...command })) }
  seedReservation(reservation: ShadowReservationRecord): void { this.#reservations.set(`${reservation.commandId}\0${reservation.reservationId}`, Object.freeze({ ...reservation })) }
  setDispatchState(commandId: string, state: string): void { this.#dispatchStates.set(commandId, state) }
  plans(): readonly OutboundShadowPlan[] { return Object.freeze([...this.#plansByCommand.values()]) }
  commandSnapshot(): string { return JSON.stringify([...this.#commands.values()]) }
  reservationSnapshot(): string { return JSON.stringify([...this.#reservations.values()]) }

  async getCommand(commandId: string): Promise<ShadowCommandRecord | null> { return this.#commands.get(commandId) ?? null }

  async getActiveReservation(commandId: string, reservationId: string): Promise<ShadowReservationRecord | null> {
    const reservation = this.#reservations.get(`${commandId}\0${reservationId}`)
    return reservation?.reservationState === 'reserved' ? reservation : null
  }

  async getDispatchState(commandId: string): Promise<string | null> { return this.#dispatchStates.get(commandId) ?? null }

  async getByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<OutboundShadowPlan | null> {
    return this.#plansByIdempotency.get(`${accountId}\0${idempotencyKey}`) ?? null
  }

  async getByCommandId(commandId: string): Promise<OutboundShadowPlan | null> { return this.#plansByCommand.get(commandId) ?? null }

  async createPlan(draft: ShadowPlanDraft): Promise<OutboundShadowPlan> {
    const plan = Object.freeze({ ...draft })
    this.#plansByCommand.set(plan.commandId, plan)
    this.#plansByIdempotency.set(`${plan.accountId}\0${plan.idempotencyKey}`, plan)
    return plan
  }
}
