from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


SCRIPT_DIR = Path(__file__).resolve().parent
IMAGE_TAG = "yoko/freeswitch-media-dev:fs1.10.12-alchemilla-a25fb1fe"
NODE_IMAGE = (
    "node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0"
)
NETWORK = "yoko-fs-media-capability-net"
FS_CONTAINER = "yoko-fs-media-capability-dev"
BRIDGE_CONTAINER = "yoko-media-bridge"
ESL_CONTAINER = "yoko-fs-media-esl-metrics"


def run(
    command: list[str],
    *,
    check: bool = True,
    timeout: float = 30.0,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        output = (result.stdout + result.stderr).strip()
        raise RuntimeError(f"{command!r} failed ({result.returncode}): {output}")
    return result


def docker(*arguments: str, check: bool = True, timeout: float = 30.0) -> str:
    result = run(["docker", *arguments], check=check, timeout=timeout)
    return (result.stdout + result.stderr).strip()


def cli(command: str) -> str:
    return docker("exec", FS_CONTAINER, "fs_cli", "-x", command)


def exact_name_exists(kind: str, name: str) -> bool:
    return run(["docker", kind, "inspect", name], check=False).returncode == 0


def wait_for_log(container: str, marker: str, timeout_seconds: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if marker in docker("logs", container, check=False):
            return
        time.sleep(0.1)
    raise RuntimeError(f"{container} did not emit readiness marker {marker!r}")


def wait_for_fs(timeout_seconds: float = 20.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            if cli("module_exists mod_audio_stream") == "true":
                return
        except RuntimeError:
            pass
        time.sleep(0.2)
    raise RuntimeError("FreeSWITCH media module did not become ready")


def prefixed_json_lines(container: str, prefix: str) -> list[dict]:
    records = []
    for line in docker("logs", container, check=False).splitlines():
        if line.startswith(prefix):
            records.append(json.loads(line[len(prefix) :]))
    return records


def bridge_metrics() -> list[dict]:
    return prefixed_json_lines(BRIDGE_CONTAINER, "YOKO_MEDIA_METRICS ")


def wait_for_bridge_session(session_id: str | None, expected_total: int, timeout_seconds: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        records = bridge_metrics()
        if session_id:
            matches = [record for record in records if record.get("session_id") == session_id]
            if matches:
                return matches[-1]
        elif len(records) >= expected_total:
            return records[-1]
        time.sleep(0.1)
    raise RuntimeError(f"bridge metrics timeout for session={session_id!r} total={expected_total}")


def esl_snapshot() -> dict:
    docker("kill", "--signal", "SIGUSR1", ESL_CONTAINER)
    time.sleep(0.1)
    records = prefixed_json_lines(ESL_CONTAINER, "YOKO_ESL_METRICS ")
    if not records:
        raise RuntimeError("ESL metrics snapshot missing")
    return records[-1]


def show_rows() -> list[dict]:
    output = cli("show channels as json")
    if not output:
        return []
    return json.loads(output).get("rows") or []


def b_leg_uuids(rows: list[dict]) -> list[str]:
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


def wait_for_known_channels_to_close(channels: list[str], timeout_seconds: float = 7.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if all(cli(f"uuid_exists {channel}") == "false" for channel in channels):
            return
        time.sleep(0.1)
    raise RuntimeError(f"known channels did not close: {channels}")


def copy_container_file(source: str, destination: Path) -> None:
    with destination.open("wb") as output:
        result = subprocess.run(
            ["docker", "exec", FS_CONTAINER, "dd", f"if={source}", "status=none"],
            stdout=output,
            stderr=subprocess.PIPE,
            check=False,
        )
    if result.returncode != 0:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"failed to copy {source}: {result.stderr.decode(errors='replace')}")


def analyze_recording(path: Path) -> dict:
    result = run(
        [sys.executable, str(SCRIPT_DIR / "analyze_wav.py"), str(path)],
        timeout=20.0,
    )
    return json.loads(result.stdout.strip())


def assert_clean_transport(metrics: dict) -> None:
    for field in (
        "rejected_frames",
        "unresolved_missing_frames",
        "duplicate_frames",
        "out_of_order_frames",
        "checksum_mismatches",
    ):
        if metrics.get(field) != 0:
            raise RuntimeError(f"bridge metric {field} is not zero: {metrics}")


def main_probe(evidence_directory: Path) -> dict:
    a_leg = str(uuid.uuid4())
    before = len(bridge_metrics())
    response = cli(
        "originate "
        f"{{origination_uuid={a_leg}}}loopback/1000/default "
        "&playback(tone_stream://%(6000,0,440))"
    )
    if not response.startswith("+OK"):
        raise RuntimeError(f"main originate failed: {response}")

    transport = wait_for_bridge_session(None, before + 1)
    session_id = str(transport["session_id"])
    assert_clean_transport(transport)
    wait_for_known_channels_to_close([a_leg, session_id], timeout_seconds=3.0)
    if cli("show channels").strip() != "0 total.":
        raise RuntimeError("main probe left active channels")

    playback = esl_snapshot()["sessions"].get(session_id)
    if not playback:
        raise RuntimeError(f"no module playback metrics for {session_id}")

    recording_path = f"/tmp/yoko-return-{session_id}.wav"
    local_recording = evidence_directory / f"return-{session_id}.wav"
    copy_container_file(recording_path, local_recording)
    recording = analyze_recording(local_recording)
    local_recording.unlink()
    docker("exec", FS_CONTAINER, "rm", "-f", recording_path)

    injected = int(playback["module_injected_frames"])
    emitted = int(transport["receiver_emitted_frames"])
    cleanup_dropped = emitted - injected
    if not (0 < injected <= emitted and 0 <= cleanup_dropped <= 2):
        raise RuntimeError(
            f"invalid playback accounting: emitted={emitted} injected={injected}"
        )
    if not (
        recording["marker_match"]
        and recording["source_present"]
        and recording["source_return_distinct"]
        and not recording["silence_only"]
        and recording["channels"] == 2
    ):
        raise RuntimeError(f"return recording proof failed: {recording}")

    return {
        "channel_uuid": a_leg,
        "session_id": session_id,
        "fs_generated_frames": recording["fs_recorded_frames"],
        "module_exported_frames": transport["receiver_accepted_frames"],
        "receiver_accepted_frames": transport["receiver_accepted_frames"],
        "receiver_emitted_frames": emitted,
        "module_injected_frames": injected,
        "fs_recorded_frames": recording["fs_recorded_frames"],
        "cleanup_dropped_frames": cleanup_dropped,
        "unresolved_missing_frames": transport["unresolved_missing_frames"],
        "duplicate_frames": transport["duplicate_frames"],
        "out_of_order_frames": transport["out_of_order_frames"],
        "checksum_mismatches": transport["checksum_mismatches"],
        "recording": {
            **recording,
            "path": recording_path,
            "removed_after_evidence": not local_recording.exists(),
        },
    }


def isolation_probe() -> dict:
    a_legs = [str(uuid.uuid4()), str(uuid.uuid4())]
    for a_leg in a_legs:
        response = cli(
            "bgapi originate "
            f"{{origination_uuid={a_leg}}}loopback/1000/default "
            "&playback(tone_stream://%(6000,0,440))"
        )
        if not response.startswith("+OK Job-UUID:"):
            raise RuntimeError(f"isolation originate failed: {response}")

    b_legs = wait_for_b_legs(2)
    time.sleep(0.75)
    stop_first = cli(f"uuid_audio_stream {b_legs[0]} stop")
    first_exists = cli(f"uuid_exists {b_legs[0]}")
    second_exists = cli(f"uuid_exists {b_legs[1]}")
    pause_second = cli(f"uuid_audio_stream {b_legs[1]} pause")
    resume_second = cli(f"uuid_audio_stream {b_legs[1]} resume")

    time.sleep(0.25)
    first_snapshot = esl_snapshot()
    time.sleep(1.5)
    second_snapshot = esl_snapshot()

    first_one = first_snapshot["sessions"][b_legs[0]]["module_injected_frames"]
    first_two = second_snapshot["sessions"][b_legs[0]]["module_injected_frames"]
    second_one = first_snapshot["sessions"][b_legs[1]]["module_injected_frames"]
    second_two = second_snapshot["sessions"][b_legs[1]]["module_injected_frames"]
    if not (
        stop_first.startswith("+OK")
        and first_exists == "true"
        and second_exists == "true"
        and pause_second.startswith("+OK")
        and resume_second.startswith("+OK")
        and first_one == first_two
        and second_two > second_one
    ):
        raise RuntimeError(
            "channel-scoped stop isolation failed: "
            f"first={first_one}->{first_two}, second={second_one}->{second_two}"
        )

    stop_second = cli(f"uuid_audio_stream {b_legs[1]} stop")
    if not stop_second.startswith("+OK"):
        raise RuntimeError(f"second stop failed: {stop_second}")
    wait_for_known_channels_to_close(a_legs + b_legs)

    first_transport = wait_for_bridge_session(b_legs[0], 0)
    second_transport = wait_for_bridge_session(b_legs[1], 0)
    assert_clean_transport(first_transport)
    assert_clean_transport(second_transport)
    before_reconnect_check = {
        b_leg: len(
            [record for record in bridge_metrics() if record.get("session_id") == b_leg]
        )
        for b_leg in b_legs
    }
    time.sleep(0.5)
    after_reconnect_check = {
        b_leg: len(
            [record for record in bridge_metrics() if record.get("session_id") == b_leg]
        )
        for b_leg in b_legs
    }
    if before_reconnect_check != {b_legs[0]: 1, b_legs[1]: 1}:
        raise RuntimeError(f"unexpected session connection counts: {before_reconnect_check}")
    if after_reconnect_check != before_reconnect_check:
        raise RuntimeError(f"unexpected reconnect detected: {after_reconnect_check}")

    final_snapshot = esl_snapshot()
    injected = {
        b_leg: final_snapshot["sessions"][b_leg]["module_injected_frames"]
        for b_leg in b_legs
    }
    cleanup_dropped = {
        b_leg: next(
            record["receiver_emitted_frames"]
            for record in bridge_metrics()
            if record.get("session_id") == b_leg
        )
        - injected[b_leg]
        for b_leg in b_legs
    }
    if any(value < 0 or value > 2 for value in cleanup_dropped.values()):
        raise RuntimeError(f"unexpected teardown accounting: {cleanup_dropped}")

    return {
        "a_leg_uuids": a_legs,
        "b_leg_uuids": b_legs,
        "stop_first": stop_first,
        "first_channel_remained_active": first_exists == "true",
        "second_channel_remained_active": second_exists == "true",
        "first_module_injected_frames": [first_one, first_two],
        "second_module_injected_frames": [second_one, second_two],
        "cleanup_dropped_frames": cleanup_dropped,
        "connection_count_per_session": after_reconnect_check,
        "reconnects": 0,
        "all_known_channels_closed": True,
    }


def main() -> int:
    created_containers: list[str] = []
    created_network = False
    evidence_directory = Path(
        tempfile.mkdtemp(prefix="yoko-fs-media-evidence-", dir="/var/tmp")
    )
    result: dict[str, object] = {}

    try:
        for name in (FS_CONTAINER, BRIDGE_CONTAINER, ESL_CONTAINER):
            if exact_name_exists("container", name):
                raise RuntimeError(f"refusing to reuse existing container: {name}")
        if exact_name_exists("network", NETWORK):
            raise RuntimeError(f"refusing to reuse existing network: {NETWORK}")

        image_id = docker("image", "inspect", "--format", "{{.Id}}", IMAGE_TAG)
        docker("image", "inspect", NODE_IMAGE)

        docker("network", "create", "--internal", NETWORK)
        created_network = True

        docker(
            "run",
            "-d",
            "--name",
            BRIDGE_CONTAINER,
            "--network",
            NETWORK,
            "--network-alias",
            BRIDGE_CONTAINER,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "128m",
            "--cpus",
            "0.25",
            "--pids-limit",
            "64",
            "--mount",
            f"type=bind,source={SCRIPT_DIR / 'bridge.js'},target=/probe/bridge.js,readonly",
            "--entrypoint",
            "/usr/local/bin/node",
            NODE_IMAGE,
            "/probe/bridge.js",
        )
        created_containers.append(BRIDGE_CONTAINER)
        wait_for_log(BRIDGE_CONTAINER, "YOKO_MEDIA_BRIDGE_READY")

        docker(
            "run",
            "-d",
            "--name",
            FS_CONTAINER,
            "--network",
            NETWORK,
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=128m",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "256m",
            "--cpus",
            "0.50",
            "--pids-limit",
            "128",
            "--entrypoint",
            "/usr/bin/freeswitch",
            image_id,
            "-nonat",
            "-nf",
            "-nc",
            "-conf",
            "/usr/share/freeswitch/conf/yoko-media-dev",
            "-log",
            "/tmp/log",
            "-db",
            "/tmp/db",
            "-run",
            "/tmp/run",
        )
        created_containers.append(FS_CONTAINER)
        wait_for_fs()

        docker(
            "run",
            "-d",
            "--name",
            ESL_CONTAINER,
            "--network",
            f"container:{FS_CONTAINER}",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "64m",
            "--cpus",
            "0.10",
            "--pids-limit",
            "32",
            "--mount",
            (
                f"type=bind,source={SCRIPT_DIR / 'esl-playback-metrics.js'},"
                "target=/probe/esl-playback-metrics.js,readonly"
            ),
            "--entrypoint",
            "/usr/local/bin/node",
            NODE_IMAGE,
            "/probe/esl-playback-metrics.js",
        )
        created_containers.append(ESL_CONTAINER)
        wait_for_log(ESL_CONTAINER, "YOKO_ESL_READY")

        result = {
            "image": IMAGE_TAG,
            "image_id": image_id,
            "module_path": "/usr/lib/freeswitch/mod/mod_audio_stream.so",
            "module_loaded": cli("module_exists mod_audio_stream") == "true",
            "api": cli("show api uuid_audio_stream"),
            "application": cli("show application uuid_audio_stream"),
            "main_probe": main_probe(evidence_directory),
            "isolation_probe": isolation_probe(),
        }
        print(f"YOKO_CAPABILITY_RESULT {json.dumps(result, sort_keys=True)}")
        return 0
    except Exception as error:
        print(f"YOKO_CAPABILITY_ERROR {error}", file=sys.stderr)
        return 1
    finally:
        for container in reversed(created_containers):
            docker("rm", "-f", container, check=False)
        if created_network:
            docker("network", "rm", NETWORK, check=False)
        if evidence_directory.name.startswith("yoko-fs-media-evidence-"):
            shutil.rmtree(evidence_directory, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
