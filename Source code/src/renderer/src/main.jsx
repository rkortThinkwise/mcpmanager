import React from 'react'
import ReactDOM from 'react-dom/client'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import theme from './theme'
import { ConnectionsProvider } from './state/ConnectionsContext'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ConnectionsProvider>
        <App />
      </ConnectionsProvider>
    </ThemeProvider>
  </React.StrictMode>
)
