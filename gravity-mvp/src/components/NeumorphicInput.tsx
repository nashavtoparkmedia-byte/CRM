import { InputHTMLAttributes } from 'react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

interface Props extends InputHTMLAttributes<HTMLInputElement> {
    label?: string
}

export default function NeumorphicInput({ label, className, ...props }: Props) {
    return (
        <div className="flex flex-col gap-2 w-full">
            {label && <label className="text-sm text-gray-400 ml-1">{label}</label>}
            <input
                className={twMerge(
                    clsx(
                        'bg-[#2b2f3a] text-gray-200 px-4 py-3 rounded-lg outline-none',
                        'shadow-[inset_4px_4px_8px_#1e2129,inset_-4px_-4px_8px_#383d4b]',
                        'focus:shadow-[inset_6px_6px_10px_#1e2129,inset_-6px_-6px_10px_#383d4b] transition-shadow w-full',
                        className
                    )
                )}
                {...props}
            />
        </div>
    )
}
