export function createSubmitActivationGate(
  scheduleRelease: (release: () => void) => void = queueMicrotask,
): { claim(): boolean } {
  let claimed = false
  return {
    claim(): boolean {
      if (claimed) return false
      claimed = true
      scheduleRelease(() => { claimed = false })
      return true
    },
  }
}
