// ═══════════════════════════════════════════════════════════════════
// Minimal in-memory toast store — used for inline action feedback.
// Not persisted. No dependencies beyond zustand.
// ═══════════════════════════════════════════════════════════════════

import { create } from 'zustand'

export type ToastKind = 'error' | 'success' | 'info'

export interface Toast {
    id: string
    text: string
    kind: ToastKind
}

interface ToastState {
    items: Toast[]
    push: (text: string, kind?: ToastKind) => string
    dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
    items: [],
    push: (text, kind = 'info') => {
        const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        set((s) => ({ items: [...s.items, { id, text, kind }] }))
        // Auto-dismiss after 3s
        setTimeout(() => get().dismiss(id), 3000)
        return id
    },
    dismiss: (id) =>
        set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

export function pushToast(text: string, kind: ToastKind = 'info'): string {
    return useToastStore.getState().push(text, kind)
}
