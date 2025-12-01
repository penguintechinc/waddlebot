import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Handle 401 errors (token expired)
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const response = await api.post('/api/v1/auth/refresh');
        if (response.data.success) {
          localStorage.setItem('token', response.data.token);
          originalRequest.headers.Authorization = `Bearer ${response.data.token}`;
          return api(originalRequest);
        }
      } catch (refreshError) {
        localStorage.removeItem('token');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;

// API helper functions
export const publicApi = {
  getStats: () => api.get('/api/v1/public/stats'),
  getCommunities: (params) => api.get('/api/v1/public/communities', { params }),
  getCommunity: (id) => api.get(`/api/v1/public/communities/${id}`),
  getLiveStreams: (params) => api.get('/api/v1/public/live', { params }),
  getStreamDetails: (entityId) => api.get(`/api/v1/public/streams/${entityId}`),
};

export const communityApi = {
  getMyCommunities: () => api.get('/api/v1/communities/my'),
  getDashboard: (id) => api.get(`/api/v1/communities/${id}/dashboard`),
  getLeaderboard: (id, params) => api.get(`/api/v1/communities/${id}/leaderboard`, { params }),
  getActivity: (id, params) => api.get(`/api/v1/communities/${id}/activity`, { params }),
  getEvents: (id, params) => api.get(`/api/v1/communities/${id}/events`, { params }),
  getMemories: (id, params) => api.get(`/api/v1/communities/${id}/memories`, { params }),
  getModules: (id) => api.get(`/api/v1/communities/${id}/modules`),
  updateProfile: (id, data) => api.put(`/api/v1/communities/${id}/profile`, data),
  leave: (id) => api.post(`/api/v1/communities/${id}/leave`),
};

export const adminApi = {
  getMembers: (communityId, params) => api.get(`/api/v1/admin/${communityId}/members`, { params }),
  updateMemberRole: (communityId, userId, role) =>
    api.put(`/api/v1/admin/${communityId}/members/${userId}/role`, { role }),
  adjustReputation: (communityId, userId, amount, reason) =>
    api.put(`/api/v1/admin/${communityId}/members/${userId}/reputation`, { amount, reason }),
  removeMember: (communityId, userId, reason) =>
    api.delete(`/api/v1/admin/${communityId}/members/${userId}`, { data: { reason } }),
  getModules: (communityId) => api.get(`/api/v1/admin/${communityId}/modules`),
  updateModuleConfig: (communityId, moduleId, data) =>
    api.put(`/api/v1/admin/${communityId}/modules/${moduleId}/config`, data),
  getBrowserSources: (communityId) => api.get(`/api/v1/admin/${communityId}/browser-sources`),
  regenerateBrowserSources: (communityId, sourceType) =>
    api.post(`/api/v1/admin/${communityId}/browser-sources/regenerate`, { sourceType }),
  getDomains: (communityId) => api.get(`/api/v1/admin/${communityId}/domains`),
  addDomain: (communityId, domain) => api.post(`/api/v1/admin/${communityId}/domains`, { domain }),
  verifyDomain: (communityId, domainId) =>
    api.post(`/api/v1/admin/${communityId}/domains/${domainId}/verify`),
  removeDomain: (communityId, domainId) =>
    api.delete(`/api/v1/admin/${communityId}/domains/${domainId}`),
  generateTempPassword: (communityId, data) =>
    api.post(`/api/v1/admin/${communityId}/temp-password`, data),
};

export const platformApi = {
  getUsers: (params) => api.get('/api/v1/platform/users', { params }),
  getUser: (id) => api.get(`/api/v1/platform/users/${id}`),
  updateUserRole: (id, role) => api.put(`/api/v1/platform/users/${id}/role`, { role }),
  deactivateUser: (id, reason) => api.delete(`/api/v1/platform/users/${id}`, { data: { reason } }),
  getCommunities: (params) => api.get('/api/v1/platform/communities', { params }),
  getCommunity: (id) => api.get(`/api/v1/platform/communities/${id}`),
  updateCommunity: (id, data) => api.put(`/api/v1/platform/communities/${id}`, data),
  deactivateCommunity: (id, reason) =>
    api.delete(`/api/v1/platform/communities/${id}`, { data: { reason } }),
  getHealth: () => api.get('/api/v1/platform/health'),
  getModules: () => api.get('/api/v1/platform/modules'),
  getAuditLog: (params) => api.get('/api/v1/platform/audit-log', { params }),
  getStats: () => api.get('/api/v1/platform/stats'),
};
