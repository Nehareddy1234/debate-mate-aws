/**
 * useVoice.js (V6 — Deepgram Flux / Aura)
 *
 * Key changes:
 *  - Handshake sends { topic, user_side, first_speaker: "AI" | "User" }
 *  - Mic capture pinned to 16 kHz Linear16 PCM; if the browser ignores the
 *    sampleRate constraint (e.g. Safari), audio is linearly downsampled
 *    to 16 kHz before being sent over the WebSocket.
 *  - Typed audio framing from the server:
 *      audio_start (JSON metadata) -> binary PCM chunks -> audio_end
 *    so playback state tracks the AI speech window precisely.
 *  - Live captions: partial_transcript (Deepgram "Update") vs final
 *    transcript turns — routed to App.jsx via onMessage.
 */

import { useRef, useState, useCallback, useEffect } from 'react'

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/debate`
const MIC_SAMPLE_RATE = 16_000
const PLAY_SAMPLE_RATE = 24_000
const CHUNK_INTERVAL_MS = 250

export function useVoice({ onMessage }) {
    const wsRef = useRef(null)

    const micCtxRef = useRef(null)
    const playCtxRef = useRef(null)

    const analyserRef = useRef(null)
    const micStreamRef = useRef(null)
    const processorRef = useRef(null)
    const chunkBufRef = useRef([])
    const intervalRef = useRef(null)

    // Connection resilience: auto-reconnect with exponential backoff unless
    // the close was intentional (logout/end) or an auth rejection (4001).
    const intentionalCloseRef = useRef(false)
    const lastConfigRef = useRef(null)
    const pendingMessagesRef = useRef([])
    const backoffRef = useRef(1000)

    // Gapless TTS playback: chunks are scheduled back-to-back on the
    // AudioContext clock. Waiting for onended between chunks (old approach)
    // inserts underrun gaps that make the AI voice sound distorted/robotic.
    const nextStartTimeRef = useRef(0)
    const pendingSourcesRef = useRef(0)
    const streamEndedRef = useRef(false)

    const [connected, setConnected] = useState(false)
    const [micActive, setMicActive] = useState(false)
    const [isUserSpeaking, setIsUserSpeaking] = useState(false)
    const [isAiSpeaking, setIsAiSpeaking] = useState(false)

    // ── WebSocket setup ───────────────────────────────────────────

    const connect = useCallback(({ topic, user_side, user_role, first_speaker = 'User' }) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            console.log('[WS] Already open, skipping connect.')
            return
        }

        intentionalCloseRef.current = false
        lastConfigRef.current = { topic, user_side, user_role, first_speaker }

        console.log(`[WS] Connecting to ${WS_URL}...`)
        const ws = new WebSocket(WS_URL)
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws

        ws.onopen = () => {
            console.log('[WS] Connected successfully.')
            setConnected(true)
            // SETUP HANDSHAKE — first JSON metadata frame the backend expects:
            // { topic, user_side ("Pro"/"Con"), first_speaker ("AI"/"User"),
            //   token (JWT) }. The token rides in-frame, not in the URL.
            const payload = {
                type: 'start_debate',
                topic,
                user_side: user_side || user_role || 'Pro',
                first_speaker: String(first_speaker).toLowerCase() === 'ai' ? 'AI' : 'User',
                token: localStorage.getItem('dm_token') || undefined,
            }
            console.log('[WS] Sending handshake')
            ws.send(JSON.stringify(payload))

            // Deliver anything queued while the socket was down
            while (pendingMessagesRef.current.length) {
                ws.send(JSON.stringify(pendingMessagesRef.current.shift()))
            }
            backoffRef.current = 1000
        }

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                // Binary frame between audio_start/audio_end = Linear16 PCM
                _queueAudio(event.data)
                return
            }

            try {
                const msg = JSON.parse(event.data)

                switch (msg.type) {
                    // ── Typed audio framing (TTS window) ──
                    case 'audio_start':
                    case 'ai_speaking_start':   // legacy alias
                        // New TTS window — reset scheduling state
                        nextStartTimeRef.current = 0
                        streamEndedRef.current = false
                        pendingSourcesRef.current = 0
                        setIsAiSpeaking(true)
                        break
                    case 'audio_end':
                    case 'ai_speaking_end':     // legacy alias
                        // Stream finished; keep "speaking" until every
                        // scheduled source has drained to avoid UI flicker
                        streamEndedRef.current = true
                        if (pendingSourcesRef.current === 0) setIsAiSpeaking(false)
                        break
                    default:
                        // partial_transcript (live captions), transcript
                        // (final turns), agent_response (rebuttal /
                        // coaching_tip / sticky_note), errors, etc.
                        onMessage?.(msg)
                }
            } catch (e) {
                console.warn('[WS] Non-JSON text:', event.data)
            }
        }

        ws.onclose = (e) => {
            console.log(`[WS] Closed. Code=${e.code}, Reason=${e.reason}`)
            setConnected(false)
            setMicActive(false)
            setIsAiSpeaking(false)

            if (intentionalCloseRef.current || e.code === 4001) return
            const delay = backoffRef.current
            backoffRef.current = Math.min(delay * 2, 30000)
            console.log(`[WS] Reconnecting in ${delay}ms...`)
            setTimeout(() => {
                if (!intentionalCloseRef.current) {
                    connect(lastConfigRef.current || {})
                }
            }, delay)
        }
        ws.onerror = (e) => console.error('[WS] Connection error:', e)
    }, [onMessage])

    const disconnect = useCallback(() => {
        console.log('[WS] Disconnecting manually...')
        intentionalCloseRef.current = true
        wsRef.current?.close()
        _stopMicInternal()
    }, [])

    const sendMessage = useCallback((json) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(json))
        } else {
            // Queue instead of dropping so help requests survive reconnects
            pendingMessagesRef.current.push(json)
            console.warn('[WS] sendMessage queued — WS not open')
        }
    }, [])

    // ── Mic capture ───────────────────────────────────────────────

    const startMic = useCallback(async () => {
        if (micActive) return
        console.log('[Mic] Requesting microphone access...')

        try {
            if (!micCtxRef.current) {
                console.log(`[Mic] Creating mic AudioContext at ${MIC_SAMPLE_RATE}Hz`)
                micCtxRef.current = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })
            }
            if (micCtxRef.current.state === 'suspended') {
                await micCtxRef.current.resume()
                console.log('[Mic] AudioContext resumed')
            }

            const ctx = micCtxRef.current
            if (ctx.sampleRate !== MIC_SAMPLE_RATE) {
                console.warn(`[Mic] Browser ignored sampleRate constraint — context runs at ${ctx.sampleRate}Hz, PCM will be downsampled to ${MIC_SAMPLE_RATE}Hz in software`)
            }

            if (!analyserRef.current) {
                const analyser = ctx.createAnalyser()
                analyser.fftSize = 256
                analyserRef.current = analyser
            }

            console.log('[Mic] Calling getUserMedia: channelCount=1, sampleRate=16000')
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: MIC_SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
            })
            micStreamRef.current = stream
            console.log('[Mic] MediaStream acquired:', stream.getTracks()[0].label)

            const source = ctx.createMediaStreamSource(stream)
            source.connect(analyserRef.current)

            const processor = ctx.createScriptProcessor(4096, 1, 1)
            processorRef.current = processor

            processor.onaudioprocess = (e) => {
                let float32 = e.inputBuffer.getChannelData(0)

                // Guarantee 16 kHz PCM even if the browser ignored the
                // sampleRate constraint (ctx ran at 44.1/48 kHz instead)
                if (ctx.sampleRate !== MIC_SAMPLE_RATE) {
                    float32 = _downsample(float32, ctx.sampleRate, MIC_SAMPLE_RATE)
                }

                // Float32 [-1, 1] -> Linear16 PCM for Deepgram Flux
                const int16 = new Int16Array(float32.length)
                for (let i = 0; i < float32.length; i++) {
                    int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)))
                }
                chunkBufRef.current.push(int16.buffer)

                let sum = 0
                for (let i = 0; i < float32.length; i++) sum += float32[i] ** 2
                const rms = Math.sqrt(sum / float32.length)
                setIsUserSpeaking(rms > 0.012)
            }

            // ScriptProcessor must stay wired into the graph to fire, but the
            // mic must NOT reach the speakers — route it through a zero-gain
            // node (direct destination connection causes audible feedback).
            const silentSink = ctx.createGain()
            silentSink.gain.value = 0
            source.connect(processor)
            processor.connect(silentSink)
            silentSink.connect(ctx.destination)

            let loggedFirstChunk = false
            intervalRef.current = setInterval(() => {
                if (!chunkBufRef.current.length) return
                if (wsRef.current?.readyState !== WebSocket.OPEN) return

                const merged = _mergeBuffers(chunkBufRef.current)
                chunkBufRef.current = []
                wsRef.current.send(merged)   // Linear16 PCM binary frame

                if (!loggedFirstChunk) {
                    loggedFirstChunk = true
                    console.log(`[Mic] First PCM chunk sent: ${merged.byteLength} bytes (${MIC_SAMPLE_RATE}Hz linear16 mono)`)
                }
            }, CHUNK_INTERVAL_MS)

            console.log('[Mic] Processing started successfully')
            setMicActive(true)

        } catch (e) {
            console.error('[Mic] Error accessing microphone:', e)
            const guidance =
                e.name === 'NotAllowedError'
                    ? 'Microphone access denied. Allow mic access for this site and try again.'
                    : e.name === 'NotFoundError'
                        ? 'No microphone found. Connect one and try again.'
                        : `Microphone error: ${e.message || e.name}`
            onMessage?.({ type: 'error', text: guidance })
        }
    }, [micActive])

    const stopMic = useCallback(() => {
        console.log('[Mic] Stopping mic...')
        _stopMicInternal()
        setMicActive(false)
        setIsUserSpeaking(false)
    }, [])

    function _stopMicInternal() {
        clearInterval(intervalRef.current)
        processorRef.current?.disconnect()
        micStreamRef.current?.getTracks().forEach((t) => t.stop())
        processorRef.current = null
        micStreamRef.current = null
        chunkBufRef.current = []
    }

    // ── Audio playback (24000Hz — Deepgram Aura-2 linear16 PCM) ──

    /** Create/resume the playback context inside a user gesture (Start
     *  click) so browsers' autoplay policy can't silence AI-first speech. */
    const primeAudio = useCallback(async () => {
        if (!playCtxRef.current) {
            playCtxRef.current = new AudioContext({ sampleRate: PLAY_SAMPLE_RATE })
        }
        if (playCtxRef.current.state === 'suspended') {
            await playCtxRef.current.resume()
        }
    }, [])

    async function _queueAudio(arrayBuffer) {
        // Decode one PCM chunk and schedule it immediately after the
        // previously scheduled chunk on the AudioContext clock — this is
        // what makes the streamed voice gapless.
        if (!playCtxRef.current) {
            playCtxRef.current = new AudioContext({ sampleRate: PLAY_SAMPLE_RATE })
        }
        const ctx = playCtxRef.current
        if (ctx.state === 'suspended') {
            await ctx.resume()
        }

        try {
            const validLength = Math.floor(arrayBuffer.byteLength / 2) * 2
            if (!validLength) return
            const int16 = new Int16Array(arrayBuffer, 0, validLength / 2)
            const float32 = new Float32Array(int16.length)
            for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768

            const audioBuffer = ctx.createBuffer(1, float32.length, PLAY_SAMPLE_RATE)
            audioBuffer.copyToChannel(float32, 0)

            const source = ctx.createBufferSource()
            source.buffer = audioBuffer
            source.connect(ctx.destination)

            // Back-to-back scheduling: never earlier than "now + safety",
            // never overlapping the previous chunk.
            const startTime = Math.max(ctx.currentTime + 0.02, nextStartTimeRef.current)
            nextStartTimeRef.current = startTime + audioBuffer.duration

            pendingSourcesRef.current++
            source.onended = () => {
                pendingSourcesRef.current--
                if (pendingSourcesRef.current === 0 && streamEndedRef.current) {
                    setIsAiSpeaking(false)
                }
            }
            source.start(startTime)
        } catch (err) {
            console.error('[Playback] Error decoding TTS audio:', err)
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    /** Linear-interpolation downsample (e.g. 48 kHz -> 16 kHz). */
    function _downsample(buffer, fromRate, toRate) {
        if (fromRate <= toRate) return buffer
        const ratio = fromRate / toRate
        const newLength = Math.floor(buffer.length / ratio)
        const result = new Float32Array(newLength)
        for (let i = 0; i < newLength; i++) {
            const pos = i * ratio
            const idx = Math.floor(pos)
            const frac = pos - idx
            const next = Math.min(idx + 1, buffer.length - 1)
            result[i] = buffer[idx] * (1 - frac) + buffer[next] * frac
        }
        return result
    }

    function _mergeBuffers(buffers) {
        const totalLength = buffers.reduce((acc, b) => acc + b.byteLength, 0)
        const result = new Uint8Array(totalLength)
        let offset = 0
        for (const buf of buffers) {
            result.set(new Uint8Array(buf), offset)
            offset += buf.byteLength
        }
        return result.buffer
    }

    useEffect(() => () => {
        disconnect()
        micCtxRef.current?.close()
        playCtxRef.current?.close()
    }, [disconnect])

    return {
        connect,
        disconnect,
        startMic,
        stopMic,
        sendMessage,
        primeAudio,
        connected,
        micActive,
        isUserSpeaking,
        isAiSpeaking,
        analyserRef,
    }
}