import {
  Activity, Users, Car, Map as MapIcon, Settings, MessageSquare, Phone,
  Bot, BarChart3, Inbox, Archive, UserPlus, Gift, Target, PieChart,
  CheckSquare, UserCheck, AlertTriangle, TrendingDown, Eye, CheckCircle,
  Clock, LineChart, FileText, Smartphone, Key, CarFront, Link2, 
  Megaphone, History, Percent
} from "lucide-react";

export type NavigationItem = {
  name: string;
  href?: string;
  icon: any;
  sectionKey?: string;
  subItems?: NavigationItem[];
};

export type NavigationGroup = {
  title: string;
  items: NavigationItem[];
};

export const NAVIGATION: NavigationGroup[] = [
  {
    title: "Главная",
    items: [
      { name: "Dashboard", href: "/", icon: Activity, sectionKey: "dashboard" },
    ]
  },
  {
    title: "Учетная запись",
    items: [
      { name: "Пользователи", href: "/users", icon: Users, sectionKey: "users" },
    ]
  },
  {
    title: "Исполнители",
    items: [
      { name: "Водители", href: "/drivers", icon: Users, sectionKey: "drivers" },
      { name: "Карточки", href: "/drivers/cards", icon: Car, sectionKey: "cards" },
      { name: "Мониторинг", href: "/monitoring", icon: BarChart3, sectionKey: "monitoring" },
      { name: "Архив", href: "/drivers/archive", icon: Archive, sectionKey: "archive" },
    ]
  },
  {
    title: "Подключение",
    items: [
      { name: "Новые лиды", href: "/leads/new", icon: UserPlus, sectionKey: "leads_new" },
      { name: "В работе", href: "/leads/in-progress", icon: Clock, sectionKey: "leads_in_progress" },
      { name: "Подключены", href: "/leads/connected", icon: UserCheck, sectionKey: "leads_connected" },
      { name: "Нет 1го заказа", href: "/leads/no-orders", icon: AlertTriangle, sectionKey: "leads_no_orders" },
    ]
  },
  {
    title: "Контроль",
    items: [
      { name: "Риск запуска", href: "/control/launch-risk", icon: Clock, sectionKey: "control_launch_risk" },
      { name: "Риск оттока", href: "/control/churn-risk", icon: TrendingDown, sectionKey: "control_churn_risk" },
      { name: "Нет заказов", href: "/control/no-orders", icon: AlertTriangle, sectionKey: "control_no_orders" },
      { name: "Внимание", href: "/control/attention", icon: Eye, sectionKey: "control_attention" },
    ]
  },
  {
    title: "Акции",
    items: [
      { name: "Активные", href: "/promotions/active", icon: Gift, sectionKey: "promo_active" },
      { name: "Заканчиваются", href: "/promotions/ending", icon: Clock, sectionKey: "promo_ending" },
      { name: "История", href: "/promotions/history", icon: History, sectionKey: "promo_history" },
      { name: "Эффективность", href: "/promotions/efficiency", icon: Percent, sectionKey: "promo_efficiency" },
    ]
  },
  {
    title: "Коммуникации",
    items: [
      { name: "Мессенджер", href: "/messages", icon: MessageSquare, sectionKey: "messages" },
      { name: "Автосообщения", href: "/communications/auto-messages", icon: Bot, sectionKey: "auto_messages" },
      { name: "Шаблоны", href: "/communications/templates", icon: FileText, sectionKey: "msg_templates" },
      {
        name: "Настройки",
        icon: Settings,
        subItems: [
          { name: "Справочники", href: "/settings/dictionaries", icon: FileText, sectionKey: "dictionaries" },
          { name: "Telegram", href: "/telegram", icon: MessageSquare, sectionKey: "settings_telegram" },
          { name: "MAX", href: "/max", icon: MessageSquare, sectionKey: "settings_max" },
          { name: "TG Бот", href: "/bot-admin", icon: Bot, sectionKey: "settings_bot" },
          { name: "WhatsApp", href: "/whatsapp", icon: Phone, sectionKey: "settings_whatsapp" },
        ]
      },
    ]
  },
  {
    title: "Управление",
    items: [
      { name: "Задачи", href: "/inbox", icon: Inbox, sectionKey: "tasks" },
    ]
  },
  {
    title: "Ресурсы",
    items: [
      { name: "Номера", href: "/resources/numbers", icon: Smartphone, sectionKey: "res_numbers" },
      { name: "Аккаунты", href: "/resources/accounts", icon: Key, sectionKey: "res_accounts" },
      { name: "Автомобили", href: "/resources/cars", icon: CarFront, sectionKey: "res_cars" },
      { name: "Привязки", href: "/resources/bindings", icon: Link2, sectionKey: "res_bindings" },
    ]
  },
  {
    title: "Аналитика",
    items: [
      { name: "Каналы", href: "/analytics/channels", icon: Megaphone, sectionKey: "analytics_channels" },
      { name: "Воронка", href: "/analytics/funnel", icon: LineChart, sectionKey: "analytics_funnel" },
      { name: "Отток", href: "/analytics/churn", icon: TrendingDown, sectionKey: "analytics_churn" },
      { name: "Активная база", href: "/analytics/active-base", icon: Users, sectionKey: "analytics_active_base" },
      { name: "LTV водителей", href: "/analytics", icon: PieChart, sectionKey: "analytics_ltv" },
    ]
  }
];
