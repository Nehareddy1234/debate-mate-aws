import { Component } from 'react'

export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        console.error('[ErrorBoundary]', error, info?.componentStack)
    }

    render() {
        if (this.state.error) {
            return (
                <div
                    style={{
                        height: '100vh',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '16px',
                        color: '#e2e8f0',
                        fontFamily: 'Inter, sans-serif',
                        background: 'var(--bg)',
                        textAlign: 'center',
                        padding: '24px',
                    }}
                >
                    <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
                        Something went wrong
                    </div>
                    <p style={{ color: '#64748b', maxWidth: '420px', fontSize: '0.9rem' }}>
                        An unexpected error interrupted the app. Your debates are
                        saved server-side — reload to continue.
                    </p>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            padding: '10px 22px',
                            borderRadius: '10px',
                            border: 'none',
                            background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
                            color: '#fff',
                            fontWeight: 700,
                            cursor: 'pointer',
                            fontFamily: 'Inter, sans-serif',
                        }}
                    >
                        Reload DebateMate
                    </button>
                </div>
            )
        }
        return this.props.children
    }
}
