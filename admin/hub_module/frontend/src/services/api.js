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
  getCommunityProfile: (id) => api.get(`/api/v1/public/communities/${id}/profile`),
  getLiveStreams: (params) => api.get('/api/v1/public/live', { params }),
  getStreamDetails: (entityId) => api.get(`/api/v1/public/streams/${entityId}`),
  getSignupSettings: () => api.get('/api/v1/public/signup-settings'),
};

export const communityApi = {
  getMyCommunities: () => api.get('/api/v1/communities/my'),
  getDashboard: (id) => api.get(`/api/v1/communities/${id}/dashboard`),
  getLeaderboard: (id, params) => api.get(`/api/v1/communities/${id}/leaderboard`, { params }),
  getActivity: (id, params) => api.get(`/api/v1/communities/${id}/activity`, { params }),
  getEvents: (id, params) => api.get(`/api/v1/communities/${id}/events`, { params }),
  getMemories: (id, params) => api.get(`/api/v1/communities/${id}/memories`, { params }),
  getModules: (id) => api.get(`/api/v1/communities/${id}/modules`),
  getMembers: (id, params) => api.get(`/api/v1/communities/${id}/members`, { params }),
  updateProfile: (id, data) => api.put(`/api/v1/communities/${id}/profile`, data),
  leave: (id) => api.post(`/api/v1/communities/${id}/leave`),
  getChatHistory: (id, params) => api.get(`/api/v1/community/${id}/chat/history`, { params }),
  getChatChannels: (id) => api.get(`/api/v1/community/${id}/chat/channels`),
  // Join functionality
  join: (id, message) => api.post(`/api/v1/communities/${id}/join`, { message }),
  getMyJoinRequests: () => api.get('/api/v1/communities/join-requests'),
  cancelJoinRequest: (requestId) => api.delete(`/api/v1/communities/join-requests/${requestId}`),
  // Server linking (user adding their server)
  addServer: (id, data) => api.post(`/api/v1/communities/${id}/servers`, data),
  getServers: (id) => api.get(`/api/v1/communities/${id}/servers`),
  getMyServerLinkRequests: () => api.get('/api/v1/communities/server-link-requests'),
  cancelServerLinkRequest: (requestId) => api.delete(`/api/v1/communities/server-link-requests/${requestId}`),
  // Activity leaderboards
  getWatchTimeLeaderboard: (id, params) =>
    api.get(`/api/v1/communities/${id}/leaderboard/watch-time`, { params }),
  getMessageLeaderboard: (id, params) =>
    api.get(`/api/v1/communities/${id}/leaderboard/messages`, { params }),
  getMyActivityStats: (id) => api.get(`/api/v1/communities/${id}/activity/my-stats`),
};

export const adminApi = {
  // Community settings
  getSettings: (communityId) => api.get(`/api/v1/admin/${communityId}/settings`),
  updateSettings: (communityId, data) => api.put(`/api/v1/admin/${communityId}/settings`, data),
  // Join requests
  getJoinRequests: (communityId, params) => api.get(`/api/v1/admin/${communityId}/join-requests`, { params }),
  approveJoinRequest: (communityId, requestId, note) =>
    api.post(`/api/v1/admin/${communityId}/join-requests/${requestId}/approve`, { note }),
  rejectJoinRequest: (communityId, requestId, note) =>
    api.post(`/api/v1/admin/${communityId}/join-requests/${requestId}/reject`, { note }),
  // Member management
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
  // Server linking management
  getServers: (communityId, params) => api.get(`/api/v1/admin/${communityId}/servers`, { params }),
  updateServer: (communityId, serverId, data) =>
    api.put(`/api/v1/admin/${communityId}/servers/${serverId}`, data),
  removeServer: (communityId, serverId) =>
    api.delete(`/api/v1/admin/${communityId}/servers/${serverId}`),
  getServerLinkRequests: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/server-link-requests`, { params }),
  approveServerLinkRequest: (communityId, requestId, note) =>
    api.post(`/api/v1/admin/${communityId}/server-link-requests/${requestId}/approve`, { note }),
  rejectServerLinkRequest: (communityId, requestId, note) =>
    api.post(`/api/v1/admin/${communityId}/server-link-requests/${requestId}/reject`, { note }),
  // Mirror groups
  getMirrorGroups: (communityId) => api.get(`/api/v1/admin/${communityId}/mirror-groups`),
  getMirrorGroup: (communityId, groupId) =>
    api.get(`/api/v1/admin/${communityId}/mirror-groups/${groupId}`),
  createMirrorGroup: (communityId, data) =>
    api.post(`/api/v1/admin/${communityId}/mirror-groups`, data),
  updateMirrorGroup: (communityId, groupId, data) =>
    api.put(`/api/v1/admin/${communityId}/mirror-groups/${groupId}`, data),
  deleteMirrorGroup: (communityId, groupId) =>
    api.delete(`/api/v1/admin/${communityId}/mirror-groups/${groupId}`),
  addMirrorGroupMember: (communityId, groupId, data) =>
    api.post(`/api/v1/admin/${communityId}/mirror-groups/${groupId}/members`, data),
  updateMirrorGroupMember: (communityId, groupId, memberId, data) =>
    api.put(`/api/v1/admin/${communityId}/mirror-groups/${groupId}/members/${memberId}`, data),
  removeMirrorGroupMember: (communityId, groupId, memberId) =>
    api.delete(`/api/v1/admin/${communityId}/mirror-groups/${groupId}/members/${memberId}`),
  // Leaderboard configuration
  getLeaderboardConfig: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/leaderboard-config`),
  updateLeaderboardConfig: (communityId, data) =>
    api.put(`/api/v1/admin/${communityId}/leaderboard-config`, data),
  // Community profile management
  updateCommunityProfile: (communityId, data) =>
    api.put(`/api/v1/admin/${communityId}/profile`, data),
  uploadCommunityLogo: (communityId, file) => {
    const formData = new FormData();
    formData.append('logo', file);
    return api.post(`/api/v1/admin/${communityId}/logo`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  deleteCommunityLogo: (communityId) => api.delete(`/api/v1/admin/${communityId}/logo`),
  uploadCommunityBanner: (communityId, file) => {
    const formData = new FormData();
    formData.append('banner', file);
    return api.post(`/api/v1/admin/${communityId}/banner`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  deleteCommunityBanner: (communityId) => api.delete(`/api/v1/admin/${communityId}/banner`),
  // Reputation configuration (FICO-style 300-850 scoring)
  getReputationConfig: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/reputation/config`),
  updateReputationConfig: (communityId, data) =>
    api.put(`/api/v1/admin/${communityId}/reputation/config`, data),
  getAtRiskUsers: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/reputation/at-risk`, { params }),
  getReputationLeaderboard: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/reputation/leaderboard`, { params }),
  // AI Insights
  getAIInsights: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/ai-insights`, { params }),
  getAIInsight: (communityId, insightId) =>
    api.get(`/api/v1/admin/${communityId}/ai-insights/${insightId}`),
  // AI Researcher Config
  getAIResearcherConfig: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/ai-researcher/config`),
  updateAIResearcherConfig: (communityId, data) =>
    api.put(`/api/v1/admin/${communityId}/ai-researcher/config`, data),
  // Bot Detection
  getBotDetections: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/bot-detection`, { params }),
  getBotDetectionResults: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/bot-detection`, { params }),
  reviewBotDetection: (communityId, resultId, data) =>
    api.post(`/api/v1/admin/${communityId}/bot-detection/${resultId}/review`, data),
  markBotDetectionReviewed: (communityId, resultId) =>
    api.post(`/api/v1/admin/${communityId}/bot-detection/${resultId}/mark-reviewed`),
  // Context Visualization
  getAIContext: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/ai-context`),
  // Overlay management
  getOverlay: (communityId) => api.get(`/api/v1/admin/${communityId}/overlay`),
  updateOverlay: (communityId, data) => api.put(`/api/v1/admin/${communityId}/overlay`, data),
  rotateOverlayKey: (communityId) => api.post(`/api/v1/admin/${communityId}/overlay/rotate`),
  getOverlayStats: (communityId) => api.get(`/api/v1/admin/${communityId}/overlay/stats`),
  // Loyalty configuration
  getLoyaltyConfig: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/config`),
  updateLoyaltyConfig: (communityId, data) =>
    api.put(`/api/v1/admin/${communityId}/loyalty/config`, data),
  // Loyalty leaderboard
  getLoyaltyLeaderboard: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/leaderboard`, { params }),
  adjustLoyaltyBalance: (communityId, userId, data) =>
    api.put(`/api/v1/admin/${communityId}/loyalty/user/${userId}/balance`, data),
  wipeLoyaltyCurrency: (communityId) =>
    api.post(`/api/v1/admin/${communityId}/loyalty/wipe`),
  getLoyaltyStats: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/stats`),
  // Loyalty giveaways
  getLoyaltyGiveaways: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/giveaways`, { params }),
  createLoyaltyGiveaway: (communityId, data) =>
    api.post(`/api/v1/admin/${communityId}/loyalty/giveaways`, data),
  getLoyaltyGiveawayEntries: (communityId, giveawayId) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/giveaways/${giveawayId}/entries`),
  drawLoyaltyGiveawayWinner: (communityId, giveawayId) =>
    api.post(`/api/v1/admin/${communityId}/loyalty/giveaways/${giveawayId}/draw`),
  endLoyaltyGiveaway: (communityId, giveawayId) =>
    api.put(`/api/v1/admin/${communityId}/loyalty/giveaways/${giveawayId}/end`),
  // Loyalty games management
  getLoyaltyGamesConfig: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/games/config`),
  updateLoyaltyGamesConfig: (communityId, data) =>
    api.put(`/api/v1/admin/${communityId}/loyalty/games/config`, data),
  getLoyaltyGamesStats: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/games/stats`),
  getLoyaltyGamesRecent: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/games/recent`, { params }),
  // Loyalty gear management
  getLoyaltyGearCategories: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/gear/categories`),
  getLoyaltyGearItems: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/gear/items`, { params }),
  createLoyaltyGearItem: (communityId, data) =>
    api.post(`/api/v1/admin/${communityId}/loyalty/gear/items`, data),
  updateLoyaltyGearItem: (communityId, itemId, data) =>
    api.put(`/api/v1/admin/${communityId}/loyalty/gear/items/${itemId}`, data),
  deleteLoyaltyGearItem: (communityId, itemId) =>
    api.delete(`/api/v1/admin/${communityId}/loyalty/gear/items/${itemId}`),
  getLoyaltyGearStats: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/loyalty/gear/stats`),
  // Announcements
  getAnnouncements: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/announcements`, { params }),
  getAnnouncement: (communityId, announcementId) =>
    api.get(`/api/v1/admin/${communityId}/announcements/${announcementId}`),
  createAnnouncement: (communityId, data) =>
    api.post(`/api/v1/admin/${communityId}/announcements`, data),
  updateAnnouncement: (communityId, announcementId, data) =>
    api.put(`/api/v1/admin/${communityId}/announcements/${announcementId}`, data),
  deleteAnnouncement: (communityId, announcementId) =>
    api.delete(`/api/v1/admin/${communityId}/announcements/${announcementId}`),
  publishAnnouncement: (communityId, announcementId) =>
    api.post(`/api/v1/admin/${communityId}/announcements/${announcementId}/publish`),
  pinAnnouncement: (communityId, announcementId) =>
    api.put(`/api/v1/admin/${communityId}/announcements/${announcementId}/pin`),
  unpinAnnouncement: (communityId, announcementId) =>
    api.put(`/api/v1/admin/${communityId}/announcements/${announcementId}/unpin`),
  archiveAnnouncement: (communityId, announcementId) =>
    api.post(`/api/v1/admin/${communityId}/announcements/${announcementId}/archive`),
  broadcastAnnouncement: (communityId, announcementId, platforms) =>
    api.post(`/api/v1/admin/${communityId}/announcements/${announcementId}/broadcast`, { platforms }),
  getBroadcastStatus: (communityId, announcementId) =>
    api.get(`/api/v1/admin/${communityId}/announcements/${announcementId}/broadcast-status`),
  // Analytics
  getAnalyticsBasic: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/analytics/basic`),
  getAnalyticsPoll: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/analytics/poll`),
  getAnalyticsHealthScore: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/analytics/health-score`),
  getAnalyticsBadActors: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/analytics/bad-actors`, { params }),
  getAnalyticsRetention: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/analytics/retention`),
  // Security
  getSecurityConfig: (communityId) =>
    api.get(`/api/v1/admin/${communityId}/security/config`),
  updateSecurityConfig: (communityId, data) =>
    api.put(`/api/v1/admin/${communityId}/security/config`, data),
  getSecurityBlockedWords: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/security/blocked-words`, { params }),
  addSecurityBlockedWord: (communityId, data) =>
    api.post(`/api/v1/admin/${communityId}/security/blocked-words`, data),
  updateSecurityBlockedWord: (communityId, wordId, data) =>
    api.put(`/api/v1/admin/${communityId}/security/blocked-words/${wordId}`, data),
  deleteSecurityBlockedWord: (communityId, wordId) =>
    api.delete(`/api/v1/admin/${communityId}/security/blocked-words/${wordId}`),
  getSecurityWarnings: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/security/warnings`, { params }),
  getSecurityModerationLog: (communityId, params) =>
    api.get(`/api/v1/admin/${communityId}/security/moderation-log`, { params }),
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

export const superAdminApi = {
  getDashboard: () => api.get('/api/v1/superadmin/dashboard'),
  getCommunities: (params) => api.get('/api/v1/superadmin/communities', { params }),
  getCommunity: (id) => api.get(`/api/v1/superadmin/communities/${id}`),
  createCommunity: (data) => api.post('/api/v1/superadmin/communities', data),
  updateCommunity: (id, data) => api.put(`/api/v1/superadmin/communities/${id}`, data),
  deleteCommunity: (id) => api.delete(`/api/v1/superadmin/communities/${id}`),
  reassignOwner: (id, data) => api.post(`/api/v1/superadmin/communities/${id}/reassign`, data),
  // Module registry
  getAllModules: (params) => api.get('/api/v1/superadmin/marketplace/modules', { params }),
  createModule: (data) => api.post('/api/v1/superadmin/marketplace/modules', data),
  updateModule: (id, data) => api.put(`/api/v1/superadmin/marketplace/modules/${id}`, data),
  publishModule: (id, isPublished) => api.put(`/api/v1/superadmin/marketplace/modules/${id}/publish`, { isPublished }),
  deleteModule: (id) => api.delete(`/api/v1/superadmin/marketplace/modules/${id}`),
  // Platform configuration
  getPlatformConfigs: () => api.get('/api/v1/superadmin/platform-config'),
  updatePlatformConfig: (platform, data) => api.put(`/api/v1/superadmin/platform-config/${platform}`, data),
  testPlatformConnection: (platform) => api.post(`/api/v1/superadmin/platform-config/${platform}/test`),
  // Hub settings
  getHubSettings: () => api.get('/api/v1/superadmin/settings'),
  updateHubSettings: (data) => api.put('/api/v1/superadmin/settings', data),
  // Storage testing
  testStorageConnection: () => api.post('/api/v1/superadmin/platform-config/storage/test'),
};

// Marketplace API
export const marketplaceApi = {
  browseModules: (communityId, params) => api.get(`/api/v1/admin/${communityId}/marketplace/modules`, { params }),
  getModuleDetails: (communityId, moduleId) => api.get(`/api/v1/admin/${communityId}/marketplace/modules/${moduleId}`),
  installModule: (communityId, moduleId) => api.post(`/api/v1/admin/${communityId}/marketplace/modules/${moduleId}/install`),
  uninstallModule: (communityId, moduleId) => api.delete(`/api/v1/admin/${communityId}/marketplace/modules/${moduleId}`),
  configureModule: (communityId, moduleId, data) => api.put(`/api/v1/admin/${communityId}/marketplace/modules/${moduleId}/config`, data),
  addReview: (communityId, moduleId, data) => api.post(`/api/v1/admin/${communityId}/marketplace/modules/${moduleId}/review`, data),
};

// User Identity & Profile API
export const userApi = {
  // Identity management
  getIdentities: () => api.get('/api/v1/user/identities'),
  linkIdentity: (platform) => api.post(`/api/v1/user/identities/link/${platform}`),
  unlinkIdentity: (platform) => api.delete(`/api/v1/user/identities/${platform}`),
  getPrimaryIdentity: () => api.get('/api/v1/user/identities/primary'),
  setPrimaryIdentity: (platform) => api.put('/api/v1/user/identities/primary', { platform }),
  // Profile management
  getMyProfile: () => api.get('/api/v1/user/profile'),
  updateProfile: (data) => api.put('/api/v1/user/profile', data),
  uploadAvatar: (file) => {
    const formData = new FormData();
    formData.append('avatar', file);
    return api.post('/api/v1/user/profile/avatar', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  deleteAvatar: () => api.delete('/api/v1/user/profile/avatar'),
  getLinkedPlatforms: () => api.get('/api/v1/user/linked-platforms'),
  // View other profiles
  getPublicProfile: (userId) => api.get(`/api/v1/public/users/${userId}/profile`),
  getMemberProfile: (communityId, userId) =>
    api.get(`/api/v1/communities/${communityId}/members/${userId}/profile`),
};

// Stream API
export const streamApi = {
  getLiveStreams: (communityId) => api.get(`/api/v1/communities/${communityId}/streams`),
  getFeaturedStreams: (communityId) => api.get(`/api/v1/communities/${communityId}/streams/featured`),
  getStreamDetails: (communityId, entityId) =>
    api.get(`/api/v1/communities/${communityId}/streams/${entityId}`),
};

// Kong Gateway API
export const kongApi = {
  // Status
  getKongStatus: () => api.get('/api/v1/superadmin/kong/status'),

  // Services
  getKongServices: (params) => api.get('/api/v1/superadmin/kong/services', { params }),
  getKongService: (id) => api.get(`/api/v1/superadmin/kong/services/${id}`),
  createKongService: (data) => api.post('/api/v1/superadmin/kong/services', data),
  updateKongService: (id, data) => api.put(`/api/v1/superadmin/kong/services/${id}`, data),
  deleteKongService: (id) => api.delete(`/api/v1/superadmin/kong/services/${id}`),

  // Routes
  getKongRoutes: (params) => api.get('/api/v1/superadmin/kong/routes', { params }),
  getKongRoute: (id) => api.get(`/api/v1/superadmin/kong/routes/${id}`),
  getKongServiceRoutes: (serviceId) => api.get(`/api/v1/superadmin/kong/services/${serviceId}/routes`),
  createKongRoute: (serviceId, data) => api.post(`/api/v1/superadmin/kong/services/${serviceId}/routes`, data),
  updateKongRoute: (id, data) => api.put(`/api/v1/superadmin/kong/routes/${id}`, data),
  deleteKongRoute: (id) => api.delete(`/api/v1/superadmin/kong/routes/${id}`),

  // Plugins
  getKongPlugins: (params) => api.get('/api/v1/superadmin/kong/plugins', { params }),
  getKongPlugin: (id) => api.get(`/api/v1/superadmin/kong/plugins/${id}`),
  createKongPlugin: (data) => api.post('/api/v1/superadmin/kong/plugins', data),
  updateKongPlugin: (id, data) => api.put(`/api/v1/superadmin/kong/plugins/${id}`, data),
  deleteKongPlugin: (id) => api.delete(`/api/v1/superadmin/kong/plugins/${id}`),

  // Consumers
  getKongConsumers: (params) => api.get('/api/v1/superadmin/kong/consumers', { params }),
  getKongConsumer: (id) => api.get(`/api/v1/superadmin/kong/consumers/${id}`),
  createKongConsumer: (data) => api.post('/api/v1/superadmin/kong/consumers', data),
  deleteKongConsumer: (id) => api.delete(`/api/v1/superadmin/kong/consumers/${id}`),

  // Upstreams
  getKongUpstreams: (params) => api.get('/api/v1/superadmin/kong/upstreams', { params }),
  getKongUpstream: (id) => api.get(`/api/v1/superadmin/kong/upstreams/${id}`),
  createKongUpstream: (data) => api.post('/api/v1/superadmin/kong/upstreams', data),
  updateKongUpstream: (id, data) => api.put(`/api/v1/superadmin/kong/upstreams/${id}`, data),
  deleteKongUpstream: (id) => api.delete(`/api/v1/superadmin/kong/upstreams/${id}`),

  // Targets
  getKongTargets: (upstreamId, params) => api.get(`/api/v1/superadmin/kong/upstreams/${upstreamId}/targets`, { params }),
  createKongTarget: (upstreamId, data) => api.post(`/api/v1/superadmin/kong/upstreams/${upstreamId}/targets`, data),
  deleteKongTarget: (upstreamId, targetId) => api.delete(`/api/v1/superadmin/kong/upstreams/${upstreamId}/targets/${targetId}`),

  // Certificates
  getKongCertificates: (params) => api.get('/api/v1/superadmin/kong/certificates', { params }),
  getKongCertificate: (id) => api.get(`/api/v1/superadmin/kong/certificates/${id}`),
  createKongCertificate: (data) => api.post('/api/v1/superadmin/kong/certificates', data),
  deleteKongCertificate: (id) => api.delete(`/api/v1/superadmin/kong/certificates/${id}`),

  // SNIs
  getKongSNIs: (params) => api.get('/api/v1/superadmin/kong/snis', { params }),
  createKongSNI: (data) => api.post('/api/v1/superadmin/kong/snis', data),
  deleteKongSNI: (id) => api.delete(`/api/v1/superadmin/kong/snis/${id}`),
};
