import { ArrowLeft, User, CreditCard, Car, AlertTriangle, Clock, Phone as PhoneIcon } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/infrastructure/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import TelegramLinkClient from './TelegramLinkClient'
import { DriverTimeline } from './DriverTimeline'
import CallButton from '@/components/sip/CallButton'
import CallsList from '@/components/sip/CallsList'
import AiMockCallButton from '@/components/sip/AiMockCallButton'
import { prisma } from '@/lib/prisma'
import { getDriverById, getCarById } from '@/app/actions'
import { getDriverTimeline } from './timeline-actions'
import { listMaxDriverDeliveryConnectionsV1 } from '@/infrastructure/fleet/driver-max-messaging'
import { getTelegramConnections } from '@/app/tg-actions'

export const dynamic = 'force-dynamic'

export default async function DriverDetailsPage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
    // Safely resolve params for Next.js 14 & 15
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams?.id;

    if (!id) {
        return <div className="p-[8px] text-center text-red-500">Некорректный ID водителя</div>;
    }

    // Fetch real driver data from Yandex and stored TG link from DB in parallel
    const [driver, tgLink, timeline, telegramConnections, maxConnections, prismaDriver] = await Promise.all([
        getDriverById(id),
        prisma.driverTelegram.findFirst({ where: { driverId: id } }),
        getDriverTimeline(id),
        getTelegramConnections(),
        listMaxDriverDeliveryConnectionsV1(),
        // PR #64: accept either yandexDriverId OR Prisma cuid in URL.
        // Also select `phone` so the page can fall back to the local
        // value when Yandex API returns nothing (sync stale, network
        // down, driver dropped from Yandex Fleet).
        prisma.driver.findFirst({
            where: { OR: [{ yandexDriverId: id }, { id }] },
            select: { id: true, phone: true },
        }),
    ])
    const car = driver?.car_id ? await getCarById(driver.car_id, id) : null

    const driverName = driver
        ? `${driver.last_name || ''} ${driver.first_name || ''}`.trim() || 'Неизвестный водитель'
        : `ID: ${id}`
    // PR #64: phone has two sources of truth — Yandex Fleet API (live)
    // and our local Prisma DB (last-known). Operator should be able to
    // dial (or fire the AI-call mock) whenever EITHER has it. Yandex
    // wins when both are present; local is the fallback.
    const driverPhone = driver?.phones?.[0] || prismaDriver?.phone || '—'
    const driverStatus = driver?.status || '—'
    const driverBalance = driver?.balance !== undefined ? `${Number(driver.balance).toLocaleString('ru-RU')} ₽` : '—'
    const driverBalanceLimit = driver?.balance_limit !== undefined ? `${Number(driver.balance_limit).toLocaleString('ru-RU')} ₽` : '—'

    return (
        <div className="flex flex-col gap-6 animate-in fade-in duration-500 max-w-5xl mx-auto w-full">
            <div className="flex items-center gap-[4px]">
                <Button variant="outline" size="icon" asChild className="rounded-xl h-10 w-10 border-muted-foreground/20 text-muted-foreground hover:bg-secondary">
                    <Link href="/drivers">
                        <ArrowLeft size={18} />
                    </Link>
                </Button>
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-3 text-foreground">
                        Детали Водителя
                        <Badge variant="secondary" className="font-mono text-xs">{id}</Badge>
                    </h1>
                </div>
            </div>

            <div className="rounded-2xl border bg-card p-6 shadow-sm">
                <Tabs defaultValue="profile" className="w-full">
                    <TabsList className="mb-6 grid w-full grid-cols-6 bg-secondary/50 p-1.5 rounded-xl h-auto">
                        <TabsTrigger value="profile" className="rounded-lg py-2.5 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-foreground text-muted-foreground"><User size={16} className="mr-[2px]" /> Профиль</TabsTrigger>
                        <TabsTrigger value="timeline" className="rounded-lg py-2.5 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-foreground text-muted-foreground"><Clock size={16} className="mr-[2px]" /> Хронология</TabsTrigger>
                        <TabsTrigger value="calls" className="rounded-lg py-2.5 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-foreground text-muted-foreground"><PhoneIcon size={16} className="mr-[2px]" /> Звонки</TabsTrigger>
                        <TabsTrigger value="transactions" className="rounded-lg py-2.5 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-foreground text-muted-foreground"><CreditCard size={16} className="mr-[2px]" /> Транзакции</TabsTrigger>
                        <TabsTrigger value="fines" className="rounded-lg py-2.5 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-foreground text-muted-foreground"><AlertTriangle size={16} className="mr-[2px]" /> Штрафы</TabsTrigger>
                        <TabsTrigger value="cars" className="rounded-lg py-2.5 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-foreground text-muted-foreground"><Car size={16} className="mr-[2px]" /> Авто</TabsTrigger>
                    </TabsList>

                    <TabsContent value="profile" className="space-y-[4px] animate-in fade-in zoom-in-95 duration-300">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-[4px]">
                                <div>
                                    <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Основная информация</h3>
                                    <div className="rounded-xl border p-5 space-y-[4px] bg-secondary/20 shadow-inner">
                                        <div className="grid grid-cols-[120px_1fr] gap-3 text-sm">
                                            <span className="text-muted-foreground font-medium">ФИО:</span>
                                            <span className="font-semibold text-foreground">{driverName}</span>

                                            <span className="text-muted-foreground font-medium">Телефон:</span>
                                            <span className="font-semibold text-foreground flex items-center gap-[2px] flex-wrap">
                                                {driverPhone}
                                                {driverPhone && driverPhone !== '—' && (
                                                    <CallButton phoneNumber={driverPhone} label="Позвонить" />
                                                )}
                                                {driverPhone && driverPhone !== '—' && prismaDriver && (
                                                    <AiMockCallButton
                                                        driverId={prismaDriver.id}
                                                        phoneNumber={driverPhone}
                                                    />
                                                )}
                                            </span>

                                            <span className="text-muted-foreground font-medium">Статус:</span>
                                            <Badge variant={driverStatus === 'working' ? 'default' : 'secondary' as any} className="w-fit text-[10px] uppercase font-bold">
                                                {driverStatus}
                                            </Badge>

                                            <span className="text-muted-foreground font-medium">Баланс:</span>
                                            <span className="font-semibold text-foreground">{driverBalance}</span>

                                            <span className="text-muted-foreground font-medium">Лимит счёта:</span>
                                            <span className="font-semibold text-blue-600">{driverBalanceLimit}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="space-y-[4px]">
                                <div>
                                    <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Реквизиты и Данные</h3>
                                    <div className="rounded-xl border p-5 space-y-3 bg-secondary/20 shadow-inner min-h-[140px] flex items-center justify-center">
                                        <div className="text-sm font-medium text-muted-foreground text-center">
                                            Данные о реквизитах или ВУ отсутствуют
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Интеграции</h3>
                                    <TelegramLinkClient
                                        driverId={id}
                                        initialTelegramId={tgLink?.telegramId}
                                        initialUsername={tgLink?.username}
                                    />
                                </div>
                            </div>
                        </div>
                    </TabsContent>

                    <TabsContent value="timeline" className="animate-in fade-in zoom-in-95 duration-300">
                        <DriverTimeline
                            driverId={id}
                            events={timeline}
                            telegramConnections={telegramConnections}
                            maxConnections={maxConnections}
                        />
                    </TabsContent>

                    <TabsContent value="calls" className="animate-in fade-in zoom-in-95 duration-300">
                        <div className="rounded-xl border p-5 bg-secondary/20 shadow-inner">
                            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-[4px]">История звонков</h3>
                            {prismaDriver ? (
                                <CallsList driverId={prismaDriver.id} limit={50} />
                            ) : (
                                <div className="text-[13px] text-muted-foreground py-[2px]">Водитель ещё не зарегистрирован в CRM — звонков пока нет</div>
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="transactions" className="animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex flex-col items-center justify-center py-[16px] text-center rounded-xl border border-dashed border-muted-foreground/30 text-muted-foreground bg-secondary/20">
                            <CreditCard size={48} className="mb-[4px] opacity-40 text-primary" strokeWidth={1} />
                            <p className="font-medium">История транзакций будет доступна здесь</p>
                        </div>
                    </TabsContent>

                    <TabsContent value="fines" className="animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex flex-col items-center justify-center py-[16px] text-center rounded-xl border border-dashed border-muted-foreground/30 text-muted-foreground bg-secondary/20">
                            <AlertTriangle size={48} className="mb-[4px] opacity-40 text-red-500" strokeWidth={1} />
                            <p className="font-medium">Информация о штрафах будет доступна здесь</p>
                        </div>
                    </TabsContent>

                    <TabsContent value="cars" className="animate-in fade-in zoom-in-95 duration-300">
                        {car ? (
                            <div className="rounded-xl border p-5 bg-secondary/20 shadow-inner">
                                <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-[4px]">Привязанный автомобиль</h3>
                                <div className="grid grid-cols-[140px_1fr] gap-3 text-sm">
                                    <span className="text-muted-foreground font-medium">Марка / Модель:</span>
                                    <span className="font-semibold">{[car.brand, car.model].filter(Boolean).join(' ') || '—'}</span>

                                    <span className="text-muted-foreground font-medium">Гос. номер:</span>
                                    <span className="font-semibold font-mono">{car.plate || '—'}</span>

                                    <span className="text-muted-foreground font-medium">Год выпуска:</span>
                                    <span className="font-semibold">{car.year || '—'}</span>

                                    <span className="text-muted-foreground font-medium">Цвет:</span>
                                    <span className="font-semibold">{car.color || '—'}</span>

                                    <span className="text-muted-foreground font-medium">Статус:</span>
                                    <Badge variant="secondary" className="w-fit text-[10px] uppercase font-bold">{car.status || '—'}</Badge>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-[16px] text-center rounded-xl border border-dashed border-muted-foreground/30 text-muted-foreground bg-secondary/20">
                                <Car size={48} className="mb-[4px] opacity-40 text-primary" strokeWidth={1} />
                                <p className="font-medium">Автомобиль не привязан</p>
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    )
}
