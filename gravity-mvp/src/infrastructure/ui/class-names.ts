import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Shared technical class-name composition with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
