"""
voice_server.py — FastAPI WebSocket Orchestration (V11 — production hardening)

Pipeline overview (one /ws/debate connection == one DebateSession):

  1. SETUP HANDSHAKE   client sends first JSON frame
                       {type, topic, user_side ("Pro"/"Con"),
                        first_speaker ("AI"/"User")}
                       -> stored in session state.

  2. AI OPENING TURN   if first_speaker == "AI" the LangGraph opening graph
                       runs immediately (opposite stance of the user) and the
                       reply is streamed back as binary PCM wrapped by
                       audio_start / audio_end metadata frames.

  3. STT (Flux v2)     mic PCM -> wss://api.deepgram.com/v2/listen
                       Flux wraps ALL transcription in "TurnInfo" frames,
                       dispatched by their inner "event" field:
                       - event=Update      -> live captions to frontend
                       - event=StartOfTurn -> reset per-turn accumulators
                       - event=EndOfTurn   -> carries the complete turn
                         transcript; ONLY here the LangGraph LLM is
                         triggered (no premature cutoffs). Turns failing
                         the noise guard (< 0.65 confidence or < 2 words)
                         are discarded.

  4. ASYNC MODEL       Deepgram frames arrive through the asyncio-native
                       `websockets` client, so every event is ALREADY handled
                       on the FastAPI event loop — no thread hop required.

  5. LLM + TTS         final turn text -> LangGraph brain (Gemini via
                       langchain-google-genai when GOOGLE_API_KEY is set,
                       else OpenAI-compatible) -> structured reply ->
                       Aura TTS -> binary linear16 audio frames back to the
                       client between typed audio_start / audio_end JSON
                       frames. LLM calls are bounded by LLM_TIMEOUT_S.

  6. CLEANUP           WebSocketDisconnect / RuntimeError are caught, all
                       background tasks cancelled, CloseStream sent to
                       Deepgram STT.

  7. POST /transcripts persists the debate per authenticated user in the
       database (SQLite locally, Postgres in production). Input is fully
       validated by Pydantic (schemas.SaveTranscriptRequest).
       POST /save_transcript remains as a deprecated, auth-required alias.

Hardening notes: all diagnostics go through the logging module; client-facing
error messages are generic (details stay server-side); CORS origins come from
CORS_ORIGINS; /healthz serves the Render health check.
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path

import websockets
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import HumanMessage
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from auth import JWT_SECRET, decode_token, get_current_user
from logging_config import setup_logging
from rate_limit import limiter
from routes_auth import router as auth_router
from routes_transcripts import persist_transcript
from routes_transcripts import router as transcripts_router
from schemas import SaveTranscriptRequest
from storage import store

# LangGraph components from main.py
from main import DebateState, app_brain, app_opening, app_help

load_dotenv()
setup_logging(os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

# ─────────────────────────── Setup ────────────────────────────

app = FastAPI(title="AI Debate Coach API")

# Env-driven origins; never combine "*" with credentials (spec violation).
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# Rate limiting (per-IP; decorators on the routers set the actual limits)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request, exc):
    return JSONResponse({"detail": "Rate limit exceeded"}, status_code=429)


app.add_middleware(SlowAPIMiddleware)

app.include_router(auth_router, prefix="/auth", tags=["auth"])
app.include_router(transcripts_router, prefix="/transcripts",
                   tags=["transcripts"])

DEEPGRAM_API_KEY = (os.getenv("DEEPGRAM_API_KEY") or "").strip()
if not DEEPGRAM_API_KEY:
    raise RuntimeError("DEEPGRAM_API_KEY not found in .env — please add it before starting.")

# LLM provider check (mirrors main.py selection: GOOGLE_API_KEY -> Gemini,
# else OpenAI-compatible). Fail fast instead of erroring on the first turn.
if os.getenv("GOOGLE_API_KEY"):
    logger.info("Startup: LLM provider Gemini (GOOGLE_API_KEY set)")
elif (os.getenv("OPENAI_API_KEY") or "").strip():
    _base = (os.getenv("OPENAI_BASE_URL") or os.getenv("OPENAI_API_BASE") or "").strip()
    logger.info("Startup: LLM provider OpenAI-compatible (endpoint=%s, model=%s)",
                _base or "api.openai.com", os.getenv("OPENAI_MODEL", "gpt-4o"))
else:
    raise RuntimeError(
        "Neither OPENAI_API_KEY nor GOOGLE_API_KEY is set in .env — "
        "the debate brain cannot generate replies. Add one of them."
    )

# ── Deepgram STT: Flux via the v2 Listen API with EndOfTurn events ──
DG_STT_URL = "wss://api.deepgram.com/v2/listen"
DG_STT_PARAMS = (
    "model=flux-general-en"
    "&encoding=linear16"
    "&sample_rate=16000"
    "&eot_threshold=0.85"
    "&eot_timeout_ms=5000"
)
# NOTE: if your Deepgram plan exposes Listen v2 only through the official
# SDK, swap DG_STT_URL/DG_STT_PARAMS for "wss://api.deepgram.com/v1/listen"
# + nova-2 params — the event handling below already tolerates both shapes.

# ── Deepgram TTS: Aura-2 streaming speech ──
DG_TTS_URL = "wss://api.deepgram.com/v1/speak"
DG_TTS_PARAMS = (
    "model=aura-2-asteria-en"
    "&encoding=linear16"
    "&sample_rate=24000"
    "&container=none"
)
TTS_SAMPLE_RATE = 24_000

# Noise guard (spec §3): discard turns with low confidence or fewer than
# 2 words — filters ambient clicks, breaths, and STT filler artifacts.
MIN_TURN_WORDS = 2
MIN_CONFIDENCE = 0.65

# Bounds on external calls so a hung provider can't wedge a session.
LLM_TIMEOUT_S = float(os.getenv("LLM_TIMEOUT_S", "30"))
TTS_OPEN_TIMEOUT_S = 10
TTS_PING_TIMEOUT_S = 15

# Cooldown between STT connect attempts (avoids a retry storm on failure)
STT_RECONNECT_COOLDOWN_S = 5.0


def _should_accept_turn(text: str, confidence: float | None) -> tuple[bool, str]:
    """Pure noise guard: returns (accept, reason). Extracted for testability."""
    if not text:
        return False, "empty"
    if len(text.split()) < MIN_TURN_WORDS:
        return False, "too-short"
    if confidence is not None and confidence < MIN_CONFIDENCE:
        return False, "low-confidence"
    return True, "ok"


# ─────────────────────────── REST endpoints ────────────────────

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.post("/save_transcript", deprecated=True)
async def save_transcript(payload: SaveTranscriptRequest,
                          user: dict = Depends(get_current_user)):
    """Deprecated alias of POST /transcripts kept for old clients."""
    try:
        row = await persist_transcript(user, payload)
        return JSONResponse({"status": "saved", "id": row["id"]})
    except Exception:
        logger.error("Save transcript failed", exc_info=True)
        return JSONResponse({"status": "error", "message": "Internal server error"},
                            status_code=500)


@app.on_event("startup")
async def _startup():
    logger.info("Storage backend: %s", store.label)
    if JWT_SECRET == "dev-only-insecure-secret-change-in-prod":
        logger.warning("JWT_SECRET is the dev default — set it in .env/Render "
                       "before exposing this service.")


# ─────────────────────────── Session ──────────────────────────

class DebateSession:
    """All mutable state + pipeline tasks for ONE /ws/debate connection."""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.session_id = str(uuid.uuid4())
        self.user_id: str | None = None   # set by the authenticated handshake

        # ── Connection session state (filled by the setup handshake) ──
        self.topic = "General Debate"
        self.user_side = "Pro"
        self.first_speaker = "User"
        self.started_at: str | None = None

        # ── LangGraph state (rebuilt into each ainvoke call) ──
        self.state: DebateState = {
            "messages":       [],
            "topic":          self.topic,
            "user_side":      self.user_side,
            "debate_summary": [],
        }

        # ── Queues wiring the pipeline together ──
        self.turn_queue   = asyncio.Queue()   # validated user turns (EndOfTurn only)
        self.help_queue   = asyncio.Queue()   # explicit Help-button requests
        self.audio_queue  = asyncio.Queue()   # mic PCM chunks -> Deepgram STT

        # ── Deepgram STT connection (lazy: opened on first mic chunk) ──
        self.stt_ws = None
        self.stt_tasks: list[asyncio.Task] = []
        self.stt_connected = asyncio.Event()
        self.last_audio_ts = 0.0
        self._stt_failed_ts = 0.0        # reconnect cooldown anchor
        self._cooldown_logged = False    # log the cooldown drop once/window
        self._first_audio_logged = False

        # Finalized partials of the CURRENT spoken turn, flushed on EndOfTurn
        self._turn_buffer: list[str] = []
        self._turn_conf: list[float] = []       # per-segment STT confidence
        self._last_final_segment: str = ""      # dedupe Results vs Turn repeat

        # Serializes AI turns so opening / rebuttal / hint never interleave
        self._respond_lock = asyncio.Lock()
        self._opening_task: asyncio.Task | None = None
        self._closed = False

    # ── Outbound helpers ──────────────────────────────────────────

    async def _send_json(self, payload: dict):
        """Send JSON to the client; a dead socket marks the session closed."""
        if self._closed:
            return
        try:
            await self.ws.send_json(payload)
        except Exception as exc:
            logger.warning("WS JSON send failed (%r) — closing session.", exc)
            self._closed = True

    async def _send_bytes(self, chunk: bytes):
        if self._closed:
            return
        try:
            await self.ws.send_bytes(chunk)
        except Exception as exc:
            logger.warning("WS binary send failed (%r) — closing session.", exc)
            self._closed = True

    # ── Main loop ─────────────────────────────────────────────────

    async def run(self):
        """Receive loop + lifecycle management for the connection."""
        worker_tasks = [
            asyncio.create_task(self._turn_worker(), name="turn-worker"),
            asyncio.create_task(self._help_worker(), name="help-worker"),
        ]
        await self._send_json({"type": "ready", "session_id": self.session_id})

        try:
            while True:
                # Raw receive() so we can also inspect disconnect messages
                message = await self.ws.receive()

                if message.get("type") == "websocket.disconnect":
                    break

                raw_text = message.get("text")
                raw_bytes = message.get("bytes")

                if raw_text is not None:
                    await self._handle_text_frame(raw_text)
                elif raw_bytes is not None:
                    await self._handle_audio_frame(raw_bytes)

        except WebSocketDisconnect:
            logger.info("WS client disconnected")
        except RuntimeError as exc:
            # Starlette raises this when receive() is called after the
            # disconnect message was already consumed — treat as disconnect.
            logger.info("WS receive after disconnect: %s", exc)
        except Exception:
            logger.error("WS unexpected error", exc_info=True)
        finally:
            await self.cleanup(worker_tasks)

    # ── Inbound frames ────────────────────────────────────────────

    async def _handle_text_frame(self, raw: str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("WS ignoring non-JSON text frame: %r", raw[:80])
            return

        msg_type = data.get("type")

        if msg_type in ("setup", "start_debate"):
            await self._handle_setup(data)
        elif msg_type == "help_request":
            logger.info("WS help requested via button")
            await self.help_queue.put(True)
        else:
            logger.warning("WS ignoring unknown control frame: %r", msg_type)

    async def _handle_setup(self, data: dict):
        """
        SETUP HANDSHAKE — the first JSON metadata frame locks in the
        session: topic, user_side ("Pro"/"Con"), first_speaker ("AI"/"User").
        If the AI speaks first, the opening turn is triggered immediately.
        """
        # AUTH: the setup frame must carry a valid JWT (sent in-frame, not in
        # the URL, so tokens never appear in access logs).
        token = (data.get("token") or "").strip()
        if not token:
            logger.warning("WS setup rejected: missing auth token")
            self._closed = True
            await self.ws.close(code=4001, reason="Missing auth token")
            return
        try:
            claims = decode_token(token)
        except HTTPException:
            logger.warning("WS setup rejected: invalid auth token")
            self._closed = True
            await self.ws.close(code=4001, reason="Invalid auth token")
            return
        self.user_id = claims["sub"]

        # topic
        topic = (data.get("topic") or "").strip()
        if topic:
            self.topic = topic

        # user_side — accept legacy "user_role" key as fallback
        side = (data.get("user_side") or data.get("user_role") or "Pro").strip().lower()
        self.user_side = "Pro" if side.startswith("p") else "Con"

        # first_speaker — case-insensitive "AI" / "User"
        speaker = (data.get("first_speaker") or "User").strip().lower()
        self.first_speaker = "AI" if speaker == "ai" else "User"

        self.started_at = datetime.now().isoformat()

        # Mirror handshake values into LangGraph state
        self.state["topic"] = self.topic
        self.state["user_side"] = self.user_side

        logger.info("WS handshake: topic=%r user_side=%s first_speaker=%s",
                    self.topic, self.user_side, self.first_speaker)

        await self._send_json({
            "type": "setup_ack",
            "session_id": self.session_id,
            "topic": self.topic,
            "user_side": self.user_side,
            "first_speaker": self.first_speaker,
        })

        # AI OPENING TURN: tracked task so cleanup can cancel it; the respond
        # lock guarantees ordering with later turns.
        if self.first_speaker == "AI":
            logger.info("WS AI speaks first — generating opening argument...")
            self._opening_task = asyncio.create_task(
                self._agent_turn(is_opening=True), name="opening-turn")

    async def _handle_audio_frame(self, chunk: bytes):
        """Mic PCM (16-bit, 16 kHz, mono) from the browser."""
        if not chunk:
            return

        # Diagnostic: proves client audio bytes are reaching the server
        if not self._first_audio_logged:
            self._first_audio_logged = True
            logger.info("WS first audio chunk received from client (%d bytes)", len(chunk))

        if not self.stt_connected.is_set():
            # Cooldown after a failed connect — otherwise every chunk would
            # retrigger a doomed connection attempt (auth error, etc.)
            now = asyncio.get_event_loop().time()
            if self._stt_failed_ts and now - self._stt_failed_ts < STT_RECONNECT_COOLDOWN_S:
                if not self._cooldown_logged:
                    self._cooldown_logged = True
                    logger.info("STT reconnect cooldown active — dropping mic audio until retry.")
                return
            self._cooldown_logged = False
            # Lazy connect on the FIRST chunk — avoids Deepgram NET-0001
            # ("no audio received") while the user hasn't started the mic.
            await self._connect_stt(chunk)
        else:
            await self.audio_queue.put(chunk)

    # ── LangGraph execution ───────────────────────────────────────

    async def _turn_worker(self):
        """Consumes validated EndOfTurn transcripts and runs the brain."""
        while True:
            user_text = await self.turn_queue.get()
            try:
                await self._agent_turn(user_text=user_text)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("Turn worker error", exc_info=True)
            finally:
                self.turn_queue.task_done()

    async def _help_worker(self):
        """Consumes explicit Help-button requests."""
        while True:
            await self.help_queue.get()
            try:
                await self._agent_turn(is_help=True)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("Help worker error", exc_info=True)
            finally:
                self.help_queue.task_done()

    async def _agent_turn(self, user_text: str | None = None, *,
                          is_opening: bool = False, is_help: bool = False):
        """
        Core pipeline step:
          user transcript -> LangGraph (structured reply) -> JSON payload
          to client -> Aura TTS -> binary audio frames -> client.
        Serialized by _respond_lock so AI turns never interleave.
        """
        async with self._respond_lock:
            if self._closed:
                return
            try:
                # 1. Append the user's turn to conversation history
                if user_text:
                    self.state["messages"].append(HumanMessage(content=user_text))

                # 2. Pick the graph: opening / explicit help / routed brain
                #    (app_brain internally routes opponent vs assist intent)
                graph = (app_opening if is_opening
                         else app_help if is_help
                         else app_brain)

                await self._send_json({"type": "ai_thinking_start"})

                # 3. Run LangGraph (bounded so a hung provider can't wedge us)
                try:
                    final_state = await asyncio.wait_for(
                        graph.ainvoke({
                            "messages":       self.state["messages"],
                            "topic":          self.state["topic"],
                            "user_side":      self.state["user_side"],
                            "debate_summary": self.state["debate_summary"],
                        }),
                        timeout=LLM_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    logger.error("LLM call timed out after %.0fs", LLM_TIMEOUT_S)
                    await self._send_json({
                        "type": "error",
                        "text": "The AI took too long to respond. Please try again.",
                    })
                    return

                # 4. Persist resulting state back into the session
                self.state["messages"]       = final_state["messages"]
                self.state["debate_summary"] = final_state.get(
                    "debate_summary", self.state["debate_summary"]
                )
                reply = final_state.get("agent_reply") or {}
                rebuttal = reply.get("rebuttal", "")

                # 5. STRUCTURED PAYLOAD -> frontend
                await self._send_json({
                    "type": "agent_response",
                    "rebuttal": rebuttal,
                    "coaching_tip": reply.get("coaching_tip"),
                    "sticky_note": reply.get("sticky_note"),
                    "notes": self.state["debate_summary"],
                    "is_help": is_help,
                    "is_opening": is_opening,
                    # legacy aliases kept for backward compatibility
                    "text": rebuttal,
                    "tip": reply.get("coaching_tip"),
                })

                # 6. Stream the spoken reply as binary PCM audio
                await self._stream_tts(rebuttal)

            except Exception:
                logger.error("Agent turn failed", exc_info=True)
                await self._send_json({"type": "error",
                                       "text": "An internal error occurred. Please try again."})
            finally:
                await self._send_json({"type": "ai_thinking_end"})

    # ── Deepgram TTS (Aura) ───────────────────────────────────────

    async def _stream_tts(self, text: str):
        """
        Synthesize text with Aura and forward binary PCM chunks to the
        client, framed by explicit audio_start / audio_end metadata so the
        React frontend knows exactly when audio streaming starts/stops.
        """
        text = (text or "").strip()
        if not text:
            return

        tts_url = f"{DG_TTS_URL}?{DG_TTS_PARAMS}"
        headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

        try:
            # Typed metadata wrapper: binary PCM (linear16, 24 kHz) incoming
            await self._send_json({
                "type": "audio_start",
                "encoding": "linear16",
                "sample_rate": TTS_SAMPLE_RATE,
            })

            async with websockets.connect(
                tts_url, extra_headers=headers,
                open_timeout=TTS_OPEN_TIMEOUT_S,
                ping_timeout=TTS_PING_TIMEOUT_S,
            ) as tts_ws:
                # Control protocol per Deepgram docs: Speak (text) then Flush.
                # "Flushed" only arrives in response to Flush; without it the
                # buffer is never synthesized and this loop would hang.
                await tts_ws.send(json.dumps({"type": "Speak", "text": text}))
                await tts_ws.send(json.dumps({"type": "Flush"}))

                async for message in tts_ws:
                    if self._closed:
                        break
                    if isinstance(message, (bytes, bytearray)):
                        await self._send_bytes(bytes(message))
                    else:
                        evt = json.loads(message)
                        evt_type = evt.get("type")
                        if evt_type == "Flushed":
                            break   # synthesis complete
                        if evt_type == "Warning":
                            logger.warning("Deepgram TTS warning: %s", evt)

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.error("Deepgram TTS error", exc_info=True)
        finally:
            # Always close the audio window, even on failure
            await self._send_json({"type": "audio_end"})

    # ── Deepgram STT (Flux v2 Listen) ─────────────────────────────

    async def _connect_stt(self, first_chunk: bytes):
        """Open the STT socket lazily on the first microphone chunk."""
        url = f"{DG_STT_URL}?{DG_STT_PARAMS}"
        headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

        logger.info("Deepgram STT connecting on first mic audio...")
        try:
            self.stt_ws = await websockets.connect(url, extra_headers=headers)
        except websockets.exceptions.InvalidStatusCode as e:
            self._stt_failed_ts = asyncio.get_event_loop().time()
            logger.error("Deepgram STT rejected — HTTP %s", e.status_code)
            await self._send_json(
                {"type": "error", "text": "Speech recognition unavailable. Check your connection."})
            return
        except Exception as e:
            self._stt_failed_ts = asyncio.get_event_loop().time()
            logger.error("Deepgram STT connection failed: %s", e)
            await self._send_json(
                {"type": "error", "text": "Speech recognition unavailable. Check your connection."})
            return

        self.stt_connected.set()
        logger.info("Deepgram STT connected.")

        await self.stt_ws.send(first_chunk)
        self.last_audio_ts = asyncio.get_event_loop().time()

        # Cancel stale workers from a previous (dead) connection, if any
        for task in self.stt_tasks:
            task.cancel()

        self.stt_tasks = [
            asyncio.create_task(self._stt_sender(self.stt_ws),   name="stt-sender"),
            asyncio.create_task(self._stt_receiver(self.stt_ws), name="stt-receiver"),
        ]

    async def _stt_sender(self, stt_ws):
        """Forward raw PCM audio from the browser to Deepgram."""
        try:
            while True:
                chunk = await self.audio_queue.get()
                try:
                    if stt_ws.open:
                        await stt_ws.send(chunk)
                        self.last_audio_ts = asyncio.get_event_loop().time()
                finally:
                    self.audio_queue.task_done()
        except asyncio.CancelledError:
            pass
        except websockets.exceptions.ConnectionClosed:
            logger.info("Deepgram STT sender: connection closed.")
        except Exception as e:
            logger.error("Deepgram STT sender error: %s", e)

    async def _stt_receiver(self, stt_ws):
        """
        Event-driven turn handling for Flux /v2/listen. Flux sends ONLY:
          Connected, TurnInfo, ConfigureSuccess/Failure, FatalError.
        All transcription rides inside TurnInfo frames, dispatched by their
        inner "event" field:
          Update        -> live interim captions to the frontend
          StartOfTurn   -> reset per-turn accumulators
          EndOfTurn     -> carries the full turn transcript; the ONLY
                           trigger for LangGraph execution.
        (Legacy v1 "Update"/"Results" branches below remain as fallbacks.)
        """
        try:
            async for raw in stt_ws:
                if not isinstance(raw, str):
                    continue

                data = json.loads(raw)
                msg_type = data.get("type")

                if msg_type == "TurnInfo":
                    await self._handle_turn_info(data)

                elif msg_type == "FatalError":
                    logger.error("Deepgram STT FatalError: %s", data)
                    self._reset_stt_for_reconnect()
                    break

                elif msg_type == "Error":
                    logger.error("Deepgram STT error event: %s", data)

                elif msg_type == "Connected":
                    logger.info("Deepgram STT upstream Connected event received.")

                elif msg_type == "Update":
                    # Real-time live captioning — never triggers the LLM
                    interim, _ = self._extract_result(data)
                    if interim:
                        await self._send_json({
                            "type": "partial_transcript",
                            "speaker": "user",
                            "text": interim,
                        })

                elif msg_type == "Results":
                    transcript, confidence = self._extract_result(data)
                    if not transcript:
                        continue
                    if data.get("is_final"):
                        # Finalized segment: buffer until explicit EndOfTurn
                        self._buffer_final_segment(transcript, confidence)
                        await self._send_json({
                            "type": "transcript",
                            "speaker": "user",
                            "text": transcript,
                        })
                    else:
                        # Interim results on deployments that use Results
                        await self._send_json({
                            "type": "partial_transcript",
                            "speaker": "user",
                            "text": transcript,
                        })

                elif msg_type in ("Turn", "EndOfTurn"):
                    # EndOfTurn frame — finalize the accumulated turn.
                    # Some v2 builds embed the final text in the Turn frame.
                    transcript, confidence = self._extract_result(data)
                    if transcript:
                        self._buffer_final_segment(transcript, confidence)
                        await self._send_json({
                            "type": "transcript",
                            "speaker": "user",
                            "text": transcript,
                        })

                    end_of_turn = (
                        msg_type == "EndOfTurn"
                        or data.get("is_final") is True
                        or data.get("end_of_turn") is True
                    )
                    if end_of_turn:
                        await self._finalize_turn()

                elif msg_type == "Metadata":
                    logger.info("Deepgram STT metadata — duration: %s", data.get("duration"))

                else:
                    # Unknown event type — log once-ish for diagnostics so a
                    # silent pipeline is never silent for long.
                    logger.warning("Deepgram STT unhandled event type: %r", msg_type)

        except asyncio.CancelledError:
            pass
        except websockets.exceptions.ConnectionClosed as e:
            logger.info("Deepgram STT receiver: connection closed (%s).", e.code)
            self._reset_stt_for_reconnect()
        except Exception as e:
            logger.error("Deepgram STT receiver error: %s", e)
            self._reset_stt_for_reconnect()

    async def _handle_turn_info(self, data: dict):
        """Flux /v2/listen wraps ALL transcription in TurnInfo frames; the
        inner "event" field selects the stage of the turn state machine."""
        event = data.get("event")
        transcript, confidence = self._extract_result(data)

        if event == "Update":
            # Cumulative interim caption for the current turn
            if transcript:
                await self._send_json({
                    "type": "partial_transcript",
                    "speaker": "user",
                    "text": transcript,
                })

        elif event == "StartOfTurn":
            self._turn_buffer.clear()
            self._turn_conf.clear()
            self._last_final_segment = ""

        elif event == "EndOfTurn":
            if transcript:
                # EndOfTurn carries the COMPLETE turn transcript — replace
                # any buffered segments rather than appending to them.
                self._turn_buffer = [transcript]
                self._turn_conf = (
                    [float(confidence)]
                    if isinstance(confidence, (int, float)) else []
                )
                await self._send_json({
                    "type": "transcript",
                    "speaker": "user",
                    "text": transcript,
                })
            await self._finalize_turn()

        elif event in ("EagerEndOfTurn", "TurnResumed"):
            # Only emitted when eager_eot_threshold is set — we don't use it.
            logger.info("Deepgram STT TurnInfo event ignored: %s", event)

        else:
            logger.warning("Deepgram STT unknown TurnInfo event: %r", event)

    def _reset_stt_for_reconnect(self):
        """The upstream STT socket died — cancel the stale worker tasks and
        clear the connected flag so the next mic chunk opens a fresh
        connection instead of dropping audio into a dead queue forever."""
        for task in self.stt_tasks:
            task.cancel()
        self.stt_tasks = []
        self.stt_connected.clear()
        self.stt_ws = None
        logger.info("Deepgram STT connection reset — will reconnect on next audio.")

    def _buffer_final_segment(self, text: str, confidence: float | None):
        """Accumulate a finalized segment (with confidence) for the current
        turn. Dedupes v2 behavior where the same final text can arrive in
        BOTH a Results(is_final) frame and the closing Turn frame."""
        if text == self._last_final_segment:
            return
        self._last_final_segment = text
        self._turn_buffer.append(text)
        if isinstance(confidence, (int, float)):
            self._turn_conf.append(float(confidence))

    # ── Turn finalization & noise filtering ───────────────────────

    async def _finalize_turn(self):
        """
        Called ONLY on explicit EndOfTurn. Flushes the turn buffer and runs
        the noise guard: turns with average confidence < 0.65 or fewer than
        2 words (ambient clicks / fillers) never reach the LLM.
        """
        text = " ".join(self._turn_buffer).strip()
        confidence = (
            sum(self._turn_conf) / len(self._turn_conf) if self._turn_conf else None
        )

        # Reset per-turn accumulators regardless of outcome
        self._turn_buffer.clear()
        self._turn_conf.clear()
        self._last_final_segment = ""

        accept, reason = _should_accept_turn(text, confidence)
        if not accept:
            logger.info("STT discarded %s turn: %r (confidence=%s)",
                        reason, text, confidence)
            return

        logger.info("STT EndOfTurn confidence=%s text=%r",
                    "n/a" if confidence is None else f"{confidence:.2f}", text)
        await self.turn_queue.put(text)

    @staticmethod
    def _extract_result(data: dict) -> tuple[str, float | None]:
        """
        Pull (transcript, confidence) from ANY Deepgram event shape.

        Flux TurnInfo: top-level "transcript"; confidence lives in
                    "end_of_turn_confidence" (or per-word "confidence").
        v1 Listen : channel.alternatives[0].transcript
        Being shape-agnostic is what keeps the pipeline from going silent
        when the payload nesting differs between API versions.
        """

        def _conf_from_words(words) -> float | None:
            confs = [
                w.get("confidence") for w in (words or [])
                if isinstance(w, dict)
                and isinstance(w.get("confidence"), (int, float))
            ]
            return sum(confs) / len(confs) if confs else None

        # Top-level transcript (Flux TurnInfo frames)
        top = data.get("transcript")
        if isinstance(top, str) and top.strip():
            conf = data.get("end_of_turn_confidence")
            if not isinstance(conf, (int, float)):
                conf = data.get("confidence")
            if not isinstance(conf, (int, float)):
                conf = _conf_from_words(data.get("words"))
            return top.strip(), conf if isinstance(conf, (int, float)) else None

        # channel (v1, singular) or channels[0] (v2, plural)
        channel = data.get("channel")
        if channel is None:
            channels = data.get("channels")
            if isinstance(channels, list) and channels:
                channel = channels[0]

        try:
            alt = channel["alternatives"][0]
            conf = alt.get("confidence")
            return (alt.get("transcript") or "").strip(), \
                conf if isinstance(conf, (int, float)) else None
        except (KeyError, IndexError, TypeError, AttributeError):
            return "", None

    # ── Cleanup ──────────────────────────────────────────────────

    async def _close_stt(self):
        """Gracefully terminate the Deepgram STT socket with CloseStream."""
        ws = self.stt_ws
        if ws is None:
            return
        try:
            if ws.open:
                await ws.send(json.dumps({"type": "CloseStream"}))
                logger.info("Deepgram STT sent CloseStream.")
                await asyncio.sleep(0.3)   # let Deepgram flush final results
        except Exception as exc:
            logger.warning("Deepgram STT CloseStream failed: %s", exc)
        try:
            await ws.close()
        except Exception as exc:
            logger.warning("Deepgram STT socket close failed: %s", exc)
        self.stt_ws = None

    async def cleanup(self, worker_tasks: list[asyncio.Task]):
        """Cancel every background task, then close upstream sockets."""
        self._closed = True

        all_tasks = list(worker_tasks) + list(self.stt_tasks)
        if self._opening_task is not None:
            all_tasks.append(self._opening_task)

        for task in all_tasks:
            task.cancel()
        # Await cancellation so no task outlives the connection
        await asyncio.gather(*all_tasks, return_exceptions=True)

        await self._close_stt()
        logger.info("WS session %s cleaned up.", self.session_id[:8])


# ─────────────────────────── WebSocket route ──────────────────

@app.websocket("/ws/debate")
async def debate_websocket(websocket: WebSocket):
    await websocket.accept()
    logger.info("WS client connected")
    session = DebateSession(websocket)
    await session.run()


# ─────────────────────── Static frontend ──────────────────────
# In production a single service serves API + UI: the Vite build lives in
# frontend/dist and is mounted LAST so /ws/debate and REST routes win.

_DIST_DIR = Path(__file__).parent / "frontend" / "dist"
if _DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=_DIST_DIR, html=True), name="frontend")
else:
    logger.warning("Static frontend not found at frontend/dist — run `npm run build`.")


# ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",                       # required for Render routing
        port=int(os.getenv("PORT", "8000")),  # Render injects $PORT
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
        timeout_keep_alive=30,
        ws_max_size=2**20,                    # 1 MB inbound WS frame cap
    )
