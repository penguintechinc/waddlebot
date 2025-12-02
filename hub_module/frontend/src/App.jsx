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

// Auth pages
import LoginPage from './pages/auth/LoginPage';
import OAuthCallback from './pages/auth/OAuthCallback';

// Dashboard pages
import DashboardHome from './pages/dashboard/DashboardHome';
import CommunityDashboard from './pages/dashboard/CommunityDashboard';
import CommunitySettings from './pages/dashboard/CommunitySettings';

// Admin pages
import AdminHome from './pages/admin/AdminHome';
import AdminMembers from './pages/admin/AdminMembers';
import AdminModules from './pages/admin/AdminModules';
import AdminBrowserSources from './pages/admin/AdminBrowserSources';
import AdminDomains from './pages/admin/AdminDomains';

// Platform admin pages
import PlatformDashboard from './pages/platform/PlatformDashboard';
import PlatformUsers from './pages/platform/PlatformUsers';
import PlatformCommunities from './pages/platform/PlatformCommunities';

// Super admin pages
import SuperAdminDashboard from './pages/superadmin/SuperAdminDashboard';
import SuperAdminCommunities from './pages/superadmin/SuperAdminCommunities';
import SuperAdminCreateCommunity from './pages/superadmin/SuperAdminCreateCommunity';

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
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<OAuthCallback />} />
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
        <Route path="/dashboard/community/:id" element={<CommunityDashboard />} />
        <Route path="/dashboard/community/:id/settings" element={<CommunitySettings />} />
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
        <Route path="/admin/:communityId/modules" element={<AdminModules />} />
        <Route path="/admin/:communityId/browser-sources" element={<AdminBrowserSources />} />
        <Route path="/admin/:communityId/domains" element={<AdminDomains />} />
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

      {/* Super admin routes */}
      <Route
        element={
          <ProtectedRoute requireSuperAdmin>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/superadmin" element={<SuperAdminDashboard />} />
        <Route path="/superadmin/communities" element={<SuperAdminCommunities />} />
        <Route path="/superadmin/communities/new" element={<SuperAdminCreateCommunity />} />
      </Route>

      {/* Catch all - redirect to home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
