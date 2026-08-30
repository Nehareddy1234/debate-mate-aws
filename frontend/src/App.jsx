/**
 * App.jsx — AI Debate Coach (V4)
 *
 * Layout (debate view):
 *   ┌──────────────────────────────────────────────────────┐
 *   │  Header Bar                                          │
 *   │    ┌───────────────────────────┐ ┌────────────────┐  │
 *   │    │   Sphere + notes (center) │ │ Transcript     │  │
 *   │    │   Mic / Help / State      │ │ Panel (right)  │  │
 *   │    └───────────────────────────┘ └────────────────┘  │
 *   │  Live Transcript Overlay (fixed bottom of center)    │
 *   └──────────────────────────────────────────────────────┘
 *
 * Fixes applied:
 *   - agent_response handled → AI text added to transcript + notes/tips updated
 *   - first_speaker forwarded to WS (AI or User)
 *   - Help Me button → sends help_request over WS
 *   - Save Transcript → downloads .txt + optionally POSTs to server
 *   - Full transcript stored (not just last 20) via fullTranscriptRef
 *   - AI text added to transcript panel when agent_response arrives
 */

import { useState, useCallback, useRef, lazy, Suspense } from 'react'
import DebateNotes from './components/DebateNotes'
import TranscriptOverlay from './components/TranscriptOverlay'
import TranscriptPanel from './components/TranscriptPanel'
import AuthScreen from './components/AuthScreen'
import ErrorBoundary from './components/ErrorBoundary'
import HistoryView from './components/HistoryView'
import LandingPage from './components/LandingPage'
import { useAuth } from './hooks/useAuth'
import { useVoice } from './hooks/useVoice'

// three.js is heavy — split it out of the main chunk and load it only when
// the debate view renders.
const SphereVisualizer = lazy(() => import('./components/SphereVisualizer'))

// ── Setup screen ──────────────────────────────────────────────

const SAMPLE_TOPICS = [
    'AI will create more jobs than it destroys',
    'Social media does more harm than good',
    'Universal Basic Income should be implemented globally',
    'Space exploration is worth the cost',
    'Cryptocurrencies should replace traditional banking',
]

function SetupScreen({ onStart }) {
    const [topic, setTopic] = useState('')
    const [role, setRole] = useState('Pro')
    const [firstSpeaker, setFirstSpeaker] = useState('ai')
    const [custom, setCustom] = useState(false)

    const handleStart = () => {
        const finalTopic = topic.trim() || SAMPLE_TOPICS[0]
        // Handshake contract: topic, user_side ("Pro"/"Con"),
        // first_speaker ("AI"/"User")
        onStart({
            topic: finalTopic,
            user_side: role,
            first_speaker: firstSpeaker === 'ai' ? 'AI' : 'User',
        })
    }

    return (
        <div className="setup-container" style={{ padding: '24px' }}>
            {/* Logo */}
            <div style={{ textAlign: 'center', marginBottom: '40px' }}>
                <div
                    style={{
                        fontSize: '2.8rem',
                        fontWeight: 800,
                        background: 'linear-gradient(135deg, #38bdf8, #818cf8)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        letterSpacing: '-0.02em',
                        lineHeight: 1.1,
                    }}
                >
                    DebateMate
                </div>
                <p style={{ color: '#64748b', fontSize: '0.95rem', marginTop: '8px' }}>
                    Your real-time voice sparring partner, powered by Gemini
                </p>
            </div>

            {/* Card */}
            <div
                className="glass"
                style={{ width: '100%', maxWidth: '520px', padding: '32px' }}
            >
                {/* Topic */}
                <div style={{ marginBottom: '24px' }}>
                    <label style={labelStyle}>Debate Topic</label>

                    {!custom ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                            {SAMPLE_TOPICS.map((t) => (
                                <button
                                    key={t}
                                    onClick={() => setTopic(t)}
                                    style={{
                                        ...topicBtnStyle,
                                        borderColor: topic === t ? '#38bdf8' : 'rgba(30,45,74,0.8)',
                                        background: topic === t ? 'rgba(56,189,248,0.08)' : 'transparent',
                                        color: topic === t ? '#e2e8f0' : '#64748b',
                                    }}
                                >
                                    {t}
                                </button>
                            ))}
                            <button
                                onClick={() => { setCustom(true); setTopic('') }}
                                style={{ ...topicBtnStyle, borderStyle: 'dashed', color: '#38bdf8', borderColor: 'rgba(56,189,248,0.3)' }}
                            >
                                + Custom topic…
                            </button>
                        </div>
                    ) : (
                        <input
                            type="text"
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            placeholder="Enter your debate topic…"
                            style={inputStyle}
                            autoFocus
                        />
                    )}
                </div>

                {/* Role */}
                <div style={{ marginBottom: '24px' }}>
                    <label style={labelStyle}>Your Stance</label>
                    <div style={{ display: 'flex', gap: '12px', marginTop: '10px' }}>
                        {['Pro', 'Con'].map((r) => (
                            <button
                                key={r}
                                onClick={() => setRole(r)}
                                style={{
                                    flex: 1,
                                    padding: '12px',
                                    borderRadius: '10px',
                                    border: `2px solid ${role === r ? (r === 'Pro' ? '#4ade80' : '#38bdf8') : 'rgba(30,45,74,0.8)'}`,
                                    background: role === r
                                        ? r === 'Pro' ? 'rgba(74,222,128,0.08)' : 'rgba(56,189,248,0.08)'
                                        : 'transparent',
                                    color: role === r ? '#e2e8f0' : '#475569',
                                    fontSize: '0.9rem',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                    fontFamily: 'Inter, sans-serif',
                                }}
                            >
                                {r === 'Pro' ? '👍 Support the motion' : '👎 Oppose the motion'}
                            </button>
                        ))}
                    </div>
                    <p style={{ fontSize: '0.75rem', color: '#475569', margin: '8px 0 0' }}>
                        The AI will take the opposite stance and challenge your arguments.
                    </p>
                </div>

                {/* Who speaks first */}
                <div style={{ marginBottom: '28px' }}>
                    <label style={labelStyle}>Who Speaks First?</label>
                    <div style={{ display: 'flex', gap: '12px', marginTop: '10px' }}>
                        {[
                            { value: 'ai', label: '🤖 AI makes opening', desc: 'AI starts with an opening statement' },
                            { value: 'user', label: '🙋 I speak first', desc: "You kick off the debate" },
                        ].map(({ value, label, desc }) => (
                            <button
                                key={value}
                                onClick={() => setFirstSpeaker(value)}
                                style={{
                                    flex: 1,
                                    padding: '10px 12px',
                                    borderRadius: '10px',
                                    border: `2px solid ${firstSpeaker === value ? '#818cf8' : 'rgba(30,45,74,0.8)'}`,
                                    background: firstSpeaker === value ? 'rgba(129,140,248,0.08)' : 'transparent',
                                    color: firstSpeaker === value ? '#e2e8f0' : '#475569',
                                    fontSize: '0.82rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                    fontFamily: 'Inter, sans-serif',
                                    textAlign: 'left',
                                    lineHeight: 1.4,
                                }}
                            >
                                <div>{label}</div>
                                <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '2px' }}>{desc}</div>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Start button */}
                <button
                    onClick={handleStart}
                    disabled={!topic && SAMPLE_TOPICS.length === 0}
                    style={{
                        width: '100%',
                        padding: '14px',
                        borderRadius: '12px',
                        border: 'none',
                        background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
                        color: '#fff',
                        fontSize: '1rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                        letterSpacing: '0.03em',
                        boxShadow: '0 0 24px rgba(14, 165, 233, 0.3)',
                        fontFamily: 'Inter, sans-serif',
                        transition: 'transform 0.15s, box-shadow 0.15s',
                    }}
                    onMouseEnter={(e) => { e.target.style.transform = 'translateY(-1px)'; e.target.style.boxShadow = '0 0 36px rgba(14,165,233,0.4)' }}
                    onMouseLeave={(e) => { e.target.style.transform = 'translateY(0)'; e.target.style.boxShadow = '0 0 24px rgba(14,165,233,0.3)' }}
                >
                    🎙️ Start Debate
                </button>
            </div>
        </div>
    )
}

// ── Main debate view ──────────────────────────────────────────

function DebateView({
    topic, userRole, analyserRef,
    isUserSpeaking, isAiSpeaking,
    micActive, connected,
    onMicToggle, onEnd,
    notes, tips,
    transcriptLines,      // last 6 lines for overlay
    fullTranscript,       // all lines for panel
    onHelp,
    onSave,
    isAiThinking,
}) {
    const aiRole = userRole === 'Pro' ? 'Con' : 'Pro'

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

            {/* ── Header ── */}
            <header
                style={{
                    padding: '12px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid rgba(30,45,74,0.6)',
                    background: 'rgba(8,12,20,0.9)',
                    backdropFilter: 'blur(12px)',
                    flexShrink: 0,
                    zIndex: 10,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{
                        fontSize: '1.05rem',
                        fontWeight: 800,
                        background: 'linear-gradient(135deg, #38bdf8, #818cf8)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                    }}>
                        DebateMate
                    </span>
                    <span style={{ color: '#1e3a5f', fontSize: '0.8rem' }}>|</span>
                    <span style={{
                        color: '#64748b', fontSize: '0.78rem',
                        maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                        {topic}
                    </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span className={`role-badge ${userRole.toLowerCase()}`}>{userRole === 'Pro' ? '👍 You' : '👎 You'}</span>
                    <span style={{ color: '#334155', fontSize: '0.7rem' }}>vs</span>
                    <span className={`role-badge ${aiRole.toLowerCase()}`}>AI {aiRole === 'Pro' ? '👍' : '👎'}</span>

                    {/* Connection dot */}
                    <div
                        role="status"
                        aria-label={connected ? 'Connected to server' : 'Disconnected from server'}
                        style={{
                            width: '8px', height: '8px', borderRadius: '50%',
                            background: connected ? '#4ade80' : '#64748b',
                            boxShadow: connected ? '0 0 8px #4ade80' : 'none',
                            marginLeft: '4px',
                        }}
                        title={connected ? 'Connected' : 'Disconnected'}
                    />

                    <button
                        onClick={onEnd}
                        aria-label="End debate"
                        style={{
                            padding: '6px 14px',
                            borderRadius: '8px',
                            border: '1px solid rgba(30,45,74,0.8)',
                            background: 'transparent',
                            color: '#64748b',
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                            fontFamily: 'Inter, sans-serif',
                            transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(239,68,68,0.5)'; e.currentTarget.style.color = '#f87171' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(30,45,74,0.8)'; e.currentTarget.style.color = '#64748b' }}
                    >
                        End Debate
                    </button>
                </div>
            </header>

            {/* ── Main content: Sphere + Transcript panel ── */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

                {/* ── Center area ── */}
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                    {/* Sphere */}
                    <div style={{ position: 'absolute', inset: 0 }}>
                        <Suspense fallback={null}>
                            <SphereVisualizer
                                analyserRef={analyserRef}
                                isAiSpeaking={isAiSpeaking}
                                isUserSpeaking={isUserSpeaking}
                            />
                        </Suspense>
                    </div>

                    {/* Notes panel — top right of center */}
                    <div
                        style={{
                            position: 'absolute',
                            top: '16px',
                            right: '16px',
                            zIndex: 5,
                        }}
                    >
                        <DebateNotes notes={notes} tips={tips} />
                    </div>

                    {/* State label */}
                    <div
                        style={{
                            position: 'absolute',
                            bottom: '235px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            letterSpacing: '0.12em',
                            textTransform: 'uppercase',
                            color: isAiThinking
                                ? '#fbbf24'
                                : isAiSpeaking
                                    ? '#38bdf8'
                                    : isUserSpeaking
                                        ? '#4ade80'
                                        : '#334155',
                            transition: 'color 0.4s',
                            textShadow: isAiSpeaking
                                ? '0 0 12px rgba(56,189,248,0.5)'
                                : isUserSpeaking
                                    ? '0 0 12px rgba(74,222,128,0.5)'
                                    : 'none',
                        }}
                    >
                        {isAiThinking
                            ? '⏳ AI Thinking…'
                            : isAiSpeaking
                                ? '◉ AI Speaking'
                                : isUserSpeaking
                                    ? '◉ Listening…'
                                    : '○ Idle'}
                    </div>

                    {/* Controls row — mic + help */}
                    <div
                        style={{
                            position: 'absolute',
                            bottom: '175px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            zIndex: 5,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '20px',
                        }}
                    >
                        {/* Help Me button */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                            <button
                                onClick={onHelp}
                                aria-label="Ask AI coach for help"
                                title="Ask AI to help you respond"
                                style={{
                                    width: '48px',
                                    height: '48px',
                                    borderRadius: '50%',
                                    border: '2px solid rgba(251,191,36,0.4)',
                                    background: 'rgba(251,191,36,0.08)',
                                    color: '#fbbf24',
                                    fontSize: '1.2rem',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s',
                                    backdropFilter: 'blur(8px)',
                                }}
                                onMouseEnter={e => {
                                    e.currentTarget.style.background = 'rgba(251,191,36,0.18)'
                                    e.currentTarget.style.boxShadow = '0 0 16px rgba(251,191,36,0.3)'
                                }}
                                onMouseLeave={e => {
                                    e.currentTarget.style.background = 'rgba(251,191,36,0.08)'
                                    e.currentTarget.style.boxShadow = 'none'
                                }}
                            >
                                💡
                            </button>
                            <span style={{ fontSize: '0.62rem', color: '#475569' }}>Help Me</span>
                        </div>

                        {/* Mic button */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                            <button
                                onClick={onMicToggle}
                                aria-label={micActive ? 'Mute microphone' : 'Activate microphone'}
                                aria-pressed={micActive}
                                className={micActive ? 'mic-active' : ''}
                                style={{
                                    width: '64px',
                                    height: '64px',
                                    borderRadius: '50%',
                                    border: `2px solid ${micActive ? '#4ade80' : 'rgba(30,45,74,0.8)'}`,
                                    background: micActive ? 'rgba(74,222,128,0.12)' : 'rgba(8,12,20,0.85)',
                                    color: micActive ? '#4ade80' : '#475569',
                                    fontSize: '1.5rem',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s',
                                    backdropFilter: 'blur(8px)',
                                    boxShadow: micActive ? '0 0 20px rgba(74,222,128,0.25)' : 'none',
                                }}
                            >
                                {micActive ? '🎙️' : '🎤'}
                            </button>
                            <span style={{ fontSize: '0.62rem', color: '#475569' }}>
                                {micActive ? 'Tap to mute' : 'Tap to speak'}
                            </span>
                        </div>

                        {/* Spacer to balance layout */}
                        <div style={{ width: '48px' }} />
                    </div>

                    {/* Live Transcript overlay (bottom of center area) */}
                    <TranscriptOverlay lines={transcriptLines} />
                </div>

                {/* ── Right: Full transcript panel ── */}
                <TranscriptPanel
                    lines={fullTranscript}
                    topic={topic}
                    onSave={onSave}
                />
            </div>
        </div>
    )
}

// ── Root App ──────────────────────────────────────────────────

let lineId = 0

export default function App() {
    const { user, loading, login, register, logout, authFetch } = useAuth()
    const [showAuth, setShowAuth] = useState(false)
    const [authMode, setAuthMode] = useState('login')

    if (loading) {
        return (
            <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontFamily: 'Inter, sans-serif', background: 'var(--bg)' }}>
                Loading DebateMate…
            </div>
        )
    }

    if (!user) {
        return showAuth ? (
            <AuthScreen
                initialMode={authMode}
                onBack={() => setShowAuth(false)}
                onLogin={login}
                onRegister={register}
            />
        ) : (
            <LandingPage
                onGetStarted={() => { setAuthMode('register'); setShowAuth(true) }}
                onLogin={() => { setAuthMode('login'); setShowAuth(true) }}
            />
        )
    }

    return (
        <ErrorBoundary>
            <AppContent user={user} logout={logout} authFetch={authFetch} />
        </ErrorBoundary>
    )
}

function AppContent({ user, logout, authFetch }) {
    const [phase, setPhase] = useState('setup')   // 'setup' | 'debate' | 'history'
    const [debateConfig, setDebateConfig] = useState(null)
    const [notes, setNotes] = useState([])
    const [tips, setTips] = useState([])
    const [transcriptLines, setTranscript] = useState([])  // last 6 for overlay
    const [isAiThinking, setIsAiThinking] = useState(false)

    // Full transcript (all lines, never trimmed) — stored in ref + state for panel
    const fullTranscriptRef = useRef([])
    const [fullTranscript, setFullTranscript] = useState([])
    const sessionIdRef = useRef(null)
    const startedAtRef = useRef(null)

    const addLine = useCallback((speaker, text, isPartial = false) => {
        const ts = Date.now()
        const newLine = { id: ++lineId, speaker, text, isPartial, timestamp: ts }

        // Update overlay (last 6 lines)
        setTranscript(prev => {
            const last = prev[prev.length - 1]
            if (last && last.speaker === speaker && last.isPartial) {
                return [...prev.slice(0, -1), { ...last, text, isPartial, timestamp: ts }]
            }
            return [...prev.slice(-5), newLine]
        })

        // Update full transcript (replace partial or append)
        if (!isPartial) {
            const allLines = fullTranscriptRef.current
            const lastFull = allLines[allLines.length - 1]
            let updated
            if (lastFull && lastFull.speaker === speaker && lastFull.isPartial) {
                updated = [...allLines.slice(0, -1), { ...lastFull, text, isPartial: false, timestamp: ts }]
            } else {
                updated = [...allLines, newLine]
            }
            fullTranscriptRef.current = updated
            setFullTranscript([...updated])
        } else {
            // Show partial in both
            const allLines = fullTranscriptRef.current
            const lastFull = allLines[allLines.length - 1]
            let updated
            if (lastFull && lastFull.speaker === speaker && lastFull.isPartial) {
                updated = [...allLines.slice(0, -1), { ...lastFull, text, timestamp: ts }]
            } else {
                updated = [...allLines, newLine]
            }
            fullTranscriptRef.current = updated
            setFullTranscript([...updated])
        }
    }, [])

    const onMessage = useCallback((msg) => {
        switch (msg.type) {
            case 'ready':
                if (msg.session_id) sessionIdRef.current = msg.session_id
                break

            case 'setup_ack':
                // Server confirmed the setup handshake (topic / side / first
                // speaker stored in the connection session state)
                startedAtRef.current = new Date().toISOString()
                break

            case 'transcript':
                // Completed final turn of the user's speech
                addLine(msg.speaker || 'user', msg.text, false)
                break

            case 'partial_transcript':
                // Live interim caption (Deepgram "Update" event)
                addLine(msg.speaker || 'user', msg.text, true)
                break

            case 'agent_response': {
                // Structured payload: rebuttal (voice text), coaching_tip,
                // sticky_note — with legacy text/tip aliases as fallback
                setIsAiThinking(false)
                const replyText = msg.rebuttal ?? msg.text
                const coachingTip = msg.coaching_tip ?? msg.tip
                if (replyText) addLine('ai', replyText, false)
                if (msg.notes) setNotes(msg.notes)
                else if (msg.sticky_note) setNotes(prev => [...prev, msg.sticky_note])
                if (coachingTip) setTips(prev => [...prev, coachingTip])
                break
            }

            case 'ai_thinking_start':
                setIsAiThinking(true)
                break

            case 'ai_thinking_end':
                setIsAiThinking(false)
                break

            case 'note':
                setNotes((prev) => [...prev, msg.text])
                break

            case 'tip':
                setTips((prev) => [...prev, msg.text])
                break

            case 'error':
                console.error('[Server error]', msg.text)
                addLine('ai', `⚠️ ${msg.text}`, false)
                break

            default:
                break
        }
    }, [addLine])

    const { connect, disconnect, startMic, stopMic, sendMessage, primeAudio, connected, micActive, isUserSpeaking, isAiSpeaking, analyserRef } = useVoice({ onMessage })

    const handleStart = useCallback(({ topic, user_side, first_speaker }) => {
        setDebateConfig({ topic, user_side, first_speaker })
        setNotes([])
        setTips([])
        setTranscript([])
        fullTranscriptRef.current = []
        setFullTranscript([])
        lineId = 0
        setPhase('debate')
        primeAudio()   // unlock playback audio inside this click gesture
        connect({ topic, user_side, first_speaker })
    }, [connect, primeAudio])

    const handleMicToggle = useCallback(async () => {
        if (micActive) stopMic()
        else await startMic()
    }, [micActive, startMic, stopMic])

    const handleEnd = useCallback(() => {
        disconnect()
        setPhase('setup')
        setDebateConfig(null)
    }, [disconnect])

    const handleHelp = useCallback(() => {
        sendMessage({ type: 'help_request' })
    }, [sendMessage])

    const handleSave = useCallback(() => {
        const lines = fullTranscriptRef.current
        const topic = debateConfig?.topic || 'Debate'
        const timestamp = new Date().toLocaleString()

        // Build plain text
        let text = `DebateMate — Debate Transcript\n`
        text += `Topic: ${topic}\n`
        text += `Date: ${timestamp}\n`
        text += `Your Role: ${debateConfig?.user_side || '?'}\n`
        text += `${'─'.repeat(60)}\n\n`

        lines.filter(l => !l.isPartial).forEach(line => {
            const who = line.speaker === 'user' ? 'YOU' : 'AI '
            const time = new Date(line.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            text += `[${time}] ${who}: ${line.text}\n\n`
        })

        // Download as .txt
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `debate_${Date.now()}.txt`
        a.click()
        URL.revokeObjectURL(url)

        // Also POST to server for durable per-user saving
        if (sessionIdRef.current) {
            authFetch('/transcripts', {
                method: 'POST',
                body: JSON.stringify({
                    session_id: sessionIdRef.current,
                    topic,
                    user_side: debateConfig?.user_side,
                    started_at: startedAtRef.current,
                    transcript: lines.filter(l => !l.isPartial).map(l => ({
                        speaker: l.speaker,
                        text: l.text,
                        timestamp: new Date(l.timestamp).toISOString(),
                    })),
                }),
            })
                .then(r => { if (!r.ok) console.warn('[Save] Server save failed:', r.status) })
                .catch(err => console.warn('[Save] Server save failed:', err))
        }
    }, [debateConfig, authFetch])

    return (
        <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>
            {phase === 'debate' ? (
                <DebateView
                    topic={debateConfig.topic}
                    userRole={debateConfig.user_side}
                    analyserRef={analyserRef}
                    isUserSpeaking={isUserSpeaking}
                    isAiSpeaking={isAiSpeaking}
                    micActive={micActive}
                    connected={connected}
                    onMicToggle={handleMicToggle}
                    onEnd={handleEnd}
                    notes={notes}
                    tips={tips}
                    transcriptLines={transcriptLines}
                    fullTranscript={fullTranscript}
                    onHelp={handleHelp}
                    onSave={handleSave}
                    isAiThinking={isAiThinking}
                />
            ) : (
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <nav
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            padding: '10px 20px',
                            borderBottom: '1px solid rgba(30,45,74,0.6)',
                            flexShrink: 0,
                        }}
                    >
                        <span style={{ color: '#64748b', fontSize: '0.8rem', marginRight: 'auto', fontFamily: 'Inter, sans-serif' }}>
                            Signed in as <strong style={{ color: '#94a3b8' }}>{user.username}</strong>
                        </span>
                        <button
                            onClick={() => setPhase(phase === 'setup' ? 'history' : 'setup')}
                            style={navBtnStyle}
                        >
                            {phase === 'setup' ? '📚 Past Debates' : '🎙️ New Debate'}
                        </button>
                        <button onClick={logout} aria-label="Log out" style={navBtnStyle}>
                            Log out
                        </button>
                    </nav>
                    <div style={{ flex: 1, overflowY: 'auto' }}>
                        {phase === 'setup' ? (
                            <SetupScreen onStart={handleStart} />
                        ) : (
                            <HistoryView authFetch={authFetch} onBack={() => setPhase('setup')} />
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

// ── Shared styles ─────────────────────────────────────────────

const labelStyle = {
    display: 'block',
    fontSize: '0.75rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#64748b',
}

const topicBtnStyle = {
    width: '100%',
    textAlign: 'left',
    padding: '10px 14px',
    borderRadius: '8px',
    border: '1px solid rgba(30,45,74,0.8)',
    background: 'transparent',
    color: '#64748b',
    fontSize: '0.85rem',
    cursor: 'pointer',
    transition: 'all 0.15s',
    fontFamily: 'Inter, sans-serif',
}

const inputStyle = {
    width: '100%',
    marginTop: '10px',
    padding: '12px 14px',
    borderRadius: '10px',
    border: '1px solid rgba(56,189,248,0.35)',
    background: 'rgba(13,20,36,0.8)',
    color: '#e2e8f0',
    fontSize: '0.9rem',
    outline: 'none',
    fontFamily: 'Inter, sans-serif',
    boxSizing: 'border-box',
}

const navBtnStyle = {
    padding: '6px 14px',
    borderRadius: '8px',
    border: '1px solid rgba(30,45,74,0.8)',
    background: 'transparent',
    color: '#64748b',
    fontSize: '0.75rem',
    cursor: 'pointer',
    fontFamily: 'Inter, sans-serif',
    transition: 'all 0.15s',
}
