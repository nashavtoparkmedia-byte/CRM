'use client';

import { Button } from '@/components/ui/button';

interface ActionButtonsProps {
    driverId: string;
    phone: string | null;
    licenseNumber: string | null;
    checksLimitReached: boolean;
    lastFleetCheckStatus: string | null;
    showResolve?: boolean;
    onCall: (driverId: string) => void;
    onMessage: (driverId: string) => void;
    onFleetCheck: (driverId: string) => void;
    onResolve?: (driverId: string) => void;
}

export function ActionButtons({
    driverId,
    phone,
    checksLimitReached,
    lastFleetCheckStatus,
    showResolve = false,
    onCall,
    onMessage,
    onFleetCheck,
    onResolve,
}: ActionButtonsProps) {
    const isFleetCheckDisabled = checksLimitReached;

    return (
        <div className="flex items-center gap-1">
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                title="Позвонить"
                onClick={(e) => {
                    e.stopPropagation();
                    if (phone) {
                        window.open(`tel:${phone}`, '_self');
                    }
                    onCall(driverId);
                }}
                disabled={!phone}
            >
                📞
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                title="Написать в Telegram"
                onClick={(e) => {
                    e.stopPropagation();
                    onMessage(driverId);
                }}
            >
                💬
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                title={isFleetCheckDisabled ? 'Проверка уже идёт или лимит достигнут' : 'Проверить Fleet'}
                onClick={(e) => {
                    e.stopPropagation();
                    onFleetCheck(driverId);
                }}
                disabled={isFleetCheckDisabled}
            >
                🔎
            </Button>
            {showResolve && onResolve && (
                <>
                    <span className="mx-1 text-muted-foreground">│</span>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-green-600 hover:text-green-700"
                        title="Закрыть задачу"
                        onClick={(e) => {
                            e.stopPropagation();
                            onResolve(driverId);
                        }}
                    >
                        ✓
                    </Button>
                </>
            )}
        </div>
    );
}
