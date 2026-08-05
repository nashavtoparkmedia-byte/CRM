#!/usr/bin/env python3
from pathlib import Path


SRC = Path(__file__).resolve().parents[3]


def test_inbound_alert_requires_the_registered_megafon_did() -> None:
    esl = (SRC / "lib/freeswitch/EslClient.ts").read_text(encoding="utf-8")

    assert "const MEGAFON_INBOUND_DID = normalizePhoneE164(" in esl
    assert "function isExpectedInboundDid(rawNumber: string)" in esl
    assert "!isExpectedInboundDid(localNumber)" in esl
    assert esl.index("!isExpectedInboundDid(localNumber)") < esl.index("prisma.call.upsert")


if __name__ == "__main__":
    test_inbound_alert_requires_the_registered_megafon_did()
    print("PASS test_inbound_alert_requires_the_registered_megafon_did")
    print("1/1 PASS")
