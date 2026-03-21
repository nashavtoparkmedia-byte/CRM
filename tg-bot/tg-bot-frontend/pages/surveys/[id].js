import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { fetchSurvey, fetchSurveyAnalytics, fetchSurveyUsers, createQuestion, updateQuestion, updateSurvey, fetchSurveysStats } from '../../lib/api';
import api from '../../lib/api'; // Standard import for export functionality
import CustomSelect from '../../components/CustomSelect';

export default function SurveyBuilder() {
    const router = useRouter();
    const { id: surveyId } = router.query;

    // Survey & Setup State
    const [survey, setSurvey] = useState(null);
    const [questions, setQuestions] = useState([]);
    const [loading, setLoading] = useState(true);

    // Analytics State
    const [analytics, setAnalytics] = useState({
        totalUsers: 0,
        completedUsers: 0,
        completionRate: '0%',
        conversions: []
    });

    // Users (Responses) State
    const [usersList, setUsersList] = useState([]);
    const [surveyVersions, setSurveyVersions] = useState([]);
    const [visibleColumns, setVisibleColumns] = useState({});
    const [showColumnToggle, setShowColumnToggle] = useState(false);
    const [expandedUsers, setExpandedUsers] = useState({});

    const toggleUserExpand = (userId) => {
        setExpandedUsers(prev => ({ ...prev, [userId]: !prev[userId] }));
    };

    // Tabs State (SCENARIO | RESPONSES)
    const [activeTab, setActiveTab] = useState('SCENARIO');

    // Modal State
    const [showModal, setShowModal] = useState(false);
    const [editingQuestion, setEditingQuestion] = useState(null);
    const [showExportModal, setShowExportModal] = useState(false);

    // For branching logic: list of { buttonLabel, nextQuestionId }
    const [branchingRules, setBranchingRules] = useState([]);

    useEffect(() => {
        if (surveyId) loadData();

        if (window.location.hash === '#responses') {
            setActiveTab('RESPONSES');
        }
    }, [surveyId]);

    const loadData = async () => {
        try {
            setLoading(true);
            const data = await fetchSurvey(surveyId);
            setSurvey(data);

            let analyticsData = { totalUsers: 0, completedUsers: 0, completionRate: '0%', conversions: [] };
            let usersData = [];

            if (data && data.id) {
                const [aData, uData, allSurveys] = await Promise.all([
                    fetchSurveyAnalytics(data.id),
                    fetchSurveyUsers(data.id),
                    fetchSurveysStats()
                ]);
                analyticsData = aData;
                usersData = uData;

                const versions = allSurveys
                    .filter(s => s.botId === data.botId && s.triggerButton === data.triggerButton)
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                setSurveyVersions(versions);
            }

            const fetchedQuestions = data.questions || [];
            setQuestions(fetchedQuestions);
            setAnalytics(analyticsData);
            setUsersList(usersData);

            // Visibility Preferences Init
            const savedPrefs = localStorage.getItem(`surveyProps_${surveyId}`);
            let initialPrefs = {};
            if (savedPrefs) {
                try {
                    initialPrefs = JSON.parse(savedPrefs);
                } catch (e) { console.error(e); }
            }

            // Ensure all cols have a default if not in prefs
            const newPrefs = { ...initialPrefs };
            if (newPrefs.firstName === undefined) newPrefs.firstName = true;
            if (newPrefs.username === undefined) newPrefs.username = true;
            if (newPrefs.createdAt === undefined) newPrefs.createdAt = true;

            fetchedQuestions.forEach(q => {
                if (newPrefs[q.id] === undefined) {
                    newPrefs[q.id] = true;
                }
            });
            setVisibleColumns(newPrefs);

        } catch (err) {
            console.error('Error loading survey data:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleToggleColumn = (colKey) => {
        setVisibleColumns(prev => {
            const newPrefs = { ...prev, [colKey]: !prev[colKey] };
            localStorage.setItem(`surveyProps_${surveyId}`, JSON.stringify(newPrefs));
            return newPrefs;
        });
    };

    const executeExport = async (exportAllRequested) => {
        try {
            const dateStr = new Date().toISOString().split('T')[0];
            const suffix = exportAllRequested ? 'all' : 'selected';
            const fileName = `survey_export_${dateStr}_${suffix}.xlsx`;

            // Navigate directly to backend with filename in URL path.
            // Auth middleware supports ?token= query param as fallback.
            // The server returns Content-Disposition: attachment; filename="..."
            // which the browser uses for the download name.
            const token = localStorage.getItem('crm_token');
            const params = new URLSearchParams();
            if (token) params.set('token', token);
            if (exportAllRequested) {
                params.set('all', 'true');
            } else {
                const visibleQIds = questions
                    .filter(q => visibleColumns[q.id])
                    .map(q => q.id)
                    .join(',');
                params.set('columns', visibleQIds);
            }

            const backendUrl = `http://localhost:3001/api/admin/surveys/${surveyId}/export/${encodeURIComponent(fileName)}?${params.toString()}`;
            window.location.assign(backendUrl);

            setShowExportModal(false);
        } catch (error) {
            console.error("Export error:", error);
            alert("Ошибка при выгрузке: " + error.message);
        }
    };

    const [showArchivePrompt, setShowArchivePrompt] = useState(false);

    const handleToggleSurveyAttempt = () => {
        if (survey.isActive) {
            setShowArchivePrompt(true);
        } else {
            // Turning it back ON
            confirmToggle(true, false);
        }
    };

    const confirmToggle = async (isActive, shouldArchive) => {
        try {
            const payload = { ...survey, isActive };
            if (shouldArchive) {
                payload.archivedAt = new Date().toISOString();
            } else if (isActive) {
                payload.archivedAt = null; // Un-archive if turning back on
            } else {
                payload.archivedAt = null; // Just hiding, not archiving
            }
            const updated = await updateSurvey(survey.id, payload);
            setSurvey(updated);
        } catch (err) {
            console.error('Ошибка при изменении статуса:', err);
            alert('Не удалось изменить статус опроса');
        } finally {
            setShowArchivePrompt(false);
        }
    };

    const toggleLinearMode = async () => {
        try {
            const nextMode = !survey.isLinear;
            const updated = await updateSurvey(survey.id, { ...survey, isLinear: nextMode });
            setSurvey(updated);
        } catch (err) {
            console.error(err);
            alert('Ошибка при сохранении режима опроса');
        }
    };

    const openNewQuestion = () => {
        setEditingQuestion({ text: '', type: 'TEXT', isRequired: true });
        setBranchingRules([]);
        setShowModal(true);
    };

    const editQuestion = (q) => {
        const rules = [];
        const options = q.options || [];
        const routingData = q.routingRules || [];

        // If it's branching mode, we reconstruct the rules from options and routingRules
        if (q.type === 'BUTTONS') {
            options.forEach(opt => {
                const rule = routingData.find(r => r.if_answer === opt);
                rules.push({ label: opt, nextId: rule ? rule.next_question_id : '' });
            });
        }

        setEditingQuestion(q);
        setBranchingRules(rules);
        setShowModal(true);
    };

    const addBranchingRule = () => {
        setBranchingRules([...branchingRules, { label: '', nextId: '' }]);
    };

    const updateBranchingRule = (index, field, value) => {
        const newRules = [...branchingRules];
        newRules[index][field] = value;
        setBranchingRules(newRules);
    };

    const removeBranchingRule = (index) => {
        setBranchingRules(branchingRules.filter((_, i) => i !== index));
    };

    const formatVersionName = (version) => {
        const title = version.triggerButton || 'Опрос';
        const start = new Date(version.createdAt).toLocaleDateString('ru-RU');
        const end = version.archivedAt ? new Date(version.archivedAt).toLocaleDateString('ru-RU') : 'наст. время';
        return `${title} (${start} — ${end}) ${version.isActive ? '🔥 Активный' : '📦 Архив'}`;
    };

    const handleSaveQuestion = async (e) => {
        e.preventDefault();
        try {
            let options = null;
            let routingRules = null;

            if (editingQuestion.type === 'BUTTONS') {
                options = branchingRules.map(r => r.label).filter(l => l.trim() !== '');
                routingRules = branchingRules
                    .filter(r => r.label.trim() !== '' && r.nextId !== '')
                    .map(r => ({ if_answer: r.label, next_question_id: r.nextId }));

                if (options.length === 0) {
                    alert('Для кнопок нужно добавить хотя бы один вариант ответа');
                    return;
                }
            }

            const payload = {
                ...editingQuestion,
                surveyId: survey.id,
                options: options,
                routingRules: routingRules
            };

            if (editingQuestion.id) {
                await updateQuestion(editingQuestion.id, payload);
            } else {
                await createQuestion(payload);
            }
            setShowModal(false);
            loadData();
        } catch (err) {
            console.error(err);
            alert('Ошибка при сохранении вопроса');
        }
    };

    if (loading) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="flex flex-col items-center justify-center space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-t-2 border-neu-accent shadow-neu-glow"></div>
                <span className="text-sm text-slate-400 font-medium tracking-wide">Загрузка данных опроса...</span>
            </div>
        </div>
    );
    if (!survey) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="flex flex-col items-center justify-center space-y-4 neu-panel p-12 text-center">
                <div className="w-16 h-16 bg-neu-base shadow-neu-inner rounded-full flex items-center justify-center mb-4 text-slate-500">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                </div>
                <span className="text-lg text-white font-semibold">Опрос не найден</span>
            </div>
        </div>
    );

    return (
        <div className="space-y-6 max-w-7xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
            {/* --- ANALYTICS TOP SECTION --- */}
            {!survey.isActive && (
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-4 mb-6 flex items-center gap-3 backdrop-blur-sm shadow-neu-inner">
                    <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                    <div>
                        <h4 className="text-purple-300 font-bold text-sm">Опрос находится в архиве</h4>
                        <p className="text-purple-400/70 text-xs mt-0.5">Данные доступны только для чтения и выгрузки. Чтобы возобновить опрос, создайте новый период на главной странице.</p>
                    </div>
                </div>
            )}
            <div className="neu-panel p-6 sm:p-8 mb-8">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-6 mb-8">
                    <div className="flex-1 space-y-6">
                        <div className="flex items-center gap-4">
                            <h1 className="text-3xl font-bold tracking-tight text-white drop-shadow-md">Опрос <span className="text-[10px] text-slate-500 font-normal">v2.5</span></h1>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 drop-shadow-sm">Кнопка-триггер (Название опроса)</label>
                            <input
                                type="text"
                                value={survey.triggerButton || ''}
                                onChange={(e) => setSurvey({ ...survey, triggerButton: e.target.value })}
                                onBlur={(e) => updateSurveySettings({ triggerButton: e.target.value })}
                                readOnly={true}
                                className="w-full max-w-md text-2xl sm:text-3xl font-bold text-white bg-transparent border-0 border-b-2 border-white/[0.05] focus:border-neu-accent focus:ring-0 p-0 pb-1 transition-colors outline-none drop-shadow-md placeholder:text-slate-600 cursor-default select-none"
                                placeholder="📊 Опрос качества"
                            />
                            <p className="text-[11px] font-medium text-slate-500 mt-2 ml-1">Точный текст кнопки в боте, который запускает этот опрос</p>
                        </div>
                    </div>

                    {/* Basic Info */}
                    <div className="flex flex-col items-end space-y-3">

                        <div className="text-right flex items-center justify-end gap-3 bg-neu-base shadow-neu px-4 py-3 rounded-xl border border-white/[0.02]">
                            <div className="relative flex items-center justify-center w-3 h-3">
                                <div className={`absolute w-full h-full rounded-full opacity-75 animate-ping ${survey.isActive ? 'bg-emerald-400' : 'bg-red-400'}`}></div>
                                <div className={`relative w-2 h-2 rounded-full ${survey.isActive ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]'}`}></div>
                            </div>
                            <span className={`text-xs font-bold uppercase tracking-wider ${survey.isActive ? 'text-emerald-400' : 'text-red-400'}`}>
                                {survey.isActive ? 'Активен' : 'Отключен'}
                            </span>
                            <div className="w-px h-4 bg-white/[0.05]"></div>
                            <button
                                onClick={handleToggleSurveyAttempt}
                                className="text-xs font-bold text-slate-400 hover:text-white transition-colors"
                            >
                                {survey.isActive ? 'Выключить' : 'Включить'}
                            </button>
                        </div>

                        <div className="text-right flex items-center justify-end gap-3 bg-neu-base shadow-neu px-4 py-3 rounded-xl border border-white/[0.02]">
                            <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${survey.isLinear ? 'text-neu-accent' : 'text-neu-secondary'}`}>
                                {!survey.isLinear && <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
                                {survey.isLinear && <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>}
                                Режим: {survey.isLinear ? 'Линейный' : 'Ветвление'}
                            </span>
                            <div className="w-px h-4 bg-white/[0.05]"></div>
                            <button
                                onClick={toggleLinearMode}
                                disabled={!survey.isActive}
                                className="text-xs font-bold text-slate-400 hover:text-white transition-colors disabled:opacity-50"
                            >
                                Изменить
                            </button>
                        </div>

                    </div>
                </div>

                {/* --- ARCHIVE PROMPT MODAL --- */}
                {showArchivePrompt && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-in fade-in duration-200">
                        <div className="bg-neu-base shadow-[10px_10px_20px_#202227,-10px_-10px_20px_#4a505b] border border-white/[0.05] rounded-2xl max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-200">
                            <div className="px-6 py-5 border-b border-white/[0.05]">
                                <h3 className="text-xl font-bold text-white mb-2 flex items-center gap-3">
                                    <div className="p-2 bg-neu-base shadow-neu-inner text-purple-400 rounded-xl border border-black/20">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                                    </div>
                                    Скрытие опроса
                                </h3>
                                <p className="text-sm text-slate-400">
                                    Вы выключаете опрос. Как поступить с собранными ответами и самим опросом?
                                </p>
                            </div>
                            <div className="p-6 space-y-4">
                                <button
                                    onClick={() => confirmToggle(false, true)}
                                    className="w-full text-left bg-neu-base shadow-neu border border-white/[0.05] hover:border-purple-500/30 p-4 rounded-xl transition-all group"
                                >
                                    <h4 className="font-bold text-purple-400 group-hover:text-purple-300">📦 Архивировать (Рекомендуется)</h4>
                                    <p className="text-xs text-slate-500 mt-1">Опрос переместится в Архив (только чтение). Текущая статистика закроется, и новые ответы в нее не попадут. Вы сможете начать новый период с чистого листа.</p>
                                </button>

                                <button
                                    onClick={() => confirmToggle(false, false)}
                                    className="w-full text-left bg-neu-base shadow-neu border border-white/[0.05] hover:border-slate-500/30 p-4 rounded-xl transition-all group"
                                >
                                    <h4 className="font-bold text-slate-300 group-hover:text-white">🔴 Просто скрыть из бота</h4>
                                    <p className="text-xs text-slate-500 mt-1">Опрос пропадет из меню бота, но останется во вкладке "Активные". Ответы будут записываться в текущую статистику, если вы его потом включите.</p>
                                </button>

                                <button
                                    onClick={() => setShowArchivePrompt(false)}
                                    className="w-full mt-2 py-3 text-sm font-bold text-slate-500 hover:text-white transition-colors"
                                >
                                    Отмена
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
                    {/* Core Stats */}
                    <div className="bg-neu-base shadow-neu-inner border border-black/20 rounded-2xl p-5 relative overflow-hidden group">
                        <div className="absolute -right-4 -top-4 w-16 h-16 bg-blue-500/10 rounded-full blur-xl group-hover:bg-blue-500/20 transition-all duration-500"></div>
                        <div className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2">Всего участников</div>
                        <div className="text-3xl font-black text-white drop-shadow-md">{analytics.totalUsers}</div>
                    </div>
                    <div className="bg-neu-base shadow-neu-inner border border-black/20 rounded-2xl p-5 relative overflow-hidden group">
                        <div className="absolute -right-4 -top-4 w-16 h-16 bg-emerald-500/10 rounded-full blur-xl group-hover:bg-emerald-500/20 transition-all duration-500"></div>
                        <div className="text-emerald-500/80 text-xs font-bold uppercase tracking-wider mb-2">Завершили опрос</div>
                        <div className="text-3xl font-black text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.3)]">{analytics.completedUsers}</div>
                    </div>
                    <div className="bg-neu-base shadow-neu-inner border border-black/20 rounded-2xl p-5 relative overflow-hidden group">
                        <div className="absolute -right-4 -top-4 w-16 h-16 bg-purple-500/10 rounded-full blur-xl group-hover:bg-purple-500/20 transition-all duration-500"></div>
                        <div className="text-purple-500/80 text-xs font-bold uppercase tracking-wider mb-2">Процент завершения</div>
                        <div className="text-3xl font-black text-purple-400 drop-shadow-[0_0_8px_rgba(168,85,247,0.3)]">{analytics.completionRate}</div>
                    </div>

                    {/* Dynamic Conversion Cards */}
                    {analytics.conversions.map((conv, idx) => (
                        <div key={idx} className="bg-neu-base shadow-neu-inner border border-black/20 rounded-2xl p-5 relative overflow-hidden group">
                            <div className="absolute -right-4 -top-4 w-16 h-16 bg-orange-500/10 rounded-full blur-xl group-hover:bg-orange-500/20 transition-all duration-500"></div>
                            <div className="text-orange-400 text-[10px] font-bold uppercase tracking-widest mb-2 flex items-center justify-between opacity-80">
                                <span className="truncate pr-2" title={conv.button_name}>{conv.button_name}</span>
                                <span className="drop-shadow-[0_0_5px_rgba(251,146,60,0.8)]">⚡</span>
                            </div>
                            <div className="flex items-end space-x-2">
                                <div className="text-3xl font-black text-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.3)]">{conv.percentage_of_completed}</div>
                                <div className="text-xs font-bold text-orange-500/80 mb-1.5 bg-black/20 px-2 py-0.5 rounded-md">({conv.click_count} чел)</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* --- TABS NAVIGATION --- */}
            <div className="mb-8">
                <div className="bg-neu-base p-1.5 rounded-2xl shadow-neu-inner inline-flex border border-black/20">
                    <button
                        onClick={() => setActiveTab('SCENARIO')}
                        className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-all duration-300 flex items-center gap-2 ${activeTab === 'SCENARIO' ? 'bg-[#2a2d32] text-white shadow-neu border border-white/[0.05]' : 'text-slate-500 hover:text-slate-300 bg-transparent'}`}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                        Сценарий (Вопросы)
                    </button>
                    <button
                        onClick={() => setActiveTab('RESPONSES')}
                        className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-all duration-300 flex items-center gap-2 ${activeTab === 'RESPONSES' ? 'bg-[#2a2d32] text-white shadow-neu border border-white/[0.05]' : 'text-slate-500 hover:text-slate-300 bg-transparent'}`}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                        База ответов
                        <span className={`px-2 py-0.5 rounded-md text-[10px] ml-1 border ${activeTab === 'RESPONSES' ? 'bg-neu-base border-black/20 shadow-neu-inner text-neu-accent' : 'bg-[#1c1e22] border-black/10 text-slate-500'}`}>{usersList.length}</span>
                    </button>
                </div>
            </div>

            {/* --- TAB CONTENT: SCENARIO --- */}
            {activeTab === 'SCENARIO' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="flex justify-between items-center mt-4">
                        <h2 className="text-xl font-bold text-white drop-shadow-sm">Конструктор сценария</h2>
                        {survey.isActive && (
                            <button onClick={openNewQuestion} className="neu-button-primary !py-2.5">
                                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                                Добавить вопрос
                            </button>
                        )}
                    </div>

                    <div className="neu-panel overflow-hidden">
                        <ul className="divide-y divide-white/[0.05]">
                            {questions.length === 0 && <li className="p-12 text-center text-slate-500 italic">Нет вопросов. Добавьте первый, чтобы начать.</li>}
                            {questions.map((q, index) => (
                                <li key={q.id} className={`p-6 flex items-center justify-between transition-colors group ${survey.isActive ? 'hover:bg-white/[0.02] cursor-pointer' : ''}`} onClick={() => survey.isActive && editQuestion(q)}>
                                    <div className="flex flex-col">
                                        <div className="flex items-center gap-3">
                                            <span className={`flex items-center justify-center w-8 h-8 rounded-full bg-neu-base shadow-neu-inner font-bold text-sm border border-black/20 transition-all ${survey.isActive ? 'text-neu-accent group-hover:shadow-neu-glow' : 'text-slate-500'}`}>
                                                {index + 1}
                                            </span>
                                            <span className={`text-lg font-bold transition-colors ${survey.isActive ? 'text-slate-200 group-hover:text-white' : 'text-slate-400'}`}>{q.text}</span>
                                        </div>
                                        <div className="flex items-center mt-3 space-x-3 text-xs font-semibold text-slate-500 ml-11">
                                            <span className="bg-neu-base px-2.5 py-1 rounded-md shadow-neu-inner border border-black/20 uppercase tracking-wider text-[10px] text-slate-400">{q.type}</span>
                                            <span className="flex items-center gap-1">
                                                <div className={`w-1.5 h-1.5 rounded-full ${q.isRequired ? (survey.isActive ? 'bg-red-400' : 'bg-red-900') : 'bg-slate-500'}`}></div>
                                                {q.isRequired ? 'Обязательный' : 'Необязательный'}
                                            </span>
                                            {!survey.isLinear && q.type === 'BUTTONS' && (
                                                <span className={`${survey.isActive ? 'text-neu-accent' : 'text-slate-600'} flex items-center gap-1`}>
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                    {q.options?.length || 0} кнопок с правилами
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    {survey.isActive && (
                                        <div className="text-sm font-bold text-slate-500 group-hover:text-neu-accent group-hover:drop-shadow-[0_0_5px_rgba(56,189,248,0.5)] transition-all">Изменить</div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>

                    {showModal && editingQuestion && (
                        <div className="fixed z-50 inset-0 overflow-y-auto bg-background/80 backdrop-blur-md flex items-center justify-center p-4">
                            <div className="bg-neu-base shadow-[10px_10px_20px_#15171a,-10px_-10px_20px_#2f333a] border border-white/[0.05] rounded-2xl p-8 max-w-3xl w-full animate-in zoom-in-95 duration-200">
                                <h3 className="text-2xl font-bold text-white mb-6 border-b border-white/[0.05] pb-4 drop-shadow-sm flex items-center gap-3">
                                    <div className="p-2 bg-neu-base shadow-neu-inner text-neu-accent rounded-xl border border-black/20">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                    </div>
                                    {editingQuestion.id ? 'Настройка вопроса' : 'Создание вопроса'}
                                </h3>
                                <form onSubmit={handleSaveQuestion} className="space-y-6">
                                    <div>
                                        <label className="block text-sm font-bold text-slate-400 mb-2">Текст вопроса в боте</label>
                                        <textarea required className="w-full neu-input focus:ring-neu-accent focus:shadow-neu-glow resize-y min-h-[100px]" rows="3"
                                            placeholder="Введите текст, который увидит пользователь..."
                                            value={editingQuestion.text} onChange={e => setEditingQuestion({ ...editingQuestion, text: e.target.value })} />
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div>
                                            <label className="block text-sm font-bold text-slate-400 mb-2">Тип ответа</label>
                                            <CustomSelect
                                                value={editingQuestion.type}
                                                onChange={(val) => setEditingQuestion({ ...editingQuestion, type: val })}
                                                options={[
                                                    { value: 'TEXT', label: 'Текстовый ответ' },
                                                    { value: 'BUTTONS', label: 'Кнопки (выбор варианта)' },
                                                    { value: 'NUMBER', label: 'Цифровой ввод' },
                                                ]}
                                            />
                                        </div>
                                        <div className="flex flex-col space-y-4 justify-center md:mt-7">
                                            <div className="neu-panel-inner p-3 flex items-center justify-between border border-black/10">
                                                <label className="text-sm font-bold text-slate-300 cursor-pointer">Обязательный вопрос</label>
                                                <label className="relative inline-flex items-center cursor-pointer">
                                                    <input type="checkbox" className="sr-only peer" checked={editingQuestion.isRequired}
                                                        onChange={e => setEditingQuestion({ ...editingQuestion, isRequired: e.target.checked })} />
                                                    <div className="w-11 h-6 bg-[#191b1f] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-300 after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-neu-accent shadow-neu-inner"></div>
                                                </label>
                                            </div>

                                            <div className="neu-panel-inner p-3 flex items-center justify-between border border-black/10 transition-opacity">
                                                <label className="text-sm font-bold text-slate-300 cursor-pointer flex items-center gap-2">Считать конверсией <span className="drop-shadow-[0_0_5px_rgba(251,146,60,0.8)]">⚡</span></label>
                                                <label className="relative inline-flex items-center cursor-pointer">
                                                    <input type="checkbox" className="sr-only peer" checked={!!editingQuestion.isConversion}
                                                        onChange={e => setEditingQuestion({ ...editingQuestion, isConversion: e.target.checked })} />
                                                    <div className="w-11 h-6 bg-[#191b1f] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-300 after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500 shadow-neu-inner"></div>
                                                </label>
                                            </div>
                                        </div>
                                    </div>

                                    {editingQuestion.type === 'BUTTONS' && (
                                        <div className="neu-panel-inner p-6 mt-6 border border-black/20 relative">
                                            <div className="flex justify-between items-center mb-6">
                                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                                    <svg className="w-5 h-5 text-neu-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
                                                    Варианты ответов
                                                </h4>
                                                <button type="button" onClick={addBranchingRule} className="text-xs font-bold text-neu-accent hover:text-white transition-colors flex items-center gap-1">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                                                    Добавить вариант
                                                </button>
                                            </div>

                                            <div className="space-y-4">
                                                {branchingRules.map((rule, idx) => (
                                                    <div key={idx} className="flex flex-col sm:flex-row items-center gap-3 bg-neu-base p-3 rounded-xl shadow-neu border border-white/[0.02]">
                                                        <input required className="w-full sm:flex-1 neu-input focus:ring-neu-accent text-sm py-2" placeholder="Текст на кнопке"
                                                            value={rule.label} onChange={e => updateBranchingRule(idx, 'label', e.target.value)} />

                                                        {!survey.isLinear && (
                                                            <CustomSelect
                                                                value={rule.nextId}
                                                                onChange={(val) => updateBranchingRule(idx, 'nextId', val)}
                                                                options={[
                                                                    { value: '', label: 'Следующий по порядку' },
                                                                    ...questions.filter(q => q.id !== editingQuestion.id).map(q => ({
                                                                        value: q.id,
                                                                        label: q.text.substring(0, 35) + (q.text.length > 35 ? '...' : '')
                                                                    })),
                                                                    { value: 'END', label: '🏁 Завершить опрос', className: 'text-red-400' },
                                                                ]}
                                                                className="w-full sm:flex-1"
                                                            />
                                                        )}

                                                        <button type="button" onClick={() => removeBranchingRule(idx)} className="w-full sm:w-auto neu-button !py-2 hover:!text-red-400">
                                                            <svg className="w-5 h-5 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                                        </button>
                                                    </div>
                                                ))}
                                                {branchingRules.length === 0 && <p className="text-sm text-center text-slate-500 font-medium py-4">Добавьте хотя бы одну кнопку</p>}
                                            </div>
                                            {!survey.isLinear && (
                                                <p className="mt-4 text-[11px] font-medium text-slate-500">
                                                    * В режиме ветвления вы указываете, на какой вопрос перейдет бот при нажатии конкретной кнопки. Если выбрано "Завершить опрос", бот поблагодарит пользователя и закончит анкету.
                                                </p>
                                            )}
                                        </div>
                                    )}

                                    {editingQuestion.type !== 'BUTTONS' && (
                                        <div className="neu-panel-inner p-5 mt-6 border border-black/20 relative flex items-start gap-4">
                                            <div className="p-2 bg-neu-base rounded-xl shadow-neu-inner text-neu-accent shrink-0 border border-black/20">
                                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            </div>
                                            <div>
                                                <p className="text-sm font-bold text-white mb-2">
                                                    {editingQuestion.type === 'TEXT' ? 'Ожидается любой текст' : 'Ожидается конкретное число (строго)'}
                                                </p>
                                                <p className="text-xs text-slate-400 leading-relaxed">
                                                    {editingQuestion.type === 'TEXT'
                                                        ? 'Бот запишет любое присланное сообщение как ответ.'
                                                        : 'Бот не переключится на следующий вопрос, пока пользователь не введет именно ЦИФРЫ (например "120" или "500"). Любой другой текст будет считаться ошибкой.'}
                                                    <br /><br />
                                                    Вам <strong className="text-slate-300">не нужно добавлять кнопки или варианты ответа</strong>. После того как пользователь отправит {editingQuestion.type === 'TEXT' ? 'текстовое сообщение' : 'цифры'} в чат, бот автоматически сохранит ответ и перейдет к следующему вопросу (или завершит опрос, если вопросов больше нет).
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    <div className="pt-8 flex justify-end gap-4 border-t border-white/[0.05]">
                                        <button type="button" onClick={() => setShowModal(false)} className="neu-button">
                                            Отмена
                                        </button>
                                        <button type="submit" className="neu-button-primary">
                                            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                            Сохранить
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* --- TAB CONTENT: RESPONSES --- */}
            {activeTab === 'RESPONSES' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mt-4">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                            <h2 className="text-xl font-bold text-white drop-shadow-sm">Ответы пользователей</h2>
                            {surveyVersions.length > 0 && (
                                <CustomSelect
                                    value={survey.id}
                                    onChange={(val) => {
                                        setLoading(true);
                                        router.push(`/surveys/${val}#responses`);
                                    }}
                                    options={surveyVersions.map(v => ({
                                        value: v.id,
                                        label: formatVersionName(v)
                                    }))}
                                    className="w-72"
                                    compact
                                />
                            )}
                        </div>
                        <div className="flex gap-4">
                            <div className="relative">
                                <button
                                    onClick={() => setShowColumnToggle(!showColumnToggle)}
                                    className="neu-button !py-2.5"
                                >
                                    <svg className="w-5 h-5 mr-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                    Столбцы
                                </button>
                                {showColumnToggle && (
                                    <div className="absolute right-0 mt-2 w-72 bg-neu-base shadow-[10px_10px_20px_#15171a,-10px_-10px_20px_#2f333a] rounded-xl z-20 border border-white/[0.05] animate-in slide-in-from-top-2 duration-200">
                                        <div className="p-4 max-h-96 overflow-y-auto custom-scrollbar">
                                            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Основные</h3>
                                            <label className="flex items-center space-x-3 mb-3 cursor-pointer group">
                                                <input type="checkbox" checked={visibleColumns.firstName} onChange={() => handleToggleColumn('firstName')} className="w-4 h-4 rounded bg-[#191b1f] border-black/20 text-neu-accent focus:ring-neu-accent focus:ring-offset-0 shadow-neu-inner" />
                                                <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">Имя</span>
                                            </label>
                                            <label className="flex items-center space-x-3 mb-3 cursor-pointer group">
                                                <input type="checkbox" checked={visibleColumns.username} onChange={() => handleToggleColumn('username')} className="w-4 h-4 rounded bg-[#191b1f] border-black/20 text-neu-accent focus:ring-neu-accent focus:ring-offset-0 shadow-neu-inner" />
                                                <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">Username</span>
                                            </label>
                                            <label className="flex items-center space-x-3 mb-4 cursor-pointer group">
                                                <input type="checkbox" checked={visibleColumns.createdAt} onChange={() => handleToggleColumn('createdAt')} className="w-4 h-4 rounded bg-[#191b1f] border-black/20 text-neu-accent focus:ring-neu-accent focus:ring-offset-0 shadow-neu-inner" />
                                                <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">Дата завершения</span>
                                            </label>

                                            {questions.length > 0 && (
                                                <>
                                                    <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 border-t border-white/[0.05] pt-4">Вопросы опроса</h3>
                                                    {questions.map(q => (
                                                        <label key={q.id} className="flex items-center space-x-3 mb-3 cursor-pointer group">
                                                            <input
                                                                type="checkbox"
                                                                checked={visibleColumns[q.id] || false}
                                                                onChange={() => handleToggleColumn(q.id)}
                                                                className="w-4 h-4 rounded bg-[#191b1f] border-black/20 text-neu-accent focus:ring-neu-accent focus:ring-offset-0 shadow-neu-inner"
                                                            />
                                                            <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors truncate" title={q.text}>{q.text}</span>
                                                        </label>
                                                    ))}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={() => setShowExportModal(true)}
                                className="neu-button !py-2.5 !text-emerald-400 hover:!text-emerald-300 border-emerald-500/20"
                            >
                                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                Экспорт Excel
                            </button>
                        </div>
                    </div>

                    <div className="neu-panel overflow-hidden overflow-x-auto">
                        <table className="min-w-full divide-y divide-white/[0.02]">
                            <thead className="bg-[#1c1e22]/50 border-b border-black/20">
                                <tr>
                                    {visibleColumns.firstName && <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap drop-shadow-sm">Имя</th>}
                                    {visibleColumns.username && <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap drop-shadow-sm">Username</th>}
                                    {visibleColumns.createdAt && <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap drop-shadow-sm">Дата</th>}

                                    {questions.map(q => (
                                        visibleColumns[q.id] && (
                                            <th key={q.id} scope="col" className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider max-w-[200px] truncate drop-shadow-sm" title={q.text}>
                                                {q.text}
                                            </th>
                                        )
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="bg-transparent divide-y divide-white/[0.02]">
                                {usersList.length === 0 ? (
                                    <tr>
                                        <td colSpan="100%" className="px-6 py-16 text-center">
                                            <div className="flex flex-col items-center justify-center text-slate-500">
                                                <svg className="w-12 h-12 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
                                                <span className="font-medium">Ответов пока нет</span>
                                            </div>
                                        </td>
                                    </tr>
                                ) : (
                                    usersList.map((user) => {
                                        const userAnswersMap = {};

                                        // 1. Initial mapping from current answers
                                        if (user.answers && Array.isArray(user.answers)) {
                                            user.answers.forEach(ans => {
                                                userAnswersMap[ans.questionId] = ans.value;
                                            });
                                        }

                                        const multiplePasses = user.surveyHistory && user.surveyHistory.length > 1;
                                        const hasCurrentAnswers = user.answers && user.answers.length > 0;
                                        const latestHistory = (user.surveyHistory && user.surveyHistory.length >= 1) ? user.surveyHistory[0] : null;

                                        // 2. Fallback to latest history metadata if no current answers
                                        if (!hasCurrentAnswers && latestHistory && latestHistory.metadata) {
                                            try {
                                                const meta = typeof latestHistory.metadata === 'string' ? JSON.parse(latestHistory.metadata) : latestHistory.metadata;
                                                Object.keys(meta).forEach(qId => {
                                                    userAnswersMap[qId] = meta[qId];
                                                });
                                            } catch (e) { }
                                        }

                                        return (
                                            <React.Fragment key={user.id}>
                                                <tr
                                                    onClick={() => { if (multiplePasses) toggleUserExpand(user.id); }}
                                                    className={`hover:bg-white/[0.04] transition-colors group ${multiplePasses ? 'cursor-pointer' : ''} ${expandedUsers[user.id] ? 'bg-white/[0.03]' : ''}`}
                                                >
                                                    {visibleColumns.firstName && (
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-slate-200 group-hover:text-white transition-colors relative">
                                                            <div className="flex items-center gap-3">
                                                                <span className="truncate">{user.firstName || '-'}</span>
                                                                {multiplePasses && (
                                                                    <span className="inline-flex items-center gap-1.5 bg-orange-500/10 border border-orange-500/20 text-orange-400 text-[10px] px-2.5 py-0.5 rounded-full whitespace-nowrap drop-shadow-[0_0_5px_rgba(251,146,60,0.3)] shadow-neu-inner">
                                                                        🔥 {user.surveyHistory.length} попыток
                                                                        <svg className={`w-3.5 h-3.5 transition-transform duration-300 ${expandedUsers[user.id] ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </td>
                                                    )}
                                                    {visibleColumns.username && <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-400 group-hover:text-neu-accent transition-colors">{user.username ? `@${user.username}` : '-'}</td>}
                                                    {visibleColumns.createdAt && <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500 group-hover:text-slate-300 transition-colors">{new Date(user.createdAt).toLocaleDateString('ru-RU')}</td>}

                                                    {questions.map(q => {
                                                        if (!visibleColumns[q.id]) return null;
                                                        const answerValue = userAnswersMap[q.id];
                                                        return (
                                                            <td key={q.id} className="px-6 py-4 text-sm font-medium text-slate-400 max-w-[250px] truncate relative group/cell cursor-default">
                                                                {answerValue ? (
                                                                    <span title={answerValue}>{answerValue}</span>
                                                                ) : !hasCurrentAnswers && latestHistory ? (
                                                                    <span className="text-slate-600 italic text-[10px]">см. историю</span>
                                                                ) : (
                                                                    <span>-</span>
                                                                )}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                                {/* History Accordion Details */}
                                                {multiplePasses && expandedUsers[user.id] && (
                                                    <tr className="bg-black/20 border-t border-b border-black/40">
                                                        <td colSpan="100%" className="p-0">
                                                            <div className="overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300 py-6 px-8 bg-gradient-to-br from-orange-500/[0.02] to-transparent">
                                                                <div className="flex items-center gap-3 mb-5">
                                                                    <div className="h-6 w-1 bg-orange-500 rounded-full shadow-[0_0_8px_rgba(251,146,60,0.5)]"></div>
                                                                    <h4 className="text-sm font-bold text-orange-400 tracking-wide uppercase">История ответов</h4>
                                                                </div>
                                                                <div className="space-y-4">
                                                                    {user.surveyHistory.map((histRow, hIdx) => {
                                                                        let meta = {};
                                                                        if (histRow.metadata) {
                                                                            try { meta = typeof histRow.metadata === 'string' ? JSON.parse(histRow.metadata) : histRow.metadata; } catch (e) { }
                                                                        }
                                                                        return (
                                                                            <div key={histRow.id} className="flex flex-col lg:flex-row gap-6 bg-neu-base/60 p-5 rounded-2xl shadow-neu-inner border border-orange-500/10 hover:border-orange-500/30 transition-colors">
                                                                                <div className="shrink-0 w-40 lg:border-r border-white/[0.05] lg:pr-6">
                                                                                    <div className="text-[10px] font-bold text-orange-500/70 uppercase tracking-widest mb-1.5 flex items-center gap-2">
                                                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                                                                        Попытка {user.surveyHistory.length - hIdx}
                                                                                    </div>
                                                                                    <div className="text-sm font-bold text-slate-200">
                                                                                        {new Date(histRow.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                                                                    </div>
                                                                                </div>
                                                                                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-y-5 gap-x-8">
                                                                                    {questions.map(q => (
                                                                                        <div key={q.id}>
                                                                                            <div className="text-[10px] font-bold text-slate-500 mb-1.5 truncate border-b border-white/[0.05] pb-1 inline-block pr-4" title={q.text}>{q.text}</div>
                                                                                            <div className="text-sm font-medium text-slate-200 bg-[#16181b] px-3 py-2 rounded-lg border border-white/[0.02]">
                                                                                                {meta[q.id] || <span className="text-slate-600 italic font-normal text-xs">Нет ответа</span>}
                                                                                            </div>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* --- EXPORT MODAL (MOVED TO ROOT FOR CLICK SAFETY) --- */}
            {showExportModal && (
                <div
                    className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-xl flex items-center justify-center p-4"
                    style={{ zIndex: 2147483647, pointerEvents: 'auto' }}
                >
                    <div
                        onClick={(e) => {
                            e.stopPropagation();
                        }}
                        className="bg-[#1c1e22] shadow-[20px_20px_60px_#111215,-20px_-20px_60px_#272a2f] border border-white/10 rounded-3xl p-8 max-w-md w-full animate-in zoom-in-95 duration-200"
                    >
                        <h3 className="text-xl font-bold text-white mb-4 border-b border-white/5 pb-4 flex items-center gap-3">
                            <div className="p-2.5 bg-neu-base shadow-neu-inner text-emerald-400 rounded-xl border border-black/20">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            </div>
                            Настройки экспорта
                        </h3>

                        <p className="text-sm font-medium text-slate-400 mb-8 leading-relaxed">Выберите метод формирования Excel файла.</p>

                        <div className="space-y-4">
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    executeExport(false);
                                }}
                                className="w-full text-left p-6 rounded-2xl bg-[#2a2d32] border border-white/10 hover:border-neu-accent hover:bg-neutral-800 transition-all cursor-pointer flex items-center gap-5 group"
                            >
                                <div className="w-12 h-12 rounded-xl bg-neu-base shadow-neu-inner flex items-center justify-center text-neu-accent border border-white/5 shrink-0">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                </div>
                                <div>
                                    <div className="font-bold text-white text-lg group-hover:text-neu-accent transition-colors">Выбранные столбцы</div>
                                    <div className="text-sm text-slate-500 font-medium">Только видимые данные</div>
                                </div>
                            </button>

                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    executeExport(true);
                                }}
                                className="w-full text-left p-6 rounded-2xl bg-[#2a2d32] border border-white/10 hover:border-emerald-500 hover:bg-neutral-800 transition-all cursor-pointer flex items-center gap-5 group"
                            >
                                <div className="w-12 h-12 rounded-xl bg-neu-base shadow-neu-inner flex items-center justify-center text-emerald-400 border border-white/5 shrink-0">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>
                                </div>
                                <div>
                                    <div className="font-bold text-white text-lg group-hover:text-emerald-400 transition-colors">Все столбцы</div>
                                    <div className="text-sm text-slate-500 font-medium">Полная выгрузка данных</div>
                                </div>
                            </button>
                        </div>

                        <div className="mt-8 pt-6 border-t border-white/5 flex justify-end">
                            <button
                                type="button"
                                onClick={() => setShowExportModal(false)}
                                className="px-6 py-2.5 rounded-xl bg-neutral-800 text-slate-300 font-bold hover:text-white transition-all border border-white/5"
                            >
                                Отмена
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
