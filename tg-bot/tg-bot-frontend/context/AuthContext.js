import { createContext, useState, useEffect, useContext } from 'react';
import { useRouter } from 'next/router';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
    const [authenticated, setAuthenticated] = useState(false);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    useEffect(() => {
        let active = true;
        fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
            .then(response => {
                if (active) setAuthenticated(response.ok);
            })
            .catch(() => {
                if (active) setAuthenticated(false);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, []);

    const login = async (username, password) => {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        if (!response.ok) {
            setAuthenticated(false);
            throw new Error(response.status === 401 ? 'Неверный логин или пароль' : 'Сервис авторизации недоступен');
        }
        setAuthenticated(true);
        await router.push('/');
    };

    const logout = async () => {
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } finally {
            setAuthenticated(false);
            await router.push('/login');
        }
    };

    return (
        <AuthContext.Provider value={{ authenticated, loading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
