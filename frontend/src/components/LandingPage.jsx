const featureCards = [
    {
        icon: '🎙️',
        title: 'Voice-to-voice debate',
        body: 'Speak naturally. Your words are transcribed live, answered in real time, and spoken back by the AI opponent.',
    },
    {
        icon: '',
        title: 'A real opponent',
        body: 'The AI argues the opposite side relentlessly — sharp rebuttals, never a concession, just like a real sparring partner.',
    },
    {
        icon: '💡',
        title: 'Coach when you’re stuck',
        body: 'Say “I’m stuck” or tap Help and the AI switches sides: supportive angles and structure tips for YOUR argument.',
    },
    {
        icon: '📚',
        title: 'Every debate saved',
        body: 'Full transcripts stored to your account. Re-read past debates, review coaching tips, and track your progress.',
    },
]

const steps = [
    { n: '1', title: 'Pick a topic & stance', body: 'Choose a preset motion or your own, take Pro or Con — the AI takes the other side.' },
    { n: '2', title: 'Argue out loud', body: 'Tap the mic and make your case. Watch live captions and hear instant spoken rebuttals.' },
    { n: '3', title: 'Review & improve', body: 'Save the transcript, read the AI’s sticky-note summaries, and come back stronger next time.' },
]

export default function LandingPage({ onGetStarted, onLogin }) {
    return (
        <div style={{ height: '100vh', overflowY: 'auto', background: 'var(--bg)', fontFamily: 'Inter, sans-serif' }}>
            {/* ── Nav ─ */}
            <nav style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 32px', maxWidth: '1080px', margin: '0 auto' }}>
                <span style={{ fontSize: '1.2rem', fontWeight: 800, background: 'linear-gradient(135deg, #38bdf8, #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    DebateMate
                </span>
                <button onClick={onLogin} style={ghostBtn}>Log in</button>
            </nav>

            {/* ── Hero ─ */}
            <header style={{ maxWidth: '820px', margin: '0 auto', padding: '72px 24px 48px', textAlign: 'center' }}>
                <p style={{ color: '#38bdf8', fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '16px' }}>
                    Real-time AI debate sparring partner
                </p>
                <h1 style={{ color: '#e2e8f0', fontSize: 'clamp(2rem, 5vw, 3.4rem)', fontWeight: 800, lineHeight: 1.12, margin: '0 0 20px', letterSpacing: '-0.02em' }}>
                    Sharpen your arguments{' '}
                    <span style={{ background: 'linear-gradient(135deg, #38bdf8, #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                        out loud
                    </span>
                    , against an AI that talks back.
                </h1>
                <p style={{ color: '#64748b', fontSize: '1.05rem', lineHeight: 1.7, maxWidth: '620px', margin: '0 auto 36px' }}>
                    DebateMate listens to your case, rebuts it in voice within seconds,
                    coaches you when you stall, and keeps a record of every round —
                    so you walk into the real debate already tested.
                </p>
                <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button onClick={onGetStarted} style={primaryBtn}>Create free account</button>
                    <button onClick={onLogin} style={ghostBtn}>Log in</button>
                </div>
                <p style={{ color: '#475569', fontSize: '0.75rem', marginTop: '18px' }}>
                    No credit card. Microphone required — that’s the point. 🎤
                </p>
            </header>

            {/* ── Features ── */}
            <section style={{ maxWidth: '1080px', margin: '0 auto', padding: '32px 24px 56px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
                    {featureCards.map((f) => (
                        <div key={f.title} className="glass" style={{ padding: '24px' }}>
                            <div style={{ fontSize: '1.6rem', marginBottom: '12px' }} aria-hidden="true">{f.icon}</div>
                            <h3 style={{ color: '#e2e8f0', fontSize: '1rem', fontWeight: 700, margin: '0 0 8px' }}>{f.title}</h3>
                            <p style={{ color: '#64748b', fontSize: '0.85rem', lineHeight: 1.6, margin: 0 }}>{f.body}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── How it works ── */}
            <section style={{ maxWidth: '900px', margin: '0 auto', padding: '0 24px 72px' }}>
                <h2 style={{ color: '#e2e8f0', textAlign: 'center', fontSize: '1.5rem', fontWeight: 800, marginBottom: '32px' }}>
                    How it works
                </h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
                    {steps.map((s) => (
                        <div key={s.n} style={{ textAlign: 'center' }}>
                            <div style={{
                                width: '44px', height: '44px', borderRadius: '50%', margin: '0 auto 14px',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'rgba(56,189,248,0.1)', border: '2px solid rgba(56,189,248,0.4)',
                                color: '#38bdf8', fontWeight: 800, fontSize: '1.1rem',
                            }}>
                                {s.n}
                            </div>
                            <h3 style={{ color: '#e2e8f0', fontSize: '0.95rem', fontWeight: 700, margin: '0 0 6px' }}>{s.title}</h3>
                            <p style={{ color: '#64748b', fontSize: '0.82rem', lineHeight: 1.6, margin: 0 }}>{s.body}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── Footer ─ */}
            <footer style={{ borderTop: '1px solid rgba(30,45,74,0.6)', padding: '20px 24px', textAlign: 'center', color: '#475569', fontSize: '0.75rem' }}>
                DebateMate — powered by Gemini, Deepgram speech, and a microphone that’s heard it all.
            </footer>
        </div>
    )
}

const primaryBtn = {
    padding: '14px 28px',
    borderRadius: '12px',
    border: 'none',
    background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
    color: '#fff',
    fontSize: '0.95rem',
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.02em',
    boxShadow: '0 0 24px rgba(14, 165, 233, 0.3)',
    fontFamily: 'Inter, sans-serif',
}

const ghostBtn = {
    padding: '10px 20px',
    borderRadius: '10px',
    border: '1px solid rgba(30,45,74,0.8)',
    background: 'transparent',
    color: '#94a3b8',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'Inter, sans-serif',
}
