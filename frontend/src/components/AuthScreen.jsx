import { useState } from 'react'

const fieldStyle = {
    width: '100%',
    marginTop: '8px',
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

const labelStyle = {
    display: 'block',
    fontSize: '0.75rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#64748b',
}

export default function AuthScreen({ onLogin, onRegister, initialMode = 'login', onBack }) {
    const [mode, setMode] = useState(initialMode)   // 'login' | 'register'
    const [username, setUsername] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)

    const submit = async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            if (mode === 'login') await onLogin(username.trim(), password)
            else await onRegister(username.trim(), email.trim(), password)
        } catch (err) {
            setError(err.message)
        } finally {
            setBusy(false)
        }
    }

    const tabStyle = (active) => ({
        flex: 1,
        padding: '10px',
        borderRadius: '8px',
        border: 'none',
        background: active ? 'rgba(56,189,248,0.12)' : 'transparent',
        color: active ? '#38bdf8' : '#64748b',
        fontWeight: 700,
        fontSize: '0.85rem',
        cursor: 'pointer',
        fontFamily: 'Inter, sans-serif',
    })

    return (
        <div className="setup-container" style={{ padding: '24px' }}>
            {onBack && (
                <div style={{ width: '100%', maxWidth: '420px', margin: '0 auto 12px' }}>
                    <button
                        onClick={onBack}
                        style={{
                            background: 'none', border: 'none', color: '#64748b',
                            cursor: 'pointer', fontSize: '0.8rem',
                            fontFamily: 'Inter, sans-serif', padding: 0,
                        }}
                    >
                        ← Back
                    </button>
                </div>
            )}
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
                    Your real-time voice sparring partner
                </p>
            </div>

            <div className="glass" style={{ width: '100%', maxWidth: '420px', padding: '32px' }}>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', background: 'rgba(8,12,20,0.6)', padding: '4px', borderRadius: '10px' }}>
                    <button type="button" onClick={() => { setMode('login'); setError(null) }} style={tabStyle(mode === 'login')}>
                        Log in
                    </button>
                    <button type="button" onClick={() => { setMode('register'); setError(null) }} style={tabStyle(mode === 'register')}>
                        Create account
                    </button>
                </div>

                <form onSubmit={submit}>
                    <div style={{ marginBottom: '16px' }}>
                        <label style={labelStyle}>Username</label>
                        <input
                            style={fieldStyle}
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            autoComplete="username"
                            required
                        />
                    </div>

                    {mode === 'register' && (
                        <div style={{ marginBottom: '16px' }}>
                            <label style={labelStyle}>Email</label>
                            <input
                                style={fieldStyle}
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                autoComplete="email"
                                required
                            />
                        </div>
                    )}

                    <div style={{ marginBottom: '24px' }}>
                        <label style={labelStyle}>Password</label>
                        <input
                            style={fieldStyle}
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                            minLength={8}
                            title={mode === 'register' ? 'At least 8 characters' : undefined}
                            required
                        />
                    </div>

                    {error && (
                        <p role="alert" style={{ color: '#f87171', fontSize: '0.8rem', marginBottom: '12px' }}>
                            {error}
                        </p>
                    )}

                    <button
                        type="submit"
                        disabled={busy}
                        style={{
                            width: '100%',
                            padding: '14px',
                            borderRadius: '12px',
                            border: 'none',
                            background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
                            color: '#fff',
                            fontSize: '1rem',
                            fontWeight: 700,
                            cursor: busy ? 'wait' : 'pointer',
                            letterSpacing: '0.03em',
                            boxShadow: '0 0 24px rgba(14, 165, 233, 0.3)',
                            fontFamily: 'Inter, sans-serif',
                            opacity: busy ? 0.7 : 1,
                        }}
                    >
                        {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
                    </button>
                </form>
            </div>
        </div>
    )
}
