import { createContext, useState, useEffect, useContext } from 'react';
import { useRouter } from 'next/router';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    useEffect(() => {
        // Check if token exists on load
        const storedToken = localStorage.getItem('crm_token');
        if (storedToken) {
            setToken(storedToken);
        }
        setLoading(false);
    }, []);

    const login = (username, password) => {
        // For MVP, simply base64 encode for Basic Auth.
        // In production, this would call an API to get a JWT.
        const credentials = Buffer.from(`${username}:${password}`).toString('base64');
        localStorage.setItem('crm_token', credentials);
        setToken(credentials);
        router.push('/');
    };

    const logout = () => {
        localStorage.removeItem('crm_token');
        setToken(null);
        router.push('/login');
    };

    return (
        <AuthContext.Provider value={{ token, loading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
