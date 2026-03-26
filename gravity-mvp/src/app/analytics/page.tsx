import { SectionDescription } from '@/components/ui/SectionDescription'

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-6 h-full animate-in fade-in duration-500">
      <SectionDescription sectionKey="analytics_ltv" />
      <div className="flex-1 flex items-center justify-center min-h-[50vh]">
        <div className="text-center mb-16">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Аналитика LTV</h1>
          <p className="mt-2 text-muted-foreground">В разработке (Coming soon)</p>
        </div>
      </div>
    </div>
  )
}
