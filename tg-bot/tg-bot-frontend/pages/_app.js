import "@/styles/globals.css";
import { AuthProvider, useAuth } from '../context/AuthContext';
import Layout from '../components/Layout';
import { useRouter } from 'next/router';

function AuthGuard({ children }) {
  const { authenticated, loading } = useAuth();
  const router = useRouter();

  if (loading) return <div>Загрузка...</div>;

  if (!authenticated && router.pathname !== '/login') {
    router.push('/login');
    return null;
  }

  if (router.pathname === '/login') {
    return children;
  }

  return <Layout>{children}</Layout>;
}

export default function App({ Component, pageProps }) {
  return (
    <AuthProvider>
      <AuthGuard>
        <Component {...pageProps} />
      </AuthGuard>
    </AuthProvider>
  );
}
