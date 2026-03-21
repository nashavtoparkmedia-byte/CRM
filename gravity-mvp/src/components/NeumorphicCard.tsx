export default function NeumorphicCard({ children, className = '' }: { children: React.ReactNode, className?: string }) {
    return (
        <div className={`bg-[#2b2f3a] rounded-xl shadow-[8px_8px_16px_#1e2129,-8px_-8px_16px_#383d4b] p-6 ${className}`}>
            {children}
        </div>
    )
}
