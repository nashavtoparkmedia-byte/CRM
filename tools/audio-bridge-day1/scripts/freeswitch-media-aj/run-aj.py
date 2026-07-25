from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid

from recording import analyze_recording


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
IMAGE_TAG = "yoko/freeswitch-media-dev:fs1.10.12-alchemilla-a25fb1fe"
IMAGE_ID = "sha256:6a48cc3412d5c45f9204681880feeddddc1e4af92f0fa176d22d133a881898f7"
NODE_IMAGE = (
    "node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0"
)
NODE_BINARY = Path("/home/codexbot/.local/node-v22.18.0-linux-x64/bin/node")
NETWORK = "yoko-ai-media-aj-internal"
FS_CONTAINER = "yoko-fs-media-aj-dev"
BRIDGE_CONTAINER = "yoko-fs-media-aj-bridge"
ESL_CONTAINER = "yoko-fs-media-aj-esl"
RUNTIME_DIRECTORY = Path("/var/tmp/yoko-ai-calls-fs-media-aj")
MAX_SUITE_SECONDS = 120.0
MAX_SCENARIO_SECONDS = 120.0
MIN_INITIAL_FREE = 10 * 1024**3
MIN_FINAL_FREE = 8 * 1024**3
SUITE_DEADLINE: float | None = None
PRODUCTION_CONTAINERS = (
    "crm-max-scraper",
    "crm-gravity-mvp",
    "crm-tg-bot",
    "crm-yfs-worker",
    "crm-yfs-api",
    "crm-tg-bot-frontend",
    "seo-site",
    "crm-freeswitch",
    "crm-nginx",
    "crm-redis",
    "crm-audio-bridge",
    "crm-postgres",
    "crm-minio",
)
DOCKER = ["docker"] if os.geteuid() == 0 else ["sudo", "-n", "docker"]


class HarnessError(RuntimeError):
    pass


def capped_timeout(requested_seconds: float) -> float:
    if SUITE_DEADLINE is None:
        return requested_seconds
    remaining = SUITE_DEADLINE - time.monotonic()
    if remaining < 0.05:
        raise HarnessError("bounded A-J suite deadline exceeded")
    return min(requested_seconds, remaining)


def run(
    command: list[str],
    *,
    check: bool = True,
    timeout: float = 30.0,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        timeout=capped_timeout(timeout),
        env=env,
    )
    if check and result.returncode != 0:
        output = (result.stdout + result.stderr).strip()
        raise HarnessError(f"{command!r} failed ({result.returncode}): {output}")
    return result


def docker(*arguments: str, check: bool = True, timeout: float = 30.0) -> str:
    result = run([*DOCKER, *arguments], check=check, timeout=timeout)
    return (result.stdout + result.stderr).strip()


def cli(command: str, *, check: bool = True) -> str:
    return docker("exec", FS_CONTAINER, "fs_cli", "-x", command, check=check)


def exact_resource_exists(kind: str, name: str) -> bool:
    return run([*DOCKER, kind, "inspect", name], check=False).returncode == 0


def free_bytes() -> int:
    return shutil.disk_usage("/").free


def production_baseline() -> dict[str, dict[str, object]]:
    baseline: dict[str, dict[str, object]] = {}
    for name in PRODUCTION_CONTAINERS:
        raw = docker("inspect", name)
        item = json.loads(raw)[0]
        health = item["State"].get("Health", {}).get("Status", "not-configured")
        baseline[name] = {
            "container_id": item["Id"],
            "image_id": item["Image"],
            "started_at": item["State"]["StartedAt"],
            "restart_count": item["RestartCount"],
            "health": health,
            "state": item["State"]["Status"],
        }
    return baseline


def assert_production_unchanged(
    before: dict[str, dict[str, object]],
    after: dict[str, dict[str, object]],
) -> None:
    if before != after:
        changed = {
            name: {"before": before.get(name), "after": after.get(name)}
            for name in sorted(set(before) | set(after))
            if before.get(name) != after.get(name)
        }
        raise HarnessError(f"production container identity changed: {changed}")


def wait_until(
    predicate,
    *,
    timeout_seconds: float,
    description: str,
    interval: float = 0.05,
):
    deadline = time.monotonic() + capped_timeout(timeout_seconds)
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise HarnessError(f"timeout waiting for {description}")


class RuntimeController:
    def __init__(self, native_host: str):
        node_command = [
            *DOCKER,
            "run",
            "--rm",
            "-i",
            "--pull=never",
            "--name",
            BRIDGE_CONTAINER,
            "--network",
            f"container:{FS_CONTAINER}",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=32m",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "192m",
            "--cpus",
            "0.50",
            "--pids-limit",
            "64",
            "--user",
            "998:998",
            "--mount",
            (
                f"type=bind,source={SCRIPT_DIR.parent.parent},"
                "target=/workspace/audio-bridge,readonly"
            ),
            "-e",
            f"YOKO_AJ_NATIVE_HOST={native_host}",
            "-e",
            "YOKO_AJ_NATIVE_PORT=8080",
            "--entrypoint",
            "/usr/local/bin/node",
            NODE_IMAGE,
            "--max-old-space-size=128",
            "/workspace/audio-bridge/scripts/freeswitch-media-aj/runtime.js",
        ]
        self.process = subprocess.Popen(
            node_command,
            cwd=str(SCRIPT_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.events: queue.Queue[dict[str, object]] = queue.Queue()
        self.logs: list[str] = []
        self.responses: dict[str, dict[str, object]] = {}
        self._condition = threading.Condition()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        assert self.process.stdout is not None
        for raw_line in self.process.stdout:
            line = raw_line.rstrip("\n")
            self.logs.append(line)
            if not line.startswith("YOKO_AJ_RUNTIME "):
                continue
            try:
                event = json.loads(line[len("YOKO_AJ_RUNTIME ") :])
            except json.JSONDecodeError:
                continue
            with self._condition:
                if event.get("type") == "response":
                    self.responses[str(event.get("id"))] = event
                else:
                    self.events.put(event)
                self._condition.notify_all()

    def wait_ready(self, timeout_seconds: float = 5.0) -> dict[str, object]:
        deadline = time.monotonic() + capped_timeout(timeout_seconds)
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise HarnessError(
                    f"DEV Audio Bridge runtime exited early: {self.logs[-20:]}"
                )
            try:
                event = self.events.get(timeout=0.1)
            except queue.Empty:
                continue
            if event.get("type") == "ready":
                return event
            if event.get("type") == "fatal":
                raise HarnessError(f"DEV Audio Bridge startup failed: {event}")
        raise HarnessError("DEV Audio Bridge readiness timeout")

    def command(
        self,
        action: str,
        *,
        timeout_seconds: float = 4.0,
        **payload,
    ) -> dict[str, object]:
        if self.process.poll() is not None:
            raise HarnessError(f"DEV Audio Bridge runtime not running: {self.logs[-20:]}")
        command_id = uuid.uuid4().hex
        command = {"id": command_id, "action": action, **payload}
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + capped_timeout(timeout_seconds)
        with self._condition:
            while time.monotonic() < deadline:
                response = self.responses.pop(command_id, None)
                if response is not None:
                    if not response.get("ok"):
                        raise HarnessError(
                            f"runtime command {action!r} rejected: {response}"
                        )
                    return response
                self._condition.wait(timeout=0.05)
        raise HarnessError(f"runtime command {action!r} timeout")

    def snapshot(self) -> dict[str, object]:
        response = self.command("snapshot")
        return {
            "adapter": response["adapter"],
            "bridge": response["bridge"],
            "rss_bytes": response["rssBytes"],
        }

    def stop(self) -> dict[str, object]:
        if self.process.poll() is not None:
            return {"exit_code": self.process.returncode, "already_stopped": True}
        response = self.command("shutdown")
        try:
            exit_code = self.process.wait(timeout=4.0)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            exit_code = self.process.wait(timeout=2.0)
        return {"exit_code": exit_code, "response": response}


def adapter_sessions(snapshot: dict[str, object]) -> list[dict[str, object]]:
    adapter = snapshot["adapter"]
    return [*(adapter.get("active") or []), *(adapter.get("completed") or [])]


def value(record: dict[str, object], *names: str, default=0):
    for name in names:
        if name in record:
            return record[name]
    return default


def find_adapter_session(
    snapshot: dict[str, object],
    *,
    profile_id: str | None = None,
    channel_uuid: str | None = None,
) -> dict[str, object] | None:
    for session in adapter_sessions(snapshot):
        session_profile = value(session, "profile_id", "profileId", default="")
        session_uuid = value(session, "channel_uuid", "channelUuid", default="")
        if profile_id is not None and session_profile != profile_id:
            continue
        if channel_uuid is not None and session_uuid != channel_uuid:
            continue
        return session
    return None


def bridge_sessions(snapshot: dict[str, object]) -> list[dict[str, object]]:
    bridge = snapshot["bridge"]
    return [*(bridge.get("active") or []), *(bridge.get("completed") or [])]


def find_bridge_session(
    snapshot: dict[str, object],
    channel_uuid: str,
) -> dict[str, object] | None:
    return next(
        (
            session
            for session in bridge_sessions(snapshot)
            if session.get("sessionId") == channel_uuid
        ),
        None,
    )


def show_rows() -> list[dict[str, object]]:
    output = cli("show channels as json")
    if not output:
        return []
    return json.loads(output).get("rows") or []


def b_leg_uuids() -> set[str]:
    matches: set[str] = set()
    for row in show_rows():
        name = str(row.get("name") or "")
        destination = str(row.get("dest") or row.get("destination_number") or "")
        if name.startswith("loopback/1000-b") or (name.endswith("-b") and destination == "1000"):
            matches.add(str(row["uuid"]))
    return matches


def wait_for_fs(timeout_seconds: float = 20.0) -> None:
    def ready() -> bool:
        try:
            return cli("module_exists mod_audio_stream") == "true"
        except HarnessError:
            return False

    wait_until(ready, timeout_seconds=timeout_seconds, description="DEV FreeSWITCH")


def wait_for_log(container: str, marker: str, timeout_seconds: float = 5.0) -> None:
    wait_until(
        lambda: marker in docker("logs", container, check=False),
        timeout_seconds=timeout_seconds,
        description=f"{container} log marker {marker}",
    )


def start_channel(
    runtime: RuntimeController,
    *,
    scenario: str,
    source_hz: int,
    return_hz: int,
    suppress_native_return: bool = False,
    processing_delay_ms: int = 0,
    max_queue_frames: int = 8,
) -> tuple[str, str, dict[str, object]]:
    runtime.command(
        "arm",
        profile={
            "id": scenario,
            "sourceHz": source_hz,
            "returnHz": return_hz,
            "suppressNativeReturn": suppress_native_return,
            "processingDelayMs": processing_delay_ms,
            "maxQueueFrames": max_queue_frames,
        },
    )
    before = b_leg_uuids()
    a_leg = str(uuid.uuid4())
    response = cli(
        "bgapi originate "
        f"{{origination_uuid={a_leg}}}loopback/1000/default "
        f"&playback(tone_stream://%(6000,0,{source_hz}))"
    )
    if not response.startswith("+OK Job-UUID:"):
        raise HarnessError(f"scenario {scenario} originate failed: {response}")

    def new_b_leg() -> str | None:
        difference = sorted(b_leg_uuids() - before)
        return difference[0] if difference else None

    b_leg = wait_until(
        new_b_leg,
        timeout_seconds=3.0,
        description=f"scenario {scenario} B leg",
    )

    def connected_session() -> dict[str, object] | None:
        snapshot = runtime.snapshot()
        return find_adapter_session(
            snapshot,
            profile_id=scenario,
            channel_uuid=b_leg,
        )

    session = wait_until(
        connected_session,
        timeout_seconds=3.0,
        description=f"scenario {scenario} adapter session",
    )
    return a_leg, b_leg, session


def wait_for_frames(
    runtime: RuntimeController,
    channel_uuid: str,
    minimum: int,
    *,
    timeout_seconds: float = 3.0,
) -> dict[str, object]:
    def enough() -> dict[str, object] | None:
        snapshot = runtime.snapshot()
        session = find_adapter_session(snapshot, channel_uuid=channel_uuid)
        if not session:
            return None
        frames = int(
            value(
                session,
                "adapter_accepted_native_frames",
                "acceptedNativeFrames",
                default=0,
            )
        )
        return session if frames >= minimum else None

    return wait_until(
        enough,
        timeout_seconds=timeout_seconds,
        description=f"{minimum} native frames for {channel_uuid}",
    )


def wait_for_session_completed(
    runtime: RuntimeController,
    channel_uuid: str,
    *,
    timeout_seconds: float = 4.0,
) -> dict[str, object]:
    def completed() -> dict[str, object] | None:
        snapshot = runtime.snapshot()
        adapter = snapshot["adapter"]
        for session in adapter.get("completed") or []:
            if value(session, "channel_uuid", "channelUuid", default="") == channel_uuid:
                return session
        return None

    return wait_until(
        completed,
        timeout_seconds=timeout_seconds,
        description=f"adapter cleanup for {channel_uuid}",
    )


def wait_for_channels_closed(channels: list[str], timeout_seconds: float = 5.0) -> None:
    wait_until(
        lambda: all(cli(f"uuid_exists {channel}") == "false" for channel in channels),
        timeout_seconds=timeout_seconds,
        description=f"channel cleanup {channels}",
    )


def hangup(channel_uuid: str) -> None:
    response = cli(f"uuid_kill {channel_uuid} NORMAL_CLEARING", check=False)
    if response and not response.startswith("+OK") and "No such channel" not in response:
        raise HarnessError(f"targeted hangup failed for {channel_uuid}: {response}")


def stop_stream(channel_uuid: str) -> str:
    return cli(f"uuid_audio_stream {channel_uuid} stop", check=False)


def esl_snapshot() -> dict[str, object]:
    docker("kill", "--signal", "SIGUSR1", ESL_CONTAINER)
    time.sleep(0.1)
    records = []
    for line in docker("logs", ESL_CONTAINER, check=False).splitlines():
        if line.startswith("YOKO_ESL_METRICS "):
            records.append(json.loads(line[len("YOKO_ESL_METRICS ") :]))
    if not records:
        raise HarnessError("ESL metrics snapshot missing")
    return records[-1]


def copy_container_file(source: str, destination: Path) -> None:
    try:
        with destination.open("wb") as output:
            result = subprocess.run(
                [*DOCKER, "exec", FS_CONTAINER, "dd", f"if={source}", "status=none"],
                stdout=output,
                stderr=subprocess.PIPE,
                check=False,
                timeout=capped_timeout(30.0),
            )
    except subprocess.TimeoutExpired as error:
        destination.unlink(missing_ok=True)
        raise HarnessError(f"timed out copying {source}") from error
    if result.returncode != 0:
        destination.unlink(missing_ok=True)
        raise HarnessError(
            f"failed to copy {source}: {result.stderr.decode(errors='replace')}"
        )


def recording_evidence(
    channel_uuid: str,
    *,
    source_hz: int,
    return_hz: int,
    peer_return_hz: int | None = None,
) -> dict[str, object]:
    container_path = f"/tmp/yoko-return-{channel_uuid}.wav"
    local_path = RUNTIME_DIRECTORY / f"return-{channel_uuid}.wav"
    copy_container_file(container_path, local_path)
    evidence = analyze_recording(
        local_path,
        source_hz=source_hz,
        return_hz=return_hz,
        peer_return_hz=peer_return_hz,
    )
    local_path.unlink(missing_ok=True)
    docker("exec", FS_CONTAINER, "rm", "-f", container_path, check=False)
    evidence["container_path"] = container_path
    evidence["removed_after_evidence"] = not local_path.exists()
    return evidence


def remove_recording(channel_uuid: str) -> None:
    docker(
        "exec",
        FS_CONTAINER,
        "rm",
        "-f",
        f"/tmp/yoko-return-{channel_uuid}.wav",
        check=False,
    )


def latency_from(session: dict[str, object], bridge: dict[str, object]) -> dict[str, float]:
    adapter_latency = value(session, "latency", "returnLatency", default={}) or {}
    bridge_latency = bridge.get("serverProcessingLatency") or {}
    average = max(
        float(value(adapter_latency, "average_ms", "averageMs", default=0)),
        float(bridge_latency.get("averageMs") or 0),
    )
    p95 = max(
        float(value(adapter_latency, "p95_ms", "p95Ms", default=0)),
        float(bridge_latency.get("p95Ms") or 0),
    )
    maximum = max(
        float(value(adapter_latency, "max_ms", "maxMs", default=0)),
        float(bridge_latency.get("maxMs") or 0),
    )
    return {"average_ms": average, "p95_ms": p95, "maximum_ms": maximum}


def collect_metrics(
    runtime: RuntimeController,
    *,
    scenario: str,
    a_leg: str,
    b_leg: str,
    recording: dict[str, object] | None = None,
) -> dict[str, object]:
    snapshot = runtime.snapshot()
    adapter = find_adapter_session(snapshot, channel_uuid=b_leg)
    bridge = find_bridge_session(snapshot, b_leg)
    if not adapter or not bridge:
        raise HarnessError(
            f"scenario {scenario} missing terminal adapter/bridge metrics for {b_leg}"
        )
    playback = (esl_snapshot().get("sessions") or {}).get(b_leg) or {}

    accepted_native = int(
        value(
            adapter,
            "adapter_accepted_native_frames",
            "acceptedNativeFrames",
            default=0,
        )
    )
    wrapped = int(
        value(
            adapter,
            "adapter_wrapped_internal_frames",
            "wrappedInternalFrames",
            default=0,
        )
    )
    accepted_return = int(
        value(
            adapter,
            "adapter_accepted_return_frames",
            "acceptedReturnFrames",
            default=0,
        )
    )
    emitted_native = int(
        value(
            adapter,
            "adapter_emitted_native_frames",
            "emittedNativeFrames",
            default=0,
        )
    )
    injected = int(playback.get("module_injected_frames") or 0)
    recorded_frames = int((recording or {}).get("fs_recorded_frames") or 0)
    suppress_native_return = bool(
        (adapter.get("profile") or {}).get("suppress_native_return")
    )
    adapter_raw_missing = int(
        value(
            adapter,
            "unresolved_missing_frames",
            "unresolvedMissingFrames",
            default=0,
        )
    )
    teardown_in_flight_return = int(
        value(
            adapter,
            "in_flight_return_frames_at_cleanup",
            "inFlightReturnFramesAtCleanup",
            default=0,
        )
    )
    adapter_unexpected_missing = max(
        0, adapter_raw_missing - teardown_in_flight_return
    )
    cleanup_drop_components = {
        "adapter_to_bridge": max(
            0, wrapped - int(bridge.get("framesReceived") or 0)
        ),
        "inside_bridge": max(
            0,
            int(bridge.get("framesReceived") or 0)
            - int(bridge.get("framesSent") or 0),
        ),
        "bridge_to_adapter": max(
            0, int(bridge.get("framesSent") or 0) - accepted_return
        ),
        "adapter_to_native": (
            0 if suppress_native_return else max(0, accepted_return - emitted_native)
        ),
        "native_to_module": max(0, emitted_native - injected),
    }
    cleanup_dropped = sum(cleanup_drop_components.values())
    rejected = (
        int(bridge.get("rejectedFrames") or 0)
        + int(value(adapter, "rejected_frames", "rejectedFrames", default=0))
    )
    duplicate = (
        int(bridge.get("duplicates") or 0)
        + int(value(adapter, "duplicate_frames", "duplicateFrames", default=0))
    )
    missing = (
        int(bridge.get("missingFrames") or 0)
        + adapter_unexpected_missing
    )
    checksum = (
        int(bridge.get("checksumMismatches") or 0)
        + int(
            value(
                adapter,
                "checksum_mismatches",
                "checksumMismatches",
                default=0,
            )
        )
    )
    return {
        "scenario": scenario,
        "channel_uuid": b_leg,
        "a_leg_uuid": a_leg,
        "bridge_session_id": bridge["sessionId"],
        "fs_generated_frames": accepted_native,
        "module_exported_frames": accepted_native,
        "adapter_accepted_native_frames": accepted_native,
        "adapter_wrapped_internal_frames": wrapped,
        "bridge_accepted_frames": int(bridge.get("framesReceived") or 0),
        "bridge_emitted_frames": int(bridge.get("framesSent") or 0),
        "adapter_accepted_return_frames": accepted_return,
        "adapter_emitted_native_frames": emitted_native,
        "module_injected_frames": injected,
        "fs_recorded_frames": recorded_frames,
        "bytes": {
            "native_received": int(
                value(
                    adapter,
                    "native_bytes_received",
                    "nativeBytesReceived",
                    default=accepted_native * 320,
                )
            ),
            "internal_sent": int(
                value(
                    adapter,
                    "internal_bytes_sent",
                    "internalBytesSent",
                    default=wrapped * 320,
                )
            ),
            "bridge_received": int(bridge.get("bytesReceived") or 0),
            "bridge_sent": int(bridge.get("bytesSent") or 0),
            "internal_received": int(
                value(
                    adapter,
                    "internal_bytes_received",
                    "internalBytesReceived",
                    default=accepted_return * 320,
                )
            ),
            "native_sent": int(
                value(
                    adapter,
                    "native_bytes_sent",
                    "nativeBytesSent",
                    default=emitted_native * 320,
                )
            ),
            "module_injected": int(playback.get("module_injected_bytes") or 0),
        },
        "cleanup_dropped_frames": cleanup_dropped,
        "cleanup_drop_components": cleanup_drop_components,
        "teardown_in_flight_return_frames": teardown_in_flight_return,
        "raw_adapter_unresolved_missing": adapter_raw_missing,
        "rejected_frames": rejected,
        "duplicates": duplicate,
        "out_of_order_frames": int(bridge.get("outOfOrderFrames") or 0)
        + int(
            value(
                adapter,
                "out_of_order_frames",
                "outOfOrderFrames",
                default=0,
            )
        ),
        "recovered_missing": int(
            value(
                adapter,
                "recovered_missing_frames",
                "recoveredMissingFrames",
                default=0,
            )
        ),
        "unresolved_missing": missing,
        "checksum_mismatches": checksum,
        "queue_high_water_mark": max(
            int(bridge.get("queueHighWaterMark") or 0),
            int(
                value(
                    adapter,
                    "queue_high_water_mark",
                    "queueHighWaterMark",
                    default=0,
                )
            ),
        ),
        "websocket_connections": int(
            value(
                adapter,
                "websocket_connections",
                "websocketConnections",
                default=2,
            )
        ),
        "control_messages": int(
            value(adapter, "control_messages", "controlMessages", default=0)
        ),
        "latency": latency_from(adapter, bridge),
        "bridge_reason": bridge.get("reason"),
        "adapter_reason": value(adapter, "reason", default=None),
        "suppress_native_return": suppress_native_return,
        "cleanup": {
            "adapter": value(
                adapter,
                "cleanup_result",
                "cleanupResult",
                default="unknown",
            ),
            "bridge": bridge.get("cleanupResult"),
            "mapping_removed": not any(
                value(item, "channel_uuid", "channelUuid", default="") == b_leg
                for item in (snapshot["adapter"].get("active") or [])
            ),
        },
        "source_tone_amplitudes": value(
            adapter,
            "source_tone_amplitudes",
            "sourceToneAmplitudes",
            default={},
        ),
        "return_tone_amplitudes": value(
            adapter,
            "return_tone_amplitudes",
            "returnToneAmplitudes",
            default={},
        ),
        "recording": recording,
    }


def assert_clean_transport(metrics: dict[str, object], *, allow_rejected: bool = False) -> None:
    accepted_native = int(metrics["adapter_accepted_native_frames"])
    wrapped = int(metrics["adapter_wrapped_internal_frames"])
    bridge_accepted = int(metrics["bridge_accepted_frames"])
    bridge_emitted = int(metrics["bridge_emitted_frames"])
    accepted_return = int(metrics["adapter_accepted_return_frames"])
    emitted_native = int(metrics["adapter_emitted_native_frames"])
    injected = int(metrics["module_injected_frames"])
    teardown_in_flight = int(metrics["teardown_in_flight_return_frames"])
    cleanup_dropped = int(metrics["cleanup_dropped_frames"])

    if accepted_native <= 0:
        raise HarnessError(f"no native media reached adapter: {metrics}")
    if (
        int(metrics["fs_generated_frames"]) != accepted_native
        or int(metrics["module_exported_frames"]) != accepted_native
        or wrapped != accepted_native
    ):
        raise HarnessError(f"native export/wrapping accounting diverged: {metrics}")
    if bridge_accepted <= 0 or bridge_emitted <= 0 or accepted_return <= 0:
        raise HarnessError(f"complete YALB round trip was not observed: {metrics}")

    wrapped_gap = wrapped - bridge_accepted
    bridge_processing_gap = bridge_accepted - bridge_emitted
    return_gap = bridge_emitted - accepted_return
    if wrapped_gap < 0 or bridge_processing_gap < 0 or return_gap < 0:
        raise HarnessError(f"impossible YALB accounting: {metrics}")
    if max(wrapped_gap, bridge_processing_gap, return_gap) > 8:
        raise HarnessError(f"unbounded teardown transport gap: {metrics}")
    if (
        wrapped_gap + bridge_processing_gap + return_gap != teardown_in_flight
        or int(metrics["raw_adapter_unresolved_missing"]) != teardown_in_flight
    ):
        raise HarnessError(f"unaccounted in-flight return frames: {metrics}")
    if metrics["scenario"] == "A":
        if not metrics["suppress_native_return"] or emitted_native != 0 or injected != 0:
            raise HarnessError(f"scenario A unexpectedly injected return media: {metrics}")
    elif accepted_return < emitted_native or emitted_native < injected:
        raise HarnessError(f"impossible native/module accounting: {metrics}")
    expected_cleanup_components = {
        "adapter_to_bridge": wrapped_gap,
        "inside_bridge": bridge_processing_gap,
        "bridge_to_adapter": return_gap,
        "adapter_to_native": (
            0
            if metrics["suppress_native_return"]
            else accepted_return - emitted_native
        ),
        "native_to_module": emitted_native - injected,
    }
    if (
        metrics["cleanup_drop_components"] != expected_cleanup_components
        or cleanup_dropped != sum(expected_cleanup_components.values())
    ):
        raise HarnessError(f"cleanup drop accounting diverged: {metrics}")
    source_samples = int(
        (metrics["source_tone_amplitudes"] or {}).get("samples") or 0
    )
    if source_samples != accepted_native * 160:
        raise HarnessError(f"native PCM sample accounting diverged: {metrics}")
    if metrics["unresolved_missing"] != 0 or metrics["checksum_mismatches"] != 0:
        raise HarnessError(f"transport integrity failure: {metrics}")
    if metrics["duplicates"] != 0 or metrics["out_of_order_frames"] != 0:
        raise HarnessError(f"unexpected sequence anomaly: {metrics}")
    if not allow_rejected and metrics["rejected_frames"] != 0:
        raise HarnessError(f"unexpected rejected frames: {metrics}")
    if not metrics["cleanup"]["mapping_removed"]:
        raise HarnessError(f"adapter mapping not removed: {metrics}")
    if (
        float((metrics["source_tone_amplitudes"] or {}).get("estimated_amplitude") or 0)
        <= 500
    ):
        raise HarnessError(f"deterministic source marker not detected: {metrics}")
    if (
        float((metrics["return_tone_amplitudes"] or {}).get("estimated_amplitude") or 0)
        <= 500
    ):
        raise HarnessError(f"deterministic Bridge return marker not detected: {metrics}")


def assert_recording(evidence: dict[str, object], *, isolation: bool = False) -> None:
    required = (
        evidence["bytes"] > 0
        and evidence["duration_seconds"] >= 0.5
        and evidence["sample_rate"] == 8000
        and evidence["channels"] == 2
        and evidence["fs_recorded_frames"] >= 25
        and evidence["rms"] > 100
        and evidence["peak"] > 500
        and evidence["silence_ratio"] < 0.2
        and evidence["source_present"]
        and evidence["marker_match"]
        and evidence["direction_distinct"]
        and not evidence["silence_only"]
        and evidence["removed_after_evidence"]
    )
    if isolation:
        required = required and not evidence["cross_session_contamination"]
    if not required:
        raise HarnessError(f"recording evidence failed: {evidence}")


@dataclass
class RunningChannel:
    scenario: str
    a_leg: str
    b_leg: str
    source_hz: int
    return_hz: int


def normal_scenario(
    runtime: RuntimeController,
    *,
    name: str,
    source_hz: int,
    return_hz: int,
    recording_required: bool,
    suppress_native_return: bool = False,
) -> dict[str, object]:
    started = time.monotonic()
    a_leg, b_leg, _ = start_channel(
        runtime,
        scenario=name,
        source_hz=source_hz,
        return_hz=return_hz,
        suppress_native_return=suppress_native_return,
    )
    wait_for_frames(runtime, b_leg, 30)
    hangup(a_leg)
    wait_for_channels_closed([a_leg, b_leg])
    wait_for_session_completed(runtime, b_leg)
    recording = (
        recording_evidence(
            b_leg,
            source_hz=source_hz,
            return_hz=return_hz,
        )
        if recording_required
        else None
    )
    if not recording_required:
        remove_recording(b_leg)
    metrics = collect_metrics(
        runtime,
        scenario=name,
        a_leg=a_leg,
        b_leg=b_leg,
        recording=recording,
    )
    assert_clean_transport(metrics)
    if recording:
        assert_recording(recording)
        injection_gap = (
            metrics["adapter_emitted_native_frames"]
            - metrics["module_injected_frames"]
        )
        if injection_gap < 0 or injection_gap > 2:
            raise HarnessError(f"unbounded playback teardown gap: {metrics}")
    if suppress_native_return and metrics["module_injected_frames"] != 0:
        raise HarnessError(f"scenario {name} unexpectedly injected return audio")
    if time.monotonic() - started > MAX_SCENARIO_SECONDS:
        raise HarnessError(f"scenario {name} exceeded runtime limit")
    metrics["status"] = "PASS"
    return metrics


def scenario_d(runtime: RuntimeController) -> dict[str, object]:
    a_leg, b_leg, _ = start_channel(
        runtime,
        scenario="D",
        source_hz=440,
        return_hz=997,
    )
    wait_for_frames(runtime, b_leg, 25)
    hangup(a_leg)
    wait_for_channels_closed([a_leg, b_leg])
    wait_for_session_completed(runtime, b_leg)
    time.sleep(0.25)
    remove_recording(b_leg)
    metrics = collect_metrics(runtime, scenario="D", a_leg=a_leg, b_leg=b_leg)
    assert_clean_transport(metrics)
    snapshot = runtime.snapshot()
    if find_adapter_session(snapshot, channel_uuid=b_leg).get("state") == "active":
        raise HarnessError("scenario D session remained active")
    metrics["status"] = "PASS"
    return metrics


def scenario_e(runtime: RuntimeController) -> dict[str, object]:
    a_leg, b_leg, _ = start_channel(
        runtime,
        scenario="E",
        source_hz=440,
        return_hz=997,
    )
    wait_for_frames(runtime, b_leg, 25)
    runtime.command("disconnect_bridge", channelUuid=b_leg)
    wait_for_session_completed(runtime, b_leg)
    fs_responsive = cli("status").startswith("UP ")
    channel_alive_after_disconnect = cli(f"uuid_exists {b_leg}") == "true"
    stop_result = stop_stream(b_leg)
    hangup(a_leg)
    wait_for_channels_closed([a_leg, b_leg])
    remove_recording(b_leg)
    metrics = collect_metrics(runtime, scenario="E", a_leg=a_leg, b_leg=b_leg)
    assert_clean_transport(metrics)
    if not fs_responsive:
        raise HarnessError("scenario E made DEV FreeSWITCH unresponsive")
    if int(metrics["websocket_connections"]) != 2:
        raise HarnessError(f"scenario E unexpected reconnect: {metrics}")
    metrics.update(
        {
            "status": "PASS",
            "freeswitch_responsive": fs_responsive,
            "channel_alive_after_bridge_disconnect": channel_alive_after_disconnect,
            "reconnect_policy": "unsupported; explicit uuid_audio_stream start required",
            "targeted_stream_stop": stop_result,
        }
    )
    return metrics


def scenario_f(runtime: RuntimeController) -> dict[str, object]:
    a_leg, b_leg, _ = start_channel(
        runtime,
        scenario="F",
        source_hz=440,
        return_hz=997,
    )
    wait_for_frames(runtime, b_leg, 25)
    hangup(a_leg)
    wait_for_channels_closed([a_leg, b_leg])
    wait_for_session_completed(runtime, b_leg)
    first = runtime.snapshot()
    session = find_adapter_session(first, channel_uuid=b_leg)
    frames_before = int(
        value(session, "adapter_accepted_native_frames", "acceptedNativeFrames", default=0)
    )
    time.sleep(0.3)
    second = runtime.snapshot()
    session_after = find_adapter_session(second, channel_uuid=b_leg)
    frames_after = int(
        value(
            session_after,
            "adapter_accepted_native_frames",
            "acceptedNativeFrames",
            default=0,
        )
    )
    remove_recording(b_leg)
    metrics = collect_metrics(runtime, scenario="F", a_leg=a_leg, b_leg=b_leg)
    assert_clean_transport(metrics)
    if frames_before != frames_after:
        raise HarnessError("scenario F counters advanced after FreeSWITCH disconnect")
    metrics.update(
        {
            "status": "PASS",
            "frames_after_disconnect": [frames_before, frames_after],
            "reconnects": 0,
        }
    )
    return metrics


def scenario_g(runtime: RuntimeController) -> dict[str, object]:
    a_leg, b_leg, _ = start_channel(
        runtime,
        scenario="G",
        source_hz=440,
        return_hz=997,
        processing_delay_ms=50,
        max_queue_frames=4,
    )

    def backpressure() -> dict[str, object] | None:
        snapshot = runtime.snapshot()
        bridge = find_bridge_session(snapshot, b_leg)
        if bridge and bridge.get("reason") == "queue_backpressure":
            return snapshot
        return None

    terminal = wait_until(
        backpressure,
        timeout_seconds=4.0,
        description="scenario G controlled backpressure",
    )
    fs_responsive = cli("status").startswith("UP ")
    stop_stream(b_leg)
    hangup(a_leg)
    wait_for_channels_closed([a_leg, b_leg])
    wait_for_session_completed(runtime, b_leg)
    remove_recording(b_leg)
    metrics = collect_metrics(runtime, scenario="G", a_leg=a_leg, b_leg=b_leg)
    assert_clean_transport(metrics, allow_rejected=True)
    if metrics["bridge_reason"] != "queue_backpressure":
        raise HarnessError(f"scenario G wrong failure policy: {metrics}")
    if metrics["queue_high_water_mark"] > 4:
        raise HarnessError(f"scenario G queue exceeded bound: {metrics}")
    if metrics["rejected_frames"] < 1:
        raise HarnessError(f"scenario G did not account rejected frame: {metrics}")
    if int(terminal["rss_bytes"]) > 192 * 1024 * 1024:
        raise HarnessError(f"scenario G RSS limit exceeded: {terminal['rss_bytes']}")
    if not fs_responsive:
        raise HarnessError("scenario G made DEV FreeSWITCH unresponsive")
    metrics.update(
        {
            "status": "PASS",
            "backpressure_policy": "bounded queue then controlled session failure",
            "max_rss_bytes": terminal["rss_bytes"],
            "freeswitch_responsive": fs_responsive,
        }
    )
    return metrics


def scenario_h(runtime: RuntimeController) -> list[dict[str, object]]:
    a1, b1, _ = start_channel(
        runtime,
        scenario="H1",
        source_hz=440,
        return_hz=997,
    )
    wait_for_frames(runtime, b1, 25)
    a2, b2, _ = start_channel(
        runtime,
        scenario="H2",
        source_hz=660,
        return_hz=1187,
    )
    wait_for_frames(runtime, b2, 25)
    stop_first = stop_stream(b1)
    if not stop_first.startswith("+OK"):
        raise HarnessError(f"scenario H first exact stop failed: {stop_first}")
    time.sleep(0.25)
    before = esl_snapshot()["sessions"]
    first_before = int((before.get(b1) or {}).get("module_injected_frames") or 0)
    second_before = int((before.get(b2) or {}).get("module_injected_frames") or 0)
    time.sleep(0.75)
    after = esl_snapshot()["sessions"]
    first_after = int((after.get(b1) or {}).get("module_injected_frames") or 0)
    second_after = int((after.get(b2) or {}).get("module_injected_frames") or 0)
    if first_after != first_before or second_after <= second_before:
        raise HarnessError(
            "scenario H isolation failed: "
            f"first={first_before}->{first_after}, second={second_before}->{second_after}"
        )
    hangup(a1)
    hangup(a2)
    wait_for_channels_closed([a1, b1, a2, b2])
    wait_for_session_completed(runtime, b1)
    wait_for_session_completed(runtime, b2)
    recording1 = recording_evidence(
        b1,
        source_hz=440,
        return_hz=997,
        peer_return_hz=1187,
    )
    recording2 = recording_evidence(
        b2,
        source_hz=660,
        return_hz=1187,
        peer_return_hz=997,
    )
    assert_recording(recording1, isolation=True)
    assert_recording(recording2, isolation=True)
    metrics1 = collect_metrics(
        runtime,
        scenario="H1",
        a_leg=a1,
        b_leg=b1,
        recording=recording1,
    )
    metrics2 = collect_metrics(
        runtime,
        scenario="H2",
        a_leg=a2,
        b_leg=b2,
        recording=recording2,
    )
    assert_clean_transport(metrics1)
    assert_clean_transport(metrics2)
    for metrics in (metrics1, metrics2):
        injection_gap = (
            metrics["adapter_emitted_native_frames"]
            - metrics["module_injected_frames"]
        )
        if injection_gap < 0 or injection_gap > 2:
            raise HarnessError(f"scenario H playback teardown gap: {metrics}")
    if b1 == b2 or metrics1["bridge_session_id"] == metrics2["bridge_session_id"]:
        raise HarnessError("scenario H UUID/session mapping collision")
    metrics1.update(
        {
            "status": "PASS",
            "peer_channel_uuid": b2,
            "injected_counter_after_first_stop": [first_before, first_after],
        }
    )
    metrics2.update(
        {
            "status": "PASS",
            "peer_channel_uuid": b1,
            "injected_counter_while_peer_stopped": [second_before, second_after],
        }
    )
    return [metrics1, metrics2]


def scenario_i(runtime: RuntimeController) -> list[dict[str, object]]:
    a1, b1, _ = start_channel(
        runtime,
        scenario="I1",
        source_hz=440,
        return_hz=997,
    )
    wait_for_frames(runtime, b1, 25)
    a2, b2, _ = start_channel(
        runtime,
        scenario="I2",
        source_hz=660,
        return_hz=1187,
    )
    wait_for_frames(runtime, b2, 25)
    before = runtime.snapshot()
    peer_before = find_adapter_session(before, channel_uuid=b2)
    peer_frames_before = int(
        value(
            peer_before,
            "adapter_accepted_native_frames",
            "acceptedNativeFrames",
            default=0,
        )
    )
    runtime.command("emergency_stop", channelUuid=b1)
    target_terminal = wait_for_session_completed(runtime, b1)
    target_frames_at_stop = int(
        value(
            target_terminal,
            "adapter_accepted_native_frames",
            "acceptedNativeFrames",
            default=0,
        )
    )
    stop_result = stop_stream(b1)
    if not stop_result.startswith("+OK"):
        raise HarnessError(f"scenario I exact module stop failed: {stop_result}")
    time.sleep(0.2)
    target_injected_at_stop = int(
        ((esl_snapshot().get("sessions") or {}).get(b1) or {}).get(
            "module_injected_frames"
        )
        or 0
    )
    wait_for_frames(runtime, b2, peer_frames_before + 20)
    after = runtime.snapshot()
    if any(
        value(item, "channel_uuid", "channelUuid", default="") == b1
        for item in (after["adapter"].get("active") or [])
    ):
        raise HarnessError("scenario I target mapping remained active after exact stop")
    target_after = find_adapter_session(after, channel_uuid=b1)
    target_frames_after_stop = int(
        value(
            target_after,
            "adapter_accepted_native_frames",
            "acceptedNativeFrames",
            default=-1,
        )
    )
    if target_frames_after_stop != target_frames_at_stop:
        raise HarnessError("scenario I target export counter advanced after exact stop")
    target_injected_after_stop = int(
        ((esl_snapshot().get("sessions") or {}).get(b1) or {}).get(
            "module_injected_frames"
        )
        or 0
    )
    if target_injected_after_stop != target_injected_at_stop:
        raise HarnessError("scenario I target injection counter advanced after exact stop")
    peer_after = find_adapter_session(after, channel_uuid=b2)
    peer_frames_after = int(
        value(
            peer_after,
            "adapter_accepted_native_frames",
            "acceptedNativeFrames",
            default=0,
        )
    )
    if peer_frames_after < peer_frames_before + 20:
        raise HarnessError("scenario I peer did not continue after exact emergency stop")
    if cli(f"uuid_exists {b2}") != "true":
        raise HarnessError("scenario I peer channel was stopped")
    hangup(a1)
    hangup(a2)
    wait_for_channels_closed([a1, b1, a2, b2])
    wait_for_session_completed(runtime, b2)
    remove_recording(b1)
    remove_recording(b2)
    metrics1 = collect_metrics(runtime, scenario="I1", a_leg=a1, b_leg=b1)
    metrics2 = collect_metrics(runtime, scenario="I2", a_leg=a2, b_leg=b2)
    assert_clean_transport(metrics1)
    assert_clean_transport(metrics2)
    metrics1.update(
        {
            "status": "PASS",
            "emergency_stop_target": b1,
            "targeted_stream_stop": stop_result,
            "target_frames_after_stop": [
                target_frames_at_stop,
                target_frames_after_stop,
            ],
            "target_injected_after_stop": [
                target_injected_at_stop,
                target_injected_after_stop,
            ],
        }
    )
    metrics2.update(
        {
            "status": "PASS",
            "peer_frames_during_target_stop": [peer_frames_before, peer_frames_after],
            "peer_remained_active": True,
        }
    )
    return [metrics1, metrics2]


def aggregate_scenarios(scenarios: list[dict[str, object]]) -> dict[str, object]:
    latency_samples = [item["latency"] for item in scenarios]
    fields = (
        "fs_generated_frames",
        "module_exported_frames",
        "adapter_accepted_native_frames",
        "adapter_wrapped_internal_frames",
        "bridge_accepted_frames",
        "bridge_emitted_frames",
        "adapter_accepted_return_frames",
        "adapter_emitted_native_frames",
        "module_injected_frames",
        "fs_recorded_frames",
        "cleanup_dropped_frames",
        "teardown_in_flight_return_frames",
        "rejected_frames",
        "duplicates",
        "recovered_missing",
        "unresolved_missing",
        "checksum_mismatches",
    )
    return {
        "channels": len(scenarios),
        "bridge_sessions": len(scenarios),
        "websocket_connections": sum(int(item["websocket_connections"]) for item in scenarios),
        "frames": {field: sum(int(item[field]) for item in scenarios) for field in fields},
        "bytes": {
            key: sum(int(item["bytes"].get(key) or 0) for item in scenarios)
            for key in {
                key
                for item in scenarios
                for key in item["bytes"]
            }
        },
        "queue_high_water_mark": max(
            int(item["queue_high_water_mark"]) for item in scenarios
        ),
        "latency": {
            "average_ms": sum(item["average_ms"] for item in latency_samples)
            / max(1, len(latency_samples)),
            "p95_ms": max(item["p95_ms"] for item in latency_samples),
            "maximum_ms": max(item["maximum_ms"] for item in latency_samples),
        },
    }


def main() -> int:
    global SUITE_DEADLINE
    suite_started = time.monotonic()
    SUITE_DEADLINE = suite_started + MAX_SUITE_SECONDS
    initial_free = free_bytes()
    result: dict[str, object] = {
        "status": "IMPLEMENTATION INCOMPLETE",
        "image": {
            "requested_tag": IMAGE_TAG,
            "expected_id": IMAGE_ID,
            "pull_performed": False,
            "rebuild_performed": False,
        },
        "disk": {"initial_free_bytes": initial_free},
        "scenarios": [],
        "cleanup": {},
    }
    created_containers: list[str] = []
    created_network = False
    runtime: RuntimeController | None = None
    runtime_pid: int | None = None
    production_before: dict[str, dict[str, object]] = {}
    exit_code = 1

    try:
        if socket.gethostname() != "jvxthcorvm":
            raise HarnessError(f"wrong hostname: {socket.gethostname()}")
        if not NODE_BINARY.is_file():
            raise HarnessError(f"pinned host Node executable missing: {NODE_BINARY}")
        if initial_free < MIN_INITIAL_FREE:
            raise HarnessError(f"disk guard failed: {initial_free} bytes free")
        if RUNTIME_DIRECTORY.exists():
            raise HarnessError(f"refusing to reuse runtime directory: {RUNTIME_DIRECTORY}")
        for name in (FS_CONTAINER, BRIDGE_CONTAINER, ESL_CONTAINER):
            if exact_resource_exists("container", name):
                raise HarnessError(f"refusing to reuse existing container: {name}")
        if exact_resource_exists("network", NETWORK):
            raise HarnessError(f"refusing to reuse existing network: {NETWORK}")

        resolved_id = docker("image", "inspect", "--format", "{{.Id}}", IMAGE_TAG)
        if resolved_id != IMAGE_ID:
            raise HarnessError(
                f"image identity mismatch: expected={IMAGE_ID}, resolved={resolved_id}"
            )
        docker("image", "inspect", NODE_IMAGE)
        production_before = production_baseline()

        RUNTIME_DIRECTORY.mkdir(mode=0o700)
        created_network = True
        docker("network", "create", "--internal", NETWORK)
        network_info = json.loads(docker("network", "inspect", NETWORK))[0]
        gateway = network_info["IPAM"]["Config"][0]["Gateway"]
        if not gateway:
            raise HarnessError("internal Docker network has no gateway")

        created_containers.append(FS_CONTAINER)
        container_id = docker(
            "run",
            "-d",
            "--pull=never",
            "--name",
            FS_CONTAINER,
            "--network",
            NETWORK,
            "--add-host",
            "yoko-media-bridge:127.0.0.1",
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
            IMAGE_ID,
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
        wait_for_fs()
        actual = json.loads(docker("inspect", FS_CONTAINER))[0]
        if actual["Image"] != IMAGE_ID:
            raise HarnessError(f"actual container image mismatch: {actual['Image']}")
        result["image"].update(
            {
                "tag_resolved_id": resolved_id,
                "actual_container_id": container_id,
                "actual_container_image_id": actual["Image"],
                "exact_pinned_image_confirmed": True,
            }
        )
        result["dev_freeswitch"] = {
            "container_name": FS_CONTAINER,
            "container_id": container_id,
            "network": NETWORK,
            "network_internal": network_info.get("Internal"),
            "published_ports": actual["NetworkSettings"].get("Ports") or {},
            "cpu_limit": "0.50",
            "memory_limit": "256m",
            "pids_limit": 128,
            "read_only": True,
            "production_volumes": False,
            "production_secrets": False,
            "external_sip": False,
            "started": True,
        }

        created_containers.append(BRIDGE_CONTAINER)
        runtime = RuntimeController("127.0.0.1")
        ready = runtime.wait_ready()
        bridge_actual = json.loads(docker("inspect", BRIDGE_CONTAINER))[0]
        result["audio_bridge"] = {
            **ready,
            "execution_mode": "read-only DEV container from authoritative worktree",
            "container_name": BRIDGE_CONTAINER,
            "container_id": bridge_actual["Id"],
            "container_image_id": bridge_actual["Image"],
            "network_mode": f"container:{FS_CONTAINER}",
            "published_ports": bridge_actual["NetworkSettings"].get("Ports") or {},
            "production_secret_used": False,
            "production_traffic_used": False,
            "old_space_limit_mb": 128,
        }

        created_containers.append(ESL_CONTAINER)
        docker(
            "run",
            "-d",
            "--pull=never",
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
                f"type=bind,source={SCRIPT_DIR.parent.parent / 'dev-freeswitch-media' / 'capability' / 'esl-playback-metrics.js'},"
                "target=/probe/esl-playback-metrics.js,readonly"
            ),
            "--entrypoint",
            "/usr/local/bin/node",
            NODE_IMAGE,
            "/probe/esl-playback-metrics.js",
        )
        wait_for_log(ESL_CONTAINER, "YOKO_ESL_READY")

        scenarios: list[dict[str, object]] = result["scenarios"]
        scenarios.append(
            normal_scenario(
                runtime,
                name="A",
                source_hz=440,
                return_hz=997,
                recording_required=False,
                suppress_native_return=True,
            )
        )
        scenarios.append(
            normal_scenario(
                runtime,
                name="B",
                source_hz=440,
                return_hz=997,
                recording_required=True,
            )
        )
        scenarios.append(
            normal_scenario(
                runtime,
                name="C",
                source_hz=523,
                return_hz=1097,
                recording_required=True,
            )
        )
        scenarios.append(scenario_d(runtime))
        scenarios.append(scenario_e(runtime))
        scenarios.append(scenario_f(runtime))
        scenarios.append(scenario_g(runtime))
        scenarios.extend(scenario_h(runtime))
        scenarios.extend(scenario_i(runtime))

        snapshot = runtime.snapshot()
        if snapshot["adapter"].get("active"):
            raise HarnessError(f"active adapter sessions before J: {snapshot['adapter']['active']}")
        if snapshot["bridge"].get("active"):
            raise HarnessError(f"active Bridge sessions before J: {snapshot['bridge']['active']}")
        if cli("show channels").strip() != "0 total.":
            raise HarnessError("DEV FreeSWITCH has active channels before J")
        result["aggregate"] = aggregate_scenarios(scenarios)
        result["aggregate"]["max_rss_bytes"] = snapshot["rss_bytes"]
        if time.monotonic() - suite_started > MAX_SUITE_SECONDS:
            raise HarnessError("A-J suite exceeded bounded total runtime")
        result["status"] = "FREESWITCH MEDIA LOOPBACK PASS"
        exit_code = 0
    except Exception as error:
        SUITE_DEADLINE = None
        result["error"] = str(error)
        if runtime is not None:
            result["diagnostics"] = {
                "runtime_log_tail": runtime.logs[-50:],
            }
            try:
                result["diagnostics"]["runtime_snapshot"] = runtime.snapshot()
            except Exception as snapshot_error:
                result["diagnostics"]["runtime_snapshot_error"] = str(snapshot_error)
        if exact_resource_exists("container", FS_CONTAINER):
            result.setdefault("diagnostics", {})
            try:
                inspected = json.loads(docker("inspect", FS_CONTAINER))[0]
                result["diagnostics"]["freeswitch_state"] = inspected["State"]
            except Exception as inspect_error:
                result["diagnostics"]["freeswitch_state_error"] = str(inspect_error)
            result["diagnostics"]["freeswitch_log_tail"] = docker(
                "logs",
                "--tail",
                "100",
                FS_CONTAINER,
                check=False,
            ).splitlines()
            try:
                result["diagnostics"]["channels"] = show_rows()
            except Exception as channels_error:
                result["diagnostics"]["channels_error"] = str(channels_error)
    finally:
        SUITE_DEADLINE = None
        cleanup_errors: list[str] = []
        if runtime is not None:
            try:
                result["cleanup"]["runtime_stop"] = runtime.stop()
            except Exception as error:
                cleanup_errors.append(f"runtime stop: {error}")
                if runtime.process.poll() is None:
                    runtime.process.terminate()
                    try:
                        runtime.process.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        runtime.process.kill()
                        runtime.process.wait(timeout=1.0)
        for container in reversed(created_containers):
            try:
                docker("rm", "-f", container, check=False)
            except Exception as error:
                cleanup_errors.append(f"container {container}: {error}")
        if created_network:
            try:
                docker("network", "rm", NETWORK, check=False)
            except Exception as error:
                cleanup_errors.append(f"network {NETWORK}: {error}")
        if RUNTIME_DIRECTORY.exists():
            try:
                if RUNTIME_DIRECTORY == Path("/var/tmp/yoko-ai-calls-fs-media-aj"):
                    shutil.rmtree(RUNTIME_DIRECTORY)
                else:
                    cleanup_errors.append("runtime directory path safety check failed")
            except Exception as error:
                cleanup_errors.append(f"runtime directory: {error}")

        orphan_containers = [
            name
            for name in (FS_CONTAINER, BRIDGE_CONTAINER, ESL_CONTAINER)
            if exact_resource_exists("container", name)
        ]
        orphan_network = exact_resource_exists("network", NETWORK)
        runtime_alive = runtime is not None and runtime.process.poll() is None
        final_free = free_bytes()
        production_after = production_baseline() if production_before else {}
        production_unchanged = production_before == production_after
        if production_before and not production_unchanged:
            cleanup_errors.append("production identity changed")
        if final_free < MIN_FINAL_FREE:
            cleanup_errors.append(f"final disk guard failed: {final_free}")
        if orphan_containers or orphan_network or runtime_alive or RUNTIME_DIRECTORY.exists():
            cleanup_errors.append(
                "orphan resources: "
                f"containers={orphan_containers}, network={orphan_network}, "
                f"runtime_alive={runtime_alive}, directory={RUNTIME_DIRECTORY.exists()}"
            )
        result["disk"].update(
            {
                "final_free_bytes": final_free,
                "minimum_final_bytes": MIN_FINAL_FREE,
                "docker_prune": False,
                "production_data_removed": False,
            }
        )
        result["cleanup"].update(
            {
                "containers_removed": not orphan_containers,
                "network_removed": not orphan_network,
                "runtime_directory_removed": not RUNTIME_DIRECTORY.exists(),
                "runtime_process_stopped": not runtime_alive,
                "orphan_containers": orphan_containers,
                "errors": cleanup_errors,
            }
        )
        result["production"] = {
            "baseline_before": production_before,
            "baseline_after": production_after,
            "identity_unchanged": production_unchanged,
            "freeswitch_test_traffic": False,
            "audio_bridge_test_traffic": False,
            "deploy": False,
            "services_restarted": [],
            "migration": False,
            "db_writes": False,
            "external_call": False,
            "provider_traffic": False,
        }
        result["duration_seconds"] = time.monotonic() - suite_started
        if cleanup_errors and result["status"] == "FREESWITCH MEDIA LOOPBACK PASS":
            result["status"] = "QUALITY BLOCKED"
            exit_code = 1

        print(f"YOKO_FS_MEDIA_AJ_RESULT {json.dumps(result, sort_keys=True)}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
