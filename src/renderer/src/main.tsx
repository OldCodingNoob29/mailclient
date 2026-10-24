import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/app.css'

/*
  Dateien, die nicht dort landen, wo sie jemand annimmt - also ausserhalb des
  Verfassen-Dialogs -, sollen nichts tun: Zeiger "nicht erlaubt", kein Versuch,
  zur Datei zu navigieren. Was der Dialog schon angenommen hat, erkennt man an
  defaultPrevented; das bleibt unberuehrt.
*/
window.addEventListener('dragover', (event) => {
  if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'none'
})
window.addEventListener('drop', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
})

const container = document.getElementById('root')
if (!container) throw new Error('Wurzelelement nicht gefunden.')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
