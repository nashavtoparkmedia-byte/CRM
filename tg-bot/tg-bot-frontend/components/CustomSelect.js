import { useState, useRef, useEffect } from 'react';

/**
 * CustomSelect — кастомный дропдаун в стиле Neumorphism.
 *
 * Props:
 *  - value        (string)   — текущее значение
 *  - onChange     (fn)       — (value: string) => void
 *  - options      (array)    — [{ value, label, className? }]
 *  - placeholder  (string)   — текст при пустом значении
 *  - className    (string)   — доп. классы для обёртки
 *  - compact      (bool)     — уменьшенный вид (py-1.5 px-3 text-sm)
 */
export default function CustomSelect({
    value,
    onChange,
    options = [],
    placeholder = 'Выберите...',
    className = '',
    compact = false,
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    // Закрыть при клике вне компонента
    useEffect(() => {
        function handleClickOutside(e) {
            if (ref.current && !ref.current.contains(e.target)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selected = options.find(o => String(o.value) === String(value));
    const displayLabel = selected ? selected.label : placeholder;

    const handleSelect = (optValue) => {
        onChange(optValue);
        setOpen(false);
    };

    const triggerPy = compact ? 'py-1.5' : 'py-2.5';
    const triggerPx = compact ? 'px-3' : 'px-4';
    const triggerText = compact ? 'text-sm' : 'text-sm';

    return (
        <div ref={ref} className={`relative ${className}`}>
            {/* Trigger Button */}
            <button
                type="button"
                onClick={() => setOpen(prev => !prev)}
                className={`
          w-full flex items-center justify-between gap-3
          ${triggerPx} ${triggerPy} ${triggerText}
          bg-neu-base shadow-neu-inner border border-black/20 rounded-xl
          font-medium text-slate-300 hover:text-white
          focus:outline-none focus:ring-1 focus:ring-neu-accent focus:shadow-neu-glow
          transition-all duration-200 cursor-pointer select-none
          ${open ? 'ring-1 ring-neu-accent shadow-neu-glow text-white' : ''}
        `}
            >
                <span className="truncate">{displayLabel}</span>
                {/* Chevron */}
                <svg
                    className={`w-4 h-4 flex-shrink-0 text-slate-500 transition-transform duration-300 ${open ? 'rotate-180 text-neu-accent' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {/* Dropdown Panel */}
            {open && (
                <div
                    className={`
            absolute z-50 mt-2 w-full min-w-max
            bg-neu-base border border-white/[0.05]
            rounded-xl overflow-hidden
            shadow-[8px_8px_20px_#1a1d21,-4px_-4px_12px_#3d424b]
            animate-in fade-in slide-in-from-top-2 duration-150
          `}
                >
                    {options.map((opt, idx) => {
                        const isSelected = String(opt.value) === String(value);
                        return (
                            <button
                                key={opt.value ?? idx}
                                type="button"
                                onClick={() => handleSelect(opt.value)}
                                className={`
                  w-full text-left px-4 py-2.5 text-sm font-medium
                  flex items-center gap-3 transition-all duration-150
                  ${isSelected
                                        ? 'bg-neu-accent/10 text-neu-accent border-l-2 border-neu-accent'
                                        : 'text-slate-300 hover:bg-white/[0.04] hover:text-white border-l-2 border-transparent'
                                    }
                  ${opt.className || ''}
                `}
                            >
                                {/* Active indicator dot */}
                                {isSelected && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-neu-accent shadow-[0_0_6px_rgba(0,240,255,0.8)] flex-shrink-0" />
                                )}
                                <span className={isSelected ? '' : 'ml-[calc(0.375rem+2px)]'}>{opt.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
