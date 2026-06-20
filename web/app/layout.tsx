import type {Metadata} from 'next'
import type {ReactNode} from 'react'

import './globals.css'
import {ThemeProvider} from '../components/theme-provider'

export const metadata: Metadata = {
  description: 'Browse and run sdkck commands from your browser',
  title: 'sdkck web UI',
}

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
