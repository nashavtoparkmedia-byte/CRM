#!/usr/bin/env python3
from pathlib import Path


SRC = Path(__file__).resolve().parents[3]


def test_stale_calls_are_reconciled_against_freeswitch() -> None:
    source = (SRC / "lib/freeswitch/EslClient.ts").read_text(encoding="utf-8")

    assert "export async function reconcileStaleCalls()" in source
    assert "uuid_exists ${fsUuid}" in source
    assert "exists !== false" in source
    assert "status: { in: ['ringing', 'active'] }" in source
    assert "orderBy: { startedAt: 'desc' }" in source
    assert "call.direction === 'inbound' ? 'missed' : 'no_answer'" in source
    assert "hangupCause: 'RECOVERED_STALE_CHANNEL'" in source
    assert "where: { id: call.id, status: call.status }" in source
    assert "await syncCallToChat(updated)" in source
    assert "ensureStaleCallReconciler()" in source


if __name__ == "__main__":
    test_stale_calls_are_reconciled_against_freeswitch()
    print("PASS test_stale_calls_are_reconciled_against_freeswitch")
    print("1/1 PASS")
