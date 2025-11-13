import { useEffect, useMemo, useRef, useState } from 'react'

function App() {
  const [roomId, setRoomId] = useState(() => new URLSearchParams(window.location.search).get('room') || generateRoomId())
  const [connected, setConnected] = useState(false)
  const [wsStatus, setWsStatus] = useState('disconnected')
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [messages, setMessages] = useState([])

  const wsRef = useRef(null)
  const localVideoRef = useRef(null)
  const localStreamRef = useRef(null)
  const screenStreamRef = useRef(null)
  const peerId = useMemo(() => (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)), [])
  const peersRef = useRef(new Map()) // peerId -> { pc, stream, videoEl }

  const backendBase = useMemo(() => {
    const base = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'
    return base.replace(/\/$/, '')
  }, [])

  const wsUrl = useMemo(() => {
    const wsBase = backendBase.replace('http://', 'ws://').replace('https://', 'wss://')
    return `${wsBase}/ws/${encodeURIComponent(roomId)}`
  }, [backendBase, roomId])

  useEffect(() => {
    // Attach local stream to video element
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current
    }
  }, [connected])

  async function getMedia() {
    if (localStreamRef.current) return localStreamRef.current
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    localStreamRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream
    return stream
  }

  function addMessage(text) {
    setMessages((m) => [{ id: Date.now() + Math.random(), text }, ...m].slice(0, 50))
  }

  function createPeerConnection(targetId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478?transport=udp' },
      ],
    })

    // Send our ICE candidates to the peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWS({ type: 'ice', target: targetId, sender: peerId, candidate: event.candidate })
      }
    }

    // When tracks arrive, attach to (or create) a video element
    pc.ontrack = (event) => {
      const stream = event.streams[0]
      let info = peersRef.current.get(targetId)
      if (!info) {
        const videoEl = document.createElement('video')
        videoEl.autoplay = true
        videoEl.playsInline = true
        videoEl.muted = false
        info = { pc, stream, videoEl }
        peersRef.current.set(targetId, info)
        attachRemoteVideo(targetId)
      } else {
        info.stream = stream
      }
    }

    // Add our local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current))
    }

    // Store
    const prev = peersRef.current.get(targetId)
    const info = { pc, stream: prev?.stream || null, videoEl: prev?.videoEl || null }
    peersRef.current.set(targetId, info)
    return pc
  }

  function attachRemoteVideo(targetId) {
    // Re-render remote grid by forcing state update via messages
    setMessages((m) => [...m])
  }

  function removePeer(targetId) {
    const info = peersRef.current.get(targetId)
    if (info) {
      try { info.pc.close() } catch {}
      peersRef.current.delete(targetId)
      setMessages((m) => [...m])
    }
  }

  function sendWS(payload) {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload))
    }
  }

  async function handleJoin() {
    try {
      await getMedia()
    } catch (e) {
      alert('Could not access camera/microphone. Please allow permissions.')
      return
    }

    // Update URL with room param
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomId)
    window.history.replaceState({}, '', url.toString())

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setWsStatus('connected')
      addMessage('Connected to signaling server')
      sendWS({ type: 'join', sender: peerId })
      setConnected(true)
    }
    ws.onclose = () => {
      setWsStatus('disconnected')
      addMessage('Disconnected from signaling server')
      setConnected(false)
      // Cleanup peers
      for (const id of Array.from(peersRef.current.keys())) removePeer(id)
    }
    ws.onerror = () => {
      setWsStatus('error')
      addMessage('Signaling error')
    }
    ws.onmessage = async (evt) => {
      let msg
      try {
        msg = JSON.parse(evt.data)
      } catch {
        return
      }
      const { type, sender, target } = msg
      if (sender === peerId) return // ignore our own

      switch (type) {
        case 'join': {
          // A new peer joined; create offer as initiator
          const pc = createPeerConnection(sender)
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendWS({ type: 'offer', sender: peerId, target: sender, sdp: offer })
          break
        }
        case 'offer': {
          if (target !== peerId) return
          let info = peersRef.current.get(sender)
          const pc = info?.pc || createPeerConnection(sender)
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          sendWS({ type: 'answer', sender: peerId, target: sender, sdp: answer })
          break
        }
        case 'answer': {
          if (target !== peerId) return
          const info = peersRef.current.get(sender)
          if (!info) return
          await info.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          break
        }
        case 'ice': {
          if (target !== peerId) return
          const info = peersRef.current.get(sender)
          if (!info) return
          try {
            await info.pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          } catch (e) {
            console.warn('ICE add error', e)
          }
          break
        }
        default:
          break
      }
    }
  }

  async function handleLeave() {
    if (wsRef.current) {
      try { wsRef.current.close() } catch {}
      wsRef.current = null
    }
    for (const [id, info] of peersRef.current.entries()) {
      try { info.pc.close() } catch {}
    }
    peersRef.current.clear()
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }
    if (localStreamRef.current) {
      // Keep local stream for quick reconnect but stop if user leaves room
      localStreamRef.current.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
    }
    setConnected(false)
    setSharing(false)
  }

  function toggleMic() {
    if (!localStreamRef.current) return
    localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = !t.enabled))
    const enabled = localStreamRef.current.getAudioTracks().some((t) => t.enabled)
    setMicOn(enabled)
  }

  function toggleCam() {
    if (!localStreamRef.current) return
    localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = !t.enabled))
    const enabled = localStreamRef.current.getVideoTracks().some((t) => t.enabled)
    setCamOn(enabled)
  }

  async function toggleScreenShare() {
    if (!sharing) {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        screenStreamRef.current = screen
        const screenTrack = screen.getVideoTracks()[0]
        replaceVideoTrack(screenTrack)
        screenTrack.onended = () => {
          // Revert to camera when user stops sharing
          if (localStreamRef.current) {
            const camTrack = localStreamRef.current.getVideoTracks()[0]
            if (camTrack) replaceVideoTrack(camTrack)
            setSharing(false)
          }
        }
        setSharing(true)
      } catch (e) {
        console.warn('Screen share error', e)
      }
    } else {
      // Stop screen and switch back to camera
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop())
        screenStreamRef.current = null
      }
      if (localStreamRef.current) {
        const camTrack = localStreamRef.current.getVideoTracks()[0]
        if (camTrack) replaceVideoTrack(camTrack)
      }
      setSharing(false)
    }
  }

  function replaceVideoTrack(newTrack) {
    // Update our local preview
    if (localVideoRef.current) {
      const stream = localVideoRef.current.srcObject
      if (stream) {
        const [oldTrack] = stream.getVideoTracks()
        if (oldTrack) stream.removeTrack(oldTrack)
        stream.addTrack(newTrack)
        localVideoRef.current.srcObject = stream
      }
    }
    // Replace track in each RTCRtpSender
    for (const [, info] of peersRef.current.entries()) {
      const sender = info.pc.getSenders().find((s) => s.track && s.track.kind === 'video')
      if (sender) {
        try { sender.replaceTrack(newTrack) } catch {}
      }
    }
  }

  function copyInvite() {
    const url = `${window.location.origin}?room=${encodeURIComponent(roomId)}`
    navigator.clipboard.writeText(url)
    addMessage('Invite link copied!')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="px-6 py-4 border-b bg-white flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold">VM</div>
          <div>
            <h1 className="text-xl font-semibold text-gray-800">Web Meeting</h1>
            <p className="text-xs text-gray-500">Simple video, audio, and screen share</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="border rounded px-3 py-2 text-sm w-56"
            placeholder="Enter room ID"
            disabled={connected}
          />
          {!connected ? (
            <button onClick={handleJoin} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
              Join
            </button>
          ) : (
            <button onClick={handleLeave} className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded">
              Leave
            </button>
          )}
          <button onClick={copyInvite} className="border px-3 py-2 rounded text-sm">Copy invite</button>
        </div>
      </header>

      <main className="p-4 grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3">
          {/* Video Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
              <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
              <div className="absolute top-2 left-2 text-xs text-white bg-black/50 px-2 py-1 rounded">You ({micOn ? 'Mic on' : 'Mic off'} • {camOn ? 'Cam on' : 'Cam off'})</div>
            </div>
            {Array.from(peersRef.current.entries()).map(([id, info]) => (
              <div key={id} className="relative rounded-lg overflow-hidden bg-black aspect-video">
                <video
                  ref={(el) => {
                    if (!el) return
                    if (info.videoEl !== el) info.videoEl = el
                    if (info.videoEl && info.stream) info.videoEl.srcObject = info.stream
                  }}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-2 left-2 text-xs text-white bg-black/50 px-2 py-1 rounded">Peer {id.slice(0, 5)}</div>
              </div>
            ))}
          </div>

          {/* Controls */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={toggleMic} disabled={!connected} className={`px-4 py-2 rounded text-white ${micOn ? 'bg-gray-700' : 'bg-gray-400'}`}>{micOn ? 'Mute' : 'Unmute'}</button>
            <button onClick={toggleCam} disabled={!connected} className={`px-4 py-2 rounded text-white ${camOn ? 'bg-gray-700' : 'bg-gray-400'}`}>{camOn ? 'Stop Cam' : 'Start Cam'}</button>
            <button onClick={toggleScreenShare} disabled={!connected} className={`px-4 py-2 rounded text-white ${sharing ? 'bg-orange-600' : 'bg-blue-600'}`}>{sharing ? 'Stop Share' : 'Share Screen'}</button>
            <span className="text-sm text-gray-500 ml-2">Signal: {wsStatus}</span>
          </div>
        </div>

        {/* Activity / debug */}
        <aside className="lg:col-span-1 bg-white border rounded-lg p-4 h-[70vh] overflow-auto">
          <h3 className="font-semibold mb-2">Activity</h3>
          <ul className="space-y-1 text-sm text-gray-600">
            {messages.map((m) => (
              <li key={m.id} className="border-b pb-1">{m.text}</li>
            ))}
          </ul>
          <div className="mt-4 text-xs text-gray-400 break-words">Room: {roomId}</div>
          <div className="text-xs text-gray-400 break-words">Backend: {backendBase}</div>
        </aside>
      </main>
    </div>
  )
}

function generateRoomId() {
  const rand = () => Math.random().toString(36).slice(2, 6)
  return `${rand()}-${rand()}`
}

export default App
