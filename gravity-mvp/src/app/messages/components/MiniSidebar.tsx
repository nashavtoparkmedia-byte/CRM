import { ArrowLeft, User } from "lucide-react"
import Link from "next/link"

export default function MiniSidebar() {
    return (
        <div className="w-[56px] bg-[#F9FAFB] border-r border-[#ECECEC] flex flex-col items-center py-3 shrink-0 h-full">
            <Link 
                href="/" 
                className="w-8 h-8 rounded flex items-center justify-center text-gray-500 hover:bg-gray-200/60 hover:text-gray-900 transition-colors"
                title="Назад в CRM"
            >
                <ArrowLeft size={18} />
            </Link>
            
            <div className="mt-auto pb-1">
                <div className="w-7 h-7 rounded-full bg-gray-200/50 flex items-center justify-center text-gray-500">
                    <User size={14} />
                </div>
            </div>
        </div>
    )
}
