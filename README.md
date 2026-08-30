# DebateMate — AI Debate Coach

A real-time voice-based debate sparring partner. Speak naturally against an AI opponent that challenges your arguments, coaches you when you're stuck, and speaks its replies back to you — powered by Gemini, LangGraph, and Deepgram's streaming speech APIs.

## 🎯 Features

- **Voice-to-Voice Debate** — full-duplex voice loop: mic → transcription → AI rebuttal → spoken reply
- **User Accounts** — register/login (bcrypt + JWT); every debate is saved to your account
- **Past Debates** — browse and re-read any previous debate from the history view
- **AI or User Opens** — choose who makes the opening statement
- **Pro / Con Stances** — the AI always argues the opposite side of yours
- **Smart Coaching** — say "I'm stuck" (or hit the 💡 Help Me button) and the AI switches from opponent to coach, hinting angles for *your* side
- **Argument Summarization** — key points are captured as ≤8-word sticky notes
- **Live Transcription** — interim captions plus finalized turns for both speakers
- **Gapless TTS Playback** — streamed Aura-2 audio scheduled back-to-back on the Web Audio clock
- **Resilient Connection** — automatic WebSocket reconnect with exponential backoff
- **Transcript Export** — download the debate as `.txt`; the full transcript is stored server-side
- **3D Visualizer** — animated sphere reacts to user speech and AI speaking state

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18, Vite, TailwindCSS, React Three Fiber |
| **Backend** | FastAPI + uvicorn, Python asyncio |
| **Orchestration** | LangGraph (intent-routed graph: opponent / help coach / opening) |
| **LLM** | Google Gemini (`gemini-3.6-flash` default) with structured output; OpenAI-compatible fallback via `OPENAI_BASE_URL` |
| **Speech-to-Text** | Deepgram Flux (`/v2/listen`, EndOfTurn events) |
| **Text-to-Speech** | Deepgram Aura-2 (`aura-2-asteria-en`, streaming linear16 24 kHz) |
| **Auth** | bcrypt password hashing + JWT (PyJWT), rate limiting via slowapi |
| **Storage** | JSON object store — AWS S3 in production (`S3_BUCKET`), local `./storage/` folder in dev |

## 📋 Prerequisites

- Python 3.10+
- Node.js 18+
- **Google AI API key** (free tier: https://aistudio.google.com/apikey)
- **Deepgram API key** (https://console.deepgram.com)

## 🚀 Installation

### 1. Clone the repository

```bash
git clone <repo-url>
cd DebateMate
```

### 2. Backend setup

```bash
python -m venv venv
venv\Scripts\activate        # Windows  (source venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
```

Create a `.env` file in the project root:

```env
GOOGLE_API_KEY=your-google-ai-key
DEEPGRAM_API_KEY=your-deepgram-key
```

Optional overrides:

```env
GOOGLE_MODEL=gemini-3.6-flash   # any Gemini model with function calling
OPENAI_API_KEY=...              # fallback provider (used only if GOOGLE_API_KEY is absent)
OPENAI_BASE_URL=...             # point the fallback at any OpenAI-compatible router
OPENAI_MODEL=gpt-4o
DATABASE_URL=...                # postgres://... in prod; defaults to local SQLite
JWT_SECRET=...                  # signs login tokens; set it in production!
CORS_ORIGINS=https://your.app   # comma-separated; "*" by default (no credentials)
LLM_TIMEOUT_S=30                # hard cap on a single LLM call
```

> ⚠️ Keys are read at startup — restart the server after editing `.env`.

### 3. Start the backend

```bash
python voice_server.py
```

On startup it prints the active LLM provider, e.g. `[Startup] LLM provider: Gemini (GOOGLE_API_KEY set)`.

### 4. Frontend setup

```bash
cd frontend
npm install
npm run dev        # dev server
# or
npm run build      # production bundle in frontend/dist
```

## 🎙️ Usage

1. Create an account (or log in) — debates are saved per user.
2. Pick a topic (preset or custom), your stance (Pro/Con), and who speaks first.
3. Tap the mic button and argue. The AI rebuts in voice and text.
4. Stuck? Say "help me" or press 💡 — the AI coaches you instead of countering.
5. **Save Transcript** downloads a `.txt` and stores the full debate in your account; reopen it any time under **Past Debates**.

## 🧠 Architecture

```
Browser mic (16 kHz linear16) ──► FastAPI /ws/debate ──► Deepgram Flux STT
                                        │                     │
                                        │            EndOfTurn transcript
                                        ▼                     │
                               LangGraph debate brain ◄───────┘
                          (opening / opponent / help coach nodes)
                                        │
                          structured reply (rebuttal, coaching_tip, sticky_note)
                                        │
                    agent_response JSON ─► frontend transcript, notes & tips
                                        │
                          Deepgram Aura-2 TTS ─► binary PCM between
                          audio_start / audio_end frames ─► gapless playback
```

Key modules:

| File | Role |
|------|------|
| `voice_server.py` | WebSocket orchestration: STT streaming, turn finalization, TTS relay, auth-gated WS, router mounting |
| `main.py` | LangGraph brain: `DebateReply` structured schema, intent routing, prompts |
| `auth.py` / `routes_auth.py` | bcrypt + JWT helpers; register/login/me endpoints |
| `database.py` / `models.py` / `routes_transcripts.py` | Async SQLAlchemy engine, User/Transcript models, transcript CRUD |
| `schemas.py` | Pydantic request validation (transcripts, auth) |
| `frontend/src/hooks/useVoice.js` | Mic capture, WS protocol + reconnect, gapless PCM playback |
| `frontend/src/hooks/useAuth.js` | Token storage, login/register/logout, authenticated fetch |
| `frontend/src/App.jsx` | Auth gate, setup/debate/history views, transcript/notes state |
| `frontend/src/components/` | AuthScreen, HistoryView, ErrorBoundary, visualizer, panels |

Turn quality guards: turns with fewer than 2 words or average STT confidence below 0.65 are discarded, so breaths and ambient noise never trigger the AI.

## 🧪 Smoke test

```bash
python main.py
```

Runs one debate turn against the configured LLM and prints the rebuttal, coaching tip, and sticky note.

## 🗂️ Transcripts

Saved debates are stored per user as JSON objects (`transcripts/<user_id>/<id>.json`) in the object store — AWS S3 in production, a local `./storage/` folder in dev (no AWS account needed locally). User accounts live alongside as `users/<username>.json` with an email lookup index.

## 🧪 Tests

```bash
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

Covers intent detection, voice-text sanitizing, Deepgram payload parsing, the noise guard, and the auth/transcript endpoints (register/login/ownership/validation) against a throwaway local store — no API keys or AWS account required.

## ☁️ Deployment (Render backend + AWS S3 storage)

The app deploys as a **single Render web service** — FastAPI serves the API, the WebSocket, and the built frontend from `frontend/dist`. User accounts and transcripts persist in **AWS S3**.

### 1. Create the S3 bucket (AWS)

1. In the AWS console: **S3 → Create bucket**, e.g. `debatemate-data`. Keep it **private** (no public access).
2. **IAM → Users → Create user**, e.g. `debatemate-app`, and attach an inline policy scoped to that bucket only:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
    "Resource": ["arn:aws:s3:::debatemate-data", "arn:aws:s3:::debatemate-data/*"]
  }]
}
```

3. Create an **access key** for that user and note the ID + secret.

### 2. Deploy the backend (Render)

1. Push the repo to GitHub, then on Render: **New → Blueprint** and pick the repo (`render.yaml` is read automatically).
2. Set env vars: `GOOGLE_API_KEY`, `DEEPGRAM_API_KEY`, `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. `JWT_SECRET` is auto-generated.
3. Deploy. Render injects `$PORT`; the server binds `0.0.0.0:$PORT` automatically.
4. Verify the health check at `/healthz`, then open the service URL: landing page → register → debate.

No migrations, no tables — objects are written on demand. Without `S3_BUCKET` (local dev) the same code stores everything under `./storage/`.

Notes:

- Rebuild and commit `frontend/dist` whenever frontend code changes (`npm run build` in `frontend/`).
- The Render free tier sleeps after ~15 min of inactivity, which drops any active debate connection — use a paid plan for always-on.
- S3 costs are negligible at this scale (free tier: 5 GB/12 months; then ~$0.02/GB/month).

## 🔧 Troubleshooting

| Symptom | Fix |
|---------|-----|
| `⚠️ Agent error: 429 ...` shown in the UI | LLM quota exhausted — check your key's credits; errors are now surfaced in the transcript instead of hidden |
| Wrong/stale LLM provider used | Keys load at startup — restart `voice_server.py` after editing `.env` |
| `404 This model ... is no longer available` | Google retires models quickly — set `GOOGLE_MODEL` to a current one |
| No transcription | Check `DEEPGRAM_API_KEY`; STT connects lazily on the first mic chunk |
| Mic works but AI silent | Run `python main.py` to isolate whether the LLM or the audio path is failing |
