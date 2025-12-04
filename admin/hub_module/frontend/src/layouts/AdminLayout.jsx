import { Outlet, Link, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  HomeIcon,
  UserGroupIcon,
  PuzzlePieceIcon,
  GlobeAltIcon,
  ComputerDesktopIcon,
  ChartBarIcon,
  DocumentTextIcon,
  ArrowLeftOnRectangleIcon,
  ShieldCheckIcon,
  Cog6ToothIcon,
  BuildingStorefrontIcon,
  ServerStackIcon,
  ArrowsRightLeftIcon,
  TrophyIcon,
} from '@heroicons/react/24/outline';

function AdminLayout() {
  const { user, logout, isPlatformAdmin, isSuperAdmin } = useAuth();
  const location = useLocation();
  const { communityId } = useParams();

  // Community admin nav
  const communityAdminNav = communityId
    ? [
        { to: `/admin/${communityId}`, icon: HomeIcon, label: 'Overview', exact: true },
        { to: `/admin/${communityId}/members`, icon: UserGroupIcon, label: 'Members' },
        { to: `/admin/${communityId}/servers`, icon: ServerStackIcon, label: 'Linked Servers' },
        { to: `/admin/${communityId}/mirror-groups`, icon: ArrowsRightLeftIcon, label: 'Chat Mirroring' },
        { to: `/admin/${communityId}/leaderboard`, icon: TrophyIcon, label: 'Leaderboards' },
        { to: `/admin/${communityId}/modules`, icon: PuzzlePieceIcon, label: 'Modules' },
        { to: `/admin/${communityId}/browser-sources`, icon: ComputerDesktopIcon, label: 'Browser Sources' },
        { to: `/admin/${communityId}/domains`, icon: GlobeAltIcon, label: 'Custom Domains' },
      ]
    : [];

  // Platform admin nav
  const platformAdminNav = [
    { to: '/platform', icon: ChartBarIcon, label: 'Dashboard', exact: true },
    { to: '/platform/users', icon: UserGroupIcon, label: 'Users' },
    { to: '/platform/communities', icon: HomeIcon, label: 'Communities' },
  ];

  // Super admin nav
  const superAdminNav = [
    { to: '/superadmin', icon: ChartBarIcon, label: 'Dashboard', exact: true },
    { to: '/superadmin/communities', icon: HomeIcon, label: 'Communities' },
    { to: '/superadmin/modules', icon: BuildingStorefrontIcon, label: 'Module Registry' },
    { to: '/superadmin/platform-config', icon: Cog6ToothIcon, label: 'Platform Config' },
  ];

  const isActive = (to, exact = false) => {
    if (exact) return location.pathname === to;
    return location.pathname.startsWith(to);
  };

  // Determine which nav to show based on the path
  const isSuperAdminPath = location.pathname.startsWith('/superadmin');
  const navItems = communityId
    ? communityAdminNav
    : isSuperAdminPath
      ? superAdminNav
      : platformAdminNav;
  const title = communityId
    ? 'Community Admin'
    : isSuperAdminPath
      ? 'Super Admin'
      : 'Platform Admin';

  return (
    <div className="min-h-screen bg-navy-950">
      {/* Top bar */}
      <header className="bg-navy-900 border-b border-navy-700 sticky top-0 z-50">
        <div className="flex justify-between items-center h-16 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center space-x-4">
            <Link to="/" className="flex items-center space-x-2">
              <span className="text-2xl">🐧</span>
              <span className="text-xl font-bold text-gold-400">WaddleBot</span>
            </Link>
            <span className="text-navy-600">|</span>
            <div className="flex items-center space-x-2">
              <ShieldCheckIcon className="w-5 h-5 text-gold-400" />
              <span className="font-medium text-gold-400">{title}</span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {isSuperAdmin && (
              <Link
                to="/superadmin"
                className="text-sm font-medium text-gold-400 hover:text-gold-300"
              >
                Super Admin
              </Link>
            )}
            <Link to="/dashboard" className="text-sm text-navy-300 hover:text-sky-300">
              Back to Dashboard
            </Link>
            <div className="flex items-center space-x-2">
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt={user.username} className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center border border-navy-600">
                  <span className="text-sky-100 font-medium">
                    {user?.username?.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <span className="text-sm text-sky-100">{user?.username}</span>
            </div>
            <button
              onClick={logout}
              className="p-2 text-navy-400 hover:text-sky-300 rounded-lg hover:bg-navy-800"
            >
              <ArrowLeftOnRectangleIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-64 bg-navy-900 border-r border-navy-700 min-h-[calc(100vh-4rem)] sticky top-16">
          <nav className="p-4 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center space-x-3 px-3 py-2 rounded-lg transition-colors ${
                  isActive(item.to, item.exact)
                    ? 'bg-gold-500/20 text-gold-400 border border-gold-500/30'
                    : 'text-navy-300 hover:bg-navy-800 hover:text-sky-300'
                }`}
              >
                <item.icon className="w-5 h-5" />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            ))}

            {communityId && (
              <>
                <div className="pt-6 pb-2">
                  <div className="text-xs font-semibold text-navy-500 uppercase tracking-wider px-3">
                    Quick Actions
                  </div>
                </div>
                <Link
                  to={`/dashboard/community/${communityId}`}
                  className="flex items-center space-x-3 px-3 py-2 rounded-lg text-navy-300 hover:bg-navy-800 hover:text-sky-300"
                >
                  <DocumentTextIcon className="w-5 h-5" />
                  <span className="text-sm font-medium">View Community</span>
                </Link>
              </>
            )}

            {isPlatformAdmin && communityId && (
              <Link
                to="/platform"
                className="flex items-center space-x-3 px-3 py-2 rounded-lg text-navy-300 hover:bg-navy-800 hover:text-sky-300"
              >
                <ShieldCheckIcon className="w-5 h-5" />
                <span className="text-sm font-medium">Platform Admin</span>
              </Link>
            )}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AdminLayout;
