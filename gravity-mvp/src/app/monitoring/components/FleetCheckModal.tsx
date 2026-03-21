'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X } from 'lucide-react';

interface FleetCheckModalProps {
    driverName: string;
    onSubmit: (licenseNumber: string) => void;
    onClose: () => void;
}

export function FleetCheckModal({ driverName, onSubmit, onClose }: FleetCheckModalProps) {
    const [license, setLicense] = useState('');
    const [loading, setLoading] = useState(false);
    const [mounted, setMounted] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setMounted(true);
        return () => setMounted(false);
    }, []);

    useEffect(() => {
        if (mounted && inputRef.current) {
            inputRef.current.focus();
        }
    }, [mounted]);

    const handleSubmit = async () => {
        if (!license.trim()) return;
        setLoading(true);
        try {
            await onSubmit(license.trim());
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
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Проверка Fleet</h3>
                    <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
                        <X className="h-4 w-4" />
                    </Button>
                </div>
                <p className="text-sm text-gray-500 mb-4">
                    Введите номер ВУ для водителя <strong className="text-gray-900">{driverName}</strong>
                </p>
                <Input
                    ref={inputRef}
                    placeholder="Номер водительского удостоверения"
                    value={license}
                    onChange={(e) => setLicense(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                    className="mb-4"
                />
                <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose}>Отмена</Button>
                    <Button onClick={handleSubmit} disabled={!license.trim() || loading}>
                        {loading ? 'Запуск...' : 'Проверить'}
                    </Button>
                </div>
            </div>
        </div>
    );

    if (!mounted) return null;
    return createPortal(modal, document.body);
}
