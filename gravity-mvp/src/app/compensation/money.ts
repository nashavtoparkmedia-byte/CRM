/** Kopecks as a manager reads them. Formatting only: no money is decided here. */
export function rublesFromKopecks(kopecks: number): string {
    return `${(kopecks / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
}

export const MANAGER_STATE_LABELS: Record<string, string> = {
    new: 'Новая',
    awaiting_payment: 'Ждёт выплаты',
    reconciliation: 'Требует сверки',
    paid: 'Выплачена',
    rejected: 'Отклонена',
}
