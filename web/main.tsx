import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import EditorApp from './EditorApp'
import './style.css'
import { initTheme } from './theme'

// Apply the resolved theme to <html data-theme> before the first paint, so a
// stored light preference never flashes the dark default. EditorApp's useTheme
// keeps the attribute in sync from here on.
initTheme()

const root = createRoot(document.getElementById('app')!)
root.render(
  <StrictMode>
    <EditorApp />
  </StrictMode>
)
