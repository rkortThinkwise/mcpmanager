import { createTheme } from '@mui/material/styles'

// Brand palette (see PLAN.md "Branding"). The status colours and surfaces
// match wireframe.html's custom properties.
export const brand = {
  blue: '#1D71B8',
  lightBlue: '#38A8E0',
  navy: '#1C52A1',
  ink: '#0A0907',
  border: '#E2E6EC',
  pageBg: '#F3F5F8',
  panelBg: '#FFFFFF',
  windowBg: '#F3F5F8',
  textSecondary: '#6B7280',
  textMuted: '#9AA0A6',
  success: '#1E7A3C',
  successBg: '#E7F4EC',
  warn: '#B4650A',
  warnBg: '#FCEEDD',
  danger: '#C62828',
  dangerBg: '#FBE9E9',
  errorBg: '#FBE9E9',
  chipBg: '#EEF2F7',
  chipInk: '#3C4656',
  hoverBg: '#EEF4FA',
  mono: "'SFMono-Regular', Consolas, Menlo, monospace",
  shadow: '0 1px 2px rgba(10,9,7,0.06), 0 4px 14px rgba(10,9,7,0.05)',
  shadowHover: '0 1px 2px rgba(10,9,7,0.06), 0 6px 18px rgba(29,113,184,0.12)'
}

// Card border + badge colours keyed by connection status, so the dot, the badge
// and the label can never disagree about what a status looks like.
//
// `scope_drift` is blue rather than amber on purpose: it's an advisory (the
// connection still works, the server just offers a different scope set now),
// while amber `warn` means access is actually broken until you reauthorize.
// Giving both the same colour would flatten that difference.
export const statusMeta = {
  connected: { color: brand.success, bg: brand.successBg, label: 'Connected' },
  scope_drift: { color: brand.blue, bg: '#E7F0F9', label: 'Scope refresh needed' },
  warn: { color: brand.warn, bg: brand.warnBg, label: 'Needs reauthorization' },
  error: { color: brand.danger, bg: brand.dangerBg, label: 'Error' },
  // Neutral grey: a disabled connection isn't a problem to fix, it's just off.
  disabled: { color: '#6B7280', bg: '#EEF2F7', label: 'Disabled' }
}

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: brand.blue, dark: brand.navy, light: brand.lightBlue },
    secondary: { main: brand.lightBlue },
    success: { main: brand.success },
    error: { main: brand.danger },
    warning: { main: brand.warn },
    background: { default: brand.pageBg, paper: brand.panelBg },
    text: { primary: brand.ink, secondary: brand.textSecondary },
    divider: brand.border
  },
  typography: {
    fontFamily: 'Roboto, Arial, sans-serif',
    h5: { fontWeight: 500 },
    h6: { fontWeight: 500 },
    button: { textTransform: 'none', fontWeight: 500 }
  },
  shape: { borderRadius: 8 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { borderRadius: 6, height: 38, paddingInline: 20 } }
    },
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: 'none' } }
    },
    // Required-field asterisks are red everywhere, including while the field is
    // focused or in an error state (MUI otherwise tints them with the label).
    MuiFormLabel: {
      styleOverrides: {
        asterisk: {
          color: '#C5221F',
          '&.Mui-error': { color: '#C5221F' }
        }
      }
    },
    MuiInputLabel: {
      styleOverrides: {
        asterisk: {
          color: '#C5221F',
          '&.Mui-error': { color: '#C5221F' }
        }
      }
    }
  }
})

export default theme
