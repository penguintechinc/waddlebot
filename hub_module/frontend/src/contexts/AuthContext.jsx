import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Check for existing session on mount
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      fetchCurrentUser();
    } else {
      setLoading(false);
    }
  }, []);

  const fetchCurrentUser = async () => {
    try {
      const response = await api.get('/api/v1/auth/me');
      if (response.data.success && response.data.user) {
        setUser(response.data.user);
      } else {
        localStorage.removeItem('token');
      }
    } catch (err) {
      console.error('Failed to fetch user:', err);
      localStorage.removeItem('token');
    } finally {
      setLoading(false);
    }
  };

  const loginWithOAuth = useCallback(async (platform) => {
    try {
      const response = await api.get(`/api/v1/auth/oauth/${platform}`);
      if (response.data.authorizeUrl) {
        window.location.href = response.data.authorizeUrl;
      }
    } catch (err) {
      setError(err.response?.data?.error || 'OAuth login failed');
      throw err;
    }
  }, []);

  const loginWithTempPassword = useCallback(async (identifier, password) => {
    try {
      setError(null);
      const response = await api.post('/api/v1/auth/temp-login', { identifier, password });
      if (response.data.success) {
        localStorage.setItem('token', response.data.token);
        await fetchCurrentUser();
        return response.data;
      }
    } catch (err) {
      const message = err.response?.data?.error || 'Login failed';
      setError(message);
      throw new Error(message);
    }
  }, []);

  const handleOAuthCallback = useCallback(async (token) => {
    if (token) {
      localStorage.setItem('token', token);
      await fetchCurrentUser();
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      localStorage.removeItem('token');
      setUser(null);
    }
  }, []);

  const refreshToken = useCallback(async () => {
    try {
      const response = await api.post('/api/v1/auth/refresh');
      if (response.data.success) {
        localStorage.setItem('token', response.data.token);
      }
    } catch (err) {
      console.error('Token refresh failed:', err);
      logout();
    }
  }, [logout]);

  const value = {
    user,
    loading,
    error,
    loginWithOAuth,
    loginWithTempPassword,
    handleOAuthCallback,
    logout,
    refreshToken,
    isAuthenticated: !!user,
    isPlatformAdmin: user?.roles?.includes('platform-admin'),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
