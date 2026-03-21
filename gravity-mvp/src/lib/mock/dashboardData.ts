import { Car, AlertTriangle, RefreshCcw, Phone, Archive, Gift, UserPlus, PieChart } from "lucide-react";

export const dashboardCards = [
  {
    title: "Активные водители",
    description: "Активные в Яндекс",
    metric: 126,
    icon: Car,
    href: "/drivers?segment=active",
    breakdown: [
      { label: "Прибыльные", value: 32 },
      { label: "Средние", value: 61 },
      { label: "Малые", value: 33 }
    ]
  },
  {
    title: "Отток / Риски",
    description: "В риске ухода",
    metric: 14,
    icon: AlertTriangle,
    href: "/drivers/monitoring?filter=risk",
    breakdown: [
      { label: "Падение поездок", value: "—" },
      { label: "Давно не на линии", value: "—" },
      { label: "Новый парк рядом", value: "—" },
      { label: "Закончилась акция", value: "—" }
    ]
  },
  {
    title: "Требуют контакта",
    description: "Нужно связаться",
    metric: 9,
    icon: Phone,
    href: "/drivers?filter=contact",
    breakdown: [
      { label: "Риск ухода", value: 3 },
      { label: "Падение активности", value: 2 },
      { label: "Акция", value: 2 },
      { label: "Давно не общались", value: 2 }
    ]
  },
  {
    title: "Реактивация",
    description: "Вернули водителей",
    metric: 11,
    icon: RefreshCcw,
    href: "/drivers?filter=reactivated",
    breakdown: [
      { label: "Были неактивны 7 дней", value: 5 },
      { label: "Были неактивны 14 дней", value: 4 },
      { label: "Были неактивны 30 дней", value: 2 }
    ]
  },
  {
    title: "Подключение / Лиды",
    description: "Новые лиды",
    metric: 18,
    icon: UserPlus,
    href: "/leads",
    breakdown: [
      { label: "Новые", value: 7 },
      { label: "В работе", value: 8 },
      { label: "Подключены", value: 3 }
    ]
  },
  {
    title: "Акции / Конверсии",
    description: "Активные акции",
    metric: 3,
    icon: Gift,
    href: "/promotions",
    breakdown: [
      { label: "Получили", value: 27 },
      { label: "Активировали", value: 15 },
      { label: "Не использовали", value: 12 }
    ]
  },
  {
    title: "LTV водителей",
    description: "Средний LTV",
    metric: "48 200 ₽",
    icon: PieChart,
    href: "/analytics",
    breakdown: [
      { label: "Топ водители", value: 12 },
      { label: "Средние", value: 74 },
      { label: "Низкий LTV", value: 40 }
    ]
  },
  {
    title: "Архив / Ушедшие водители",
    description: "В архиве",
    metric: 64,
    icon: Archive,
    href: "/drivers/archive",
    breakdown: [
      { label: "Ушли из Яндекс", value: 21 },
      { label: "Неактивны > 60 дней", value: 31 },
      { label: "Заблокированы", value: 12 }
    ]
  }
];
