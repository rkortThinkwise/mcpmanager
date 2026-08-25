import { Box, Typography } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import { STEPS } from '../../state/WizardContext'
import { brand } from '../../theme'

/**
 * Numbered step dots joined by a connecting line: done turns green with a
 * checkmark, active turns blue (wireframe.html, `.stepper`).
 */
export default function WizardStepper({ current }) {
  return (
    <Box
      sx={{
        display: 'flex',
        gap: 0.5,
        px: 5,
        pt: 2,
        maxWidth: 760,
        mx: 'auto',
        width: '100%'
      }}
    >
      {STEPS.map((s, i) => {
        const done = s.n < current
        const active = s.n === current
        const dotBg = done ? brand.success : active ? brand.blue : '#DCE3EA'
        const dotColor = done || active ? '#fff' : '#8A94A3'

        return (
          <Box
            key={s.n}
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.75,
              pb: 1.75,
              position: 'relative'
            }}
          >
            {i > 0 && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 11,
                  left: '-50%',
                  width: '100%',
                  height: 2,
                  bgcolor: done || active ? brand.blue : '#DCE3EA',
                  zIndex: 0
                }}
              />
            )}
            <Box
              sx={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                bgcolor: dotBg,
                color: dotColor,
                fontSize: 11,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1
              }}
            >
              {done ? <CheckIcon sx={{ fontSize: 13 }} /> : s.n}
            </Box>
            <Typography
              sx={{
                fontSize: 9.5,
                lineHeight: 1.15,
                textAlign: 'center',
                color: active ? brand.blue : brand.textSecondary,
                fontWeight: active ? 600 : 400
              }}
            >
              {s.title}
            </Typography>
          </Box>
        )
      })}
    </Box>
  )
}
