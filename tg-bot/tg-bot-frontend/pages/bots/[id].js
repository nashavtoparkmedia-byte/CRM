import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { fetchBot, updateSurvey, updateBot } from '../../lib/api';
import Link from 'next/link';
import CustomSelect from '../../components/CustomSelect';

export default function BotDetail() {
    const router = useRouter();
    const { id } = router.query;

    const [bot, setBot] = useState(null);
    const [survey, setSurvey] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState('');
    const [isSheetsOpen, setIsSheetsOpen] = useState(false);

    useEffect(() => {
        if (id) loadData();
    }, [id]);

    const loadData = async () => {
        try {
            const bData = await fetchBot(id);
            setBot(bData);

            // Temporary measure to support the existing page state which configures the FIRST survey associated with a bot
            if (bData.surveys && bData.surveys.length > 0) {
                setSurvey(bData.surveys[0]);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handleSaveSettings = async (e) => {
        e.preventDefault();
        setSaving(true);
        setSaveStatus('');
        try {
            if (survey) {
                await updateSurvey(survey.id, {
                    isActive: survey.isActive,
                    googleSheetId: survey.googleSheetId,
                    syncMode: survey.syncMode
                });
            }
            setSaveStatus('success');
            setTimeout(() => setSaveStatus(''), 3000);
        } catch (error) {
            setSaveStatus('error');
            setTimeout(() => setSaveStatus(''), 3000);
        } finally {
            setSaving(false);
        }
    };

    if (loading) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="flex flex-col items-center justify-center space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-t-2 border-neu-accent shadow-neu-glow"></div>
                <span className="text-sm text-slate-400 font-medium tracking-wide">Загрузка данных...</span>
            </div>
        </div>
    );
    if (!bot) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="flex flex-col items-center justify-center space-y-4 neu-panel p-12 text-center">
                <div className="w-16 h-16 bg-neu-base shadow-neu-inner rounded-full flex items-center justify-center mb-4 text-slate-500">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                </div>
                <span className="text-lg text-white font-semibold">Бот не найден</span>
            </div>
        </div>
    );

    const isSheetsEnabled = !!survey?.googleSheetId;

    return (
        <div className="space-y-6 max-w-4xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 neu-panel p-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white drop-shadow-md">{bot.name} <span className="text-sm text-slate-500 font-normal">({bot.surveys?.length} опросов)</span></h1>
                    <p className="text-slate-400 text-sm mt-1">ID: <span className="font-mono text-neu-secondary">{bot.id}</span></p>
                </div>
                <div className="flex gap-4">
                    {survey && (
                        <Link href={`/surveys/${survey.id}`} className="neu-button-primary !py-2.5">
                            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                            Конструктор опроса
                        </Link>
                    )}
                </div>
            </div>

            {survey ? (
                <div className="neu-panel overflow-hidden relative">
                    <div className="px-6 py-6 sm:p-8">
                        <button
                            type="button"
                            onClick={() => setIsSheetsOpen(!isSheetsOpen)}
                            className="w-full flex items-center justify-between gap-4 mb-2 p-2 -mx-2 rounded-xl hover:bg-white/[0.02] transition-colors group text-left"
                        >
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-neu-base shadow-neu-inner text-emerald-400 rounded-xl border border-black/20 group-hover:shadow-neu-glow transition-all">
                                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V6c0-1.1-.89-2-2-2zm0 14H5V8h14v10z" clipRule="evenodd" /><path d="M7 10h4v2H7zM13 10h4v2h-4zM7 14h4v2H7zM13 14h4v2h-4z" /></svg>
                                </div>
                                <div>
                                    <h3 className="text-xl font-bold text-white drop-shadow-sm flex items-center gap-3">
                                        Google Sheets
                                        {isSheetsEnabled ? (
                                            <span className="px-2.5 py-0.5 text-[10px] uppercase font-bold tracking-wider rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-neu-inner inline-flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
                                                Активно
                                            </span>
                                        ) : (
                                            <span className="px-2.5 py-0.5 text-[10px] uppercase font-bold tracking-wider rounded-md bg-slate-500/10 text-slate-400 border border-slate-500/20 shadow-neu-inner inline-flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-slate-400"></div>
                                                Ожидает подключения
                                            </span>
                                        )}
                                    </h3>
                                    <p className="text-sm text-slate-400 mt-1">Настройте автоматическую выгрузку ответов в вашу таблицу Google.</p>
                                </div>
                            </div>
                            <div className={`p-2 bg-neu-base shadow-neu-inner rounded-xl text-slate-500 group-hover:text-emerald-400 transition-all ${isSheetsOpen ? 'rotate-180' : ''}`}>
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                            </div>
                        </button>

                        {isSheetsOpen && (
                            <form className="mt-6 space-y-6 animate-in fade-in slide-in-from-top-4 duration-300" onSubmit={handleSaveSettings}>
                                {isSheetsEnabled && (
                                    <div className="neu-panel-inner p-4 mb-6 relative overflow-hidden group">
                                        <label className="block text-sm font-medium text-slate-400 mb-2">Откройте таблицу</label>
                                        <a
                                            href={`https://docs.google.com/spreadsheets/d/${survey.googleSheetId}/edit`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="flex items-center gap-3 text-emerald-400 hover:text-emerald-300 font-medium transition-colors p-3 rounded-xl bg-[#191b1f] border border-white/[0.02]"
                                        >
                                            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                            <span className="truncate">docs.google.com/spreadsheets/d/{survey.googleSheetId.substring(0, 15)}.../edit</span>
                                        </a>
                                    </div>
                                )}

                                <div className="p-5 border border-white/[0.05] bg-neu-base shadow-neu-inner rounded-2xl relative">
                                    <h4 className="text-sm font-bold text-white mb-4">Настройки подключения</h4>
                                    <div>
                                        <label className="block text-sm font-medium text-slate-400 mb-2">Google Sheet ID</label>
                                        <input
                                            type="text"
                                            value={survey.googleSheetId || ''}
                                            onChange={(e) => setSurvey({ ...survey, googleSheetId: e.target.value })}
                                            className="w-full neu-input focus:ring-emerald-400 focus:shadow-neu-glow font-mono text-sm"
                                            placeholder="1BxiMVs0XRYFgwnLEUK9..."
                                        />
                                        <p className="text-xs text-slate-500 mt-2">ID находится в URL таблицы: .../d/<span className="text-slate-300 font-bold">1BxiMVs0XRYFgwnLEUK9...</span>/edit</p>
                                    </div>

                                    <div className="mt-5">
                                        <label className="block text-sm font-medium text-slate-400 mb-2">Режим синхронизации</label>
                                        <CustomSelect
                                            value={survey.syncMode}
                                            onChange={(val) => setSurvey({ ...survey, syncMode: val })}
                                            options={[
                                                { value: 'ON_COMPLETE', label: 'Только после завершения опроса целиком' },
                                                { value: 'ON_ANSWER', label: 'После каждого ответа (В реальном времени)' },
                                            ]}
                                        />
                                    </div>
                                </div>

                                <div className="pt-6 border-t border-white/[0.05] flex flex-col sm:flex-row justify-between items-center gap-4">
                                    <div className="flex-1">
                                        {saveStatus === 'success' && <span className="text-emerald-400 text-sm font-bold shadow-neu-glow animate-in fade-in slide-in-from-left-2">✅ Настройки успешно сохранены</span>}
                                        {saveStatus === 'error' && <span className="text-red-400 text-sm font-bold shadow-neu-glow animate-in fade-in slide-in-from-left-2">❌ Ошибка сохранения</span>}
                                    </div>
                                    <button type="submit" disabled={saving} className="neu-button-primary disabled:opacity-50 disabled:shadow-neu w-full sm:w-auto">
                                        {saving ? (
                                            <>
                                                <div className="w-4 h-4 mr-2 rounded-full border-2 border-neu-accent border-t-transparent shadow-neu-glow animate-spin"></div>
                                                Сохранение...
                                            </>
                                        ) : (
                                            'Сохранить изменения'
                                        )}
                                    </button>
                                </div>
                            </form>
                        )}
                    </div>
                </div>
            ) : (
                <div className="neu-panel p-12 text-center flex flex-col items-center">
                    <div className="w-16 h-16 bg-neu-base shadow-neu-inner rounded-full flex items-center justify-center mb-4 text-slate-500">
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
                    </div>
                    <h3 className="text-lg font-medium text-white">Нет привязанного опроса</h3>
                    <p className="text-slate-400 mt-1 max-w-sm mx-auto">Для настройки интеграции необходимо создать хотя бы один опрос для этого бота.</p>
                </div>
            )}
        </div>
    );
}
