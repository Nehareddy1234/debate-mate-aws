import { useEffect, useState } from 'react'

export default function HistoryView({ authFetch, onBack }) {
    const [items, setItems] = useState(null)
    const [error, setError] = useState(null)
    const [openId, setOpenId] = useState(null)
    const [detail, setDetail] = useState(null)
    const [detailLoading, setDetailLoading] = useState(false)

    useEffect(() => {
        let alive = true
        authFetch('/transcripts')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => alive && setItems(data.transcripts))
            .catch((e) => alive && setError(e.message))
        return () => { alive = false }
    }, [authFetch])

    const toggle = async (id) => {
        if (openId === id) {
            setOpenId(null)
            setDetail(null)
            return
        }
        setOpenId(id)
        setDetail(null)
        setDetailLoading(true)
        try {
            const r = await authFetch(`/transcripts/${id}`)
            if (r.ok) setDetail(await r.json())
        } finally {
            setDetailLoading(false)
        }
    }

    return (
        <div className="setup-container" style={{ padding: '24px', overflowY: 'auto' }}>
            <div style={{ width: '100%', maxWidth: '720px', margin: '0 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
                    <h2 style={{ color: '#e2e8f0', fontFamily: 'Inter, sans-serif', fontSize: '1.3rem', margin: 0 }}>
                        Past Debates
                    </h2>
                    <button
                        onClick={onBack}
                        style={{
                            padding: '8px 16px',
                            borderRadius: '8px',
                            border: '1px solid rgba(30,45,74,0.8)',
                            background: 'transparent',
                            color: '#64748b',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            fontFamily: 'Inter, sans-serif',
                        }}
                    >
                        ← New Debate
                    </button>
                </div>

                {error && <p style={{ color: '#f87171' }}>Could not load debates: {error}</p>}
                {items === null && !error && <p style={{ color: '#64748b' }}>Loading…</p>}
                {items !== null && items.length === 0 && (
                    <p style={{ color: '#64748b' }}>
                        No saved debates yet — finish one and hit “Save Transcript”.
                    </p>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {(items || []).map((t) => (
                        <div key={t.id} className="glass" style={{ padding: '14px 18px' }}>
                            <button
                                onClick={() => toggle(t.id)}
                                aria-expanded={openId === t.id}
                                style={{
                                    width: '100%',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    background: 'none',
                                    border: 'none',
                                    color: '#e2e8f0',
                                    cursor: 'pointer',
                                    fontFamily: 'Inter, sans-serif',
                                    fontSize: '0.9rem',
                                    padding: 0,
                                    textAlign: 'left',
                                }}
                            >
                                <span>{t.topic}</span>
                                <span style={{ color: '#64748b', fontSize: '0.75rem', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                                    {new Date(t.saved_at).toLocaleString()} · {t.total_turns} turns
                                </span>
                            </button>

                            {openId === t.id && (
                                <div style={{ marginTop: '12px', borderTop: '1px solid rgba(30,45,74,0.6)', paddingTop: '12px' }}>
                                    {detailLoading && <p style={{ color: '#64748b', fontSize: '0.8rem' }}>Loading transcript…</p>}
                                    {detail && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px', overflowY: 'auto' }}>
                                            {detail.transcript.map((line, i) => (
                                                <p key={i} style={{
                                                    margin: 0,
                                                    fontSize: '0.82rem',
                                                    color: line.speaker === 'user' ? '#4ade80' : '#38bdf8',
                                                    fontFamily: 'Inter, sans-serif',
                                                    lineHeight: 1.5,
                                                }}>
                                                    <strong>{line.speaker === 'user' ? 'You' : 'AI'}:</strong>{' '}
                                                    <span style={{ color: '#cbd5e1' }}>{line.text}</span>
                                                </p>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
