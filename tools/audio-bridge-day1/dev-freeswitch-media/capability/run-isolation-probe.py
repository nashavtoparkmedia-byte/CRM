from __future__ import annotations

import json
import subprocess
import time
import uuid


FS_CONTAINER = "yoko-fs-media-capability-dev"
ESL_CONTAINER = "yoko-fs-media-esl-metrics"


def run(command: list[str], check: bool = True) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    output = (result.stdout + result.stderr).strip()
    if check and result.returncode != 0:
        raise RuntimeError(f"{command!r} failed ({result.returncode}): {output}")
    return output


def cli(command: str) -> str:
    return run(["docker", "exec", FS_CONTAINER, "fs_cli", "-x", command])


def show_rows() -> list[dict[str, object]]:
    output = cli("show channels as json")
    if not output:
        return []
    payload = json.loads(output)
    return payload.get("rows") or []


def b_leg_uuids(rows: list[dict[str, object]]) -> list[str]:
    matches = []
    for row in rows:
        name = str(row.get("name") or "")
        destination = str(row.get("dest") or row.get("destination_number") or "")
        if name.startswith("loopback/1000-b") or (name.endswith("-b") and destination == "1000"):
            matches.append(str(row["uuid"]))
    return sorted(set(matches))


def wait_for_b_legs(expected: int, timeout_seconds: float = 3.0) -> list[str]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        matches = b_leg_uuids(show_rows())
        if len(matches) >= expected:
            return matches[:expected]
        time.sleep(0.1)
    raise RuntimeError(f"expected {expected} B legs, found {b_leg_uuids(show_rows())}")


def snapshot_esl() -> None:
    run(["docker", "kill", "--signal", "SIGUSR1", ESL_CONTAINER])


def main() -> int:
    a_legs = [str(uuid.uuid4()), str(uuid.uuid4())]
    evidence: dict[str, object] = {"a_leg_uuids": a_legs}

    try:
        for a_leg in a_legs:
            evidence.setdefault("originate", []).append(
                cli(
                    "bgapi originate "
                    f"{{origination_uuid={a_leg}}}loopback/1000/default "
                    "&playback(tone_stream://%(6000,0,440))"
                )
            )

        b_legs = wait_for_b_legs(2)
        evidence["b_leg_uuids"] = b_legs
        time.sleep(0.75)

        evidence["stop_first"] = cli(f"uuid_audio_stream {b_legs[0]} stop")
        evidence["first_exists_after_stop"] = cli(f"uuid_exists {b_legs[0]}")
        evidence["second_exists_after_first_stop"] = cli(f"uuid_exists {b_legs[1]}")
        evidence["second_pause"] = cli(f"uuid_audio_stream {b_legs[1]} pause")
        evidence["second_resume"] = cli(f"uuid_audio_stream {b_legs[1]} resume")

        time.sleep(0.25)
        snapshot_esl()
        evidence["snapshot_one_monotonic"] = time.monotonic()

        time.sleep(1.5)
        snapshot_esl()
        evidence["snapshot_two_monotonic"] = time.monotonic()
        evidence["first_exists_later"] = cli(f"uuid_exists {b_legs[0]}")
        evidence["second_exists_later"] = cli(f"uuid_exists {b_legs[1]}")
        evidence["second_stop"] = cli(f"uuid_audio_stream {b_legs[1]} stop")

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if all(cli(f"uuid_exists {channel}") == "false" for channel in a_legs + b_legs):
                break
            time.sleep(0.1)

        evidence["all_known_channels_closed"] = all(
            cli(f"uuid_exists {channel}") == "false" for channel in a_legs + b_legs
        )
        print(f"YOKO_ISOLATION_PROBE {json.dumps(evidence, sort_keys=True)}")
        return 0 if evidence["all_known_channels_closed"] else 1
    finally:
        for channel in a_legs:
            if cli(f"uuid_exists {channel}") == "true":
                cli(f"uuid_kill {channel} NORMAL_CLEARING")


if __name__ == "__main__":
    raise SystemExit(main())
