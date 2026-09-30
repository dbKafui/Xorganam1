import React from 'react'
import ReactDOM from 'react-dom/client'
import { InstitutionAuthProvider } from './context/InstitutionAuthContext.jsx'
import App from './App.jsx'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <InstitutionAuthProvider>
      <App />
    </InstitutionAuthProvider>
  </React.StrictMode>
)
