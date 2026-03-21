import axios from 'axios';

const API_BASE = 'http://localhost:3001/api/admin';

// Create an axios instance
const api = axios.create({
    baseURL: API_BASE,
    headers: {
        'Content-Type': 'application/json',
    },
});

// Intercept requests to add Basic Auth header
api.interceptors.request.use(
    (config) => {
        // In a real app, prefer HttpOnly Cookies or JWT. 
        // Here we use Base64 Basic Auth stored in localStorage per MVP spec.
        const token = typeof window !== 'undefined' ? localStorage.getItem('crm_token') : null;
        if (token) {
            config.headers['Authorization'] = `Basic ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// --- BOTS ---
export const fetchBots = async () => (await api.get('/bots')).data;
export const fetchBot = async (id) => (await api.get(`/bots/${id}`)).data;
export const createBot = async (data) => (await api.post('/bots', data)).data;
export const updateBot = async (id, data) => (await api.put(`/bots/${id}`, data)).data;

// --- SURVEYS & QUESTIONS ---
export const fetchSurvey = async (surveyId) => (await api.get(`/surveys/${surveyId}`)).data;
export const updateSurvey = async (surveyId, data) => (await api.put(`/surveys/${surveyId}`, data)).data;
export const createQuestion = async (data) => (await api.post('/questions', data)).data;
export const updateQuestion = async (id, data) => (await api.put(`/questions/${id}`, data)).data;
export const reorderQuestions = async (orderedIds) => (await api.put('/questions/reorder', { orderedIds })).data;

// --- USERS & ANALYTICS ---
export const fetchUsers = async (params) => (await api.get('/users', { params })).data;
export const fetchUserAnswers = async (id) => (await api.get(`/users/${id}/answers`)).data;
export const sendMessageToUser = async (id, text) => (await api.post(`/users/${id}/message`, { text })).data;
export const fetchSurveyAnalytics = async (surveyId) => (await api.get(`/surveys/${surveyId}/analytics`)).data;
export const fetchSurveyUsers = async (surveyId) => (await api.get(`/surveys/${surveyId}/users`)).data;
export const fetchSurveysStats = async () => (await api.get('/surveys')).data;

// --- BROADCAST ---
export const broadcastMessage = async (data) => (await api.post('/users/broadcast', data)).data;

export default api;
