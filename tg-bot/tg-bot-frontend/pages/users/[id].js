import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { fetchUserAnswers, sendMessageToUser } from '../../lib/api';

export default function UserDetail() {
    const router = useRouter();
    const { id } = router.query;

    const [answers, setAnswers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [messageText, setMessageText] = useState('');
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (id) loadData();
    }, [id]);

    const loadData = async () => {
        try {
            const data = await fetchUserAnswers(id);
            setAnswers(data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        setSending(true);
        try {
            await sendMessageToUser(id, messageText);
            alert('Сообщение отправлено!');
            setMessageText('');
        } catch (err) {
            alert('Ошибка отправки');
        } finally {
            setSending(false);
        }
    };

    if (loading) return <div>Загрузка...</div>;

    return (
        <div className="space-y-6 max-w-4xl mx-auto">
            <h1 className="text-2xl font-bold text-gray-900">Детали пользователя (История ответов)</h1>

            <div className="bg-white shadow overflow-hidden sm:rounded-lg">
                <ul className="divide-y divide-gray-200">
                    {answers.length === 0 && <li className="p-4 text-gray-500">Пользователь пока не дал ни одного ответа</li>}
                    {answers.map((answer, i) => (
                        <li key={answer.id} className="p-4">
                            <p className="text-sm font-medium text-gray-900">Вопрос {i + 1}: {answer.question?.text || 'Удаленный вопрос'}</p>
                            <p className="text-sm text-gray-500 mt-1">Ответ: <span className="text-indigo-600 font-semibold">{answer.value}</span></p>
                            <p className="text-xs text-gray-400 mt-1">{new Date(answer.createdAt).toLocaleString()}</p>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="bg-white shadow sm:rounded-lg p-6">
                <h3 className="text-lg font-medium text-gray-900">Отправить сообщение вручную</h3>
                <form className="mt-4" onSubmit={handleSendMessage}>
                    <textarea
                        rows="3" required
                        className="block w-full border border-gray-300 rounded-md p-2"
                        value={messageText}
                        onChange={e => setMessageText(e.target.value)}
                        placeholder="Напишите сообщение, которое придет пользователю в Telegram от имени бота..."
                    />
                    <button disabled={sending} type="submit" className="mt-3 inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400">
                        {sending ? 'Отправка...' : 'Отправить'}
                    </button>
                </form>
            </div>

        </div>
    );
}
