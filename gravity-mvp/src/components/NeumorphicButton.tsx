'use client'

import { ButtonHTMLAttributes } from 'react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'danger'
}

export default function NeumorphicButton({ children, className, variant = 'primary', ...props }: Props) {
    const baseStyles = 'px-6 py-2 rounded-lg font-semibold transition-all duration-200 ease-in-out select-none active:scale-95'

    const variants = {
        primary: 'bg-[#2b2f3a] text-blue-400 shadow-[5px_5px_10px_#1e2129,-5px_-5px_10px_#383d4b] hover:shadow-[2px_2px_5px_#1e2129,-2px_-2px_5px_#383d4b] active:shadow-[inset_4px_4px_8px_#1e2129,inset_-4px_-4px_8px_#383d4b]',
        secondary: 'bg-[#2b2f3a] text-gray-300 shadow-[5px_5px_10px_#1e2129,-5px_-5px_10px_#383d4b] hover:shadow-[2px_2px_5px_#1e2129,-2px_-2px_5px_#383d4b] active:shadow-[inset_4px_4px_8px_#1e2129,inset_-4px_-4px_8px_#383d4b]',
        danger: 'bg-[#2b2f3a] text-red-400 shadow-[5px_5px_10px_#1e2129,-5px_-5px_10px_#383d4b] hover:shadow-[2px_2px_5px_#1e2129,-2px_-2px_5px_#383d4b] active:shadow-[inset_4px_4px_8px_#1e2129,inset_-4px_-4px_8px_#383d4b]',
    }

    return (
        <button className={twMerge(clsx(baseStyles, variants[variant], className))} {...props}>
            {children}
        </button>
    )
}
