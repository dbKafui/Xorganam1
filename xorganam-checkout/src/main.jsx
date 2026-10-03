import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { redirectToIsolatedOrigin } from './security/storefrontOrigin'
import './styles/global.css'

redirectToIsolatedOrigin()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
