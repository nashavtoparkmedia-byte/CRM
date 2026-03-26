export type SectionMeta = {
  sectionKey: string;
  title: string;
  description: {
    what: string;
    why: string;
    when: string;
    actions: string;
    result: string;
  };
  isStub: boolean;
  badgeLabel?: string;
  availability?: "available" | "coming_soon" | "hidden";
  breadcrumbs?: string[];
};

export const SECTIONS: Record<string, SectionMeta> = {
  // === ГЛАВНАЯ ===
  dashboard: {
    sectionKey: "dashboard",
    title: "Dashboard",
    isStub: false,
    availability: "available",
    description: {
      what: "Главная сводка по состоянию парка.",
      why: "Для быстрого контроля ключевых метрик.",
      when: "Ежедневно для оценки общего статуса.",
      actions: "Просмотр графиков и оперативной информации.",
      result: "Понимание ситуации в парке с первого взгляда.",
    },
  },
  
  // === ВОДИТЕЛИ ===
  drivers: {
    sectionKey: "drivers",
    title: "Водители",
    isStub: false,
    availability: "available",
    description: {
      what: "Основная база водителей парка.",
      why: "Для управления списком исполнителей.",
      when: "При поиске или фильтрации водителей.",
      actions: "Просмотр и поиск активных водителей.",
      result: "Найден нужный водитель для дальнейшей работы.",
    },
  },
  cards: {
    sectionKey: "cards",
    title: "Карточки",
    isStub: true,
    badgeLabel: "В разработке",
    availability: "coming_soon",
    description: {
      what: "Детальная карточка водителя с историей.",
      why: "Для полного аудита профиля сотрудника.",
      when: "При детальном разборе спорных ситуаций.",
      actions: "Управление документами, балансами и профилем.",
      result: "Полная информация по одному водителю.",
    },
  },
  monitoring: {
    sectionKey: "monitoring",
    title: "Мониторинг",
    isStub: false,
    availability: "available",
    description: {
      what: "Отслеживание показателей водителей.",
      why: "Для контроля качества работы и фрода.",
      when: "Во время операционных проверок.",
      actions: "Анализ метрик рейтинга и активности.",
      result: "Выявлены аномалии в работе водителей.",
    },
  },
  archive: {
    sectionKey: "archive",
    title: "Архив",
    isStub: true,
    badgeLabel: "В разработке",
    availability: "coming_soon",
    description: {
      what: "База уволенных или заблокированных водителей.",
      why: "Для хранения истории и работы с реактивацией.",
      when: "При проверке прошлых сотрудников.",
      actions: "Восстановление водителей из архива.",
      result: "Водитель возвращен в работу или проверен.",
    },
  },

  // === ПОДКЛЮЧЕНИЕ ===
  leads_new: {
    sectionKey: "leads_new",
    title: "Новые лиды",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Поток новых заявок на подключение.",
      why: "Для быстрой обработки потенциальных водителей.",
      when: "Как только приходит новая заявка.",
      actions: "Взятие лида в работу или отказ.",
      result: "Лид переведен в статус 'В работе'.",
    },
  },
  leads_in_progress: {
    sectionKey: "leads_in_progress",
    title: "В работе",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Заявки на этапе проверки и оформления.",
      why: "Для контроля воронки подключения.",
      when: "При общении с кандидатом и сборе документов.",
      actions: "Проверка СБ, подписание договора.",
      result: "Водитель успешно подключен к парку.",
    },
  },
  leads_connected: {
    sectionKey: "leads_connected",
    title: "Подключены",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Список недавно оформленных водителей.",
      why: "Для контроля успешности онбординга.",
      when: "После физического подключения водителя.",
      actions: "Передача в отдел сопровождения.",
      result: "Водитель готов выйти на линию.",
    },
  },
  leads_no_orders: {
    sectionKey: "leads_no_orders",
    title: "Нет первого заказа",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Подключенные водители, не совершившие ни одного заказа.",
      why: "Для дожима водителя до выхода на линию.",
      when: "Если с момента подключения прошло больше суток.",
      actions: "Прозвон или отправка мотивационного сообщения.",
      result: "Водитель совершил первый заказ.",
    },
  },

  // === КОНТРОЛЬ ===
  control_launch_risk: {
    sectionKey: "control_launch_risk",
    title: "Риск запуска",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Водители, задерживающие начало смены.",
      why: "Для раннего выявления проблем с выходом на линию.",
      when: "В начале рабочих смен.",
      actions: "Связь с водителем для уточнения статуса.",
      result: "Снижение простоев автомобилей.",
    },
  },
  control_churn_risk: {
    sectionKey: "control_churn_risk",
    title: "Риск оттока",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Водители с падающей активностью.",
      why: "Для предотвращения ухода водителя в другой парк.",
      when: "При фиксации спада показателей.",
      actions: "Индивидуальные предложения и решение проблем.",
      result: "Водитель удержан в парке.",
    },
  },
  control_no_orders: {
    sectionKey: "control_no_orders",
    title: "Нет заказов",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Водители на линии, но не получающие заказы.",
      why: "Для выявления технических или операционных проблем.",
      when: "Днем при нулевой активности агрегатора.",
      actions: "Проверка блокировок агрегатора или геолокации.",
      result: "Водитель снова получает заказы.",
    },
  },
  control_attention: {
    sectionKey: "control_attention",
    title: "Требует внимания",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Сборная группа водителей с различными отклонениями.",
      why: "Для ручного реагирования на нетипичные ситуации.",
      when: "При ручном разборе проблем оператором.",
      actions: "Детальный анализ карточки и логов.",
      result: "Разрешение нестандартной проблемы.",
    },
  },

  // === АКЦИИ ===
  promo_active: {
    sectionKey: "promo_active",
    title: "Активные",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Текущие мотивационные программы для водителей.",
      why: "Для стимулирования нужного поведения.",
      when: "Для оценки запущенных инициатив.",
      actions: "Мониторинг участия и метрик.",
      result: "Понимание промежуточных результатов акции.",
    },
  },
  promo_ending: {
    sectionKey: "promo_ending",
    title: "Заканчиваются",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Акции, чей срок действия истекает.",
      why: "Для своевременного подведения итогов.",
      when: "За несколько дней до конца акции.",
      actions: "Дожим участников для выполнения условий.",
      result: "Максимизация эффекта от акции перед завершением.",
    },
  },
  promo_history: {
    sectionKey: "promo_history",
    title: "История",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Архив всех проведенных мотивационных программ.",
      why: "Для анализа прошлых механик.",
      when: "При планировании новых акций.",
      actions: "Просмотр условий и результатов.",
      result: "Опыт учтен при создании новых программ.",
    },
  },
  promo_efficiency: {
    sectionKey: "promo_efficiency",
    title: "Эффективность",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Аналитика ROI проведенных акций.",
      why: "Для оценки экономической целесообразности.",
      when: "При подведении финансовых итогов месяца.",
      actions: "Анализ затрат к принесенной прибыли.",
      result: "Оптимизация бюджета на маркетинг внутри парка.",
    },
  },

  // === КОММУНИКАЦИИ ===
  messages: {
    sectionKey: "messages",
    title: "Мессенджер",
    isStub: false,
    availability: "available",
    description: {
      what: "Единое окно переписок со всеми водителями.",
      why: "Для оперативной связи и омниканальной поддержки.",
      when: "В течение всего рабочего дня.",
      actions: "Чтение и отправка сообщений.",
      result: "Вопрос водителя решен.",
    },
  },
  auto_messages: {
    sectionKey: "auto_messages",
    title: "Автосообщения",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Настройка триггерных рассылок.",
      why: "Для автоматизации рутинного общения.",
      when: "При изменении процессов в парке.",
      actions: "Создание правил и текстов.",
      result: "Водители информируются без участия оператора.",
    },
  },
  msg_templates: {
    sectionKey: "msg_templates",
    title: "Шаблоны сообщений",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Заготовки для частых ответов.",
      why: "Для ускорения работы поддержки.",
      when: "При частых повторяющихся вопросах.",
      actions: "Создание и редактирование шаблонов быстрых ответов.",
      result: "Оператор отвечает в один клик.",
    },
  },
  settings_telegram: {
    sectionKey: "settings_telegram",
    title: "Telegram",
    isStub: false,
    availability: "available",
    description: {
      what: "Настройки интеграции с Telegram.",
      why: "Для управления ботами и аккаунтами поддержки.",
      when: "При изменении токенов или проверке статуса.",
      actions: "Проверка подключения и логов.",
      result: "Связь через Telegram работает.",
    },
  },
  settings_max: {
    sectionKey: "settings_max",
    title: "MAX",
    isStub: false,
    availability: "available",
    description: {
      what: "Настройки интеграции со скрапером MAX.",
      why: "Для управления синхронизацией с агрегатором.",
      when: "При сбоях доставки сообщений.",
      actions: "Перезапуск скрапера, проверка статуса.",
      result: "Интеграция с диспетчерской Яндекс работает.",
    },
  },
  settings_bot: {
    sectionKey: "settings_bot",
    title: "TG Бот",
    isStub: false,
    availability: "available",
    description: {
      what: "Управление основным ботом парка.",
      why: "Для настройки меню и автоматизаций бота.",
      when: "При добавлении новых функций для водителей.",
      actions: "Настройка команд и ответов.",
      result: "Бот предоставляет актуальную информацию.",
    },
  },
  settings_whatsapp: {
    sectionKey: "settings_whatsapp",
    title: "WhatsApp",
    isStub: false,
    availability: "available",
    description: {
      what: "Настройки интеграции с WhatsApp.",
      why: "Для управления аккаунтом WAZZUP/Green API.",
      when: "При проверке статуса QR-кода বা сессии.",
      actions: "Переподключение сессии WhatsApp.",
      result: "Интеграция с WhatsApp работает стабильно.",
    },
  },

  // === ЗАДАЧИ ===
  tasks: {
    sectionKey: "tasks",
    title: "Задачи",
    isStub: false,
    availability: "available",
    description: {
      what: "Внутренний таск-трекер команды парка.",
      why: "Для организации работы менеджеров.",
      when: "Постоянно в течение дня.",
      actions: "Постановка, выполнение и контроль задач.",
      result: "Ни одно обращение не потеряно.",
    },
  },

  // === РЕСУРСЫ ===
  res_numbers: {
    sectionKey: "res_numbers",
    title: "Номера",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Реестр телефонных номеров парка.",
      why: "Для учета корпоративных симок и виртуальных номеров.",
      when: "При выдаче нового номера или оплате связи.",
      actions: "Просмотр балансов и распределения номеров.",
      result: "Полный учет средств связи.",
    },
  },
  res_accounts: {
    sectionKey: "res_accounts",
    title: "Аккаунты",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Учетные записи в агрегаторах.",
      why: "Для управления доступами диспетчерской.",
      when: "При ротации доступов.",
      actions: "Добавление и отзыв доступов к Яндекс.Про.",
      result: "Доступы всегда актуальны и безопасны.",
    },
  },
  res_cars: {
    sectionKey: "res_cars",
    title: "Автомобили",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Автопарк компании.",
      why: "Для технического и финансового учета ТС.",
      when: "При работе со своими авто или раскате.",
      actions: "Просмотр статуса по каждому авто (ремонт, аренда).",
      result: "Реестр автомобилей в актуальном состоянии.",
    },
  },
  res_bindings: {
    sectionKey: "res_bindings",
    title: "Привязки",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Журнал привязки авто к водителям.",
      why: "Для понимания, кто сейчас за рулем.",
      when: "При смене водителя на автопарке.",
      actions: "Фиксация передачи авто.",
      result: "Штрафы и аренда начисляются верному лицу.",
    },
  },

  // === АНАЛИТИКА ===
  analytics_channels: {
    sectionKey: "analytics_channels",
    title: "Каналы",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Аналитика эффективности каналов привлечения.",
      why: "Для оптимизации маркетингового бюджета.",
      when: "При ежемесячном планировании.",
      actions: "Сравнение CPL и CPA по источникам.",
      result: "Бюджет перераспределен на эффективные каналы.",
    },
  },
  analytics_funnel: {
    sectionKey: "analytics_funnel",
    title: "Воронка",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Конверсия от заявки до выхода на линию.",
      why: "Для поиска узких мест в процессе подключения.",
      when: "При аудите процесса онбординга.",
      actions: "Анализ отвалов на каждом этапе.",
      result: "Выявлен этап, требующий оптимизации.",
    },
  },
  analytics_churn: {
    sectionKey: "analytics_churn",
    title: "Отток",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Анализ причин и динамики ухода водителей.",
      why: "Для разработки мер по удержанию.",
      when: "При анализе падения маржинальности.",
      actions: "Изучение причин разрыва договоров.",
      result: "Приняты решения по сокращению оттока.",
    },
  },
  analytics_active_base: {
    sectionKey: "analytics_active_base",
    title: "Активная база",
    isStub: true,
    badgeLabel: "Заглушка",
    availability: "coming_soon",
    description: {
      what: "Ключевые показатели работы лояльных водителей.",
      why: "Для понимания здоровья основного актива парка.",
      when: "Регулярный мониторинг ячеек.",
      actions: "Анализ средних чеков и часов на линии.",
      result: "Понимание доходности с одного активного водителя.",
    },
  },
  analytics_ltv: {
    sectionKey: "analytics_ltv",
    title: "LTV водителей",
    isStub: false,
    availability: "available",
    description: {
      what: "Lifetime Value монетизации водителя.",
      why: "Для расчета допустимой стоимости привлечения.",
      when: "Для построения долгосрочной финмодели.",
      actions: "Просмотр исторической доходности когорт.",
      result: "Рассчитан предельный CPA для новых лидов.",
    },
  },
};
