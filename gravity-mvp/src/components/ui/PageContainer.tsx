import React from 'react'

export function PageContainer({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <main
      className="
        px-6
        py-6
        max-w-[1400px]
        mx-auto
        w-full
      "
    >
      {children}
    </main>
  )
}
