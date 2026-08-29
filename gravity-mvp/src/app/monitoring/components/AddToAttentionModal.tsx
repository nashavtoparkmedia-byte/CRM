'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/infrastructure/ui/button';
import { Input } from '@/infrastructure/ui/input';
import { X } from 'lucide-react';

interface AddToAttentionModalProps {
    driverName: string;
    onSubmit: (reason: string, riskLevel: string) => void;
    onClose: () => void;
}

const riskOptions = [
    { value: 'low', label: '🟢 Низкий', color: '#22c55e' },
    { value: 'medium', label: '🟡 Средний', color: '#eab308' },
    { value: 'high', label: '🔴 Высокий', color: '#ef4444' },
];

export function AddToAttentionModal({ driverName, onSubmit, onClose }: AddToAttentionModalProps) {
    const [reason, setReason] = useState('');
    const [riskLevel, setRiskLevel] = useState('medium');
    const [loading, setLoading] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        return () => setMounted(false);
    }, []);

    const handleSubmit = async () => {
        if (!reason.trim()) return;
        setLoading(true);
        try {
            await onSubmit(reason.trim(), riskLevel);
        } finally {
            setLoading(false);
        }
    };

    const modal = (
        <div
            className="fixed inset-0 flex items-center justify-center"
            style={{ zIndex: 9999, backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
            onClick={onClose}
        >
            <div
                className="w-full max-w-md rounded-xl bg-white p-6 border"
                style={{ boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-[4px]">
                    <h3 className="text-lg font-semibold text-gray-900">Добавить в наблюдение</h3>
                    <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
                        <X className="h-[4px] w-[4px]" />
                    </Button>
                </div>
                <p className="text-sm text-gray-500 mb-[4px]">
                    Водитель: <strong className="text-gray-900">{driverName}</strong>
                </p>
                <Input
                    placeholder="Причина (например: подозрение на сторонний парк)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="mb-[4px]"
                    autoFocus
                />
                <div className="mb-[4px]">
                    <label className="text-sm font-medium mb-[2px] block text-gray-700">Уровень риска</label>
                    <div className="flex gap-[2px]">
                        {riskOptions.map((opt) => (
                            <button
                                key={opt.value}
                                onClick={() => setRiskLevel(opt.value)}
                                className="flex-1 rounded-lg px-3 py-[2px] text-sm font-medium transition-colors"
                                style={{
                                    border: `2px solid ${riskLevel === opt.value ? opt.color : 'transparent'}`,
                                    backgroundColor: riskLevel === opt.value ? '#f5f5f5' : 'transparent',
                                }}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex justify-end gap-[2px]">
                    <Button variant="outline" onClick={onClose}>Отмена</Button>
                    <Button onClick={handleSubmit} disabled={!reason.trim() || loading}>
                        {loading ? 'Сохранение...' : 'Добавить'}
                    </Button>
                </div>
            </div>
        </div>
    );

    if (!mounted) return null;
    return createPortal(modal, document.body);
}
