import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import api, { fetchBots } from '../lib/api';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';
import CustomSelect from '../components/CustomSelect';

export default function Dashboard() {
  const router = useRouter();
  const [bots, setBots] = useState([]);
  const [selectedBotId, setSelectedBotId] = useState('');
  const [period, setPeriod] = useState('30d');

  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        const fetchedBots = await fetchBots();
        setBots(fetchedBots);
        if (fetchedBots.length > 0) {
          setSelectedBotId(fetchedBots[0].id);
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error("Failed to fetch bots max", err);
        setLoading(false);
      }
    }
    init();
  }, []);

  useEffect(() => {
    async function loadDashboard() {
      if (!selectedBotId) return;
      setLoading(true);
      try {
        const { data } = await api.get(`/dashboard?botId=${selectedBotId}&period=${period}`);
        if (data) {
          setDashboardData(data);
        }
      } catch (error) {
        console.error('Failed to load dashboard data', error);
      } finally {
        setLoading(false);
      }
    }
    loadDashboard();
  }, [selectedBotId, period]);

  if (!bots.length && !loading) {
    return <div className="p-8 text-slate-400">Нет доступных ботов. Создайте бота сначала.</div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-12">

      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2 drop-shadow-md">Аналитика Дашборд</h1>
          <p className="text-slate-400 text-sm">Детальная статистика по воронкам, аудитории и рассылкам</p>
        </div>

        <div className="flex gap-2">
          <CustomSelect
            value={selectedBotId}
            onChange={setSelectedBotId}
            compact
            options={bots.map(b => ({ value: b.id, label: b.name }))}
            className="w-40"
          />
          <CustomSelect
            value={period}
            onChange={setPeriod}
            compact
            options={[
              { value: 'today', label: 'Сегодня' },
              { value: '7d', label: 'За 7 дней' },
              { value: '30d', label: 'За 30 дней' },
              { value: 'all', label: 'За всё время' },
            ]}
            className="w-40"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-t-2 border-neu-accent shadow-neu-glow"></div>
        </div>
      ) : !dashboardData ? (
        <div className="p-8 text-center text-rose-500 bg-neu-base rounded-xl border border-rose-500/20 shadow-neu-inner">
          Не удалось загрузить данные дашборда. Возможно, сервер недоступен или произошла ошибка.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Audience Growth Chart */}
            <div className="lg:col-span-2 neu-panel p-6">
              <h3 className="text-lg font-bold text-slate-200 mb-6 drop-shadow-sm">График роста аудитории</h3>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dashboardData.audienceGrowth}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2b2f35" />
                    <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickMargin={10} />
                    <YAxis stroke="#94a3b8" fontSize={12} tickMargin={10} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1a1d24', borderColor: '#2b2f35', borderRadius: '12px', boxShadow: '5px 5px 10px #111317, -5px -5px 10px #23272f' }}
                      itemStyle={{ color: '#e2e8f0' }}
                    />
                    <Legend wrapperStyle={{ paddingTop: '20px' }} />
                    <Line type="monotone" name="Новые пользователи" dataKey="newUsers" stroke="#34d399" strokeWidth={3} dot={{ r: 4, fill: '#34d399', strokeWidth: 0 }} activeDot={{ r: 6, strokeWidth: 0, shadow: '0 0 10px #34d399' }} />
                    <Line type="monotone" name="Начали опрос" dataKey="started" stroke="#fbbf24" strokeWidth={3} dot={{ r: 4, fill: '#fbbf24', strokeWidth: 0 }} />
                    <Line type="monotone" name="Завершили опрос" dataKey="completed" stroke="#ff3366" strokeWidth={3} dot={{ r: 4, fill: '#ff3366', strokeWidth: 0 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Funnel */}
            <div className="neu-panel p-6 flex flex-col justify-center">
              <h3 className="text-lg font-bold text-slate-200 mb-6 drop-shadow-sm self-start">Воронка (Funnel)</h3>
              <div className="flex flex-col gap-4 relative">
                <div className="absolute left-6 top-10 bottom-10 w-0.5 bg-slate-700 z-0"></div>
                <FunnelStep
                  label="Зашли в бота (Нажали /start)"
                  count={dashboardData.funnel.entered}
                  percent="100%"
                  color="bg-neu-accent"
                  link={`/users?botId=${selectedBotId}&filter=entered`}
                  router={router}
                />
                <FunnelStep
                  label="Начали опрос"
                  count={dashboardData.funnel.started}
                  percent={dashboardData.funnel.entered > 0 ? Math.round((dashboardData.funnel.started / dashboardData.funnel.entered) * 100) + '%' : '0%'}
                  color="bg-amber-400"
                  link={`/users?botId=${selectedBotId}&filter=started`}
                  router={router}
                />
                <FunnelStep
                  label="Завершили опрос"
                  count={dashboardData.funnel.completed}
                  percent={dashboardData.funnel.started > 0 ? Math.round((dashboardData.funnel.completed / dashboardData.funnel.started) * 100) + '%' : '0%'}
                  color="bg-emerald-400"
                  link={`/users?botId=${selectedBotId}&filter=completed`}
                  router={router}
                />
                <div className="flex items-center gap-4 z-10 pt-4">
                  <div className="w-12 h-12 rounded-full shadow-neu flex items-center justify-center font-bold text-xl border-4 border-neu-base bg-neu-accent text-slate-900">
                    📈
                  </div>
                  <div className="flex-1 bg-neu-base p-3 rounded-lg shadow-neu border border-white/[0.02] flex justify-between items-center bg-gradient-to-r from-neu-base to-[#1a2530]">
                    <span className="text-sm font-bold text-white drop-shadow-md">Общий Completion Rate</span>
                    <span className="font-bold text-xl text-neu-accent drop-shadow-glow">{dashboardData.kpi.completionRate}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Survey Breakdown */}
            <div className="neu-panel p-6">
              <h3 className="text-lg font-bold text-slate-200 mb-6 drop-shadow-sm">Разбивка по опросам</h3>
              {dashboardData.surveyBreakdown.length === 0 ? (
                <div className="text-center text-slate-500 py-10">Нет данных по опросам за этот период</div>
              ) : (
                <div className="h-[250px] w-full mt-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dashboardData.surveyBreakdown} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#2b2f35" />
                      <XAxis type="number" stroke="#94a3b8" fontSize={12} />
                      <YAxis dataKey="surveyTitle" type="category" stroke="#94a3b8" fontSize={12} width={100} tickFormatter={(val) => val.length > 12 ? val.substring(0, 12) + '...' : val} />
                      <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ backgroundColor: '#1a1d24', borderColor: '#2b2f35', borderRadius: '12px' }} />
                      <Legend />
                      <Bar dataKey="started" name="Начали" fill="#fbbf24" radius={[0, 4, 4, 0]} barSize={12} />
                      <Bar dataKey="completed" name="Завершили" fill="#10b981" radius={[0, 4, 4, 0]} barSize={12} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Broadcast Stats */}
            <div className="neu-panel p-6">
              <h3 className="text-lg font-bold text-slate-200 mb-6 drop-shadow-sm">Данные по рассылке</h3>
              <div className="flex flex-col justify-center h-full pb-8">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-neu-base rounded-xl p-4 shadow-neu-inner border border-black/20 flex flex-col items-center justify-center">
                    <span className="text-3xl mb-2">📤</span>
                    <span className="text-2xl font-bold text-slate-200">{dashboardData.broadcastSummary.totalSent}</span>
                    <span className="text-xs text-slate-500 uppercase tracking-wider mt-1 text-center">Отправлено<br />сообщений</span>
                  </div>
                  <div className="bg-neu-base rounded-xl p-4 shadow-neu-inner border border-black/20 flex flex-col items-center justify-center">
                    <span className="text-3xl mb-2">📬</span>
                    <span className="text-2xl font-bold text-emerald-400">{dashboardData.broadcastSummary.success}</span>
                    <span className="text-xs text-slate-500 uppercase tracking-wider mt-1 text-center">Успешно<br />доставлено</span>
                  </div>
                  <div className="bg-neu-base rounded-xl p-4 shadow-neu-inner border border-black/20 flex flex-col items-center justify-center">
                    <span className="text-3xl mb-2">❌</span>
                    <span className="text-2xl font-bold text-rose-500">{dashboardData.broadcastSummary.failed}</span>
                    <span className="text-xs text-slate-500 uppercase tracking-wider mt-1 text-center">Ошибок<br />(блокировки)</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FunnelStep({ label, count, percent, color, link, router }) {
  const content = (
    <>
      <div className={`w-12 h-12 shrink-0 rounded-full shadow-neu flex items-center justify-center font-bold text-xs border-4 border-neu-base ${color} text-slate-900`}>
        {percent}
      </div>
      <div className="flex-1 bg-neu-base p-3 rounded-lg shadow-neu border border-white/[0.02] flex justify-between items-center group-hover:bg-[#1f2228] transition-colors relative">
        <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">{label}</span>
        <span className="font-bold text-lg text-white">{count}</span>
        {link && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-hover:translate-x-[15px] transition-all duration-300 text-neu-accent">
            →
          </span>
        )}
      </div>
    </>
  );

  return (
    <div className="flex items-center gap-4 z-10 group cursor-pointer relative" onClick={() => { if (link) router.push(link) }}>
      {content}
    </div>
  );
}
