#!/usr/bin/env python3
from pathlib import Path
import re

component = Path(__file__).resolve().parents[1] / "MessageInputArea.tsx"


def read_component() -> str:
    return component.read_text()


def assert_match(pattern: str, text: str) -> None:
    assert re.search(pattern, text, re.S), f"missing pattern: {pattern}"


def assert_contains(needle: str, text: str) -> None:
    assert needle in text, f"missing text: {needle}"


def test_media_preview_enter_send_uses_latest_caption_text() -> None:
    src = read_component()

    assert_contains('const [mediaCaption, setMediaCaption] = useState("")', src)
    assert_match(r"const captionText = mediaCaption\.trim\(\)", src)
    assert_match(r"value=\{mediaCaption\}", src)
    assert_match(r"onChange=\{\(e\) => setMediaCaption\(e\.target\.value\)\}", src)
    assert_match(r"document\.addEventListener\('keydown', handleModalKeyDown\)[\s\S]*?return \(\) => document\.removeEventListener\('keydown', handleModalKeyDown\)[\s\S]*?\}, \[imagePreview, mediaCaption\]\)", src)
    assert_match(r"onSendMedia\(file, dataUrl, captionText, effectiveNormalized\)", src)


if __name__ == "__main__":
    test_media_preview_enter_send_uses_latest_caption_text()
    print("PASS test_media_preview_enter_send_uses_latest_caption_text")
    print("1/1 PASS")
