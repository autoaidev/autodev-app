import React from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from '@renderer/ui'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {/* Last-resort full-app fallback: per-view boundaries in App.tsx contain most
        crashes, but a throw in the shell itself lands here instead of a blank window. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
