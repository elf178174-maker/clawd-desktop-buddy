import { createRoot } from 'react-dom/client'
import '../shared/theme.css'
import './panel.css'
import { ErrorBoundary } from '../shared/ui'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
