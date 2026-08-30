"""Unit tests for pure brain/pipeline logic — no API keys or network needed."""

from main import _plain_voice, detect_assist_intent
from voice_server import DebateSession, _should_accept_turn


# ── detect_assist_intent ──────────────────────────────────────

def test_assist_stuck():
    assert detect_assist_intent("I'm stuck") is True

def test_assist_hint():
    assert detect_assist_intent("give me a hint please") is True

def test_assist_help():
    assert detect_assist_intent("help me with this") is True

def test_assist_normal_argument():
    assert detect_assist_intent("AI destroys jobs because automation scales.") is False

def test_assist_empty():
    assert detect_assist_intent("") is False

def test_assist_none():
    assert detect_assist_intent(None) is False


# ── _plain_voice sanitizer ────────────────────────────────────

def test_plain_voice_strips_emoji():
    assert "🎤" not in _plain_voice("hello 🎤 world")

def test_plain_voice_strips_markdown():
    assert _plain_voice("**bold** and _under_") == "bold and under"

def test_plain_voice_strips_bullets():
    assert _plain_voice("- first point") == "first point"

def test_plain_voice_collapses_whitespace():
    assert _plain_voice("a\n\n  b") == "a b"


# ── _extract_result (shape-agnostic Deepgram parsing) ─────────

def test_extract_flux_turninfo_shape():
    data = {"transcript": "hello world", "end_of_turn_confidence": 0.9}
    text, conf = DebateSession._extract_result(data)
    assert text == "hello world"
    assert conf == 0.9

def test_extract_v1_channel_shape():
    data = {"channel": {"alternatives": [{"transcript": "hi there", "confidence": 0.8}]}}
    text, conf = DebateSession._extract_result(data)
    assert text == "hi there"
    assert conf == 0.8

def test_extract_v2_channels_shape():
    data = {"channels": [{"alternatives": [{"transcript": "yo", "confidence": 0.7}]}]}
    text, conf = DebateSession._extract_result(data)
    assert text == "yo"
    assert conf == 0.7

def test_extract_empty_payload():
    assert DebateSession._extract_result({}) == ("", None)


# ── noise guard ────────────────────────────────────────────────

def test_guard_rejects_empty():
    assert _should_accept_turn("", None)[0] is False

def test_guard_rejects_single_word():
    assert _should_accept_turn("hello", 0.99)[0] is False

def test_guard_rejects_low_confidence():
    assert _should_accept_turn("hello world", 0.3)[0] is False

def test_guard_accepts_valid():
    assert _should_accept_turn("hello world", 0.9)[0] is True

def test_guard_accepts_unknown_confidence():
    assert _should_accept_turn("hello world", None)[0] is True
