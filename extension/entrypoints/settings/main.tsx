import React from 'react'
import { createRoot } from 'react-dom/client'
import { OptionsApp } from '../../src/OptionsApp'
import '../../src/styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>,
)
