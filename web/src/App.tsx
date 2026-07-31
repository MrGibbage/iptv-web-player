import { useEffect, useState } from 'react'

function App() {
  const [apiStatus, setApiStatus] = useState<'checking' | 'ok' | 'error'>('checking')

  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? setApiStatus('ok') : setApiStatus('error')))
      .catch(() => setApiStatus('error'))
  }, [])

  return (
    <main>
      <h1>iptv-web-player</h1>
      <p>Live TV / EPG / VOD / Series web player — scaffold in progress.</p>
      <p>API status: {apiStatus}</p>
    </main>
  )
}

export default App
