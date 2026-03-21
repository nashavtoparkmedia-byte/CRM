'use client';

import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
    id: number;
    message: string;
    type: ToastType;
}

interface ToastContextValue {
    showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => { } });

export function useToast() {
    return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = useCallback((message: string, type: ToastType = 'info') => {
        const id = nextId++;
        setToasts((prev) => [...prev, { id, message, type }]);
    }, []);

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            {/* Toast container — portaled to top-right */}
            <div className="fixed top-4 right-4 flex flex-col gap-2" style={{ zIndex: 10000 }}>
                {toasts.map((toast) => (
                    <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
    useEffect(() => {
        const timer = setTimeout(onDismiss, 5000);
        return () => clearTimeout(timer);
    }, [onDismiss]);

    const colors: Record<ToastType, string> = {
        success: 'border-l-green-500 bg-green-50 text-green-900',
        error: 'border-l-red-500 bg-red-50 text-red-900',
        info: 'border-l-blue-500 bg-blue-50 text-blue-900',
    };

    return (
        <div
            className={`flex items-start gap-3 rounded-lg border border-l-4 px-4 py-3 shadow-lg min-w-[320px] max-w-[420px] animate-[slideIn_0.2s_ease-out] ${colors[toast.type]}`}
        >
            <span className="flex-1 text-sm font-medium">{toast.message}</span>
            <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}
