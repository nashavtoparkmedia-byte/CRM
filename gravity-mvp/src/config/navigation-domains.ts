import {
    LayoutDashboard, Users, UserPlus, ShieldAlert, MessageSquare, UserCog, ToggleRight, ListRestart,
    Gift, CheckSquare, Database, BarChart3, Settings,
    IdCard, Activity, Archive, Clock, UserCheck, AlertCircle,
    TrendingDown, Ban, Eye, MessageCircle, Bot, FileText,
    Timer, History, BarChart2, Phone, Smartphone, Key, CarFront, Link2,
    Megaphone, Filter, PieChart, LucideIcon, Cpu
} from "lucide-react";

export type NavigationItem = {
    label: string;
    href: string;
    icon: LucideIcon;
    sectionKey: string;
};

export type NavigationGroup = {
    title: string;
    icon?: LucideIcon;
    items: NavigationItem[];
};

export type NavigationDomain = {
    key: string;
    label: string;
    icon: LucideIcon;
    hideContextPanel?: boolean;
    items?: NavigationItem[];
    groups?: NavigationGroup[];
};

export const DOMAINS: NavigationDomain[] = [
    {
        key: 'dashboard',
        label: 'Главная',
        icon: LayoutDashboard,
        hideContextPanel: true,
        items: [
            { label: 'Панель управления', href: '/', icon: LayoutDashboard, sectionKey: 'dashboard' },
            { label: 'Мой день', href: '/my-day', icon: CheckSquare, sectionKey: 'my_day' },
            { label: 'Команда', href: '/team-overview', icon: Users, sectionKey: 'team_overview' }
        ]
    },
    {
        key: 'drivers',
        label: 'Водители',
        icon: Users,
        items: [
            { label: 'Водители', href: '/drivers', icon: Users, sectionKey: 'drivers' },
            { label: 'Карточки', href: '/drivers/cards', icon: IdCard, sectionKey: 'cards' },
            { label: 'Мониторинг', href: '/monitoring', icon: Activity, sectionKey: 'monitoring' },
            { label: 'Архив', href: '/drivers/archive', icon: Archive, sectionKey: 'archive' }
        ]
    },
    {
        key: 'onboarding',
        label: 'Подключение',
        icon: UserPlus,
        items: [
            { label: 'Новые лиды', href: '/leads/new', icon: UserPlus, sectionKey: 'leads_new' },
            { label: 'В работе', href: '/leads/in-progress', icon: Clock, sectionKey: 'leads_in_progress' },
            { label: 'Подключены', href: '/leads/connected', icon: UserCheck, sectionKey: 'leads_connected' },
            { label: 'Нет первого заказа', href: '/leads/no-orders', icon: AlertCircle, sectionKey: 'leads_no_orders' }
        ]
    },
    {
        key: 'control',
        label: 'Контроль',
        icon: ShieldAlert,
        items: [
            { label: 'Риск запуска', href: '/control/launch-risk', icon: Clock, sectionKey: 'control_launch_risk' },
            { label: 'Риск оттока', href: '/control/churn-risk', icon: TrendingDown, sectionKey: 'control_churn_risk' },
            { label: 'Нет заказов', href: '/control/no-orders', icon: Ban, sectionKey: 'control_no_orders' },
            { label: 'Внимание', href: '/control/attention', icon: Eye, sectionKey: 'control_attention' }
        ]
    },
    {
        key: 'communication',
        label: 'Коммуникации',
        icon: MessageSquare,
        items: [
            { label: 'Мессенджер', href: '/messages', icon: MessageCircle, sectionKey: 'messages' },
            { label: 'Автосообщения', href: '/communications/auto-messages', icon: Bot, sectionKey: 'auto_messages' },
            { label: 'Шаблоны', href: '/communications/templates', icon: FileText, sectionKey: 'msg_templates' }
        ]
    },
    {
        key: 'promotions',
        label: 'Акции',
        icon: Gift,
        items: [
            { label: 'Активные', href: '/promotions/active', icon: Gift, sectionKey: 'promo_active' },
            { label: 'Заканчиваются', href: '/promotions/ending', icon: Timer, sectionKey: 'promo_ending' },
            { label: 'История', href: '/promotions/history', icon: History, sectionKey: 'promo_history' },
            { label: 'Эффективность', href: '/promotions/efficiency', icon: BarChart2, sectionKey: 'promo_efficiency' }
        ]
    },
    {
        key: 'tasks',
        label: 'Задачи',
        icon: CheckSquare,
        items: [
            { label: 'Все задачи', href: '/tasks', icon: CheckSquare, sectionKey: 'tasks' }
        ]
    },
    {
        key: 'resources',
        label: 'Ресурсы',
        icon: Database,
        items: [
            { label: 'Номера', href: '/resources/numbers', icon: Phone, sectionKey: 'res_numbers' },
            { label: 'Аккаунты', href: '/resources/accounts', icon: Key, sectionKey: 'res_accounts' },
            { label: 'Автомобили', href: '/resources/cars', icon: CarFront, sectionKey: 'res_cars' },
            { label: 'Привязки', href: '/resources/bindings', icon: Link2, sectionKey: 'res_bindings' }
        ]
    },
    {
        key: 'analytics',
        label: 'Аналитика',
        icon: BarChart3,
        items: [
            { label: 'Каналы', href: '/analytics/channels', icon: Megaphone, sectionKey: 'analytics_channels' },
            { label: 'Воронка', href: '/analytics/funnel', icon: Filter, sectionKey: 'analytics_funnel' },
            { label: 'Отток', href: '/analytics/churn', icon: TrendingDown, sectionKey: 'analytics_churn' },
            { label: 'Активная база', href: '/analytics/active-base', icon: Users, sectionKey: 'analytics_active_base' },
            { label: 'LTV водителей', href: '/analytics', icon: PieChart, sectionKey: 'analytics_ltv' }
        ]
    },
    {
        key: 'settings',
        label: 'Настройки',
        icon: Settings,
        items: [
            { label: 'Общие настройки', href: '/settings', icon: Settings, sectionKey: 'settings' },
            { label: 'Справочники', href: '/settings/dictionaries', icon: ListRestart, sectionKey: 'dictionaries' },
            { label: 'Пользователи', href: '/users', icon: UserCog, sectionKey: 'users' },
            { label: 'AI Control Center', href: '/settings/ai', icon: Cpu, sectionKey: 'ai_control' },
        ],
        groups: [
            {
                title: "Интеграции",
                items: [
                    { label: "Yandex API", href: "/settings/api", icon: Database, sectionKey: "api" },
                    { label: "Telegram", href: "/settings/integrations/telegram", icon: MessageCircle, sectionKey: "telegram" },
                    { label: "WhatsApp", href: "/settings/integrations/whatsapp", icon: Phone, sectionKey: "whatsapp" },
                    { label: "MAX", href: "/settings/integrations/max", icon: MessageSquare, sectionKey: "max" },
                    { label: "Bot", href: "/settings/integrations/bot", icon: Bot, sectionKey: "bot" },
                    { label: "Телефония", href: "/settings/integrations/telephony", icon: Smartphone, sectionKey: "telephony" }
                ]
            }
        ]
    }
];
