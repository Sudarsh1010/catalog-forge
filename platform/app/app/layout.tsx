import { Geist, Geist_Mono, Lora } from "next/font/google"

import "@workspace/ui/globals.css"
import { EvlogProvider } from "evlog/next/client"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@workspace/ui/lib/utils"

const loraHeading = Lora({ subsets: ["latin"], variable: "--font-heading" })

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable,
        loraHeading.variable
      )}
    >
      <body>
        <EvlogProvider service="web" transport={{ enabled: false }}>
          <ThemeProvider>{children}</ThemeProvider>
        </EvlogProvider>
      </body>
    </html>
  )
}
