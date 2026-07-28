# Listener ownership contract

The existing `TransportInterceptor` is an in-process JavaScript object, so operating-system process metadata alone cannot prove its instance count. The probe may establish the single owning Node process and count bounded listener markers exposed by process/file-descriptor metadata, but it must report `LISTENER_OWNERSHIP_UNKNOWN` unless one-instance ownership is directly established without reading messages or browser state.

Unknown is not zero and is not acceptance. A count greater than one is `SECOND_LISTENER_DETECTED`. Any future runtime instrumentation used to close this fact must be separately reviewed and must expose only an instance count and owner fence, never transport payloads.
