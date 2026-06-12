import { createContext, useState, useEffect, useContext } from 'react';
import { useRouter } from 'next/router';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    useEffect(() => {
        // SSO-lite: the parent CRM embeds this panel in an iframe and injects
        // Basic Auth credentials via `#auth=<base64(user:pass)>`. Read it first
        // and let it OVERWRITE any stale token in localStorage (a token whose
        // password no longer matches ADMIN_PASS would otherwise brick the panel
        // with permanent 401 and no way to re-login). Then strip the hash.
        let injected = null;
        if (typeof window !== 'undefined' && window.location.hash.startsWith('#auth=')) {
            const raw = window.location.hash.slice('#auth='.length);
            injected = decodeURIComponent(raw);
            if (injected) {
                localStorage.setItem('crm_token', injected);
                // Remove the hash so the credential doesn't linger in the URL.
                window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
        }

        const storedToken = injected || localStorage.getItem('crm_token');
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
