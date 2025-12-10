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

// Dashboard pages
import DashboardHome from './pages/dashboard/DashboardHome';
import CommunityDashboard from './pages/dashboard/CommunityDashboard';
import CommunitySettings from './pages/dashboard/CommunitySettings';
import CommunityChat from './pages/dashboard/CommunityChat';
import CommunityLeaderboard from './pages/dashboard/CommunityLeaderboard';
import CommunityMembers from './pages/dashboard/CommunityMembers';
import AccountSettings from './pages/dashboard/AccountSettings';
import UserProfileEdit from './pages/dashboard/UserProfileEdit';

// Admin pages
import AdminHome from './pages/admin/AdminHome';
import AdminMembers from './pages/admin/AdminMembers';
import AdminModules from './pages/admin/AdminModules';
import AdminMarketplace from './pages/admin/AdminMarketplace';
import AdminBrowserSources from './pages/admin/AdminBrowserSources';
import AdminDomains from './pages/admin/AdminDomains';
import AdminServers from './pages/admin/AdminServers';
import AdminMirrorGroups from './pages/admin/AdminMirrorGroups';
import AdminLeaderboardConfig from './pages/admin/AdminLeaderboardConfig';
import AdminCommunityProfile from './pages/admin/AdminCommunityProfile';
import ReputationSettings from './pages/admin/ReputationSettings';
import AdminAIInsights from './pages/admin/AdminAIInsights';
import AdminAIResearcherConfig from './pages/admin/AdminAIResearcherConfig';
import AdminBotDetection from './pages/admin/AdminBotDetection';
import AdminOverlays from './pages/admin/AdminOverlays';
import AdminAnnouncements from './pages/admin/AdminAnnouncements';
import AdminAnalytics from './pages/admin/AdminAnalytics';
import AdminSecurity from './pages/admin/AdminSecurity';
import LoyaltySettings from './pages/admin/LoyaltySettings';
import LoyaltyLeaderboard from './pages/admin/LoyaltyLeaderboard';
import LoyaltyGiveaways from './pages/admin/LoyaltyGiveaways';
import LoyaltyGames from './pages/admin/LoyaltyGames';
import LoyaltyGear from './pages/admin/LoyaltyGear';
import AdminWorkflows from './pages/admin/AdminWorkflows';

// Platform admin pages
import PlatformDashboard from './pages/platform/PlatformDashboard';
import PlatformUsers from './pages/platform/PlatformUsers';
import PlatformCommunities from './pages/platform/PlatformCommunities';

// Super admin pages
import SuperAdminDashboard from './pages/superadmin/SuperAdminDashboard';
import SuperAdminCommunities from './pages/superadmin/SuperAdminCommunities';
import SuperAdminCreateCommunity from './pages/superadmin/SuperAdminCreateCommunity';
import SuperAdminModuleRegistry from './pages/superadmin/SuperAdminModuleRegistry';
import SuperAdminPlatformConfig from './pages/superadmin/SuperAdminPlatformConfig';
import SuperAdminKongGateway from './pages/superadmin/SuperAdminKongGateway';

// Loading spinner
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
    </div>
  );
}

// Protected route wrapper
function ProtectedRoute({ children, requireAdmin = false, requirePlatformAdmin = false, requireSuperAdmin = false }) {
  const { user, loading, isSuperAdmin } = useAuth();

  if (loading) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requireSuperAdmin && !isSuperAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  if (requirePlatformAdmin && !user.roles?.includes('platform-admin')) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

function App() {
  return (
    <Routes>
      {/* Public routes */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/communities" element={<CommunitiesPage />} />
        <Route path="/communities/:id" element={<CommunityPublicPage />} />
        <Route path="/live" element={<LiveStreamsPage />} />
        <Route path="/users/:userId" element={<UserPublicProfile />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<OAuthCallback />} />
        <Route path="/cookie-policy" element={<CookiePolicy />} />
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
