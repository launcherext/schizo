import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode disabled to prevent double-socket connection in dev
  // or handle cleanup carefully in useEffect (which we did).
  // Keeping it enabled is fine if cleanup is robust.
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
