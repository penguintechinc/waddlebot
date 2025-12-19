import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';

// Layouts
import PublicLayout from './layouts/PublicLayout';
import DashboardLayout from './layouts/DashboardLayout';
import AdminLayout from './layouts/AdminLayout';

// Public pages
import HomePage from './pages/public/HomePage';
import CommunitiesPage from './pages/public/CommunitiesPage';
import CommunityPublicPage from './pages/public/CommunityPublicPage';
import LiveStreamsPage from './pages/public/LiveStreamsPage';
import UserPublicProfile from './pages/public/UserPublicProfile';

// Auth pages
import LoginPage from './pages/auth/LoginPage';
import OAuthCallback from './pages/auth/OAuthCallback';

// Cookie Policy page
import CookiePolicy from './pages/CookiePolicy';

      </Route>

      {/* Dashboard routes (authenticated) */}
      <Route
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardHome />} />
        <Route path="/dashboard/settings" element={<AccountSettings />} />
        <Route path="/dashboard/profile" element={<UserProfileEdit />} />
        <Route path="/dashboard/community/:id" element={<CommunityDashboard />} />
        <Route path="/dashboard/community/:id/settings" element={<CommunitySettings />} />
        <Route path="/dashboard/community/:id/chat" element={<CommunityChat />} />
        <Route path="/dashboard/community/:id/leaderboard" element={<CommunityLeaderboard />} />
        <Route path="/dashboard/community/:id/members" element={<CommunityMembers />} />
      </Route>

      {/* Admin routes (community admin) */}
      <Route
        element={
          <ProtectedRoute requireAdmin>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/admin/:communityId" element={<AdminHome />} />
        <Route path="/admin/:communityId/members" element={<AdminMembers />} />
        <Route path="/admin/:communityId/workflows" element={<AdminWorkflows />} />
        <Route path="/admin/:communityId/modules" element={<AdminModules />} />
        <Route path="/admin/:communityId/marketplace" element={<AdminMarketplace />} />
        <Route path="/admin/:communityId/browser-sources" element={<AdminBrowserSources />} />
        <Route path="/admin/:communityId/domains" element={<AdminDomains />} />
        <Route path="/admin/:communityId/servers" element={<AdminServers />} />
        <Route path="/admin/:communityId/mirror-groups" element={<AdminMirrorGroups />} />
        <Route path="/admin/:communityId/leaderboard" element={<AdminLeaderboardConfig />} />
        <Route path="/admin/:communityId/profile" element={<AdminCommunityProfile />} />
        <Route path="/admin/:communityId/reputation" element={<ReputationSettings />} />
        <Route path="/admin/:communityId/ai-insights" element={<AdminAIInsights />} />
        <Route path="/admin/:communityId/ai-config" element={<AdminAIResearcherConfig />} />
        <Route path="/admin/:communityId/bot-detection" element={<AdminBotDetection />} />
        <Route path="/admin/:communityId/overlays" element={<AdminOverlays />} />
        <Route path="/admin/:communityId/announcements" element={<AdminAnnouncements />} />
        <Route path="/admin/:communityId/analytics" element={<AdminAnalytics />} />
        <Route path="/admin/:communityId/security" element={<AdminSecurity />} />
        <Route path="/admin/:communityId/loyalty" element={<LoyaltySettings />} />
        <Route path="/admin/:communityId/loyalty/leaderboard" element={<LoyaltyLeaderboard />} />
        <Route path="/admin/:communityId/loyalty/giveaways" element={<LoyaltyGiveaways />} />
        <Route path="/admin/:communityId/loyalty/games" element={<LoyaltyGames />} />
        <Route path="/admin/:communityId/loyalty/gear" element={<LoyaltyGear />} />
      </Route>

      {/* Platform admin routes */}
      <Route
        element={
          <ProtectedRoute requirePlatformAdmin>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/platform" element={<PlatformDashboard />} />
        <Route path="/platform/users" element={<PlatformUsers />} />
        <Route path="/platform/communities" element={<PlatformCommunities />} />
      </Route>

      {/* Super admin routes - uses DashboardLayout with sidebar admin section */}
      <Route
        element={
          <ProtectedRoute requireSuperAdmin>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/superadmin" element={<SuperAdminDashboard />} />
        <Route path="/superadmin/communities" element={<SuperAdminCommunities />} />
        <Route path="/superadmin/communities/new" element={<SuperAdminCreateCommunity />} />
        <Route path="/superadmin/modules" element={<SuperAdminModuleRegistry />} />
        <Route path="/superadmin/platform-config" element={<SuperAdminPlatformConfig />} />
        <Route path="/superadmin/kong" element={<SuperAdminKongGateway />} />
      </Route>

      {/* Catch all - redirect to home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
